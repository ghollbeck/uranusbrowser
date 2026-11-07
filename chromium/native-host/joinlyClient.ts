/**
 * A minimal MCP client for a joinly server the user runs themselves (Docker, on this Mac).
 * UrAnus Browser is only a client: nothing of joinly ships here, and when it isn't running this says
 * so instead of trying to start it.
 *
 * - Loopback only. The address is checked when it is set (shared/joinly.ts), and again on
 *   every request this client makes; a redirect is never followed.
 * - Probing is a plain GET of /health: joinly starts a browser, speech models and a meeting
 *   session for every MCP connection, so a connection is made only to join, kept for the
 *   whole meeting (joinly ends the meeting when its connection ends) and closed to leave.
 * - One meeting at a time. Leaving is automatic when the panel says Stop, when the sheet is
 *   switched off, and when the host shuts down.
 * - Joining, speaking and posting need `approval.approved`: the card (or the sheet's own
 *   confirmation) comes first, in the caller. The curated tools map onto joinly's here.
 * - What this logs and what it throws is scrubbed: no links (a meeting link can carry a
 *   passcode), no transcript text.
 *
 * What joinly really does (read from its source and run through its own server.py, not guessed):
 * - A connection builds a whole meeting session (models, audio, the bot's one browser), so the
 *   first answer can take a while, and a second client is refused: its opening request gets a
 *   200 event stream that is cut short. The old session also keeps the browser for some seconds
 *   after its DELETE. Both are handled when joining (see doJoin).
 * - join_meeting blocks until the host lets the bot in (up to 180 s after loading the page) and
 *   returns the string "Joined meeting."; if it fails, the only text is "Failed to perform
 *   'join'.", so the time it took is the only hint of why (explainJoinFailure).
 * - speak_text blocks until the words are spoken. An interruption is a normal answer, not an error.
 * - Failed tool calls read "Error calling tool 'x': ...". Strings come back as {result}; the
 *   transcript as {segments:[{text,start,end,speaker|null,role}]} (seconds since admission);
 *   participants as {result:[{name,email,infos}]} with "You" in the bot's own infos.
 * - get_participants drives Meet's People panel in the bot's browser; get_transcript is cheap.
 * - If the bot's browser is signed in to Google, Meet shows that account's name, not the asked one.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  BOT_MARK,
  JOINLY_DEFAULT_ENDPOINT,
  JoinlyError,
  botDisplayName,
  checkBotName,
  checkEndpoint,
  checkMeetingUrl,
  cleanConfig,
  emptyView,
  explainJoinFailure,
  explainToolFailure,
  isLoopbackUrl,
  scrubError,
  shapeParticipants,
  shapeTranscript,
  stripToolPrefix,
  viewLines,
  type JoinlyConfig,
  type JoinlyView,
  type MeetingPort,
  type Shaped,
  type VoiceView,
} from '../shared/joinly';
import { parseSegments, type TalkSegment } from '../shared/voiceMode';

export { JoinlyError };

/** The tools of joinly this client uses; a server without them isn't joinly. */
const REQUIRED_TOOLS = ['join_meeting', 'leave_meeting', 'speak_text', 'send_chat_message', 'get_transcript', 'get_participants'];

export interface JoinlyTimeouts {
  probe: number;
  /** joinly builds a whole meeting session (speech models, audio, a browser) while a connection opens. */
  connect: number;
  /** Joining waits for a person to let the bot in: joinly itself waits up to 180 s, after loading the page. */
  join: number;
  /** A join that failed after at least this long was waiting to be let in; a quicker one was turned away. */
  slowFailure: number;
  /** Between looks at the participant list: joinly drives Meet's People panel for each, which others can see. */
  people: number;
  /** The room has only the bot in it: how long that must last before the bot leaves by itself, and how soon to look again. */
  emptyLeave: number;
  emptyRecheck: number;
  /** How long to wait for the bot's own name after joining. */
  name: number;
  /** Before trying again while joinly is still closing a meeting UrAnus Browser just left. */
  settle: number;
  speak: number;
  call: number;
  leave: number;
  /** Between looks at a meeting in progress. */
  poll: number;
  /** Between looks at the talk when joinly does not push and voice mode is on / off (three times this). */
  talkFast: number;
  /** Between looks at the talk, as a safety net, when joinly does push. */
  talkSafety: number;
  /** Between looks for joinly while there is no meeting. */
  idle: number;
}

export const DEFAULT_TIMEOUTS: JoinlyTimeouts = { probe: 2_500, connect: 60_000, join: 270_000, slowFailure: 150_000, people: 30_000, emptyLeave: 20_000, emptyRecheck: 8_000, name: 10_000, settle: 6_000, speak: 120_000, call: 30_000, leave: 20_000, poll: 4_000, talkFast: 400, talkSafety: 2_000, idle: 20_000 };

export interface JoinlyOptions {
  /** Diagnostics: names, counts and timings only. */
  log?(...args: unknown[]): void;
  /** For tests. */
  fetch?: typeof fetch;
  timeouts?: Partial<JoinlyTimeouts>;
}

/** How long the talk the panel shows reaches back, in minutes. */
const LOOKBACK_MINUTES = 30;
const FAILURES_BEFORE_LOST = 2;
/** After leaving, joinly needs some seconds to close the bot's browser; a new connection before then is refused. */
const SETTLE_WINDOW_MS = 45_000;
const CONNECT_ATTEMPTS = 3;

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** The connection is open and joinly has built its meeting session for it. */
  ready: boolean;
  /** Set once the bot is in the meeting. */
  joined: boolean;
  closing: boolean;
  /** Rejects if joinly ends the connection before it was ready (its bot is in use by another client). */
  early: Promise<never>;
  /** joinly pushes a notice whenever someone finishes speaking (we subscribed to its live transcript). */
  pushed: boolean;
}

/** joinly dropped the connection while building its meeting session. */
class EarlyEnd extends Error {}

const isTimeout = (err: unknown) => (err as { code?: unknown } | null)?.code === -32001 || /timed out/i.test(err instanceof Error ? err.message : '');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

export class JoinlyClient implements MeetingPort {
  private config: JoinlyConfig = { enabled: false, endpoint: JOINLY_DEFAULT_ENDPOINT };
  private urls?: { mcp: URL; health: URL };
  private v: JoinlyView = emptyView(this.config);
  private listeners = new Set<(view: JoinlyView) => void>();
  private session?: Session;
  private joining?: { abort: AbortController; done: Promise<unknown> };
  private leaving?: Promise<string>;
  private probing?: Promise<JoinlyView>;
  private nextMeeting = 1;
  private failures = 0;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private lastSent = '';
  private lastPeople = 0;
  /** When the participant list first showed only the bot (the meeting has ended for everyone else). */
  private emptySince: number | undefined;
  private lastReleased = 0;
  private language?: string;
  private talkListeners = new Set<(segments: TalkSegment[]) => void>();
  private talkTimer?: ReturnType<typeof setInterval>;
  private talking = false;
  private talkAgain = false;
  /** Voice mode wants the talk fast. */
  private fastTalk = false;
  private readonly t: JoinlyTimeouts;
  private readonly fetcher: typeof fetch;
  private readonly log: (...args: unknown[]) => void;

  constructor(options: JoinlyOptions = {}) {
    this.t = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.fetcher = options.fetch ?? fetch;
    this.log = options.log ?? (() => undefined);
    this.setConfigNow(this.config);
  }

  // ---- what the others see --------------------------------------------------------------------

  view(): JoinlyView {
    return { ...this.v, participants: [...this.v.participants], lines: [...this.v.lines], meeting: this.v.meeting && { ...this.v.meeting }, voice: this.v.voice && { ...this.v.voice, models: [...this.v.voice.models] } };
  }

  /** Called with the view whenever it changes. Returns how to stop. */
  onChange(listener: (view: JoinlyView) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private set(patch: Partial<JoinlyView>) {
    Object.assign(this.v, patch);
    const { checkedAt: _checkedAt, ...rest } = this.v;
    const sent = JSON.stringify(rest);
    if (sent === this.lastSent) return;
    this.lastSent = sent;
    for (const listener of this.listeners) listener(this.view());
  }

  get joined() {
    return !!this.session?.joined;
  }

  /** In a meeting, or joining one: the host must stay up. */
  get active() {
    return !!this.session || !!this.joining;
  }

  // ---- settings --------------------------------------------------------------------------------

  private setConfigNow(config: JoinlyConfig) {
    this.config = config;
    this.language = config.language;
    const checked = checkEndpoint(config.endpoint);
    this.urls = checked.ok ? { mcp: new URL(checked.url), health: new URL(checked.healthUrl) } : undefined;
    this.set({ enabled: config.enabled, endpoint: config.endpoint });
  }

  /**
   * The user's settings. Switching off, or pointing at another address, while in a meeting
   * leaves it first. While enabled, joinly is looked for now and then.
   */
  async configure(raw: JoinlyConfig): Promise<void> {
    const config = cleanConfig(raw);
    if (!config) return;
    // The language applies to the next meeting; changing it never takes the bot out of one.
    this.language = config.language;
    if (config.enabled === this.config.enabled && config.endpoint === this.config.endpoint) return;
    if (this.active) await this.leave().catch(() => undefined);
    this.setConfigNow(config);
    this.stopPolling();
    if (!config.enabled) {
      this.set({ status: 'unavailable', reason: 'disabled', detail: undefined, error: undefined, phase: undefined, meeting: undefined, participants: [], lines: [] });
      return;
    }
    this.startIdlePolling();
    await this.probe();
  }

  // ---- looking for joinly ----------------------------------------------------------------------

  /** One GET of /health: nothing else is started on joinly's side. */
  probe(): Promise<JoinlyView> {
    if (this.active) return Promise.resolve(this.view());
    this.probing ??= this.doProbe().finally(() => (this.probing = undefined));
    return this.probing;
  }

  private async doProbe(): Promise<JoinlyView> {
    const urls = this.urls;
    if (!urls) {
      this.set({ status: 'unavailable', reason: 'bad-endpoint', detail: 'The address isn’t one this computer can have.', checkedAt: Date.now() });
      return this.view();
    }
    const where = `${urls.health.hostname === 'localhost' ? 'localhost' : urls.health.hostname}:${urls.health.port || 80}`;
    try {
      const response = await this.guarded(urls.health, { method: 'GET', signal: AbortSignal.timeout(this.t.probe) });
      const body = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
      if (response.ok && body && typeof body === 'object' && (body.status === 'healthy' || body.status === 'ok')) {
        // A meeting that was lost stays reported (in `error`) until the next action.
        this.set({ status: 'ready', reason: undefined, detail: 'joinly is running and reachable.', checkedAt: Date.now() });
      } else {
        this.set({ status: 'unavailable', reason: 'not-joinly', detail: `Something answers on ${where}, but it doesn’t look like joinly.`, checkedAt: Date.now() });
      }
    } catch {
      this.set({ status: 'unavailable', reason: 'unreachable', detail: `joinly isn’t answering on ${where}. Is Docker Desktop running and the joinly container started? Start it, then check again.`, checkedAt: Date.now() });
    }
    return this.view();
  }

  async refresh(): Promise<JoinlyView> {
    if (!this.config.enabled || this.active) return this.view();
    // A look from the last few seconds is as good as a new one.
    if (Date.now() - this.v.checkedAt < 3_000) return this.view();
    return this.probe();
  }

  private startIdlePolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.tick(), this.t.idle);
    this.pollTimer.unref?.();
  }

  private startMeetingPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.tick(), this.t.poll);
    this.pollTimer.unref?.();
  }

  private stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.stopTalkTimer();
  }

  // ---- the talk, fast ------------------------------------------------------------------------------------

  /** Called with joinly's recent segments (raw, with roles) each time the talk has been looked at. */
  onTalk(listener: (segments: TalkSegment[]) => void) {
    this.talkListeners.add(listener);
    return () => void this.talkListeners.delete(listener);
  }

  /** Voice mode wants the talk as fast as it can be had. */
  setFastTalk(on: boolean) {
    this.fastTalk = on;
    this.restartTalkTimer();
  }

  /** Voice mode's part of the view (the panel shows it). */
  setVoice(voice: VoiceView | undefined) {
    this.set({ voice });
  }

  /**
   * Asks joinly to be told when someone finishes speaking (the same subscription its own client uses).
   * Each notice makes us look at the talk at once; a slow look every few seconds stays as the safety net.
   */
  private subscribeTalk(session: Session) {
    session.client.subscribeResource({ uri: 'transcript://live' }, { timeout: this.t.call }).then(
      () => {
        session.pushed = true;
        this.restartTalkTimer();
      },
      () => {
        session.pushed = false;
        this.restartTalkTimer();
      },
    );
    this.restartTalkTimer();
  }

  /** How often to look when nothing pushes: quickly in voice mode, a little slower otherwise. */
  private talkPeriod(): number | undefined {
    const pushed = !!this.session?.pushed;
    if (this.fastTalk) return pushed ? this.t.talkSafety : this.t.talkFast;
    return pushed ? undefined : this.t.talkFast * 3;
  }

  private restartTalkTimer() {
    this.stopTalkTimer();
    const period = this.session?.joined || this.session?.ready ? this.talkPeriod() : undefined;
    if (!period) return;
    this.talkTimer = setInterval(() => void this.refreshTalk(), period);
    this.talkTimer.unref?.();
  }

  private stopTalkTimer() {
    clearInterval(this.talkTimer);
    this.talkTimer = undefined;
  }

  /** One look at the talk (joinly's own memory, so cheap): the panel's lines, and whoever listens. */
  async refreshTalk(): Promise<void> {
    const session = this.session;
    if (!session?.joined) return;
    if (this.talking) {
      this.talkAgain = true;
      return;
    }
    this.talking = true;
    try {
      const talk = await session.client.callTool({ name: 'get_transcript', arguments: { mode: 'latest', minutes: LOOKBACK_MINUTES } }, undefined, { timeout: this.t.call });
      if (this.session !== session || !session.joined || talk.isError) return;
      const payload = payloadOf(talk);
      this.set({ lines: viewLines(shapeTranscript(payload, 50)) });
      const segments = parseSegments(payload);
      for (const listener of [...this.talkListeners]) {
        try {
          listener(segments);
        } catch {
          // A listener's trouble is its own.
        }
      }
      this.failures = 0;
    } catch {
      // A look that gets no answer counts toward "lost", like any other call.
      this.failure();
    } finally {
      this.talking = false;
      if (this.talkAgain) {
        this.talkAgain = false;
        void this.refreshTalk();
      }
    }
  }

  /**
   * Speaks without a card per utterance. Only voice mode calls this, and only after the person
   * switched voice mode on in the sheet (with its confirmation); the model has no way to reach it.
   */
  speakAloud(text: string): Promise<string> {
    return this.say(text, { approved: true });
  }

  private async tick() {
    if (!this.config.enabled) return;
    if (this.session?.joined) return this.watch();
    if (!this.active) await this.probe();
  }

  // ---- the connection to joinly -------------------------------------------------------------------

  /** Every request this client makes: loopback only, and no redirects. */
  private guarded: typeof fetch = async (input, init) => {
    const address = input instanceof URL ? input : new URL(typeof input === 'string' ? input : (input as Request).url);
    if (!isLoopbackUrl(address)) throw new JoinlyError('Only this computer is allowed.');
    const response = await this.fetcher(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new JoinlyError('joinly answered with a redirect, which UrAnus Browser doesn’t follow.');
    }
    return response;
  };

  private open(): Session {
    const client = new Client({ name: 'anus', version: '0.1.0' }, { capabilities: {} });
    // joinly takes its settings per connection in this header; the only one sent is the spoken language
    // (its speech recognition assumes English otherwise).
    const requestInit = this.language ? { headers: { 'joinly-settings': JSON.stringify({ language: this.language }) } } : undefined;
    const transport = new StreamableHTTPClientTransport(this.urls!.mcp, { fetch: this.guarded, requestInit, redirectPolicy: 'same-origin', reconnectionOptions: { initialReconnectionDelay: 500, maxReconnectionDelay: 2_000, reconnectionDelayGrowFactor: 1.5, maxRetries: 1 } });
    let failEarly: (err: Error) => void = () => undefined;
    const early = new Promise<never>((_, reject) => (failEarly = reject));
    early.catch(() => undefined);
    const session: Session = { client, transport, ready: false, joined: false, closing: false, early, pushed: false };
    client.onclose = () => {
      if (!session.closing && this.session === session) this.lost('closed');
    };
    // joinly says "the transcript changed" (a person finished a sentence) with no content; then we look.
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => {
      if (this.session === session && session.joined) void this.refreshTalk();
    });
    client.onerror = (err) => {
      this.log('joinly: connection error', err instanceof Error ? err.name : typeof err);
      // joinly answers the opening request with a stream that just ends when it can't build the session.
      if (!session.ready && err instanceof Error && /SSE stream disconnected/i.test(err.message)) failEarly(new EarlyEnd('joinly ended the connection'));
    };
    return session;
  }

  /** Ends a connection: joinly ends the meeting when its connection ends. Never throws. */
  private async drop(session: Session) {
    if (session.ready) this.lastReleased = Date.now();
    session.closing = true;
    session.joined = false;
    if (this.session === session) this.session = undefined;
    await Promise.race([
      (async () => {
        await session.transport.terminateSession().catch(() => undefined);
        await session.client.close().catch(() => undefined);
      })(),
      sleep(3_000),
    ]);
  }

  // ---- joining and leaving ---------------------------------------------------------------------------

  async join(request: { meetingUrl: string; botName: string }, approval: { approved: boolean }): Promise<string> {
    if (approval?.approved !== true) throw new JoinlyError('Joining needs the user’s approval first.');
    if (!this.config.enabled) throw new JoinlyError('Meetings are switched off in UrAnus Browser.');
    const url = checkMeetingUrl(request.meetingUrl);
    if (!url.ok) throw new JoinlyError(url.reason);
    const name = checkBotName(request.botName);
    if (!name.ok) throw new JoinlyError(name.reason);
    if (this.active) throw new JoinlyError('Already in a meeting, or joining one. Leave first.');
    if (!this.urls) throw new JoinlyError('joinly’s address isn’t usable.');

    const abort = new AbortController();
    const session = this.open();
    this.session = session;
    const done = this.doJoin(session, abort.signal, url, name.name);
    this.joining = { abort, done };
    this.set({ phase: 'joining', error: undefined, detail: 'Connecting to joinly…', participants: [], lines: [], meeting: undefined });
    try {
      return await done;
    } finally {
      this.joining = undefined;
      // A failed join leaves no connection: see how joinly is doing.
      if (!this.session) void this.probe();
    }
  }

  private async doJoin(first: Session, signal: AbortSignal, url: Extract<ReturnType<typeof checkMeetingUrl>, { ok: true }>, botName: string): Promise<string> {
    const started = Date.now();
    let session = first;
    let stage: 'connect' | 'tools' | 'join' = 'connect';
    try {
      // Opening the connection makes joinly build its meeting session (models, audio, browser). If it
      // refuses (its bot is in use), it just ends the stream. Right after a meeting UrAnus Browser left, the
      // old session is still closing: wait a little and try again.
      for (let attempt = 1; ; attempt++) {
        try {
          const connecting = session.client.connect(session.transport, { signal, timeout: this.t.connect });
          connecting.catch(() => undefined);
          await Promise.race([connecting, session.early]);
          session.ready = true;
          break;
        } catch (err) {
          const settling = Date.now() - this.lastReleased < SETTLE_WINDOW_MS;
          if (!(err instanceof EarlyEnd) || !settling || attempt >= CONNECT_ATTEMPTS || signal.aborted) throw err;
          this.log(`joinly: connection refused while the last meeting closes (attempt ${attempt})`);
          this.set({ detail: 'Waiting for the last meeting to finish closing…' });
          await this.drop(session);
          await sleep(this.t.settle);
          if (signal.aborted) throw new JoinlyError('Cancelled.');
          session = this.open();
          this.session = session;
        }
      }
      stage = 'tools';
      const tools = (await session.client.listTools(undefined, { signal, timeout: this.t.call })).tools.map((tool) => tool.name);
      const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
      if (missing.length) throw new JoinlyError('That server doesn’t offer the tools joinly does, so it isn’t joinly.');
      stage = 'join';
      this.set({ detail: 'Waiting to be let in… (joinly waits up to 3 minutes for the host)' });
      const joinStarted = Date.now();
      const result = await session.client.callTool({ name: 'join_meeting', arguments: { meeting_url: url.url, participant_name: botName } }, undefined, { signal, timeout: this.t.join });
      if (result.isError) throw new JoinlyError(explainJoinFailure({ kind: 'tool', text: textOf(result), elapsedMs: Date.now() - joinStarted, slowAfterMs: this.t.slowFailure, platform: url.platform }));
      if (signal.aborted) throw new JoinlyError('Cancelled.');
      session.joined = true;
      const id = this.nextMeeting++;
      this.failures = 0;
      this.lastPeople = 0;
      this.emptySince = undefined;
      this.set({ phase: undefined, status: 'joined', reason: undefined, detail: undefined, meeting: { id, host: url.host, botName, since: Date.now() } });
      this.startMeetingPolling();
      this.log(`joinly: joined in ${Date.now() - started}ms`);
      const shown = await this.learnName(session, botName);
      this.subscribeTalk(session);
      void this.watch();
      return this.joinedSentence(url.host, botName, shown);
    } catch (err) {
      const message = await this.explainFailure(err, stage, signal, url.url);
      await this.drop(session);
      this.stopPolling();
      if (this.config.enabled) this.startIdlePolling();
      this.log(`joinly: join failed after ${Date.now() - started}ms`);
      this.set({ phase: undefined, meeting: undefined, detail: undefined, error: message });
      throw new JoinlyError(message);
    }
  }

  /** What the person is told when a join (or the connection it needs) fails. */
  private async explainFailure(err: unknown, stage: 'connect' | 'tools' | 'join', signal: AbortSignal, link: string): Promise<string> {
    if (signal.aborted) return 'Cancelled before the bot was let in.';
    if (err instanceof JoinlyError) return err.message;
    if (err instanceof EarlyEnd) return explainJoinFailure({ kind: (await this.alive()) ? 'busy' : 'unreachable' });
    if (isTimeout(err)) {
      return stage === 'join' ? explainJoinFailure({ kind: 'timeout', seconds: Math.round(this.t.join / 1000) }) : explainJoinFailure({ kind: 'start-timeout', seconds: Math.round(this.t.connect / 1000) });
    }
    if (!(await this.alive())) return explainJoinFailure({ kind: 'unreachable' });
    return scrubError(stripToolPrefix(err instanceof Error ? err.message : ''), [link]);
  }

  private alive(): Promise<boolean> {
    return this.guarded(this.urls!.health, { method: 'GET', signal: AbortSignal.timeout(this.t.probe) }).then((r) => r.ok, () => false);
  }

  /**
   * joinly's browser may be signed in to Google, and then the meeting shows that account's
   * name, not the one UrAnus Browser asked for. Its participant list marks the bot's own entry:
   * ask once, so the cards and the panel say what other people really see.
   */
  private async learnName(session: Session, asked: string): Promise<string | undefined> {
    try {
      const result = await session.client.callTool({ name: 'get_participants', arguments: {} }, undefined, { timeout: this.t.name });
      if (result.isError || this.session !== session || !session.joined) return undefined;
      const payload = payloadOf(result);
      this.lastPeople = Date.now();
      const patch: Partial<JoinlyView> = { participants: shapeParticipants(payload) };
      const own = botDisplayName(payload);
      if (own && own !== asked && this.v.meeting) patch.meeting = { ...this.v.meeting, botName: own };
      this.set(patch);
      return own;
    } catch {
      return undefined;
    }
  }

  private joinedSentence(host: string, asked: string, shown: string | undefined): string {
    const name = shown ?? asked;
    const base = `Joined the meeting on ${host} as “${name}”.`;
    const silent = 'The bot does not announce itself: if the user wants the others told who it is, say so aloud or in the chat (they approve it first).';
    if (shown && shown !== asked) return `${base} That is the name other people see: joinly’s browser is signed in to a Google account, so the meeting uses that account’s name instead of “${asked}”. ${silent}`;
    return `${base} ${silent}`;
  }

  leave(): Promise<string> {
    this.leaving ??= this.doLeave().finally(() => (this.leaving = undefined));
    return this.leaving;
  }

  private async doLeave(): Promise<string> {
    const joining = this.joining;
    if (joining && !this.session?.joined) {
      joining.abort.abort();
      await joining.done.catch(() => undefined);
      return 'Cancelled joining the meeting.';
    }
    const session = this.session;
    if (!session) return 'Not in a meeting.';
    this.set({ phase: 'leaving', error: undefined });
    this.emptySince = undefined;
    this.stopPolling();
    try {
      await session.client.callTool({ name: 'leave_meeting', arguments: {} }, undefined, { timeout: this.t.leave });
    } catch {
      // Closing the connection ends the meeting on joinly's side anyway.
    }
    await this.drop(session);
    this.set({ phase: undefined, status: 'ready', meeting: undefined, participants: [], lines: [] });
    if (this.config.enabled) this.startIdlePolling();
    await this.probe();
    this.log('joinly: left');
    return 'Left the meeting.';
  }

  /** The host is going away: leave, bounded. */
  async shutdown() {
    this.stopPolling();
    if (this.active) await Promise.race([this.leave().catch(() => undefined), sleep(8_000)]);
    if (this.session) await this.drop(this.session);
  }

  // ---- in the meeting -------------------------------------------------------------------------------

  private requireJoined(): Session {
    if (!this.session?.joined) throw new JoinlyError('Not in a meeting.');
    return this.session;
  }

  /** A tool call on joinly; its failure to answer (as opposed to an error it reports) counts toward "lost". */
  private async call(name: string, args: Record<string, unknown>, timeout: number, secrets: string[] = []): Promise<{ text: string; payload: unknown }> {
    const session = this.requireJoined();
    let result;
    try {
      result = await session.client.callTool({ name, arguments: args }, undefined, { timeout });
    } catch (err) {
      this.failure();
      throw new JoinlyError(`joinly didn’t answer (${scrubError(err, secrets)}).`);
    }
    this.failures = 0;
    if (result.isError) throw new JoinlyError(explainToolFailure(textOf(result), secrets));
    return { text: textOf(result), payload: payloadOf(result) };
  }

  async say(text: string, approval: { approved: boolean }): Promise<string> {
    if (approval?.approved !== true) throw new JoinlyError('Speaking needs the user’s approval first.');
    const started = Date.now();
    const { text: reply } = await this.call('speak_text', { text }, this.t.speak);
    this.log(`joinly: spoke in ${Date.now() - started}ms`);
    // joinly says what it did: "Finished speaking.", or (as a normal answer, not an error) that
    // someone started talking and how far the bot got.
    const plain = stripToolPrefix(reply);
    if (/^interrupted/i.test(plain)) return `Interrupted: someone started talking before the bot finished. ${scrubError(plain)} Do not say it again unless the user asks.`;
    return scrubError(plain || 'Finished speaking.');
  }

  async chat(text: string, approval: { approved: boolean }): Promise<string> {
    if (approval?.approved !== true) throw new JoinlyError('Posting needs the user’s approval first.');
    await this.call('send_chat_message', { message: text }, this.t.call);
    this.log('joinly: posted');
    return 'Posted in the meeting chat.';
  }

  async transcript(last: number): Promise<Shaped> {
    const { payload } = await this.call('get_transcript', { mode: 'latest', minutes: LOOKBACK_MINUTES }, this.t.call);
    const shaped = shapeTranscript(payload, last);
    this.set({ lines: viewLines(shaped) });
    return shaped;
  }

  async participants(): Promise<string[]> {
    const { payload } = await this.call('get_participants', {}, this.t.call);
    const names = shapeParticipants(payload);
    this.lastPeople = Date.now();
    this.set({ participants: names });
    return names;
  }

  // ---- keeping watch on a meeting -------------------------------------------------------------------

  /** Is joinly still there, and what has been said: for the panel's live view. */
  private async watch() {
    if (this.refreshing) return;
    const session = this.session;
    if (!session?.joined) return;
    this.refreshing = true;
    try {
      const alive = await this.guarded(this.urls!.health, { method: 'GET', signal: AbortSignal.timeout(this.t.probe) }).then((r) => r.ok, () => false);
      if (!alive) return this.failure();
      // The talk is joinly's own memory: cheap. The participant list is read off Meet's People
      // panel by driving the bot's browser (and its camera shows a "reading" animation), so it
      // is looked at only now and then.
      const wantPeople = Date.now() - this.lastPeople >= this.t.people;
      if (wantPeople) this.lastPeople = Date.now();
      const [talk, people] = await Promise.all([
        session.client.callTool({ name: 'get_transcript', arguments: { mode: 'latest', minutes: LOOKBACK_MINUTES } }, undefined, { timeout: this.t.call }),
        wantPeople ? session.client.callTool({ name: 'get_participants', arguments: {} }, undefined, { timeout: this.t.call }) : Promise.resolve(undefined),
      ]);
      if (this.session !== session || !session.joined) return;
      this.failures = 0;
      const patch: Partial<JoinlyView> = {};
      if (!talk.isError) patch.lines = viewLines(shapeTranscript(payloadOf(talk), 50));
      if (people && !people.isError) patch.participants = shapeParticipants(payloadOf(people));
      this.set(patch);
      if (patch.participants) this.checkEmpty(patch.participants);
    } catch {
      this.failure();
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Everyone else has left (the person closed the call): the bot would sit there alone. The list
   * must show only the bot, twice, a few seconds apart, so one odd reading of Meet's People panel
   * never sends it away; an empty list (nothing read) never counts.
   */
  private checkEmpty(names: readonly string[]) {
    const alone = names.length > 0 && names.every((n) => n.endsWith(BOT_MARK));
    if (!alone) {
      this.emptySince = undefined;
      return;
    }
    const now = Date.now();
    this.emptySince ??= now;
    if (now - this.emptySince < this.t.emptyLeave) {
      // Look again soon, not in half a minute.
      this.lastPeople = now - (this.t.people - this.t.emptyRecheck);
      return;
    }
    this.emptySince = undefined;
    this.log('joinly: the meeting is empty, leaving');
    void this.leave().then(() => this.set({ detail: 'The meeting ended, so the bot left on its own.' }));
  }

  private failure() {
    if (++this.failures >= FAILURES_BEFORE_LOST) this.lost('unanswered');
  }

  /** joinly went away during a meeting. Say so; the bot may still be in the room. */
  private lost(how: string) {
    const session = this.session;
    if (!session || session.closing) return;
    this.log(`joinly: lost the connection (${how})`);
    void this.drop(session);
    this.stopPolling();
    this.failures = 0;
    this.set({
      status: 'unavailable',
      reason: 'lost',
      phase: undefined,
      meeting: undefined,
      participants: [],
      lines: [],
      detail: 'joinly stopped answering.',
      error: 'Lost the connection to joinly during the meeting. The bot may still be in it: check joinly (./scripts/playground.sh status; is Docker Desktop still running?) and remove it there if so.',
    });
    if (this.config.enabled) this.startIdlePolling();
  }
}

// ---- reading joinly's answers ---------------------------------------------------------------------

type ToolResult = { content?: unknown; structuredContent?: unknown; isError?: boolean };

function textOf(raw: unknown): string {
  const result = raw as ToolResult;
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** A tool's data: its structured content, or the JSON in its text. */
function payloadOf(raw: unknown): unknown {
  const result = raw as ToolResult;
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(textOf(raw));
  } catch {
    return undefined;
  }
}
