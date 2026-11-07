/**
 * Underdog Woof (Conway Research's on-device language models, Apache-2.0), run on this Mac through
 * MLX by the same small Python server OpenWhisper uses (python/llm_mlx_server.py, JSON lines).
 *
 * Lazy by design: nothing is started, and no weights are read, until the first prompt. Whether the
 * model is available is decided by looking at files only. After a prompt the model stays in memory
 * for a few idle minutes, then the child is told to quit and the weights are released.
 *
 * It is an option, never the default: every AI feature uses OpenAI unless the user picks this one
 * for a particular piece of work (the summariser is the only one so far, because a small model
 * can pick numbered lines from a transcript but can't drive browser tools). Nothing here sends
 * data off the Mac, and the child gets a small allow-listed environment (no API keys).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UnderdogInfo } from '../shared/meetingProtocol';

export type { UnderdogInfo };


export interface UnderdogChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens?: number;
  jsonSchema?: object | null;
  signal?: AbortSignal;
}

export interface UnderdogReply {
  text: string;
  finishReason: 'stop' | 'length';
  completionTokens: number;
  durationMs: number;
}

export class UnderdogError extends Error {
  override readonly name = 'UnderdogError';
}

/** The pinned snapshots (the same revisions OpenWhisper verifies): a different folder is not used. */
const MODELS = {
  'woof-2b-1.1': { label: 'Underdog Woof 2B 1.1', repo: 'ConwayResearch/Underdog-Woof-2B-1.1', revision: '73c8b5ca3abffb2358270f4bc86bff697131612a' },
  'woof-4b-1.1': { label: 'Underdog Woof 4B 1.1', repo: 'ConwayResearch/Underdog-Woof-4B-1.1', revision: '5decb824793e03d33df8afb47bd30c4f3a917d87' },
} as const;
export type UnderdogModelId = keyof typeof MODELS;

export interface UnderdogLaunch {
  command: string;
  args: string[];
  label: string;
}

export interface UnderdogOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => boolean;
  idleMs?: number;
  startupMs?: number;
  requestMs?: number;
}

/** What it would run, from files alone: nothing is started, nothing is loaded. */
export function resolveUnderdog(options: UnderdogOptions = {}): { ok: true; launch: UnderdogLaunch } | { ok: false; detail: string } {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? fs.existsSync;
  const id = (env.ANUS_UNDERDOG_MODEL?.trim() || 'woof-2b-1.1') as UnderdogModelId;
  const model = MODELS[id];
  if (!model) return { ok: false, detail: `Unknown Underdog model “${id}”.` };

  const python = env.ANUS_UNDERDOG_PYTHON?.trim() || path.join(home, '.local/share/voxtral-transcribe/.venv/bin/python');
  const script =
    env.ANUS_UNDERDOG_SCRIPT?.trim() ||
    '/Applications/OpenWhisper.app/Contents/Resources/python/llm_mlx_server.py';
  const hub = env.HF_HUB_CACHE?.trim() || path.join(env.HF_HOME?.trim() || path.join(home, '.cache/huggingface'), 'hub');
  const snapshot = path.join(hub, `models--${model.repo.replace('/', '--')}`, 'snapshots', model.revision);

  if (!script || !exists(script)) return { ok: false, detail: 'Underdog isn’t set up: OpenWhisper’s Underdog script wasn’t found.' };
  if (!exists(python)) return { ok: false, detail: 'Underdog isn’t set up: its Python environment (with MLX) wasn’t found.' };
  if (!exists(path.join(snapshot, 'model.safetensors'))) return { ok: false, detail: `${model.label} isn’t downloaded. Download it in OpenWhisper (Settings, Intelligence).` };
  return { ok: true, launch: { command: python, args: ['-u', script, '--server', '--model', id, '--model-path', snapshot], label: `${model.label} (on this Mac)` } };
}

/** A small, allow-listed environment: the model needs none of the user's secrets. */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? os.homedir(), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUNBUFFERED: '1' };
}

type Reply = Record<string, unknown>;

export class UnderdogLlm {
  private child?: { proc: ChildProcessWithoutNullStreams; ready: Promise<void>; waiting: Map<number, { resolve(r: Reply): void; reject(e: Error): void }> };
  private idleTimer?: ReturnType<typeof setTimeout>;
  private chain: Promise<unknown> = Promise.resolve();
  private sequence = 0;

  constructor(
    private readonly resolve: () => ReturnType<typeof resolveUnderdog> = () => resolveUnderdog(),
    private readonly options: UnderdogOptions & { spawnImpl?: typeof spawn } = {},
  ) {}

  info(): UnderdogInfo {
    const found = this.resolve();
    if (!found.ok) return { ready: false, detail: found.detail, label: 'Underdog Woof', loaded: false };
    return { ready: true, detail: 'On this Mac. Nothing is loaded until the first prompt.', label: found.launch.label, loaded: this.loaded() };
  }

  loaded() {
    return !!this.child && this.child.proc.exitCode === null && !this.child.proc.killed;
  }

  /** One prompt at a time; the first one starts the model. */
  chat(request: UnderdogChatRequest): Promise<UnderdogReply> {
    const run = () => this.generate(request);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async generate(request: UnderdogChatRequest): Promise<UnderdogReply> {
    if (request.signal?.aborted) throw new UnderdogError('Cancelled.');
    const child = await this.start();
    this.clearIdle();
    const id = ++this.sequence;
    const timeoutMs = this.options.requestMs ?? 180_000;
    try {
      const reply = await new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.waiting.delete(id);
          void this.unload(true);
          reject(new UnderdogError('The on-device model took too long and was stopped.'));
        }, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          child.waiting.delete(id);
          // A generation can't be cancelled from outside: stop the child (the weights go with it).
          void this.unload(true);
          reject(new UnderdogError('Cancelled.'));
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });
        child.waiting.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            request.signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        });
        child.proc.stdin.write(
          `${JSON.stringify({ id, messages: request.messages, max_tokens: Math.min(request.maxTokens ?? 1024, 4096), temperature: 0, top_p: 0.95, json_schema: request.jsonSchema ?? null, thinking: false })}\n`,
        );
      });
      if (typeof reply.error === 'string') throw new UnderdogError('The on-device model couldn’t answer that.');
      return {
        text: String(reply.text ?? ''),
        finishReason: reply.finish_reason === 'length' ? 'length' : 'stop',
        completionTokens: Number(reply.completion_tokens ?? 0),
        durationMs: Number(reply.duration_ms ?? 0),
      };
    } finally {
      this.armIdle();
    }
  }

  private async start() {
    if (this.child && this.loaded()) {
      await this.child.ready;
      return this.child;
    }
    const found = this.resolve();
    if (!found.ok) throw new UnderdogError(found.detail);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const proc = spawnImpl(found.launch.command, found.launch.args, { env: childEnv(this.options.env ?? process.env), stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const waiting = new Map<number, { resolve(r: Reply): void; reject(e: Error): void }>();
    let readyOk!: () => void;
    let readyFail!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyOk = resolve;
      readyFail = reject;
    });
    const child = { proc, ready, waiting };
    this.child = child;
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let message: Reply;
        try {
          message = JSON.parse(line) as Reply;
        } catch {
          continue; // a stray log line
        }
        if (message.status === 'ready') readyOk();
        else if (typeof message.id === 'number') waiting.get(message.id)?.resolve(message), waiting.delete(message.id);
        else if (typeof message.error === 'string') readyFail(new UnderdogError('The on-device model couldn’t start.'));
      }
    });
    proc.stderr.on('data', () => undefined); // never kept: it can echo prompts
    const gone = () => {
      if (this.child === child) this.child = undefined;
      const err = new UnderdogError('The on-device model stopped.');
      readyFail(err);
      for (const w of waiting.values()) w.reject(err);
      waiting.clear();
    };
    proc.once('exit', gone);
    proc.once('error', gone);
    const startup = setTimeout(() => {
      readyFail(new UnderdogError('The on-device model took too long to start.'));
      void this.unload(true);
    }, this.options.startupMs ?? 180_000);
    try {
      await ready;
    } finally {
      clearTimeout(startup);
    }
    return child;
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle() {
    this.clearIdle();
    const idle = this.options.idleMs ?? 5 * 60_000;
    if (idle > 0) this.idleTimer = setTimeout(() => void this.unload(false), idle).unref();
  }

  /** Releases the weights: asks the child to quit, and stops it if it doesn't. */
  async unload(now: boolean) {
    this.clearIdle();
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      if (!now) child.proc.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
    } catch {
      /* already closed */
    }
    const stop = setTimeout(() => child.proc.kill('SIGTERM'), now ? 0 : 2000);
    child.proc.once('exit', () => clearTimeout(stop));
    if (now) child.proc.kill('SIGTERM');
  }

  async dispose() {
    await this.unload(true);
  }
}
