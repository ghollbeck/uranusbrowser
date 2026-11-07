/**
 * Uranus Browser's native messaging host: the parts of the Electron spike that need Node, for the
 * Chromium build's shell extension, which can't read files or listen on a port.
 *
 * - Importing from other browsers (browserImport.ts), or from a bookmarks file one exported:
 *   the host reads, the shell adds.
 * - The Electron spike's own saved state, for "import from Uranus Browser".
 * - The agent bridge (agentServer.ts): an MCP server on 127.0.0.1 whose tool calls
 *   go to the shell, which runs them with chrome.tabs, chrome.scripting and chrome.debugger.
 * - The Agent panel's conversation (agentChat.ts): the approval rules every browser action
 *   passes before the shell may run it.
 * - The central AI provider (ai/registry.ts): which provider (an OpenAI API key, a ChatGPT
 *   account through Codex, the on-device model) and model each AI feature uses.
 *
 * Chromium starts it when the shell calls chrome.runtime.connectNative and stops it (closes
 * stdin) when the port closes. stdout carries only messages; logs go to stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readArcPasswords } from './arcPasswords';
import { detectBrowsers, readBookmarksHtml, readBrowser } from './browserImport';
import { AGENT_TOOLS, McpBridge, fail, type AgentResult } from './agentServer';
import { ChatSession } from './agentChat';
import { ProviderError } from './agentProvider';
import { CodexProvider } from './ai/codex';
import { OpenAIApiProvider } from './ai/openaiApi';
import { AiRegistry } from './ai/registry';
import { UnderdogProvider } from './ai/underdog';
import { scrub, systemSecrets } from './secrets';
import { AI_FEATURES, AI_PROVIDERS, OPENAI_KEY_PATTERN, type AiRequest } from '../shared/aiProtocol';
import { JoinlyClient } from './joinlyClient';
import { VoiceMode } from './voiceMode';
import { defaultTranscriber } from './meetingTranscribe';
import { summarizeMeeting } from './meetingSummary';
import { UnderdogLlm } from './underdogLlm';
import { openPrivacyPane } from './privacyPanes';
import { extractText } from './fileText';
import { ReminderPopup } from './reminderPopup';
import type { AiReply, HostMethods, ToHost, ToShell } from './protocol';

const SHELL_ORIGIN = 'chrome-extension://abdiaepfgbbhdjaecjipmaailijaaide/';
/** Chromium refuses messages from a host over 1 MB; leave room for the chunk's own fields. */
const MAX_MESSAGE = 1024 * 1024 - 1024;
const CHUNK = 128 * 1024;
/** How long a tool may take in the shell before the agent is told it failed. */
const TOOL_TIMEOUT = 60_000;

const log = (...args: unknown[]) => console.error('[anus-host]', ...args);

// Chromium passes the caller's origin first; only the shell may use the host.
const caller = process.argv.find((a) => a.startsWith('chrome-extension://'));
if (caller && caller !== SHELL_ORIGIN) {
  log('refusing', caller);
  process.exit(1);
}

// ---- framing: a 32-bit length in native byte order (little-endian on Macs), then JSON ----

let nextChunk = 1;
function send(message: ToShell) {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json) <= MAX_MESSAGE) return write(json);
  // A UTF-16 unit is at most 6 bytes once escaped again for the chunk, so CHUNK units fit.
  const id = nextChunk++;
  const size = CHUNK;
  const total = Math.ceil(json.length / size);
  for (let index = 0; index < total; index++) {
    write(JSON.stringify({ type: 'chunk', id, index, total, data: json.slice(index * size, (index + 1) * size) } satisfies ToShell));
  }
}

function write(json: string) {
  const body = Buffer.from(json);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (data: Buffer) => {
  pending = Buffer.concat([pending, data]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (pending.length < 4 + length) break;
    const body = pending.subarray(4, 4 + length).toString('utf8');
    pending = pending.subarray(4 + length);
    try {
      void receive(JSON.parse(body) as ToHost);
    } catch (err) {
      log('bad message', err);
    }
  }
});
process.stdin.on('end', () => void shutdown());
// A meeting ends with the host: the bot leaves rather than stay in the room.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void shutdown());
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  reminder.close();
  voice.dispose();
  await Promise.allSettled([bridge.stop(), joinly.shutdown(), meetingTranscriber.dispose(), registry.dispose()]);
  process.exit(0);
}

// ---- what the shell asks for --------------------------------------------------

// ---- the central AI provider ----------------------------------------------------------------

/** Uranus Browser's own AI files: the saved model choices (no secrets). ANUS_AI_DIR moves it (tests). */
const AI_DIR = process.env.ANUS_AI_DIR?.trim() || path.join(os.homedir(), 'Library', 'Application Support', 'Anus Browser', 'ai');
// The on-device Underdog model: available on request, started only by the first prompt, never the default.
const underdog = new UnderdogLlm();
const openaiApi = new OpenAIApiProvider(systemSecrets);
// A ChatGPT account, through Codex's app-server: started on first use, stopped with the host.
const codex = new CodexProvider({
  home: path.join(AI_DIR, 'codex-home'),
  workspace: path.join(AI_DIR, 'codex-workspace'),
  log,
  onChange: ({ signedIn }) => {
    if (!signedIn) return registry.changed();
    // Signed in: the plan's models first, so features that move here get its default model.
    void codex
      .models('chat')
      .catch(() => undefined)
      .then(() => registry.adopt('codex'));
  },
});
const registry = new AiRegistry({
  providers: [codex, openaiApi, new UnderdogProvider(underdog)],
  file: path.join(AI_DIR, 'prefs.json'),
  log,
});
registry.onChange(() => {
  void chat.providerChanged().catch(() => undefined);
  void pushAi();
});

/** Tells the shell (Settings › AI, the panel) what changed. */
async function pushAi() {
  try {
    send({ type: 'ai', view: await registry.view() });
  } catch (err) {
    log('ai: view failed', err instanceof Error ? err.name : typeof err);
  }
}

/** What Settings › AI and the panel's model menu ask for. Errors are short and scrubbed. */
async function aiRequest(request: AiRequest): Promise<AiReply> {
  try {
    return await aiOp(request);
  } catch (err) {
    throw new Error(err instanceof ProviderError ? err.message : scrub(err instanceof Error ? err.message : String(err)).slice(0, 200));
  }
}

async function aiOp(request: AiRequest): Promise<AiReply> {
  switch (request?.op) {
    case 'view':
      return { view: await registry.view() };
    case 'setModel': {
      if (!AI_FEATURES.includes(request.feature) || !AI_PROVIDERS.includes(request.provider)) throw new ProviderError('Unknown feature or provider.');
      // The chat's model can't change under a run.
      if ((request.feature === 'chat' || request.feature === 'routines') && chat.busy) throw new ProviderError('The agent is working. Stop it first, then pick another model.');
      registry.set(request.feature, request.provider, String(request.model ?? ''));
      return { view: await registry.view() };
    }
    case 'followChat':
      registry.followChat('routines');
      return { view: await registry.view() };
    case 'setKey': {
      const key = String(request.key ?? '').trim();
      if (!OPENAI_KEY_PATTERN.test(key)) throw new ProviderError('That doesn’t look like an OpenAI API key (sk-…).');
      if (!systemSecrets.saveOpenaiKey) throw new ProviderError('Saving a key needs the macOS Keychain.');
      await systemSecrets.saveOpenaiKey(key);
      openaiApi.forget();
      log('ai: API key saved to the Keychain');
      await registry.adopt('openai');
      return { view: await registry.view() };
    }
    case 'login': {
      const authUrl = await codex.startLogin();
      return { view: await registry.view(), authUrl };
    }
    case 'cancelLogin':
      await codex.cancelLogin();
      return { view: await registry.view() };
    case 'logout':
      await codex.logout();
      registry.changed();
      return { view: await registry.view() };
    case 'removeKey':
      await systemSecrets.removeOpenaiKey?.();
      openaiApi.forget();
      log('ai: API key removed from the Keychain');
      registry.changed();
      return { view: await registry.view() };
    default:
      throw new ProviderError('Unknown request.');
  }
}

const meetingTranscriber = defaultTranscriber(systemSecrets, registry);

const methods: { [K in keyof HostMethods]: (...args: any[]) => Promise<ReturnType<HostMethods[K]>> | ReturnType<HostMethods[K]> } = {
  readArcPasswords: () => readArcPasswords(),
  detectBrowsers: () => detectBrowsers(),
  readBrowser: (id: string) => readBrowser(String(id)),
  readBookmarksHtml: (html: string, fileName?: string) => readBookmarksHtml(String(html), fileName ? String(fileName) : undefined),
  readAnusState: () => {
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Anus Browser', 'anus-state.json');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  // Meeting notes: audio in, text out; the host keeps neither (see meetingTranscribe.ts).
  meetingEngines: () => meetingTranscriber.status(),
  meetingTranscribe: (request) => meetingTranscriber.transcribe(request),
  underdogInfo: () => underdog.info(),
  openPrivacyPane: (pane) => openPrivacyPane(pane),
  extractText: (request) => extractText(request),
  meetingSummarize: (request) => summarizeMeeting(request, { registry, underdog }),
  ai: (request) => aiRequest(request),
  // The Algorithm Diet stays on this Mac: always the local Underdog model, never the chat's provider.
  dietComplete: async (request) => {
    const reply = await underdog.chat({
      messages: [
        { role: 'system', content: String(request?.system ?? '') },
        { role: 'user', content: String(request?.user ?? '') },
      ],
      maxTokens: Math.max(16, Math.min(Number(request?.maxTokens) || 256, 1024)),
    });
    return reply.text.trim();
  },
  // The composer's modes: the OpenAI API models, and the chat's own provider and model
  // (Default follows it; Efficient and Expert apply only to OpenAI API key chats).
  agentModels: async () => {
    const { provider, model } = registry.choice('chat');
    const models = await openaiApi.models('chat').catch(() => []);
    return { models: models.map((m) => m.id), default: provider.id === 'openai' ? model : openaiApi.defaultModel('chat'), provider: provider.id };
  },
};

async function receive(message: ToHost) {
  if (message.type === 'call') {
    const method = methods[message.method];
    try {
      if (!method) throw new Error(`No method ${message.method}`);
      send({ type: 'reply', id: message.id, value: await method(...(message.params ?? [])) });
    } catch (err) {
      send({ type: 'reply', id: message.id, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (message.type === 'agent') {
    token = String(message.token ?? '');
    await setAgent(!!message.enabled && !!token);
  } else if (message.type === 'toolResult') {
    tools.get(message.id)?.(message.result);
  } else if (message.type === 'chat') {
    const { type: _type, ...action } = message;
    await chat.handle(action).catch((err) => log('chat: action failed', err instanceof Error ? err.name : typeof err));
  } else if (message.type === 'joinly') {
    await joinlyOp(message).catch((err) => log('joinly: action failed', err instanceof Error ? err.name : typeof err));
  } else if (message.type === 'reminder') {
    reminder.show(message.show);
  }
}

// ---- the meeting reminder's floating panel ----------------------------------------------------

const reminder = new ReminderPopup((id, action) => send({ type: 'reminder', id, action }), log);

// ---- the agent bridge -----------------------------------------------------------

let token = '';
let nextTool = 1;
const tools = new Map<number, (result: AgentResult) => void>();

/** Has the shell run a tool (a coding agent's, or the Agent panel's) and waits for its answer. */
function runInShell(name: string, args: Record<string, unknown> = {}) {
  return new Promise<AgentResult>((resolve) => {
    const id = nextTool++;
    const wait = TOOL_TIMEOUT + (typeof args.timeoutMs === 'number' ? args.timeoutMs : 0);
    const timer = setTimeout(() => finish(fail(`Uranus Browser didn’t answer ${name} within ${wait / 1000}s`)), wait);
    const finish = (result: AgentResult) => {
      clearTimeout(timer);
      tools.delete(id);
      resolve(result);
    };
    tools.set(id, finish);
    send({ type: 'tool', id, name, args });
  });
}

/** Each tool, as agentServer.ts describes it, is run by the shell. */
function register(mcp: McpServer) {
  for (const [name, spec] of Object.entries(AGENT_TOOLS)) {
    // The specs are typed one by one; in a loop they're all the same to us.
    (mcp.registerTool as (name: string, spec: object, cb: (args: Record<string, unknown>) => Promise<AgentResult>) => void)(
      name,
      spec,
      (args) => runInShell(name, 'inputSchema' in spec ? args : {}),
    );
  }
}

// ---- the Agent panel ------------------------------------------------------------

// ---- meetings: the user's joinly server (joinlyClient.ts) ---------------------------------------

const joinly = new JoinlyClient({ log });
// Voice mode (the bot answers out loud by itself, with a model on this Mac): off until the sheet turns it on.
const voice = new VoiceMode(joinly, { log });
joinly.onChange((view) => send({ type: 'joinly', view }));

/** What the Meetings sheet asked for. Joining here was confirmed in the sheet; the model's goes through the chat's card. */
async function joinlyOp(message: Extract<ToHost, { type: 'joinly' }>) {
  await joinly.configure(message.config);
  switch (message.op) {
    case 'probe':
      await joinly.probe();
      break;
    case 'join':
      // A failure is in the view (its `error`), scrubbed.
      await joinly.join({ meetingUrl: String(message.meetingUrl ?? ''), botName: String(message.botName ?? '') }, { approved: true }).catch(() => undefined);
      break;
    case 'leave':
      await joinly.leave();
      break;
    case 'voice-models':
      await voice.listModels(message.model);
      break;
    case 'voice':
      // The sheet confirmed with the person; VoiceMode checks again and refuses without it.
      if (message.on) await voice.start({ confirmed: message.confirmed === true, model: message.model, language: message.config.language }).catch(() => undefined);
      else voice.stop();
      break;
  }
  send({ type: 'joinly', view: joinly.view() });
}

const chat = new ChatSession((feature) => registry.chat(feature), {
  runInShell,
  publish: (snapshot) => send({ type: 'chat', snapshot }),
  log,
  meeting: joinly,
});

const bridge = new McpBridge(register, () => token);

let agentChange = Promise.resolve();
function setAgent(enabled: boolean) {
  agentChange = agentChange.then(async () => {
    try {
      if (enabled) await bridge.start();
      else await bridge.stop();
      send({ type: 'agent', endpoint: bridge.port ? `http://127.0.0.1:${bridge.port}/mcp` : undefined });
    } catch (err) {
      log('agent bridge failed', err);
      send({ type: 'agent', error: err instanceof Error ? err.message : String(err) });
    }
  });
  return agentChange;
}

log('ready', process.pid);
