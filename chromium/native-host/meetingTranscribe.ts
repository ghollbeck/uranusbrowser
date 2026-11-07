/**
 * Meeting notes, in the native host: turning a 10-second chunk of 16 kHz mono WAV into text.
 *
 * Audio arrives from the shell as base64 and is held only for the length of one request: it is
 * checked, sent to an engine, and dropped. Nothing is written to disk, and nothing about the
 * audio or the text is logged here (the host's logger gets names, counts and timings only).
 *
 * Two engines sit behind one small interface:
 *
 *  - `openai`: the OpenAI audio transcription endpoint (ai/openaiApi.ts), with the key from the
 *    macOS Keychain. The audio leaves this Mac, to OpenAI, and nowhere else. The model is the
 *    one Settings › AI picked for transcription (ai/registry.ts), `gpt-4o-mini-transcribe` by
 *    default, or ANUS_MEETING_TRANSCRIBE_MODEL (gpt-4o-transcribe and whisper-1 also work).
 *    A ChatGPT sign-in can't transcribe audio: that needs an API key or the local engine.
 *  - `local`: an OPTIONAL whisper.cpp server, used only when a `whisper-server` binary and a
 *    ggml model are ALREADY installed. Nothing is downloaded or installed. They are found at
 *    ANUS_WHISPER_SERVER / ANUS_WHISPER_MODEL, or, failing that, where the user's
 *    OpenWhisper app keeps them (read-only lookups). The server listens on 127.0.0.1 only,
 *    on a free port, and is stopped after a few idle minutes and when the host exits.
 *    Decoder settings follow OpenWhisper's meeting profile (docs/meeting-asr-benchmark.md).
 *
 * Every failure is turned into a short message with the API key (and anything shaped like
 * one) scrubbed out, and never contains audio or transcript text.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dropSilenceArtifact } from '../shared/meetings';
import type { EngineId, EngineInfo, MeetingTranscribeReply, MeetingTranscribeRequest } from '../shared/meetingProtocol';
import { fromBase64, inspectWav } from '../shared/wav';
import { ProviderError } from './agentProvider';
import { DEFAULT_TRANSCRIBE_MODEL, openaiTranscribe } from './ai/openaiApi';
import type { AiRegistry } from './ai/registry';
import type { SecretStore } from './secrets';

export { DEFAULT_TRANSCRIBE_MODEL, TRANSCRIBE_ENDPOINT } from './ai/openaiApi';

/** A chunk is about 10 s; anything over 30 s is not one of ours. */
export const MAX_CHUNK_MS = 30_000;
export const MIN_CHUNK_MS = 300;
/** 30 s of 16 kHz 16-bit mono is 960 KB; base64 of that is 1.28 MB. */
export const MAX_WAV_BYTES = 1_000_000;
export const MAX_BASE64_CHARS = Math.ceil((MAX_WAV_BYTES * 4) / 3) + 8;
const REQUEST_TIMEOUT_MS = 40_000;

/** A failure whose message is safe to show the user. */
export class MeetingError extends Error {}

export interface TranscribeOptions {
  signal: AbortSignal;
  language?: string;
}

export interface TranscribeEngine {
  readonly id: EngineId;
  info(): Promise<EngineInfo>;
  transcribe(wav: Uint8Array<ArrayBuffer>, options: TranscribeOptions): Promise<string>;
  dispose?(): Promise<void>;
}

const tidy = (text: unknown) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');

// ---- OpenAI ---------------------------------------------------------------------------------

export class OpenAITranscribeEngine implements TranscribeEngine {
  readonly id = 'openai' as const;

  /**
   * `model` fixes the model (tests); otherwise the registry's pick for transcription, or without
   * a registry ANUS_MEETING_TRANSCRIBE_MODEL, else the default.
   */
  constructor(
    private secrets: SecretStore,
    private fixedModel?: string,
    private fetcher: typeof fetch = fetch,
    private registry?: AiRegistry,
  ) {}

  get model(): string {
    if (this.fixedModel) return this.fixedModel;
    if (this.registry) return this.registry.choice('transcribe').model;
    return process.env.ANUS_MEETING_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
  }

  async info(): Promise<EngineInfo> {
    const found = await this.secrets.openaiKey();
    return {
      id: this.id,
      label: 'OpenAI',
      model: this.model,
      where: 'cloud',
      ready: !!found,
      detail: found
        ? 'Audio is sent to OpenAI for transcription, using your API key.'
        : 'No OpenAI API key yet: add one in Settings › AI (kept in the macOS Keychain). A ChatGPT sign-in can’t transcribe audio.',
    };
  }

  async transcribe(wav: Uint8Array<ArrayBuffer>, { signal, language }: TranscribeOptions): Promise<string> {
    try {
      // Through the registry when there is one, so Settings › AI decides the model.
      if (this.registry && !this.fixedModel) return await this.registry.transcribe(wav, { signal, language });
      return await openaiTranscribe(this.secrets, this.fetcher, wav, { model: this.model, signal, language });
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof ProviderError) throw new MeetingError(err.message);
      throw err;
    }
  }
}

// ---- whisper.cpp (optional, already installed, loopback only) ---------------------------------

export interface LocalPaths {
  binary: string;
  model: string;
}

const OPENWHISPER_BINARY = '/Applications/OpenWhisper.app/Contents/Resources/bin/whisper-server';
const OPENWHISPER_MODELS = path.join(os.homedir(), 'Library/Application Support/OpenWhisper/whisper-models');

function isExecutable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where an installed whisper-server and model are, or undefined. ANUS_WHISPER_SERVER=off
 * turns the local engine off. Only checks that files exist; never creates or fetches one.
 */
export function findLocalWhisper(env: NodeJS.ProcessEnv = process.env): LocalPaths | undefined {
  const server = env.ANUS_WHISPER_SERVER?.trim();
  if (server === 'off') return undefined;
  const binary = server || OPENWHISPER_BINARY;
  if (!isExecutable(binary)) return undefined;
  const chosen = env.ANUS_WHISPER_MODEL?.trim();
  const candidates = chosen ? [chosen] : ['ggml-small.bin', 'ggml-base.bin'].map((name) => path.join(OPENWHISPER_MODELS, name));
  const model = candidates.find(isFile);
  return model ? { binary, model } : undefined;
}

export interface LocalServer {
  port: number;
  stop(): Promise<void>;
  /** Resolves when the process is gone (for the engine to start a new one). */
  exited: Promise<void>;
}

export type LaunchServer = (paths: LocalPaths) => Promise<LocalServer>;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

async function healthy(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/** Starts the installed whisper-server on a free loopback port and waits until it answers. */
export const launchWhisperServer: LaunchServer = async ({ binary, model }) => {
  const port = await freePort();
  const dir = path.dirname(binary);
  const child: ChildProcess = spawn(binary, ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--language', 'auto'], {
    stdio: 'ignore',
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let dead = false;
  void exited.then(() => (dead = true));
  const stop = async () => {
    if (dead) return;
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 4000);
    await exited;
    clearTimeout(killer);
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (dead) throw new MeetingError('The local transcription server stopped while starting.');
    if (await healthy(port)) return { port, stop, exited };
    await new Promise((r) => setTimeout(r, 150));
  }
  await stop();
  throw new MeetingError('The local transcription server didn’t start in time.');
};

const IDLE_STOP_MS = 3 * 60_000;

export class WhisperCppEngine implements TranscribeEngine {
  readonly id = 'local' as const;
  private server?: Promise<LocalServer>;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(
    private find: () => LocalPaths | undefined = findLocalWhisper,
    private launch: LaunchServer = launchWhisperServer,
    private fetcher: typeof fetch = fetch,
  ) {}

  async info(): Promise<EngineInfo> {
    const paths = this.find();
    return {
      id: this.id,
      label: 'On this Mac',
      model: paths ? path.basename(paths.model) : 'whisper.cpp',
      where: 'local',
      ready: !!paths,
      detail: paths ? 'Audio stays on this Mac (an installed whisper.cpp server on 127.0.0.1).' : 'Not available: no whisper-server and ggml model are installed. UrAnus Browser doesn’t download one.',
    };
  }

  private async ensure(): Promise<LocalServer> {
    const paths = this.find();
    if (!paths) throw new MeetingError('No local whisper-server and model are installed.');
    if (!this.server) {
      const starting = this.launch(paths);
      this.server = starting;
      starting.then(
        (s) => void s.exited.then(() => this.server === starting && (this.server = undefined)),
        () => this.server === starting && (this.server = undefined),
      );
    }
    return this.server;
  }

  async transcribe(wav: Uint8Array<ArrayBuffer>, { signal, language }: TranscribeOptions): Promise<string> {
    let server: LocalServer;
    try {
      server = await this.ensure();
    } catch (err) {
      throw err instanceof MeetingError ? err : new MeetingError('The local transcription server couldn’t start.');
    }
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.dispose(), IDLE_STOP_MS);
    this.idle.unref?.();
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
    form.append('response_format', 'json');
    form.append('language', language || 'auto');
    // OpenWhisper's meeting profile: no fallback sampling, no non-speech tokens.
    form.append('temperature', '0');
    form.append('temperature_inc', '0');
    form.append('best_of', '1');
    form.append('suppress_nst', 'true');
    let response: Response;
    try {
      response = await this.fetcher(`http://127.0.0.1:${server.port}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new MeetingError('The local transcription server didn’t answer.');
    }
    const json = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
    if (!response.ok || !json) throw new MeetingError(`The local transcription server failed (HTTP ${response.status}).`);
    return tidy(json.text);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.idle);
    const server = this.server;
    this.server = undefined;
    if (server) await server.then((s) => s.stop()).catch(() => undefined);
  }
}

// ---- the front: limits, validation, engine choice --------------------------------------------

export interface Limits {
  /** Chunks accepted within `windowMs`. */
  maxChunks: number;
  windowMs: number;
  /** Requests in flight at once. */
  maxParallel: number;
  /** Audio seconds that may be queued up at once, and how many more arrive per second of waiting. */
  burstSeconds: number;
  refillPerSecond: number;
}

export const DEFAULT_LIMITS: Limits = { maxChunks: 20, windowMs: 10_000, maxParallel: 4, burstSeconds: 120, refillPerSecond: 3 };

export class MeetingTranscriber {
  private recent: number[] = [];
  private inFlight = 0;
  private budget: number;
  private budgetAt: number;

  constructor(
    private engines: Partial<Record<EngineId, TranscribeEngine>>,
    private limits: Limits = DEFAULT_LIMITS,
    private now: () => number = Date.now,
  ) {
    this.budget = limits.burstSeconds;
    this.budgetAt = now();
  }

  async status(): Promise<EngineInfo[]> {
    const infos: EngineInfo[] = [];
    for (const engine of Object.values(this.engines)) if (engine) infos.push(await engine.info());
    return infos;
  }

  /**
   * Transcribes one chunk. Throws a MeetingError (or an abort) with a message safe to show;
   * returns '' for a chunk with no speech. The caller's request object is not kept.
   */
  async transcribe(request: MeetingTranscribeRequest, signal: AbortSignal = new AbortController().signal): Promise<MeetingTranscribeReply> {
    if (!request || typeof request !== 'object') throw new MeetingError('Bad transcription request.');
    const engine = this.engines[request.engine];
    if (!engine) throw new MeetingError('Unknown transcription engine.');
    if (typeof request.wav !== 'string' || !request.wav.length) throw new MeetingError('No audio in the request.');
    if (request.wav.length > MAX_BASE64_CHARS) throw new MeetingError('That audio chunk is too large.');
    // `auto` (or none) means detect: no `language` goes to the engine at all.
    const language = request.language === undefined || request.language === 'auto' ? undefined : request.language;
    if (language !== undefined && !/^[a-z]{2,3}$/.test(language)) throw new MeetingError('Bad language code.');
    let wav: Uint8Array<ArrayBuffer>;
    try {
      wav = fromBase64(request.wav);
    } catch {
      throw new MeetingError('The audio isn’t valid base64.');
    }
    if (wav.length > MAX_WAV_BYTES) throw new MeetingError('That audio chunk is too large.');
    let seconds: number;
    try {
      const info = inspectWav(wav);
      if (info.durationMs < MIN_CHUNK_MS) return { text: '' };
      if (info.durationMs > MAX_CHUNK_MS) throw new MeetingError('That audio chunk is too long.');
      seconds = info.durationMs / 1000;
    } catch (err) {
      throw err instanceof MeetingError ? err : new MeetingError(err instanceof Error ? err.message : 'Bad audio.');
    }

    // Rate and budget: a bug or a runaway loop in the shell must not turn into a large bill.
    const now = this.now();
    this.recent = this.recent.filter((t) => now - t < this.limits.windowMs);
    if (this.recent.length >= this.limits.maxChunks) throw new MeetingError('Too many audio chunks at once; slowing down.');
    if (this.inFlight >= this.limits.maxParallel) throw new MeetingError('Transcription is behind; slowing down.');
    this.budget = Math.min(this.limits.burstSeconds, this.budget + ((now - this.budgetAt) / 1000) * this.limits.refillPerSecond);
    this.budgetAt = now;
    if (this.budget < seconds) throw new MeetingError('More audio arrived than real time allows; slowing down.');
    this.budget -= seconds;
    this.recent.push(now);

    this.inFlight++;
    try {
      const text = await engine.transcribe(wav, { signal, language });
      const level = typeof request.level === 'number' && Number.isFinite(request.level) ? request.level : 1;
      return { text: dropSilenceArtifact(text, level) };
    } finally {
      this.inFlight--;
    }
  }

  async dispose() {
    await Promise.all(Object.values(this.engines).map((e) => e?.dispose?.()));
  }
}

/** The host's engines: OpenAI always listed, the local one only if it is already installed. */
export function defaultTranscriber(secrets: SecretStore, registry?: AiRegistry): MeetingTranscriber {
  return new MeetingTranscriber({ openai: new OpenAITranscribeEngine(secrets, undefined, fetch, registry), local: new WhisperCppEngine() });
}
