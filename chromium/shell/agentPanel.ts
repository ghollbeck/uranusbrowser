/**
 * The Agent panel, from the background: where it is (lib/agentPanelState.ts, saved per
 * profile) and its conversation, which runs in the native host. Frame pages apply the
 * layout with chrome.anusPrivate.setAgentPanel; the panel page (agent.html) draws the
 * conversation and sends what the user does. Nothing here sees the API key.
 */
import type { AgentResult } from '../shared/agentTools';
import { REASONING_EFFORTS, type ChatAction, type ChatEntry, type ChatSnapshot, type ModelChoice, type ReasoningEffort } from '../shared/browserAgent';
import type { Companion } from '../shared/companions';
import { MAX_FILE_BYTES, cleanFileName, cleanFileText, kindOf, readWindow, sizeLabel, type ExtractReply, type ExtractRequest } from '../shared/knowledge';
import { draftFromRun, type RunForDraft } from '../shared/skills';
import { broadcast, handle, onConnect } from './hub';
import { clampFloat, close, dock, float, loadLayout, resize, saveLayout, toggle, type FloatRect, type PanelLayout, type PanelSide } from './lib/agentPanelState';
import * as people from './lib/companionsState';

export interface AgentPanelContext {
  /** The host's chat, once the native host is up; undefined in incognito. */
  chat?(action: ChatAction): void;
  chatSnapshot?(): ChatSnapshot | undefined;
  /** Meetings: the saved setting (on or off, and where joinly is), added to each message by the shell. */
  joinlyConfig?(): Promise<import('../shared/joinly').JoinlyConfig>;
  /** The OpenAI API key's models, the chat's default model and its provider, from the native host. */
  models?(): Promise<{ models: string[]; default: string; provider?: string } | undefined>;
  /** A PDF or document's text, from the native host (native-host/fileText.ts). */
  extractText?(request: ExtractRequest): Promise<ExtractReply>;
}

/** The composer's modes: each is a model and how hard it thinks, which you can change. */
export type ModeId = 'efficient' | 'default' | 'expert';
export const MODE_IDS: readonly ModeId[] = ['efficient', 'default', 'expert'];
export interface ChoiceState {
  mode: ModeId;
  /** Your own model or effort per mode; unset parts follow the defaults. */
  own: Partial<Record<ModeId, Partial<ModelChoice>>>;
}
/** What the selector draws. */
export interface ChoiceView {
  mode: ModeId;
  /** Default's model is the chat's own (Settings › AI, the model menu); the others pick one. */
  modes: Record<ModeId, { model: string; effort: ReasoningEffort; changed: boolean }>;
  models: string[];
  /** The chat's provider: Efficient and Expert pick models only for the OpenAI API key. */
  provider?: string;
}

/** A saved conversation, as the history list shows it. */
export interface ThreadSummary {
  id: string;
  title: string;
  companion: { name: string; hue: number };
  updatedAt: number;
  unread: boolean;
  current: boolean;
}
interface SavedThread extends Omit<ThreadSummary, 'current'> {
  entries: ChatEntry[];
}

const THREADS_KEY = 'agentThreads';
const CHOICE_KEY = 'agentChoice';
const MAX_THREADS = 50;
const MAX_THREAD_ENTRIES = 150;

/** What the panel page draws: every companion, which is active, and each one's notes, context, files and skills. */
export interface CompanionsView {
  active: string;
  companions: Companion[];
  memory: people.CompanionsState['memory'];
  context: people.CompanionsState['context'];
  files: people.CompanionsState['files'];
  skills: people.CompanionsState['skills'];
}

const newId = () => crypto.randomUUID().slice(0, 8);

/** What frame pages and the panel page get: the layout, plus a window to focus the panel in. */
export interface PanelEvent extends PanelLayout {
  focusWindow?: number;
}

export function registerAgentPanel(ctx: AgentPanelContext) {
  const storage = chrome.storage.local;
  let layout: PanelLayout = { open: false, side: 'right', width: 400 };
  const loaded = loadLayout(storage).then((saved) => {
    layout = { ...saved, open: layout.open };
    send();
  });

  // Companions and their notes: saved per profile, shown in the panel, sent to the host
  // (never the other way round) with each message.
  let companions: people.CompanionsState = people.DEFAULT_STATE;
  const companionsLoaded = people.loadState(storage).then((saved) => {
    companions = saved;
    sendCompanions();
  });

  const view = (): CompanionsView => ({
    active: companions.active,
    companions: people.allCompanions(companions),
    memory: companions.memory,
    context: companions.context,
    files: companions.files,
    skills: companions.skills,
  });
  function sendCompanions() {
    broadcast('companions', view());
  }
  /** Keeps a change if it was allowed; says why not if it wasn't. */
  async function commit(result: people.Result<object>): Promise<{ error?: string }> {
    await companionsLoaded;
    if (!result.ok) return { error: result.reason };
    companions = result.state;
    sendCompanions();
    await people.saveState(storage, companions);
    return {};
  }

  // ---- the composer's model choice -------------------------------------------------------

  let choice: ChoiceState = { mode: 'default', own: {} };
  let models: { models: string[]; default: string; provider?: string } | undefined;
  const choiceLoaded = storage.get(CHOICE_KEY).then((saved) => {
    const c = saved[CHOICE_KEY] as ChoiceState | undefined;
    if (c && MODE_IDS.includes(c.mode)) choice = { mode: c.mode, own: c.own && typeof c.own === 'object' ? c.own : {} };
  });

  /** Each mode's defaults, from the models this account has. */
  function presets(): Record<ModeId, { model: string; effort: ReasoningEffort }> {
    const base = models?.default ?? 'gpt-5.4-mini';
    const have = (name: string) => !models?.models.length || models.models.includes(name);
    const family = base.replace(/-(mini|nano)$/, '');
    const nano = `${family}-nano`;
    return {
      efficient: { model: models?.models.includes(nano) ? nano : base, effort: 'low' },
      default: { model: base, effort: 'low' },
      expert: { model: family !== base && have(family) ? family : base, effort: 'high' },
    };
  }
  function resolved(mode: ModeId): { model: string; effort: ReasoningEffort; changed: boolean } {
    const own = choice.own[mode] ?? {};
    const preset = presets()[mode];
    // Default's model is always the chat's own.
    const model = mode === 'default' ? preset.model : (own.model ?? preset.model);
    return { model, effort: own.effort ?? preset.effort, changed: (mode !== 'default' && own.model !== undefined) || own.effort !== undefined };
  }
  const choiceView = (): ChoiceView => ({
    mode: choice.mode,
    modes: { efficient: resolved('efficient'), default: resolved('default'), expert: resolved('expert') },
    models: models?.models ?? [],
    provider: models?.provider,
  });
  /** Fresh each time the selector opens: the chat's model and provider change in the model menu. */
  async function fetchModels() {
    models = (await ctx.models?.().catch(() => undefined)) ?? models;
  }

  // ---- the history list ---------------------------------------------------------------------

  let threads: SavedThread[] = [];
  const threadsLoaded = storage.get(THREADS_KEY).then((saved) => {
    const list = saved[THREADS_KEY];
    if (Array.isArray(list)) threads = list.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.entries)).slice(0, MAX_THREADS);
  });
  let currentThread: string | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const summaries = (): ThreadSummary[] =>
    threads.map(({ entries: _entries, ...t }) => ({ ...t, current: t.id === currentThread }));
  function threadsChanged() {
    broadcast('agentThreads', summaries());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void storage.set({ [THREADS_KEY]: threads }), 600);
  }

  /** Files the conversation under its id: titled by its first message, newest first. */
  async function record(snapshot: ChatSnapshot) {
    await threadsLoaded;
    if (!snapshot.threadId) return;
    const switched = currentThread !== snapshot.threadId;
    currentThread = snapshot.threadId;
    const first = snapshot.entries.find((e) => e.kind === 'user');
    const existing = threads.find((t) => t.id === snapshot.threadId);
    if (!first) {
      if (switched) broadcast('agentThreads', summaries());
      return;
    }
    const entries = snapshot.entries.slice(-MAX_THREAD_ENTRIES);
    const grew = !existing || existing.entries.length !== entries.length || JSON.stringify(existing.entries.at(-1)) !== JSON.stringify(entries.at(-1));
    if (!grew && !switched) return;
    const finished = snapshot.status === 'idle' && entries.at(-1)?.kind !== 'user';
    const thread: SavedThread = {
      id: snapshot.threadId,
      title: (first.kind === 'user' ? first.text : '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'New conversation',
      companion: existing?.companion ?? (() => {
        const c = people.activeCompanion(companions);
        return { name: c.name, hue: c.hue };
      })(),
      updatedAt: grew ? Date.now() : (existing?.updatedAt ?? Date.now()),
      // Finished while you weren't looking: a dot until you open it.
      unread: grew && finished && !layout.open ? true : (existing?.unread ?? false) && !layout.open,
      entries,
    };
    threads = [thread, ...threads.filter((t) => t.id !== thread.id)].slice(0, MAX_THREADS);
    threadsChanged();
  }

  function send(focusWindow?: number) {
    broadcast('agentPanel', { ...layout, focusWindow } satisfies PanelEvent);
  }

  function set(next: PanelLayout, focusWindow?: number) {
    const opened = next.open && !layout.open;
    const moved = next.side !== layout.side || next.width !== layout.width || JSON.stringify(next.float) !== JSON.stringify(layout.float);
    layout = next;
    send(focusWindow);
    if (moved) void saveLayout(storage, layout);
    if (opened) {
      ctx.chat?.({ action: 'hello' });
      // Looking at it now: the open conversation isn't unread any more.
      const current = threads.find((t) => t.id === currentThread);
      if (current?.unread) {
        current.unread = false;
        threadsChanged();
      }
    }
  }

  /**
   * What goes with a message: how hard to think. The model is the chat's own (the composer's
   * Model menu, Settings › AI). The old Efficient and Expert modes, which named an API-key model
   * of their own, are no longer offered; a profile that saved one now just uses its effort.
   */
  function resolvedChoice(): ModelChoice {
    return { effort: resolved('default').effort };
  }

  async function lastWindow() {
    return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined))?.id;
  }

  /** The keyboard shortcut: opening moves focus to the panel's composer, since you asked for it. */
  async function toggleFromKeyboard() {
    await loaded;
    const opening = !layout.open;
    set(toggle(layout), opening ? await lastWindow() : undefined);
    if (!opening) await focusPage();
  }

  async function focusPage() {
    const id = await lastWindow();
    if (id !== undefined && typeof chrome.anusPrivate?.focus === 'function') await chrome.anusPrivate.focus('page', id).catch(() => undefined);
  }

  handle({
    'agentPanel:get': async () => {
      await loaded;
      return { ...layout, chat: ctx.chatSnapshot?.() };
    },
    /** The toolbar button: no focus change; the page keeps the keyboard. */
    'agentPanel:toggle': async () => {
      await loaded;
      set(toggle(layout));
    },
    toggleAgentPanel: () => toggleFromKeyboard(),
    /** Escape or the close button: closed, and the keyboard goes back to the page. */
    'agentPanel:close': async () => {
      set(close(layout));
      await focusPage();
    },
    'agentPanel:dock': (side: PanelSide) => set(dock(layout, side === 'left' ? 'left' : 'right')),
    /** Dropped in the middle of the window: it floats there, over the page. */
    'agentPanel:float': (rect: FloatRect) => {
      if (!rect || typeof rect !== 'object') return;
      set(float(layout, clampFloat(rect)));
    },
    /**
     * While the panel is dragged: where it would land, for the window's frame page to draw
     * (null when the drag ends). Not saved; only the drop is.
     */
    'agentPanel:preview': (preview: { windowId?: number; target: unknown } | null) => broadcast('agentPanel:preview', preview ?? null),
    'agentPanel:resize': (width: number) => set(resize(layout, Number(width))),
    'agent:action': async (action: ChatAction) => {
      if (!ctx.chat) return broadcast('agent:chat', unavailable());
      if (action.action === 'send') {
        // Who the agent works as is whatever is saved here, whatever the page said.
        await companionsLoaded;
        // Only the shell sets these: the scheduler (routines.ts, through `begin`) marks a routine's
        // message, and the saved meeting settings come from storage. Whatever the page sent is dropped.
        const { routine: _routine, joinly: _joinly, ...fromPage } = action;
        const joinly = await ctx.joinlyConfig?.();
        await choiceLoaded;
        // The model is whatever the selector has saved here, not what the page sent. A skill the
        // page picked is only an id: its steps come from what's saved, and only if this companion has it.
        const { choice: _choice, skill, ...rest } = fromPage;
        ctx.chat({ ...rest, companion: people.contextFor(companions, typeof skill === 'string' ? skill : undefined), ...(joinly ? { joinly } : {}), choice: resolvedChoice() });
        return;
      }
      // Going back to a conversation goes through agentThreads:open, with what the shell saved.
      if (action.action === 'open') return;
      ctx.chat(action);
    },
    'agentChoice:get': async () => {
      await choiceLoaded;
      await fetchModels();
      return choiceView();
    },
    /** Picks a mode, or changes the picked (or named) mode's model or effort; `reset` drops your changes. */
    'agentChoice:set': async (change: { mode?: string; model?: string; effort?: string; reset?: boolean }) => {
      await choiceLoaded;
      const mode = MODE_IDS.includes(change?.mode as ModeId) ? (change.mode as ModeId) : choice.mode;
      const own = { ...(choice.own[mode] ?? {}) };
      if (mode !== 'default' && typeof change?.model === 'string' && /^[a-z0-9][a-z0-9.\-]{1,63}$/i.test(change.model)) own.model = change.model;
      if (REASONING_EFFORTS.includes(change?.effort as ReasoningEffort)) own.effort = change.effort as ReasoningEffort;
      choice = { mode, own: { ...choice.own, [mode]: change?.reset ? {} : own } };
      await storage.set({ [CHOICE_KEY]: choice });
      broadcast('agentChoice', choiceView());
      return choiceView();
    },
    'agentThreads:list': async () => {
      await threadsLoaded;
      return summaries();
    },
    /** Back to a saved conversation; not while the agent is working. */
    'agentThreads:open': async (id: string) => {
      await threadsLoaded;
      if (!ctx.chat) return { error: 'The agent isn’t available in this window.' };
      if (ctx.chatSnapshot?.()?.status && ctx.chatSnapshot()!.status !== 'idle') return { error: 'Wait for the agent to finish, or stop it, first.' };
      const thread = threads.find((t) => t.id === String(id));
      if (!thread) return { error: 'That conversation is gone.' };
      if (thread.unread) {
        thread.unread = false;
        threadsChanged();
      }
      ctx.chat({ action: 'open', thread: { id: thread.id, entries: thread.entries } });
      return {};
    },
    'agentThreads:remove': async (id: string) => {
      await threadsLoaded;
      const before = threads.length;
      threads = threads.filter((t) => t.id !== String(id));
      if (threads.length !== before) threadsChanged();
      // The one open now goes too: a fresh conversation takes its place.
      if (String(id) === currentThread) ctx.chat?.({ action: 'reset' });
    },
    'companions:get': async () => {
      await companionsLoaded;
      return view();
    },
    /** A different companion is a different conversation; not while one is running. */
    'companions:select': async (id: string) => {
      await companionsLoaded;
      if (ctx.chatSnapshot?.()?.status && ctx.chatSnapshot()!.status !== 'idle') return { error: 'Wait for the agent to finish, or stop it, first.' };
      const result = await commit(people.select(companions, String(id)));
      if (!result.error) ctx.chat?.({ action: 'reset' });
      return result;
    },
    'companions:save': async (input: unknown) => {
      await companionsLoaded;
      const made = people.saveCompanion(companions, input, newId);
      const changedActive = made.ok && made.state.active !== companions.active;
      const result = await commit(made);
      if (!result.error && changedActive) ctx.chat?.({ action: 'reset' });
      return made.ok ? { ...result, id: made.id } : result;
    },
    'companions:remove': async (id: string) => {
      await companionsLoaded;
      const wasActive = companions.active === id;
      const removed = people.removeCompanion(companions, String(id));
      const result = await commit(removed);
      if (removed.ok && removed.removedFiles.length) await storage.remove(removed.removedFiles.map(people.fileKey));
      if (!result.error && wasActive) ctx.chat?.({ action: 'reset' });
      return result;
    },
    /** Project context: background the user writes once, sent with every message. */
    'companions:setContext': async (companionId: string, text: string) => {
      await companionsLoaded;
      return commit(people.setContext(companions, String(companionId), text));
    },
    /**
     * A file the user picked in the Knowledge tab, as base64. Plain text is decoded here; PDFs
     * and documents go to the native host, which reads them on this Mac. Only the text is kept.
     */
    'companions:addFile': async (companionId: string, file: { name?: unknown; data?: unknown }) => {
      await companionsLoaded;
      const name = cleanFileName(file?.name);
      const kind = kindOf(name);
      if (!kind) return { error: `“${name}” isn’t a kind of file UrAnus Browser can read. Try a PDF, a Word or text file.` };
      if (typeof file?.data !== 'string' || !file.data) return { error: 'The file didn’t arrive.' };
      if (file.data.length * 0.75 > MAX_FILE_BYTES) return { error: `“${name}” is too big (the limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB).` };
      let read: ExtractReply;
      if (kind === 'text') {
        const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
        read = cleanFileText(new TextDecoder('utf-8').decode(bytes));
      } else {
        if (!ctx.extractText) return { error: 'Reading PDFs and documents needs UrAnus Browser’s helper, which isn’t available in this window.' };
        read = await ctx.extractText({ name, data: file.data }).catch((err) => ({ error: err instanceof Error ? err.message : 'The file couldn’t be read.' }));
      }
      if ('error' in read) return { error: read.error };
      const added = people.addFile(companions, String(companionId), { name, kind, chars: read.text.length, truncated: read.truncated }, newId);
      if (!added.ok) return { error: added.reason };
      // The text first: a listed file always has its text.
      await storage.set({ [people.fileKey(added.file.id)]: read.text });
      const result = await commit(added);
      return result.error ? result : { id: added.file.id, note: read.truncated ? `Only the first ${sizeLabel(read.text.length)} were kept.` : undefined };
    },
    'companions:removeFile': async (companionId: string, fileId: string) => {
      await companionsLoaded;
      const result = await commit(people.removeFile(companions, String(companionId), String(fileId)));
      if (!result.error) await storage.remove(people.fileKey(String(fileId)));
      return result;
    },
    /** The start of a file's text, for its preview in the Knowledge tab. */
    'companions:filePreview': async (companionId: string, fileId: string) => {
      await companionsLoaded;
      if (!people.filesFor(companions, String(companionId)).some((f) => f.id === fileId)) return { error: 'That file is gone.' };
      const text = (await storage.get(people.fileKey(String(fileId))))[people.fileKey(String(fileId))];
      return { text: typeof text === 'string' ? text.slice(0, 1200) : '' };
    },
    'companions:saveSkill': async (companionId: string, input: unknown, from?: { kind?: string; name?: string }) => {
      await companionsLoaded;
      const source = from?.kind === 'routine' ? ({ kind: 'routine', name: String(from.name ?? '') } as const) : ({ kind: 'manual' } as const);
      const saved = people.saveSkill(companions, String(companionId), input, source, newId);
      const result = await commit(saved);
      return saved.ok ? { ...result, id: saved.skill.id } : result;
    },
    'companions:removeSkill': async (companionId: string, skillId: string) => {
      await companionsLoaded;
      return commit(people.removeSkill(companions, String(companionId), String(skillId)));
    },
    /** A skill drafted from a routine run (routines sheet): shown in the skill editor, saved only when the user saves it. */
    'companions:draftSkill': (run: RunForDraft) => draftFromRun({ routineName: String(run?.routineName ?? ''), instructions: String(run?.instructions ?? ''), transcript: Array.isArray(run?.transcript) ? run.transcript : [] }),
    /** A note the user typed themselves. */
    'companions:addNote': async (companionId: string, text: string) => {
      await companionsLoaded;
      return commit(people.addNote(companions, String(companionId), text, newId));
    },
    'companions:removeNote': async (companionId: string, noteId: string) => {
      await companionsLoaded;
      return commit(people.removeNote(companions, String(companionId), String(noteId)));
    },
    'companions:clearNotes': async (companionId: string) => {
      await companionsLoaded;
      return commit({ ok: true, state: people.clearNotes(companions, String(companionId)) });
    },
    /** Take over: the agent stops and the page gets the keyboard back. */
    'agent:takeOver': async () => {
      ctx.chat?.({ action: 'stop' });
      await focusPage();
    },
  });

  onConnect(() => {
    send();
    const snapshot = ctx.chatSnapshot?.();
    if (snapshot) broadcast('agent:chat', snapshot);
  });

  return {
    /**
     * The host has the user's approval to save a note (it showed the card): this is the only
     * way the agent's `remember` reaches storage, and it checks the note again.
     */
    remember: async (args: Record<string, unknown>): Promise<AgentResult> => {
      await companionsLoaded;
      const added = people.addNote(companions, String(args.companionId ?? ''), args.text, newId);
      const result = await commit(added);
      return result.error ? { content: [{ type: 'text', text: result.error }], isError: true } : { content: [{ type: 'text', text: 'Saved to memory.' }] };
    },
    /** The agent's read_file: a window of an attached file's text (the host fences it as untrusted). */
    readFile: async (args: Record<string, unknown>): Promise<AgentResult> => {
      await companionsLoaded;
      const fail = (text: string): AgentResult => ({ content: [{ type: 'text', text }], isError: true });
      const companionId = String(args.companionId ?? '');
      const file = people.filesFor(companions, companionId).find((f) => f.id === args.fileId);
      if (!file) return fail('That file isn’t attached to this companion any more.');
      const key = people.fileKey(file.id);
      const text = (await storage.get(key))[key];
      if (typeof text !== 'string') return fail('That file’s text is missing. Remove the file and add it again.');
      const window = readWindow(text, Number(args.offset) || 0);
      const where = window.next !== undefined ? `\n\n[More: call read_file with offset ${window.next}. ${sizeLabel(text.length - window.next)} left.]` : '\n\n[End of the file.]';
      return { content: [{ type: 'text', text: `File: ${file.name}\n\n${window.text}${where}` }] };
    },
    /** The agent's save_skill, after the user approved it on a card: checked again here. */
    saveSkill: async (args: Record<string, unknown>): Promise<AgentResult> => {
      await companionsLoaded;
      const saved = people.saveSkill(companions, String(args.companionId ?? ''), { name: args.name, when: args.when, steps: args.steps }, { kind: 'chat' }, newId);
      const result = await commit(saved);
      return result.error ? { content: [{ type: 'text', text: result.error }], isError: true } : { content: [{ type: 'text', text: 'Saved.' }] };
    },
    /**
     * For routines (shell/routines.ts): opens the panel (approvals appear there), switches to
     * the routine's companion, starts a new conversation and sends its instructions as the
     * user's message, marked as the routine's. Says why not, if it can't.
     */
    begin: async (job: { companionId: string; text: string; routine: { id: string; name: string } }): Promise<{ error?: string }> => {
      await Promise.all([loaded, companionsLoaded]);
      if (!ctx.chat) return { error: 'The agent isn’t available in this window.' };
      const picked = await commit(people.select(companions, job.companionId));
      if (picked.error) return picked;
      if (!layout.open) set({ ...layout, open: true });
      ctx.chat({ action: 'reset' });
      await choiceLoaded;
      ctx.chat({ action: 'send', text: job.text, routine: job.routine, companion: people.contextFor(companions), choice: resolvedChoice() });
      return {};
    },
    /** The companions routines can pick from, and whether one still exists. */
    companionChoices: async () => {
      await companionsLoaded;
      return people.allCompanions(companions).map((c) => ({ id: c.id, name: c.name, hue: c.hue }));
    },
    /** Who the agent works as now: the name and colour the page overlay shows. */
    companion: () => {
      const c = people.activeCompanion(companions);
      return { name: c.name, hue: c.hue };
    },
    /** Keeps the native host running while the panel is open. */
    wanted: () => layout.open,
    onChat: (snapshot: ChatSnapshot | undefined, problem?: string) => {
      broadcast('agent:chat', snapshot ?? unavailable(problem ?? 'The agent’s helper stopped. Send a message to start again.'));
      if (snapshot) void record(snapshot);
    },
  };
}

function unavailable(detail = 'The agent isn’t available in this window.'): ChatSnapshot {
  return { status: 'idle', entries: [], provider: { id: 'none', label: 'Agent', ready: false, detail } };
}
