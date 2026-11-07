/**
 * Voice mode: the bot answers out loud by itself, with a model that runs on this Mac (Ollama),
 * so a meeting can talk with it at about conversational speed. joinly does the hearing (its
 * local Whisper) and the speaking (its local Kokoro); this is only the part in between: notice
 * that someone finished talking, ask the local model what to say, and speak the first sentence
 * as soon as it is written.
 *
 * Safety (the rules for this mode, which speaks without a card per sentence because the person
 * switched it on for exactly that):
 * - Off by default and off in every new meeting; it can only be started while in a meeting, by
 *   the person's confirmed click in the sheet (the model has no way to start it).
 * - It switches itself off after 20 minutes, when the meeting ends or is lost, when joinly
 *   fails to speak, and when the local model fails twice in a row. The sheet and the banner
 *   show it and have a Stop button.
 * - The model's words are only ever speech. It has no tools, never sees a page, and the
 *   meeting's talk reaches it fenced as untrusted data (shared/voiceMode.ts). What it writes
 *   is cleaned (no links, markdown, emoji, secrets), cut to two sentences and 200 characters.
 * - Ollama is reached on this computer only (127.0.0.1), without following redirects.
 * - It never answers the bot's own words, empty or invented speech, or more than 8 times a minute.
 * - Logs carry timings and counts, never the words.
 */
import { JoinlyError, isLoopbackUrl, type JoinlyView, type VoiceView, emptyVoice } from '../shared/joinly';
import { MEETING_LANGUAGES } from '../shared/meetingLanguages';
import {
  OLLAMA_BASE,
  RateLimiter,
  SentenceSplitter,
  TalkWatcher,
  VOICE_LIMITS,
  buildMessages,
  chatBody,
  cleanForSpeech,
  fitToBudget,
  isWorthAnswering,
  looksLikeReasoning,
  normalizeSpeech,
  parseChatLine,
  pickModel,
  type ChatMessage,
  type TalkSegment,
  type VoiceLimits,
} from '../shared/voiceMode';

// ---- Ollama, on this computer ----------------------------------------------------------------------------

export class OllamaClient {
  constructor(
    private readonly base: string = OLLAMA_BASE,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!isLoopbackUrl(base)) throw new JoinlyError('The local model must run on this computer.');
  }

  /** Every request: this computer only, no redirects. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.base);
    if (!isLoopbackUrl(url)) throw new JoinlyError('The local model must run on this computer.');
    const response = await this.fetcher(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new JoinlyError('Ollama answered with a redirect, which UrAnus Browser doesn’t follow.');
    }
    return response;
  }

  /** The installed models' names. */
  async models(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('/api/tags', { method: 'GET', signal: AbortSignal.any([AbortSignal.timeout(4_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new JoinlyError('Ollama didn’t list its models.');
    const body = (await response.json().catch(() => undefined)) as { models?: Array<{ name?: unknown; model?: unknown }> } | undefined;
    const names = (body?.models ?? []).map((m) => (typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : '')).filter(Boolean);
    return [...new Set(names)].slice(0, 50);
  }

  /** Loads the model into memory with a one-token request, so the first real answer is fast. Returns how long it took. */
  async warm(model: string, signal?: AbortSignal): Promise<number> {
    const started = Date.now();
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...chatBody(model, [{ role: 'user', content: 'Hi' }], false), options: { num_predict: 1, temperature: 0, num_ctx: VOICE_LIMITS.numCtx } }),
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) throw new JoinlyError(`Ollama couldn’t load ${model}.`);
    return Date.now() - started;
  }

  /** Streams an answer; `onToken` gets each piece as it arrives. Resolves when it ends (or is aborted). */
  async chat(model: string, messages: ChatMessage[], options: { signal: AbortSignal; onToken(token: string): void; timeoutMs?: number }): Promise<void> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody(model, messages)),
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]),
    });
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new JoinlyError(`Ollama didn’t answer (${response.status}).`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const piece = parseChatLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (piece?.error) throw new JoinlyError('Ollama reported an error.');
          if (piece?.token) options.onToken(piece.token);
          if (piece?.done) return;
        }
      }
      const last = parseChatLine(pending);
      if (last?.token) options.onToken(last.token);
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }
}

// ---- voice mode ------------------------------------------------------------------------------------------------

/** What voice mode needs of the connection to joinly (JoinlyClient). */
export interface VoiceHost {
  view(): JoinlyView;
  onChange(listener: (view: JoinlyView) => void): () => void;
  onTalk(listener: (segments: TalkSegment[]) => void): () => void;
  refreshTalk(): Promise<void>;
  setFastTalk(on: boolean): void;
  setVoice(voice: VoiceView | undefined): void;
  /** Speaks, blocking until it is said. */
  speakAloud(text: string): Promise<string>;
}

export interface VoiceOptions {
  ollama?: OllamaClient;
  log?(...args: unknown[]): void;
  limits?: Partial<VoiceLimits>;
}

export class VoiceMode {
  private v: VoiceView = emptyVoice();
  private readonly ollama: OllamaClient;
  private readonly log: (...args: unknown[]) => void;
  private readonly limits: VoiceLimits;
  private readonly limiter: RateLimiter;
  private generation = 0;
  private meetingId?: number;
  private model = '';
  private languageName?: string;
  private watcher?: TalkWatcher;
  private segments: TalkSegment[] = [];
  private offs: Array<() => void> = [];
  private quietTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private heardAt = 0;
  /** What was just said by others, not answered yet. */
  private freshText: string[] = [];
  private inFlight?: { llm: AbortController; spoke: boolean; superseded: boolean };
  private lastAnswered?: { normalized: string; at: number };
  private answeredKey = '';
  private wasInterrupted = false;
  private failures = 0;

  constructor(
    private readonly host: VoiceHost,
    options: VoiceOptions = {},
  ) {
    this.ollama = options.ollama ?? new OllamaClient();
    this.log = options.log ?? (() => undefined);
    this.limits = { ...VOICE_LIMITS, ...options.limits };
    this.limiter = new RateLimiter(this.limits.maxRepliesPerMinute);
  }

  view(): VoiceView {
    return { ...this.v, models: [...this.v.models] };
  }

  get on() {
    return this.v.state !== 'off';
  }

  private set(patch: Partial<VoiceView>) {
    this.v = { ...this.v, ...patch };
    this.host.setVoice(this.view());
  }

  // ---- asking Ollama what is installed -------------------------------------------------------------------

  /** Looks at what Ollama has (the sheet shows the list). Never starts anything. */
  async listModels(saved?: string): Promise<void> {
    try {
      const models = await this.ollama.models();
      this.set({ models, ollama: 'ready', model: this.on ? this.v.model : pickModel(models, saved || this.v.model) });
    } catch {
      this.set({ models: [], ollama: 'down' });
    }
  }

  // ---- starting and stopping ----------------------------------------------------------------------------

  /** Starts voice mode. Needs the person's confirmation (passed by the sheet) and a meeting in progress. */
  async start(request: { confirmed: boolean; model?: string; language?: string }): Promise<void> {
    if (this.on) return;
    const fail = (note: string): never => {
      this.set({ state: 'off', note, doing: undefined });
      throw new JoinlyError(note);
    };
    if (request.confirmed !== true) return fail('Voice mode needs your confirmation first.');
    const view = this.host.view();
    if (view.status !== 'joined' || !view.meeting) return fail('Join a meeting first: voice mode works only while the bot is in one.');
    const generation = ++this.generation;
    const meetingId = view.meeting.id;
    this.set({ state: 'starting', note: undefined, replies: 0, last: undefined, doing: undefined });
    const stillWanted = () => this.generation === generation && this.v.state === 'starting' && this.host.view().meeting?.id === meetingId;

    let model: string | undefined;
    let refusal: string | undefined;
    try {
      const installed = await this.ollama.models();
      this.set({ models: installed, ollama: 'ready' });
      if (request.model && !installed.includes(request.model)) refusal = `The model ${request.model} isn’t installed in Ollama. Install it (ollama pull ${request.model}) or pick another.`;
      else {
        model = pickModel(installed, request.model);
        if (!model) refusal = 'Ollama has no model installed. Install one (for example: ollama pull qwen3:4b).';
        else this.log(`voice: model warm in ${await this.ollama.warm(model)}ms`);
      }
    } catch (err) {
      if (!stillWanted()) throw new JoinlyError('Voice mode was stopped.');
      if (err instanceof JoinlyError) return fail(err.message);
      this.set({ ollama: 'down' });
      return fail('Ollama isn’t answering on this computer (127.0.0.1:11434). Start Ollama, then try again.');
    }
    if (!stillWanted()) throw new JoinlyError('Voice mode was stopped.');
    if (refusal || !model) return fail(refusal ?? 'No model.');

    // Everything said so far counts as heard: only talk from now on is answered.
    this.model = model;
    this.languageName = MEETING_LANGUAGES.find((l) => l.code === request.language)?.name;
    this.meetingId = meetingId;
    this.watcher = new TalkWatcher();
    this.segments = [];
    this.dirty = false;
    this.failures = 0;
    this.answeredKey = '';
    this.lastAnswered = undefined;
    this.wasInterrupted = false;
    const baseline = await this.firstLook();
    if (!stillWanted()) throw new JoinlyError('Voice mode was stopped.');
    this.watcher.baseline(baseline);
    this.segments = baseline;

    this.offs = [this.host.onTalk((segments) => this.heard(segments)), this.host.onChange((next) => this.viewChanged(next))];
    this.host.setFastTalk(true);
    const now = Date.now();
    this.expiryTimer = setTimeout(() => this.stop('Voice mode switched itself off after 20 minutes.'), this.limits.autoOffMs);
    this.expiryTimer.unref?.();
    this.set({ state: 'on', model, since: now, expiresAt: now + this.limits.autoOffMs, note: undefined });
    this.log(`voice: on (${model})`);
  }

  private firstLook(): Promise<TalkSegment[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => (off(), resolve([])), 3_000);
      const off = this.host.onTalk((segments) => {
        clearTimeout(timer);
        off();
        resolve(segments);
      });
      void this.host.refreshTalk();
    });
  }

  /** Switches it off. `note` says why when it wasn't the person's own Stop. */
  stop(note?: string) {
    if (this.v.state === 'off') return;
    this.generation++;
    clearTimeout(this.quietTimer);
    clearTimeout(this.expiryTimer);
    for (const off of this.offs.splice(0)) off();
    this.inFlight?.llm.abort();
    this.host.setFastTalk(false);
    this.dirty = false;
    this.freshText = [];
    this.meetingId = undefined;
    this.set({ state: 'off', doing: undefined, expiresAt: undefined, since: undefined, note });
    this.log(`voice: off${note ? ' (by itself)' : ''}`);
  }

  dispose() {
    this.stop();
  }

  private viewChanged(view: JoinlyView) {
    if (this.v.state === 'off') return;
    if (view.status !== 'joined' || !view.meeting || view.meeting.id !== this.meetingId || view.phase === 'leaving') this.stop('Voice mode switched itself off: the meeting ended.');
    else if (view.error) this.stop('Voice mode switched itself off: joinly reported a problem.');
  }

  // ---- hearing -----------------------------------------------------------------------------------------------------

  private heard(segments: TalkSegment[]) {
    if (this.v.state !== 'on') return;
    this.segments = segments;
    const fresh = this.watcher?.fresh(segments) ?? [];
    if (!fresh.length) return;
    this.heardAt = Date.now();
    this.freshText.push(...fresh.map((f) => f.text));
    this.dirty = true;
    // Someone spoke again before the bot said anything: answer the latest, not the one before.
    if (this.inFlight && !this.inFlight.spoke) {
      this.inFlight.superseded = true;
      this.inFlight.llm.abort();
    }
    this.schedule(this.limits.quietMs);
  }

  private schedule(ms: number) {
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => void this.maybeReply(), ms);
    this.quietTimer.unref?.();
  }

  private async maybeReply() {
    if (this.v.state !== 'on' || !this.dirty) return;
    // Still thinking or speaking: finish that first; it looks again when done.
    if (this.inFlight) return;
    this.dirty = false;
    const heardText = this.freshText.join(' ');
    this.freshText = [];
    const { messages, lastTurn } = buildMessages({ botName: this.host.view().meeting?.botName ?? 'the assistant', languageName: this.languageName, segments: this.segments, wasInterrupted: this.wasInterrupted });
    if (!lastTurn) return;
    const key = `${lastTurn.start}|${lastTurn.text}`;
    if (key === this.answeredKey) return;
    this.answeredKey = key;
    const worth = isWorthAnswering(heardText || lastTurn.text, this.lastAnswered);
    if (!worth.ok) {
      this.log(`voice: not answering (${worth.reason})`);
      return;
    }
    if (!this.limiter.has()) {
      this.log('voice: not answering (rate limit)');
      return;
    }
    await this.reply(messages, normalizeSpeech(heardText || lastTurn.text), this.heardAt);
  }

  // ---- answering -----------------------------------------------------------------------------------------------------

  private async reply(messages: ChatMessage[], normalized: string, heardAt: number) {
    const flight = { llm: new AbortController(), spoke: false, superseded: false };
    this.inFlight = flight;
    const generation = this.generation;
    const host = this.host.view().meeting?.host;
    this.set({ doing: 'thinking' });

    const splitter = new SentenceSplitter(this.limits.minSentenceChars);
    let budget = this.limits.maxChars;
    let queued = 0;
    let done = false;
    let stopSpeaking = false;
    let interrupted = false;
    let failure: unknown;
    let firstTokenAt = 0;
    let speakAt = 0;
    let chain: Promise<void> = Promise.resolve();

    const enqueue = (text: string) => {
      chain = chain.then(async () => {
        if (stopSpeaking || this.generation !== generation || this.v.state !== 'on') return;
        if (!flight.spoke) {
          flight.spoke = true;
          speakAt = Date.now();
          this.limiter.take();
          this.set({ doing: 'speaking' });
        }
        try {
          const said = await this.host.speakAloud(text);
          if (/^interrupted/i.test(said)) {
            interrupted = true;
            stopSpeaking = true;
            flight.llm.abort();
          }
        } catch (err) {
          failure = err;
          stopSpeaking = true;
          flight.llm.abort();
        }
      });
    };
    let leaked = false;
    const offer = (sentence: string) => {
      if (done || stopSpeaking || flight.superseded) return;
      // A model that writes its reasoning as the answer: never spoken.
      if (looksLikeReasoning(sentence)) {
        leaked = true;
        done = true;
        flight.llm.abort();
        return;
      }
      const clean = cleanForSpeech(sentence, host);
      if (!clean) return;
      const fit = fitToBudget(clean, budget);
      if (!fit) {
        done = true;
        flight.llm.abort();
        return;
      }
      budget -= fit.length + 1;
      queued++;
      if (queued >= this.limits.maxSentences || budget < 12) {
        done = true;
        flight.llm.abort();
      }
      enqueue(fit);
    };

    let llmError: unknown;
    try {
      await this.ollama.chat(this.model, messages, {
        signal: flight.llm.signal,
        onToken: (token) => {
          if (!firstTokenAt) firstTokenAt = Date.now();
          for (const sentence of splitter.push(token)) offer(sentence);
        },
      });
    } catch (err) {
      if (!flight.llm.signal.aborted) llmError = err;
    }
    if (!flight.superseded && !done && !stopSpeaking && !llmError) for (const sentence of splitter.flush()) offer(sentence);
    await chain;

    const ended = Date.now();
    this.inFlight = undefined;
    if (this.generation !== generation) return;

    if (failure) {
      // joinly couldn't speak: not something to keep trying.
      this.stop('Voice mode switched itself off: joinly could not speak.');
      return;
    }
    if (llmError) {
      this.failures++;
      this.log(`voice: the model failed (${this.failures})`);
      if (this.failures >= this.limits.failuresBeforeOff) {
        this.stop('Voice mode switched itself off: the local model stopped answering.');
        return;
      }
    } else if (leaked && !flight.spoke) {
      this.failures++;
      this.log(`voice: the model wrote its reasoning instead of an answer; not spoken (${this.failures})`);
      if (this.failures >= this.limits.failuresBeforeOff) {
        this.stop('Voice mode switched itself off: this model thinks out loud instead of answering. Choose another model in the list.');
        return;
      }
    } else if (!flight.superseded) this.failures = 0;

    if (flight.spoke) {
      this.lastAnswered = { normalized, at: ended };
      this.wasInterrupted = interrupted;
      const last = { at: ended, heardToLlmMs: firstTokenAt ? firstTokenAt - heardAt : -1, heardToSpeakMs: speakAt - heardAt, totalMs: ended - heardAt, sentences: queued };
      this.set({ doing: undefined, replies: this.v.replies + 1, last });
      this.log(`voice: answered, heard→first token ${last.heardToLlmMs}ms, heard→speaking ${last.heardToSpeakMs}ms, total ${last.totalMs}ms, ${queued} sentence(s)${interrupted ? ', interrupted' : ''}`);
    } else {
      this.set({ doing: undefined });
      if (flight.superseded) this.log('voice: newer talk arrived; answering that instead');
    }
    // Something was said while this ran: look again.
    if (this.dirty && this.v.state === 'on') this.schedule(this.limits.quietMs);
  }
}
