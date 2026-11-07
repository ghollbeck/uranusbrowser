/**
 * A ChatGPT account as one of the registry's providers, through the official Codex app-server
 * (`codex app-server`, JSON-RPC over stdio). Codex owns the whole sign-in: the OAuth flow, the
 * tokens and their refresh. UrAnus Browser never sees or stores a ChatGPT token; it only asks Codex who
 * is signed in, which models the plan offers, and for answers.
 *
 * Locked down to a chat brain with UrAnus Browser's tools only:
 *  - its own CODEX_HOME under UrAnus Browser's app data, so the user's own Codex setup (MCP servers,
 *    skills, AGENTS.md, plugins, another sign-in) never comes in, and signing out here doesn't
 *    sign the Codex CLI out; Codex's bundled skills are off too;
 *  - every thread ephemeral, in an empty folder, sandbox read-only, approvals never, and the
 *    shell, apps, plugins, web search, browser and computer tools switched off;
 *  - the browser tools go in as dynamic tools: Codex asks UrAnus Browser to run them (item/tool/call)
 *    and the chat loop (agentChat.ts) checks each one against the same approval rules as any
 *    other provider's, before the shell may run it.
 *
 * A ChatGPT plan has no audio transcription endpoint, so this provider can't transcribe.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ProviderInfo, ReasoningEffort } from '../../shared/browserAgent';
import type { AiFeature, AiLimitWindow, AiModel, AiProviderView } from '../../shared/aiProtocol';
import { ProviderError, type ChatProvider, type Conversation, type RespondRequest, type ToolCall, type ToolSpec, type Turn } from '../agentProvider';
import { scrub } from '../secrets';
import type { AiProvider, CompleteRequest } from './types';

/** Used until model/list has answered. Codex swaps an unknown model for the plan's default. */
const FALLBACK_MODEL = 'gpt-5.5';
const REQUEST_TIMEOUT_MS = 30_000;
/** A turn that says nothing for this long is given up on (no network, a stuck server). */
const SILENCE_MS = 150_000;
const LIMITS_TTL_MS = 60_000;

/**
 * Codex features a browser agent has no use for; with them off, the model sees only UrAnus Browser's tools.
 *
 * `code_mode_host` stays ON: the plan's current models are `tool_mode: "code_mode_only"` in
 * Codex's catalog, so they reach every tool, UrAnus Browser's dynamic tools included, through `exec`
 * code. With the host off they can't call a tool at all. The code runs in a bare JS isolate
 * (checked live on 0.164: no fetch, filesystem, process, require or sockets; only the tools),
 * and each tool call it makes still comes to UrAnus Browser as item/tool/call, so it passes the same
 * approval gate. What else it can see fails closed: apply_patch (read-only sandbox, approvals
 * never), spawn_agent (ephemeral threads have no rollout; a helper's tool calls would arrive for
 * a thread UrAnus Browser doesn't know and are refused), request_user_input (refused below).
 */
const DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'plugins',
  'remote_plugin',
  'multi_agent',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'view_image',
  'skill_search',
  'tool_suggest',
  'sleep_tool',
  'goals',
  'hooks',
  'workspace_dependencies',
  'memories',
  'multi_agent_v2',
];

const CONFIG = [
  // Keychain when there is one; Codex's own choice of file otherwise (in UrAnus Browser's CODEX_HOME).
  'cli_auth_credentials_store="auto"',
  'web_search="disabled"',
  'history.persistence="none"',
  'project_doc_max_bytes=0',
  // Codex's own bundled skills (imagegen, openai-docs, skill-creator, skill-installer,
  // review-agent) are off: their tools are switched off above, so the model would offer what it
  // can't do ("I can generate images"), and UrAnus Browser's companions bring their own skills.
  // Checked on 0.164: with this, skills/list is empty even where .system skills are on disk.
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
];

export interface CodexLaunch {
  command: string;
  args: string[];
}

/**
 * Where the Codex CLI is. The npm package's `codex` is a Node script that starts a native
 * binary, so the binary inside the package is used directly when it is there (UrAnus Browser's host
 * may not have a `node` on its PATH); otherwise the script runs under this host's own Node.
 */
export function findCodex(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): CodexLaunch | undefined {
  const explicit = env.ANUS_CODEX_BIN?.trim();
  if (explicit) return exists(explicit) ? launchFor(explicit) : undefined;
  const home = env.HOME || os.homedir();
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.npm-global/bin')];
  const candidates = ['/Applications/Codex.app/Contents/Resources/codex', ...dirs.map((d) => path.join(d, 'codex'))];
  for (const file of candidates) if (exists(file)) return launchFor(file);
  return undefined;
}

function launchFor(file: string): CodexLaunch {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    // A file we were told about: use it as it is.
  }
  let head = '';
  try {
    const fd = fs.openSync(real, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8');
  } catch {
    return { command: real, args: [] };
  }
  if (!head.startsWith('#!') || !/node/.test(head.split('\n')[0])) return { command: real, args: [] };
  // npm's codex.js: look for the platform package's native binary next to it.
  const pkg = path.resolve(path.dirname(real), '..');
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64-apple-darwin'] : ['x64', 'x86_64-apple-darwin'];
  for (const native of [
    path.join(pkg, 'node_modules/@openai', `codex-darwin-${arch[0]}`, 'vendor', arch[1], 'bin/codex'),
    path.join(pkg, 'node_modules/@openai', `codex-darwin-${arch[0]}`, 'vendor', arch[1], 'codex/codex'),
    path.join(pkg, 'vendor', arch[1], 'codex/codex'),
    path.join(pkg, 'vendor', arch[1], 'bin/codex'),
  ]) {
    if (fs.existsSync(native)) return { command: native, args: [] };
  }
  return { command: process.execPath, args: [real] };
}

// ---- the JSON-RPC connection --------------------------------------------------------------------

type Json = Record<string, any>;

interface Pending {
  resolve(value: Json): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One `codex app-server` child and the JSON-RPC lines it speaks. */
class AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private gone?: Error;
  ready: Promise<Json>;

  constructor(
    launch: CodexLaunch,
    env: NodeJS.ProcessEnv,
    cwd: string,
    private onNotification: (method: string, params: Json) => void,
    private onRequest: (id: number | string, method: string, params: Json) => void,
    private onExit: (err: Error) => void,
    spawnImpl: typeof spawn,
    log: (...args: unknown[]) => void,
    version: string,
  ) {
    const args = [...launch.args, 'app-server', ...CONFIG.flatMap((c) => ['-c', c]), ...DISABLED_FEATURES.flatMap((f) => ['--disable', f])];
    const child = spawnImpl(launch.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child = child;
    // Codex logs to stderr; it may name files or URLs, so only that it said something is noted.
    let stderrLines = 0;
    child.stderr.on('data', () => {
      if (stderrLines++ < 3) log('codex: (stderr output not shown)');
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    child.on('error', (err) => this.die(new ProviderError(`Couldn’t start Codex: ${scrub(err.message).slice(0, 120)}`, 'codex')));
    child.on('exit', (code, signal) => this.die(new ProviderError(`Codex stopped (${signal ?? `exit ${code}`}). Try again.`, 'codex')));
    child.stdin.on('error', () => undefined);
    this.ready = this.request('initialize', {
      clientInfo: { name: 'anus', title: 'UrAnus Browser', version },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'thread/tokenUsage/updated', 'remoteControl/status/changed'],
      },
    }).then((result) => {
      this.write({ method: 'initialized' });
      return result;
    });
    this.ready.catch(() => undefined);
  }

  get alive() {
    return !this.gone;
  }

  private write(message: Json) {
    if (this.gone || !this.child) throw this.gone ?? new ProviderError('Codex isn’t running.', 'codex');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: Json = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError('Codex didn’t answer in time. Try again.', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  respond(id: number | string, result: Json) {
    try {
      this.write({ id, result });
    } catch {
      // Gone: the turn fails on its own.
    }
  }

  respondError(id: number | string, message: string) {
    try {
      this.write({ id, error: { code: -32601, message } });
    } catch {
      // Gone.
    }
  }

  private receive(line: string) {
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) return this.onRequest(message.id, String(message.method), message.params ?? {});
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new ProviderError(cleanError(message.error.message), 'codex'));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.onNotification(String(message.method), message.params ?? {});
  }

  private die(err: Error) {
    if (this.gone) return;
    this.gone = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.onExit(err);
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.die(new ProviderError('Codex was stopped.', 'codex'));
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000).unref();
  }
}

/** A message from Codex, safe to show: no tokens, no keys, short. */
export function cleanError(text: unknown): string {
  return scrub(String(text ?? 'Codex reported an error.'))
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]')
    .replace(/(bearer|token|authorization)[=:\s]+\S+/gi, '$1 [redacted]')
    .replace(/,?\s*(cf-ray|request id):\s*\S+/gi, '')
    .slice(0, 240);
}

/** What a failed turn tells the user, by Codex's error code. */
function turnError(error: Json | undefined): ProviderError {
  const info = error?.codexErrorInfo;
  const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  switch (code) {
    case 'usageLimitExceeded':
    case 'rateLimitExceeded':
      return new ProviderError('Your ChatGPT plan’s usage limit is reached for now. Settings › AI shows when it resets; an OpenAI API key works meanwhile.', 'quota');
    case 'unauthorized':
      return new ProviderError('ChatGPT signed you out. Sign in again in Settings › AI.', 'auth');
    case 'contextWindowExceeded':
      return new ProviderError('This conversation is too long for the model. Start a new one.', 'http');
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return new ProviderError('Couldn’t reach ChatGPT. Check the connection and try again.', 'network');
    case 'serverOverloaded':
    case 'internalServerError':
      return new ProviderError('ChatGPT is having trouble right now. Try again in a moment.', 'http');
    default:
      return new ProviderError(`ChatGPT said: ${cleanError(error?.message)}`, 'http');
  }
}

// ---- conversations ------------------------------------------------------------------------------

/** What happens in a turn, in order, for whoever is waiting on it. */
type TurnEvent =
  | { kind: 'text'; itemId: string; text: string; final: boolean }
  | { kind: 'call'; rpcId: number | string; call: ToolCall }
  | { kind: 'done'; status: string; error?: Json };

class LiveTurn {
  events: TurnEvent[] = [];
  private wake?: () => void;
  id?: string;

  push(event: TurnEvent) {
    this.events.push(event);
    this.wake?.();
  }

  /** The next event, or undefined if `ms` pass without one. */
  next(ms: number, signal: AbortSignal): Promise<TurnEvent | undefined> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.wake = undefined;
        resolve(this.events.shift());
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      this.wake = done;
    });
  }
}

class CodexConversation implements Conversation {
  threadId?: string;
  /** The instructions and tools the thread was started with; a change needs a new thread. */
  signature?: string;
  model?: string;
  pendingUser: string[] = [];
  /** Tool calls Codex is waiting on, by call id, with their JSON-RPC request id. */
  waiting = new Map<string, number | string>();
  outputs = new Map<string, string>();
  /** The words so far, to brief a new thread if the instructions change mid-conversation. */
  history: Array<{ who: 'User' | 'Assistant'; text: string }> = [];
  turn?: LiveTurn;
  /** An interrupted turn winding down. */
  closing?: Promise<void>;

  addUser(text: string) {
    this.pendingUser.push(text);
    this.history.push({ who: 'User', text });
  }

  addToolResult(callId: string, output: string) {
    this.outputs.set(callId, output);
  }
}

/** The chat on a ChatGPT account, with one model. */
class CodexChat implements ChatProvider {
  readonly id = 'codex';

  constructor(
    private codex: CodexProvider,
    readonly model: string,
  ) {}

  async info(): Promise<ProviderInfo> {
    const status = await this.codex.status();
    return {
      id: this.id,
      label: 'ChatGPT',
      ready: status.ready,
      model: this.model,
      detail: status.ready ? (status.account?.email ? `Signed in as ${status.account.email}` : 'Signed in to ChatGPT') : status.detail,
    };
  }

  newConversation(): Conversation {
    return new CodexConversation();
  }

  respond(conversation: Conversation, request: RespondRequest): Promise<Turn> {
    return this.codex.respond(conversation as CodexConversation, this.model, request);
  }
}

// ---- the provider -------------------------------------------------------------------------------

export interface CodexOptions {
  /** UrAnus Browser's own Codex home: its sign-in and nothing else. */
  home: string;
  /** The empty folder every thread works in. */
  workspace: string;
  /** How to start Codex; found on disk when left out. */
  launch?: CodexLaunch | (() => CodexLaunch | undefined);
  spawnImpl?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  /** Added to Codex's (otherwise allow-listed) environment: tests' fake server settings. */
  extraEnv?: Record<string, string>;
  log?: (...args: unknown[]) => void;
  /** A sign-in finished, or the account changed. */
  onChange?: (event: { signedIn: boolean; error?: string }) => void;
  version?: string;
  silenceMs?: number;
}

export class CodexProvider implements AiProvider {
  readonly id = 'codex' as const;
  readonly label = 'ChatGPT';
  readonly capabilities = { chat: true, text: true, transcribe: false };
  private server?: AppServer;
  private turns = new Map<string, LiveTurn>();
  /** Turns that were interrupted; whatever they still say is ignored. */
  private ended = new Set<string>();
  private modelsCache?: { models: AiModel[]; fallback: string };
  private limits?: { at: number; value: AiProviderView['limits'] };
  private login?: { id: string; error?: string };
  private lastLoginError?: string;
  private log: (...args: unknown[]) => void;

  constructor(private options: CodexOptions) {
    this.log = options.log ?? (() => {});
  }

  private findLaunch(): CodexLaunch | undefined {
    const l = this.options.launch;
    if (typeof l === 'function') return l();
    return l ?? findCodex(this.options.env);
  }

  /** Starts `codex app-server` if it isn't running. */
  private async connect(): Promise<AppServer> {
    if (this.server?.alive) {
      await this.server.ready;
      return this.server;
    }
    const launch = this.findLaunch();
    if (!launch) throw new ProviderError('Codex isn’t installed, so UrAnus Browser can’t sign in with ChatGPT.', 'codex');
    fs.mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.options.workspace, { recursive: true, mode: 0o700 });
    const base = this.options.env ?? process.env;
    // A small environment: no API keys, Codex's own home.
    const env: NodeJS.ProcessEnv = { CODEX_HOME: this.options.home, HOME: base.HOME ?? os.homedir(), PATH: base.PATH ?? '/usr/bin:/bin', LANG: base.LANG ?? 'en_US.UTF-8', TMPDIR: base.TMPDIR, USER: base.USER };
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE']) if (base[name]) env[name] = base[name];
    Object.assign(env, this.options.extraEnv);
    const server = new AppServer(
      launch,
      env,
      this.options.workspace,
      (method, params) => this.notification(method, params),
      (id, method, params) => this.serverRequest(id, method, params),
      (err) => this.exited(server, err),
      this.options.spawnImpl ?? spawn,
      this.log,
      this.options.version ?? '0.1',
    );
    this.server = server;
    this.log('codex: app-server started');
    await server.ready;
    return server;
  }

  private exited(server: AppServer, err: Error) {
    if (this.server !== server) return;
    this.server = undefined;
    this.log('codex: app-server stopped');
    // Anyone waiting on a turn hears about it at once rather than at the silence timeout.
    for (const turn of this.turns.values()) turn.push({ kind: 'done', status: 'failed', error: { message: err.message } });
    this.turns.clear();
    if (this.login) {
      this.login = undefined;
      this.options.onChange?.({ signedIn: false });
    }
  }

  private notification(method: string, params: Json) {
    switch (method) {
      case 'account/login/completed': {
        if (this.login && params.loginId && params.loginId !== this.login.id) return;
        this.login = undefined;
        this.modelsCache = undefined;
        this.limits = undefined;
        this.lastLoginError = params.success ? undefined : params.error ? cleanError(params.error) : 'The sign-in didn’t finish.';
        this.log(`codex: sign-in ${params.success ? 'finished' : 'failed'}`);
        this.options.onChange?.({ signedIn: !!params.success, error: this.lastLoginError });
        return;
      }
      case 'account/updated':
        this.modelsCache = undefined;
        this.limits = undefined;
        this.options.onChange?.({ signedIn: true });
        return;
      case 'account/rateLimits/updated':
        if (params.rateLimits) this.limits = { at: Date.now(), value: limitsFrom(params.rateLimits) };
        return;
    }
    const turn = typeof params.threadId === 'string' ? this.turns.get(params.threadId) : undefined;
    if (!turn) return;
    // Only this turn's events: not the late ones of a turn that was interrupted.
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId && (this.ended.has(turnId) || (turn.id && turnId !== turn.id))) return;
    switch (method) {
      case 'item/agentMessage/delta':
        turn.push({ kind: 'text', itemId: String(params.itemId), text: String(params.delta ?? ''), final: false });
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage') turn.push({ kind: 'text', itemId: String(params.item.id), text: String(params.item.text ?? ''), final: true });
        break;
      case 'error':
        // A retry is on its way; the turn's own end says whether it worked.
        if (!params.willRetry) this.log('codex: turn error');
        break;
      case 'turn/completed':
        turn.push({ kind: 'done', status: String(params.turn?.status ?? 'completed'), error: params.turn?.error ?? undefined });
        break;
    }
  }

  private serverRequest(id: number | string, method: string, params: Json) {
    const server = this.server;
    if (!server) return;
    if (method === 'item/tool/call') {
      const turn = this.ended.has(String(params.turnId)) ? undefined : this.turns.get(String(params.threadId));
      if (!turn) return server.respond(id, { contentItems: [{ type: 'inputText', text: 'Error: no conversation is waiting for this tool.' }], success: false });
      const args = params.arguments;
      turn.push({ kind: 'call', rpcId: id, call: { callId: String(params.callId), name: String(params.tool), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } });
      return;
    }
    // Locked down: Codex has no shell or files here, so anything it asks to run is declined.
    this.log(`codex: declined ${method}`);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return server.respond(id, { decision: 'decline' });
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') return server.respond(id, { decision: 'denied' });
    server.respondError(id, 'UrAnus Browser doesn’t support this request.');
  }

  // ---- account ----------------------------------------------------------------------------------

  async status(): Promise<AiProviderView> {
    const base = { id: this.id, label: this.label, capabilities: this.capabilities };
    if (!this.findLaunch()) {
      return { ...base, ready: false, installed: false, detail: 'Signing in with ChatGPT needs the Codex app or CLI on this Mac. Install it, then come back here.' };
    }
    let account: Json | null | undefined;
    try {
      const server = await this.connect();
      account = (await server.request('account/read', {})).account;
    } catch (err) {
      return { ...base, ready: false, installed: true, loginPending: !!this.login, detail: err instanceof ProviderError ? err.message : 'Couldn’t talk to Codex.' };
    }
    if (account?.type !== 'chatgpt') {
      const detail = this.login
        ? 'Waiting for you to finish signing in on the ChatGPT page.'
        : this.lastLoginError
          ? `The last sign-in didn’t work: ${this.lastLoginError}`
          : 'Not signed in. Your ChatGPT plan covers chat, routines and meeting notes.';
      return { ...base, ready: false, installed: true, loginPending: !!this.login, detail };
    }
    return {
      ...base,
      ready: true,
      installed: true,
      account: { email: typeof account.email === 'string' ? account.email : undefined, plan: typeof account.planType === 'string' && account.planType !== 'unknown' ? account.planType : undefined },
      limits: await this.readLimits(),
      detail: 'Signed in. Uses your ChatGPT plan’s limits; Codex keeps the sign-in.',
    };
  }

  private async readLimits(): Promise<AiProviderView['limits']> {
    if (this.limits && Date.now() - this.limits.at < LIMITS_TTL_MS) return this.limits.value;
    try {
      const server = await this.connect();
      const reply = await server.request('account/rateLimits/read', {}, 10_000);
      this.limits = { at: Date.now(), value: limitsFrom(reply.rateLimits) };
      return this.limits.value;
    } catch {
      return undefined;
    }
  }

  /** Starts a ChatGPT sign-in; returns the page the user signs in on. */
  async startLogin(): Promise<string> {
    const server = await this.connect();
    if (this.login) await server.request('account/login/cancel', { loginId: this.login.id }).catch(() => undefined);
    const reply = await server.request('account/login/start', { type: 'chatgpt' });
    if (reply.type !== 'chatgpt' || typeof reply.authUrl !== 'string' || !/^https:\/\//.test(reply.authUrl)) throw new ProviderError('Codex didn’t offer a ChatGPT sign-in.', 'codex');
    this.login = { id: String(reply.loginId) };
    this.lastLoginError = undefined;
    this.log('codex: sign-in started');
    return reply.authUrl;
  }

  async cancelLogin() {
    if (!this.login || !this.server) return;
    const id = this.login.id;
    this.login = undefined;
    await this.server.request('account/login/cancel', { loginId: id }).catch(() => undefined);
  }

  async logout() {
    const server = await this.connect();
    await server.request('account/logout', {});
    this.modelsCache = undefined;
    this.limits = undefined;
    this.log('codex: signed out');
  }

  // ---- models -----------------------------------------------------------------------------------

  async models(_feature: AiFeature): Promise<AiModel[]> {
    if (this.modelsCache) return this.modelsCache.models;
    const server = await this.connect();
    const models: AiModel[] = [];
    let fallback = FALLBACK_MODEL;
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const reply: Json = await server.request('model/list', cursor ? { cursor } : {});
      for (const m of (reply.data ?? []) as Json[]) {
        if (m.hidden || typeof m.id !== 'string') continue;
        models.push({ id: m.id, label: String(m.displayName || m.id) });
        if (m.isDefault) fallback = m.id;
      }
      cursor = reply.nextCursor ?? null;
      if (!cursor) break;
    }
    // The plan's default first.
    models.sort((a, b) => Number(b.id === fallback) - Number(a.id === fallback));
    if (models.length) this.modelsCache = { models, fallback };
    return models;
  }

  defaultModel() {
    return this.modelsCache?.fallback ?? FALLBACK_MODEL;
  }

  chat(model: string): ChatProvider {
    return new CodexChat(this, model);
  }

  // ---- turns ------------------------------------------------------------------------------------

  /** Starts a thread for a conversation: ephemeral, read-only, in the empty folder, with these tools. */
  private async startThread(server: AppServer, model: string, instructions: string, tools: readonly ToolSpec[]) {
    const reply = await server.request('thread/start', {
      model,
      allowProviderModelFallback: true,
      cwd: this.options.workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      serviceName: 'anus',
      baseInstructions: instructions,
      dynamicTools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.parameters })),
    });
    const id = reply.thread?.id;
    if (typeof id !== 'string') throw new ProviderError('Codex didn’t start a conversation.', 'codex');
    return id;
  }

  /**
   * The model's next turn for the chat loop. A Codex turn runs until the model is done; when it
   * wants a tool, Codex asks us (item/tool/call) and waits. So a turn that asks for tools is
   * handed back to the chat loop as calls, and the next respond() sends their results and keeps
   * listening to the same turn.
   */
  async respond(convo: CodexConversation, model: string, { instructions, tools, signal, onText, choice }: RespondRequest): Promise<Turn> {
    const turn = await this.turnFor(convo, model, instructions, tools, choice?.effort ?? 'low');
    const result = await this.collect(await this.connect(), convo, turn, signal, onText);
    return { ...result, calls: result.calls.map((call) => withNulls(call, tools)) };
  }

  private async turnFor(convo: CodexConversation, model: string, instructions: string, tools: readonly ToolSpec[], effort: ReasoningEffort = 'low'): Promise<LiveTurn> {
    const server = await this.connect();
    let turn = convo.turn;
    // A new message while an old turn still waits on tool calls (the chat loop stopped after
    // them: a page that changed, the step limit): that turn ends first, then the message goes.
    if (turn && convo.pendingUser.length) this.interrupt(server, convo, turn, 'Not run: the agent stopped here.');
    await convo.closing;
    turn = convo.turn;
    if (turn && convo.threadId && this.turns.get(convo.threadId) === turn && convo.waiting.size) {
      // Answer the calls the model is waiting on.
      for (const [callId, rpcId] of convo.waiting) {
        const output = convo.outputs.get(callId) ?? 'Not run.';
        server.respond(rpcId, { contentItems: [{ type: 'inputText', text: output }], success: !/^(Error|Not run|Not allowed|Not saved|The user declined)/.test(output) });
      }
      convo.waiting.clear();
      convo.outputs.clear();
    } else {
      turn = undefined;
      convo.turn = undefined;
      convo.waiting.clear();
      convo.outputs.clear();
      const signature = JSON.stringify([instructions, tools.map((t) => t.name)]);
      let input = convo.pendingUser.join('\n\n');
      if (!input) throw new ProviderError('Nothing to send.', 'codex');
      if (!convo.threadId || convo.signature !== signature || convo.model !== model) {
        // A new thread (first message, or a companion or tool set that changed): it gets the
        // conversation so far as context, since Codex threads can't change instructions.
        const earlier = convo.threadId ? convo.history.slice(0, -convo.pendingUser.length) : [];
        if (convo.threadId) this.turns.delete(convo.threadId);
        convo.threadId = await this.startThread(server, model, instructions, tools);
        convo.signature = signature;
        convo.model = model;
        if (earlier.length) input = `Earlier in this conversation (for context):\n${earlier.map((h) => `${h.who}: ${h.text}`).join('\n\n')}\n\nNow:\n${input}`;
      }
      turn = new LiveTurn();
      convo.turn = turn;
      this.turns.set(convo.threadId, turn);
      convo.pendingUser = [];
      const reply = await server.request('turn/start', { threadId: convo.threadId, input: [{ type: 'text', text: input, text_elements: [] }], effort });
      turn.id = typeof reply.turn?.id === 'string' ? reply.turn.id : undefined;
    }
    return turn;
  }

  /** Waits for the model to want tools or to finish; streams its words meanwhile. */
  private async collect(server: AppServer, convo: CodexConversation, turn: LiveTurn, signal: AbortSignal, onText?: (text: string) => void): Promise<Turn> {
    const texts = new Map<string, string>();
    const say = () => [...texts.values()].filter((t) => t.trim()).join('\n\n');
    const calls: ToolCall[] = [];
    const silence = this.options.silenceMs ?? SILENCE_MS;
    while (true) {
      const event = await turn.next(calls.length ? 0 : silence, signal);
      if (signal.aborted) {
        this.interrupt(server, convo, turn);
        throw new ProviderError('Stopped.', 'aborted');
      }
      if (!event) {
        // Calls collected and nothing else queued: hand them over.
        if (calls.length) break;
        this.interrupt(server, convo, turn);
        throw new ProviderError('ChatGPT stopped answering. Check the connection and try again.', 'timeout');
      }
      if (event.kind === 'text') {
        texts.set(event.itemId, event.final ? event.text : (texts.get(event.itemId) ?? '') + event.text);
        onText?.(say());
      } else if (event.kind === 'call') {
        convo.waiting.set(event.call.callId, event.rpcId);
        calls.push(event.call);
      } else {
        // The turn is over.
        convo.turn = undefined;
        if (convo.threadId) this.turns.delete(convo.threadId);
        const text = say();
        if (text) convo.history.push({ who: 'Assistant', text });
        if (event.status === 'failed') throw turnError(event.error);
        if (event.status === 'interrupted' && !text) throw new ProviderError('ChatGPT stopped this answer.', 'incomplete');
        return { text, calls: [] };
      }
    }
    const text = say();
    if (text) convo.history.push({ who: 'Assistant', text });
    return { text, calls };
  }

  private interrupt(server: AppServer, convo: CodexConversation, turn: LiveTurn, why = 'Not run: the user stopped the agent.') {
    // Calls it waits on are answered, so the turn can wind down.
    for (const [callId, rpcId] of convo.waiting) server.respond(rpcId, { contentItems: [{ type: 'inputText', text: convo.outputs.get(callId) ?? why }], success: false });
    convo.waiting.clear();
    convo.outputs.clear();
    convo.turn = undefined;
    if (convo.threadId) {
      this.turns.delete(convo.threadId);
      // The next turn on this thread waits until Codex has let go of this one.
      if (turn.id) this.ended.add(turn.id);
      if (this.ended.size > 200) this.ended.delete(this.ended.values().next().value!);
      if (turn.id) convo.closing = server.request('turn/interrupt', { threadId: convo.threadId, turnId: turn.id }, 5000).then(() => undefined, () => undefined);
    }
  }

  /** One text answer: a fresh ephemeral thread with no tools, the answer held to the schema. */
  async complete(request: CompleteRequest): Promise<string> {
    const server = await this.connect();
    const status = await server.request('account/read', {});
    if (status.account?.type !== 'chatgpt') throw new ProviderError('ChatGPT isn’t signed in. Sign in under Settings › AI.', 'auth');
    const threadId = await this.startThread(server, request.model, request.instructions, []);
    const turn = new LiveTurn();
    this.turns.set(threadId, turn);
    try {
      const reply = await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: request.input, text_elements: [] }],
        effort: 'low',
        ...(request.schema ? { outputSchema: request.schema.schema } : {}),
      });
      turn.id = typeof reply.turn?.id === 'string' ? reply.turn.id : undefined;
      const convo = new CodexConversation();
      convo.threadId = threadId;
      const result = await this.collect(server, convo, turn, request.signal);
      if (!result.text.trim()) throw new ProviderError('ChatGPT returned nothing.', 'empty');
      // The final message is the answer; any commentary before it is not.
      const parts = result.text.split('\n\n');
      const json = request.schema ? parts.reverse().find((p) => p.trim().startsWith('{')) : undefined;
      return (json ?? result.text).trim();
    } finally {
      this.turns.delete(threadId);
      void server.request('thread/unsubscribe', { threadId }, 5000).catch(() => undefined);
    }
  }

  async dispose() {
    this.server?.stop();
    this.server = undefined;
  }
}

/**
 * Codex doesn't hold the model to strict schemas the way the Responses API does, so a model may
 * leave out an argument whose answer is null ("tabId": the active tab). Those are filled in as
 * null; anything else is left for the chat loop's own check to refuse.
 */
function withNulls(call: ToolCall, tools: readonly ToolSpec[]): ToolCall {
  const spec = tools.find((t) => t.name === call.name);
  if (!spec) return call;
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || '{}');
  } catch {
    return call;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return call;
  const given = args as Record<string, unknown>;
  const props = (spec.parameters.properties ?? {}) as Record<string, { type?: string | string[] }>;
  let changed = false;
  for (const key of (spec.parameters.required ?? []) as readonly string[]) {
    const type = props[key]?.type;
    if (!(key in given) && (Array.isArray(type) ? type.includes('null') : type === 'null')) {
      given[key] = null;
      changed = true;
    }
  }
  return changed ? { ...call, arguments: JSON.stringify(given) } : call;
}

function limitsFrom(snapshot: Json | undefined): AiProviderView['limits'] {
  if (!snapshot) return undefined;
  const window = (w: Json | null | undefined): AiLimitWindow | undefined =>
    w && typeof w.usedPercent === 'number' ? { usedPercent: w.usedPercent, windowMins: w.windowDurationMins ?? undefined, resetsAt: w.resetsAt ?? undefined } : undefined;
  return { primary: window(snapshot.primary), secondary: window(snapshot.secondary) };
}
