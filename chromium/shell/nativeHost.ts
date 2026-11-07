/**
 * The shell's side of Uranus Browser's native messaging host (chromium/native-host): importing from
 * other browsers, reading the Electron spike's state, and the agent bridge for coding agents.
 *
 * The host reads files and serves MCP on 127.0.0.1; this side adds imports to the Store and
 * runs agents' tool calls on real tabs with chrome.tabs and chrome.debugger. The port to the
 * host opens on first use and stays open while the agent bridge is on (which also keeps the
 * background awake); otherwise it closes after a minute of quiet.
 *
 * A release app registers the host it carries on every launch (patch 0054); a dev build
 * needs chromium/scripts/install-native-host.sh.
 */
import { saveArcPasswords, type PasswordSink } from '../shared/arcPasswords';
import type { BrowserImportOptions } from '../shared/types';
import type { DetectedBrowser, HistoryEntry, ImportResult, UiState } from '../shared/types';
import type { Store } from '../shared/store';
import type { AgentResult, AgentTab, AgentToolName } from '../shared/agentTools';
import { SHELL_TOOL_PREFIX, type ChatAction, type ChatSnapshot } from '../shared/browserAgent';
import { applyBrowserImport } from '../shared/importApply';
import { HOST_NAME, type HostMethods, type ToHost, type ToShell } from '../native-host/protocol';
import { broadcast, handle } from './hub';
import { browserAgentTools } from './browserAgentTools';
import type { AiRequest, AiView } from '../shared/aiProtocol';
import type { ReminderAction, ReminderSpec } from '../shared/calendar';

export interface NativeHostContext {
  store: Store;
  /** Sends every page the new state (the sidebar shows what an agent is doing). */
  broadcastState(): void;
  tabs: {
    /** Opens an address in a new Uranus Browser tab, as the command bar does; returns its id. */
    open(url: string, background: boolean): string;
    /** The Chromium tab showing a Uranus Browser tab, opened (in the background) if it has none yet. */
    chromeTab(tabId: string): Promise<number | undefined>;
    activate(tabId: string): void;
    close(tabId: string): void;
  };
  /** Whether the Agent panel needs the host kept running (it's open, or a run is going). */
  chatWanted(): boolean;
  /** The Agent panel's conversation changed, or the host went away (undefined, and why). */
  onChat(snapshot: ChatSnapshot | undefined, problem?: string): void;
  /** The agent's pointer on the page, before a click or keys (agentOverlay.ts). */
  pointAt?(chromeId: number, point: { x: number; y: number }): Promise<void>;
  /** Saves a note the user approved in the panel to a companion's memory. */
  remember(args: Record<string, unknown>): Promise<AgentResult>;
  /** A window of an attached file's text, for the agent's read_file. */
  readFile(args: Record<string, unknown>): Promise<AgentResult>;
  /** Saves a skill the user approved in the panel. */
  saveSkill(args: Record<string, unknown>): Promise<AgentResult>;
  /** Meetings: the host's view of joinly changed, or the host went away (undefined, and why). */
  onJoinly?(view: import('../shared/joinly').JoinlyView | undefined, problem?: string): void;
}

const NOT_INSTALLED =
  'Uranus Browser’s helper isn’t registered, so it can’t import from other browsers or run the agent bridge. Quit and reopen Uranus Browser to register it. Building Uranus Browser yourself? Run chromium/scripts/install-native-host.sh.';
const IDLE_CLOSE = 60_000;
/** How long the agent bridge waits before starting the host again, doubling up to a minute. */
const RETRY_FIRST = 2_000;
const RETRY_MAX = 60_000;

/** Chromium's reasons for not starting a host at all (native_message_process_host.cc), as opposed to one that stopped. */
const isMissing = (reason: string) => /host not found|host is forbidden|invalid native messaging host/i.test(reason);

export function registerNativeHost(ctx: NativeHostContext) {
  const { store } = ctx;

  // ---- the port ---------------------------------------------------------------

  let port: chrome.runtime.Port | undefined;
  let nextCall = 1;
  const calls = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  const chunks = new Map<number, string[]>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sentAgent = '';
  /** Why the host last failed, for Settings; cleared once it answers. */
  let hostError: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_FIRST;
  /** Meeting notes ends a recording when the helper goes away (meetings.ts). */
  const lostListeners: Array<() => void> = [];
  /** The meeting reminder's floating panel: what it shows (the host keeps it up), and its clicks. */
  let reminder: ReminderSpec | undefined;
  let sentReminder = '';
  const reminderListeners: Array<(id: string, action: ReminderAction) => void> = [];

  /** Tells the sidebar and an open Settings page that the host or bridge changed. */
  function changed() {
    ctx.broadcastState();
    broadcast('settings:changed');
  }

  function setHostError(error: string | undefined) {
    if (error === hostError) return;
    hostError = error;
    changed();
  }

  function connect() {
    if (port) return port;
    const p = chrome.runtime.connectNative(HOST_NAME);
    port = p;
    sentAgent = '';
    p.onMessage.addListener((message: ToShell) => receive(message));
    p.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? 'The helper stopped';
      if (port === p) port = undefined;
      endpoint = undefined;
      // The panel went with the host: show it again from a new one.
      sentReminder = '';
      if (reminder) setTimeout(() => showReminder(reminder), RETRY_FIRST);
      for (const call of calls.values()) call.reject(new Error(reason));
      calls.clear();
      chunks.clear();
      console.warn('Uranus Browser shell: native host disconnected:', reason);
      hostError = isMissing(reason) ? NOT_INSTALLED : `Uranus Browser’s helper stopped: ${reason}`;
      // A meeting ended with the host (joinly ends it when its connection does).
      if (joinlyView) {
        joinlyView = undefined;
        ctx.onJoinly?.(undefined, hostError);
      }
      for (const fn of lostListeners) fn();
      // The conversation lived in the host; the panel says it's gone, and why.
      if (chat || ctx.chatWanted()) {
        chat = undefined;
        ctx.onChat(undefined, hostError);
      }
      changed();
      // The bridge should stay up while it's on: start the host again, a little later each time.
      if (store.state.agent?.enabled) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          sentAgent = '';
          syncAgent();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
      }
    });
    return p;
  }

  /** Closes the port after a quiet minute, unless the agent bridge needs it. */
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // The host holds the connection to a meeting: closing it would end the meeting.
      // A ChatGPT sign-in waits in the host for the browser, so the host stays up for it too.
      // So does the meeting reminder's panel.
      if (!store.state.agent?.enabled && !calls.size && !ctx.chatWanted() && !chatBusy() && !joinlyActive() && !loginPending() && !reminder) {
        port?.disconnect();
        port = undefined;
      }
    }, IDLE_CLOSE);
  }

  function post(message: ToHost) {
    connect().postMessage(message);
    touch();
  }

  function call<K extends keyof HostMethods>(method: K, ...params: Parameters<HostMethods[K]>): Promise<ReturnType<HostMethods[K]>> {
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      calls.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        post({ type: 'call', id, method, params });
      } catch (err) {
        calls.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function receive(message: ToShell) {
    touch();
    retryDelay = RETRY_FIRST;
    if (message.type === 'chunk') {
      const parts = chunks.get(message.id) ?? [];
      parts[message.index] = message.data;
      chunks.set(message.id, parts);
      if (parts.filter((p) => p !== undefined).length < message.total) return;
      chunks.delete(message.id);
      return receive(JSON.parse(parts.join('')) as ToShell);
    }
    if (message.type === 'reply') {
      setHostError(undefined);
      const pending = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.value);
    } else if (message.type === 'agent') {
      endpoint = message.endpoint;
      hostError = message.error ? `The agent bridge couldn’t start: ${message.error}` : undefined;
      if (message.error) console.error('Uranus Browser shell: agent bridge failed:', message.error);
      changed();
    } else if (message.type === 'ai') {
      aiChanged(message.view);
    } else if (message.type === 'joinly') {
      joinlyView = message.view;
      ctx.onJoinly?.(message.view);
    } else if (message.type === 'reminder') {
      for (const fn of reminderListeners) fn(message.id, message.action);
    } else if (message.type === 'chat') {
      chat = message.snapshot;
      ctx.onChat(chat);
    } else if (message.type === 'tool') {
      void runTool(message.name, message.args ?? {}).then((result) => {
        try {
          post({ type: 'toolResult', id: message.id, result });
        } catch {
          // The host went away; the agent's request went with it.
        }
      });
    }
  }

  /** Shows the meeting reminder's floating panel on the pointer's display, or closes it (undefined). */
  function showReminder(spec: ReminderSpec | undefined) {
    const key = JSON.stringify(spec ?? null);
    if (key === sentReminder && (port || !spec)) return;
    reminder = spec;
    // Nothing to close in a host that isn't running.
    if (!spec && !port) return void (sentReminder = key);
    try {
      post({ type: 'reminder', show: spec });
      sentReminder = key;
    } catch (err) {
      console.warn('Uranus Browser shell: the reminder panel couldn’t be shown:', err);
    }
  }

  // ---- importing --------------------------------------------------------------

  /**
   * Chromium's history API can add a page but not when it was visited or its title, so
   * imported pages count as visited now; the address bar still finds them.
   */
  const history = {
    async merge(entries: HistoryEntry[]) {
      const urls = [...new Set(entries.filter((e) => /^https?:/.test(e.url)).map((e) => e.url))];
      // Oldest first, so the most recent visit ends up newest.
      urls.reverse();
      for (let i = 0; i < urls.length; i += 50) {
        await Promise.all(urls.slice(i, i + 50).map((url) => chrome.history.addUrl({ url }).catch(() => undefined)));
      }
      return urls.length;
    },
  };

  handle({
    detectBrowsers: async (): Promise<DetectedBrowser[]> => {
      try {
        return await call('detectBrowsers');
      } catch (err) {
        // Settings › Import says why from hostError; the tour just shows none.
        console.warn('Uranus Browser shell: no browsers to import from:', err);
        return [];
      }
    },
    importBrowser: async (id: string, options?: BrowserImportOptions): Promise<ImportResult> => {
      try {
        const result: ImportResult = id === 'arc' && options?.passwordsOnly
          ? { spaces: 0, bookmarks: 0, history: 0, warnings: [] }
          : await applyBrowserImport(await call('readBrowser', String(id)), store, history);
        if (id === 'arc' && options?.passwords) {
          const sink = (chrome as unknown as { passwordsPrivate?: PasswordSink }).passwordsPrivate;
          if (!sink?.addPassword || !sink.getSavedPasswordList) result.warnings.push('Password import needs the latest installed browser.');
          else {
            try {
              // Chromium keeps the password delegate alive only while its manager is open.
              // Leave this tab available so the person can review their imported logins.
              const managers = await chrome.tabs.query({ url: 'chrome://password-manager/*' });
              if (!managers.length) await chrome.tabs.create({ url: 'chrome://password-manager/settings', active: false });
              let ready = false;
              for (let attempt = 0; attempt < 50; attempt++) {
                try { await sink.getSavedPasswordList(); ready = true; break; }
                catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
              }
              if (!ready) throw new Error('Password manager is unavailable.');
              const saved = await saveArcPasswords(await call('readArcPasswords'), sink);
              result.passwords = saved.passwords;
              result.passwordsSkipped = saved.passwordsSkipped;
              result.warnings.push(...saved.warnings);
            } catch { result.warnings.push('Passwords could not be imported. Keep the password manager tab open and try Import passwords again in Settings.'); }
          }
        }
        return result;
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        const missing = isMissing(message);
        return { spaces: 0, bookmarks: 0, history: 0, warnings: [missing ? NOT_INSTALLED : message] };
      }
    },
    /** A bookmarks file exported from any browser as HTML, by its text, into a Space of its own. */
    importBookmarksFile: async (html: string, fileName?: string): Promise<ImportResult> => {
      try {
        return await applyBrowserImport(await call('readBookmarksHtml', String(html), fileName), store, history);
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        return { spaces: 0, bookmarks: 0, history: 0, warnings: [isMissing(message) ? NOT_INSTALLED : message] };
      }
    },
    /** The Electron spike's saved state as text, or undefined when there's none or no helper. */
    'nativeHost:anusState': async () => call('readAnusState').catch(() => undefined),
  });

  // ---- the agent bridge ---------------------------------------------------------

  let endpoint: string | undefined;
  let activity: { tabId?: string; action: string; at: number } | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;

  /** Starts, stops or re-keys the bridge whenever Settings change it. */
  function syncAgent() {
    const agent = store.state.agent;
    const wanted = JSON.stringify({ enabled: !!agent?.enabled, token: agent?.token ?? '' });
    if (wanted === sentAgent) return;
    // Nothing to stop if the host isn't running.
    if (!agent?.enabled && !port) {
      sentAgent = wanted;
      return;
    }
    sentAgent = wanted;
    if (!agent?.enabled) clearTimeout(retryTimer);
    try {
      post({ type: 'agent', enabled: !!agent?.enabled, token: agent?.token ?? '' });
    } catch (err) {
      console.warn('Uranus Browser shell: no agent bridge:', err);
      setHostError(NOT_INSTALLED);
    }
  }
  store.onChange(syncAgent);
  syncAgent();

  function showActivity(tabId: string | undefined, action: string) {
    activity = { tabId, action, at: Date.now() };
    ctx.broadcastState();
    // Drop the "busy" highlight once the agent has been quiet for a moment.
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => ctx.broadcastState(), 4000);
  }

  function listTabs(): AgentTab[] {
    const visible = new Set(store.visibleTabIds());
    const tabs: AgentTab[] = [];
    const add = (id: string, space: string, zone: AgentTab['zone']) => {
      const tab = store.state.tabs[id];
      if (tab) tabs.push({ id, title: tab.customTitle || tab.title, url: tab.url, space, zone, active: visible.has(id) });
    };
    for (const id of store.state.favorites) add(id, '', 'favorites');
    for (const space of store.state.spaces) {
      for (const id of store.allTabIds(space)) {
        if (!store.state.favorites.includes(id)) add(id, space.name, space.today.includes(id) ? 'today' : 'pinned');
      }
    }
    return tabs;
  }

  async function runTool(name: string, args: Record<string, any>): Promise<AgentResult> {
    try {
      if (name.startsWith(SHELL_TOOL_PREFIX)) {
        const tool = chatTools[name];
        return tool ? await tool(args) : fail(`No tool ${name}`);
      }
      if (!Object.hasOwn(tools, name)) return fail(`No tool ${name}`);
      return await tools[name as AgentToolName](args);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** The tool's tab (the active one by default) with its Chromium tab, after telling the sidebar. */
  async function target(id: string | undefined, action: string) {
    const tabId = id ?? store.activeTab?.id;
    if (!tabId || !store.state.tabs[tabId]) throw new Error(id ? `No tab with id ${id}` : 'There is no active tab');
    showActivity(tabId, action);
    const chromeId = await ctx.tabs.chromeTab(tabId);
    if (chromeId === undefined) throw new Error(`Tab ${tabId} couldn’t be opened`);
    return { tabId, chromeId };
  }

  /** Brings a tab on screen and waits for Chromium to show it. */
  async function bringForward(tabId: string, chromeId: number) {
    ctx.tabs.activate(tabId);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(await chrome.tabs.get(chromeId)).active) await wait(50);
  }

  const tools: Record<AgentToolName, (args: Record<string, any>) => Promise<AgentResult>> = {
    list_tabs: async () => {
      showActivity(undefined, 'listing tabs');
      return text(listTabs());
    },
    open_tab: async ({ url, background }) => {
      const tabId = ctx.tabs.open(String(url), !!background);
      showActivity(tabId, 'opening a tab');
      const chromeId = await ctx.tabs.chromeTab(tabId);
      if (chromeId !== undefined) await settle(chromeId);
      const tab = chromeId !== undefined ? await chrome.tabs.get(chromeId).catch(() => undefined) : undefined;
      return text({ tabId, url: tab?.pendingUrl || tab?.url || url });
    },
    activate_tab: async ({ tabId }) => {
      if (!store.state.tabs[tabId]) return fail(`No tab with id ${tabId}`);
      ctx.tabs.activate(tabId);
      showActivity(tabId, 'switching tab');
      return text('ok');
    },
    close_tab: async ({ tabId }) => {
      if (!store.state.tabs[tabId]) return fail(`No tab with id ${tabId}`);
      showActivity(tabId, 'closing a tab');
      ctx.tabs.close(tabId);
      return text('ok');
    },
    navigate: async ({ tabId, url, action }) => {
      const t = await target(tabId, url ? `opening ${url}` : (action ?? 'navigating'));
      if (url) await chrome.tabs.update(t.chromeId, { url: String(url) });
      else if (action === 'back') await chrome.tabs.goBack(t.chromeId).catch(() => undefined);
      else if (action === 'forward') await chrome.tabs.goForward(t.chromeId).catch(() => undefined);
      else if (action === 'reload') await chrome.tabs.reload(t.chromeId);
      await settle(t.chromeId);
      const tab = await chrome.tabs.get(t.chromeId);
      return text({ url: tab.url, title: tab.title });
    },
    read_page: async ({ tabId, format = 'text', maxChars = 40000 }) => {
      const t = await target(tabId, 'reading the page');
      const code = {
        text: 'document.body?.innerText ?? ""',
        html: 'document.documentElement.outerHTML',
        links: '[...document.links].map((a) => `${a.innerText.trim().slice(0, 80)} -> ${a.href}`).join("\\n")',
      }[format as 'text' | 'html' | 'links'];
      if (!code) return fail(`Unknown format ${format}`);
      const content = String(await evaluate(t.chromeId, code));
      const tab = await chrome.tabs.get(t.chromeId);
      return text(`# ${tab.title}\n${tab.url}\n\n${content.slice(0, maxChars)}`);
    },
    screenshot: async ({ tabId }) => {
      const t = await target(tabId, 'taking a screenshot');
      await bringForward(t.tabId, t.chromeId);
      await wait(300);
      const shot = (await debug(t.chromeId, 'Page.captureScreenshot', { format: 'png' })) as { data: string };
      return { content: [{ type: 'image', data: await shrink(shot.data, 1280), mimeType: 'image/png' }] };
    },
    console_logs: async ({ tabId, level, limit = 50 }) => {
      const t = await target(tabId, 'reading the console');
      await attach(t.chromeId);
      const entries = (consoleLogs.get(t.chromeId) ?? []).filter((e) => !level || e.level === level);
      return text(entries.slice(-limit).map((e) => `[${e.level}] ${e.message}${e.source ? `  (${e.source})` : ''}`).join('\n') || '(no messages)');
    },
    click: async ({ tabId, selector }) => {
      const t = await target(tabId, `clicking ${selector}`);
      await bringForward(t.tabId, t.chromeId);
      const point = (await evaluate(t.chromeId, centerOf(String(selector)))) as { x: number; y: number } | undefined;
      if (!point) return fail(`No visible element matches ${selector}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await debug(t.chromeId, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
      await settle(t.chromeId);
      return text({ clicked: selector, url: (await chrome.tabs.get(t.chromeId)).url });
    },
    type: async ({ tabId, selector, text: value, clear, submit }) => {
      const t = await target(tabId, `typing into ${selector ?? 'the page'}`);
      await bringForward(t.tabId, t.chromeId);
      if (selector) {
        const found = await evaluate(
          t.chromeId,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.focus();
            if (${!!clear} && 'value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
            return true;
          })()`,
        );
        if (!found) return fail(`No element matches ${selector}`);
      }
      await debug(t.chromeId, 'Input.insertText', { text: String(value) });
      if (submit) await pressKey(t.chromeId, 'Enter');
      await settle(t.chromeId);
      return text('ok');
    },
    press_key: async ({ tabId, key }) => {
      const t = await target(tabId, `pressing ${key}`);
      await bringForward(t.tabId, t.chromeId);
      await pressKey(t.chromeId, String(key));
      await settle(t.chromeId);
      return text('ok');
    },
    evaluate: async ({ tabId, expression }) => {
      const t = await target(tabId, 'running JavaScript');
      const result = await evaluate(t.chromeId, String(expression));
      return text(result === undefined ? 'undefined' : result);
    },
    wait_for: async ({ tabId, selector, timeoutMs = 10000 }) => {
      const t = await target(tabId, `waiting for ${selector ?? 'the page'}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ready = selector
          ? await evaluate(t.chromeId, `!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false)
          : (await chrome.tabs.get(t.chromeId)).status !== 'loading';
        if (ready) return text('ready');
        await wait(200);
      }
      return fail(`Timed out after ${timeoutMs}ms`);
    },
  };

  // ---- chrome.debugger --------------------------------------------------------
  // Attached on first use and kept while the agent works, so console messages keep coming
  // (Runtime.enable replays the ones logged before); let go after two quiet minutes.

  const DEBUG_IDLE = 120_000;
  const attached = new Map<number, ReturnType<typeof setTimeout>>();
  const attaching = new Map<number, Promise<void>>();
  const consoleLogs = new Map<number, Array<{ level: string; message: string; source: string; time: number }>>();

  function keepAttached(chromeId: number) {
    clearTimeout(attached.get(chromeId));
    attached.set(
      chromeId,
      setTimeout(() => void chrome.debugger.detach({ tabId: chromeId }).catch(() => undefined).finally(() => forget(chromeId)), DEBUG_IDLE),
    );
  }

  function forget(chromeId: number) {
    clearTimeout(attached.get(chromeId));
    attached.delete(chromeId);
    consoleLogs.delete(chromeId);
  }

  function attach(chromeId: number): Promise<void> {
    if (attached.has(chromeId)) {
      keepAttached(chromeId);
      return Promise.resolve();
    }
    let pending = attaching.get(chromeId);
    if (!pending) {
      pending = (async () => {
        await chrome.debugger.attach({ tabId: chromeId }, '1.3');
        keepAttached(chromeId);
        consoleLogs.set(chromeId, []);
        await chrome.debugger.sendCommand({ tabId: chromeId }, 'Runtime.enable');
        await chrome.debugger.sendCommand({ tabId: chromeId }, 'Log.enable');
        // The replayed messages arrive right after enabling.
        await wait(100);
      })().finally(() => attaching.delete(chromeId));
      attaching.set(chromeId, pending);
    }
    return pending;
  }

  async function debug(chromeId: number, method: string, params?: object) {
    await attach(chromeId);
    return chrome.debugger.sendCommand({ tabId: chromeId }, method, params);
  }

  async function evaluate(chromeId: number, expression: string): Promise<unknown> {
    const result = (await debug(chromeId, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'The script threw');
    }
    return result.result?.value;
  }

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const log = source.tabId !== undefined ? consoleLogs.get(source.tabId) : undefined;
    if (!log) return;
    if (method === 'Runtime.consoleAPICalled') {
      const level = { warning: 'warning', error: 'error', assert: 'error', debug: 'debug' }[params.type as string] ?? 'info';
      const message = (params.args ?? []).map((a: any) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type))).join(' ');
      const frame = params.stackTrace?.callFrames?.[0];
      log.push({ level, message, source: frame ? `${frame.url}:${frame.lineNumber + 1}` : '', time: params.timestamp ?? Date.now() });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      log.push({ level: 'error', message: d.exception?.description ?? d.text ?? 'Uncaught exception', source: d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}` : '', time: params.timestamp ?? Date.now() });
    } else if (method === 'Log.entryAdded') {
      const e = params.entry ?? {};
      const level = e.level === 'verbose' ? 'debug' : e.level === 'warning' || e.level === 'error' ? e.level : 'info';
      log.push({ level, message: e.text ?? '', source: e.url ? `${e.url}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ''}` : '', time: e.timestamp ?? Date.now() });
    } else if (method === 'Runtime.executionContextsCleared') {
      // A new page; Electron's log kept going across navigations too, so leave it.
    }
    if (log.length > 500) log.splice(0, log.length - 500);
  });
  chrome.debugger.onDetach.addListener((source) => source.tabId !== undefined && forget(source.tabId));
  chrome.tabs.onRemoved.addListener((chromeId) => forget(chromeId));

  // ---- the central AI provider (native-host/ai/registry.ts) -----------------------------
  // Settings › AI and the panel's model menu ask through here. The API key goes one way, to
  // the host (and on into the Keychain); nothing that comes back carries a key or a token.

  let aiView: AiView | undefined;
  /** The tab a ChatGPT sign-in opened, closed again once the host says it finished. */
  let loginTab: string | undefined;
  const loginPending = () => !!aiView?.providers.some((p) => p.loginPending);

  function aiChanged(view: AiView) {
    aiView = view;
    broadcast('ai:changed', view);
    if (loginTab && !loginPending()) {
      const signedIn = view.providers.some((p) => p.id === 'codex' && p.ready);
      // Signed in: the sign-in page has done its job. Failed or cancelled: leave it, it says why.
      if (signedIn && store.state.tabs[loginTab]) ctx.tabs.close(loginTab);
      loginTab = undefined;
    }
  }

  handle({
    'ai:request': async (request: AiRequest) => {
      const reply = await call('ai', request);
      // The sign-in page opens in a Uranus Browser tab, in front, so the user sees it.
      if (reply.authUrl && /^https:\/\//.test(reply.authUrl)) loginTab = ctx.tabs.open(reply.authUrl, false);
      aiChanged(reply.view);
      return reply.view;
    },
    /** The latest view without asking the host again (pages that just opened). */
    'ai:cached': () => aiView,
  });

  // ---- the Agent panel ------------------------------------------------------------
  // Its conversation runs in the host (which holds the API key and checks every action);
  // this side shows it and runs the browser tools the host has cleared.

  let chat: ChatSnapshot | undefined;
  const chatBusy = () => !!chat && chat.status !== 'idle';

  // Meetings: the host's latest word on joinly. While the bot is in (or joining) a meeting
  // the host stays up.
  let joinlyView: import('../shared/joinly').JoinlyView | undefined;
  const joinlyActive = () => !!joinlyView && (joinlyView.status === 'joined' || !!joinlyView.phase);

  /** Sends the host what the user did in the Meetings sheet. */
  function joinlyAction(message: Extract<ToHost, { type: 'joinly' }>) {
    try {
      post(message);
    } catch (err) {
      console.warn('Uranus Browser shell: no helper for meetings:', err);
      setHostError(NOT_INSTALLED);
      ctx.onJoinly?.(undefined, NOT_INSTALLED);
    }
  }

  const chatTools: Record<string, (args: Record<string, any>) => Promise<AgentResult>> = {
    agent_remember: (args: Record<string, any>) => ctx.remember(args),
    agent_readFile: (args: Record<string, any>) => ctx.readFile(args),
    agent_saveSkill: (args: Record<string, any>) => ctx.saveSkill(args),
    ...browserAgentTools({
    activeTab: () => {
      const tab = store.activeTab;
      return tab && { id: tab.id, title: tab.customTitle || tab.title, url: tab.url };
    },
    listTabs,
    hasTab: (id) => !!store.state.tabs[id],
    activate: (id) => ctx.tabs.activate(id),
    open: (url) => ctx.tabs.open(url, false),
    target: (id, action) => target(id ?? undefined, action),
    bringForward,
    debug,
    pressKey,
    settle,
    pointAt: ctx.pointAt,
  })};

  /** Sends the host what the user did in the panel. */
  function chatAction(action: ChatAction) {
    try {
      post({ type: 'chat', ...action });
      if (action.action === 'hello' && chat) ctx.onChat(chat);
    } catch (err) {
      console.warn('Uranus Browser shell: no helper for the Agent panel:', err);
      setHostError(NOT_INSTALLED);
      ctx.onChat(undefined, NOT_INSTALLED);
    }
  }

  async function pressKey(chromeId: number, key: string) {
    const named: Record<string, [code: string, keyCode: number, text?: string]> = {
      Enter: ['Enter', 13, '\r'],
      Tab: ['Tab', 9],
      Escape: ['Escape', 27],
      Backspace: ['Backspace', 8],
      Delete: ['Delete', 46],
      ArrowLeft: ['ArrowLeft', 37],
      ArrowUp: ['ArrowUp', 38],
      ArrowRight: ['ArrowRight', 39],
      ArrowDown: ['ArrowDown', 40],
      Home: ['Home', 36],
      End: ['End', 35],
      PageUp: ['PageUp', 33],
      PageDown: ['PageDown', 34],
      ' ': ['Space', 32, ' '],
    };
    const [code, keyCode, keyText] =
      named[key] ?? (key.length === 1 ? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key] : [key, 0]);
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await debug(chromeId, 'Input.dispatchKeyEvent', { type: keyText ? 'keyDown' : 'rawKeyDown', ...base, text: keyText, unmodifiedText: keyText });
    await debug(chromeId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  return {
    /** For UiState.agent: what a coding agent is doing, for the sidebar. */
    agentActivity(): UiState['agent'] {
      return (
        activity && {
          connected: Date.now() - activity.at < 60_000,
          busy: Date.now() - activity.at < 3_500,
          tabId: activity.tabId,
          action: activity.action,
        }
      );
    },
    /** The bridge's address while it runs, for Settings. */
    agentEndpoint: () => endpoint,
    /** Why the host last failed to start or stopped, for Settings; undefined once it works. */
    hostError: () => hostError,
    chat: chatAction,
    chatSnapshot: () => chat,
    joinly: joinlyAction,
    joinlyActive,
    /** Meeting notes: a call to the host, and a way to hear that it went away. */
    callHost: call,
    onHostLost: (fn: () => void) => void lostListeners.push(fn),
    /** The meeting reminder's floating panel (calendar.ts), and what is clicked on it. */
    showReminder,
    onReminderAction: (fn: (id: string, action: ReminderAction) => void) => void reminderListeners.push(fn),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const text = (value: unknown): AgentResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string): AgentResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Waits for navigation the last action may have started, up to a few seconds. */
async function settle(chromeId: number) {
  await wait(150);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(chromeId).catch(() => undefined);
    if (!tab || tab.status !== 'loading') return;
    await wait(100);
  }
}

function centerOf(selector: string) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return undefined;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return undefined;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** Scales a base64 PNG down to `width` pixels wide, as Electron's bridge did. */
async function shrink(png: string, width: number): Promise<string> {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (image.width <= width) return png;
  const height = Math.round((image.height * width) / image.width);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(binary);
}
