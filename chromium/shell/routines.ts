/**
 * Routines, from the background: saved per profile (lib/routinesState.ts), scheduled with
 * chrome.alarms, and run through the Agent panel's own conversation (shell/agentPanel.ts), so
 * a routine meets the same approval cards as anything else. They run only while Uranus Browser is open.
 *
 * What the scheduler promises:
 *  - A routine that comes due while Uranus Browser is open and the agent is free starts at once: the
 *    panel opens (approvals appear there), a new conversation begins as the routine's
 *    companion, and its instructions are sent as the user's message.
 *  - If the agent is busy it waits its turn; it never interleaves with another conversation.
 *  - What came due while Uranus Browser was closed (or the computer slept, or the wait was long) is
 *    "overdue": it waits for the user's Run now or Skip. Nothing runs late on its own.
 *  - Nothing is approved on its own. A card nobody answers for 10 minutes stops the run
 *    (declined, nothing done) and the run is recorded as "needed you".
 *  - One run at a time, and a trimmed copy of each is kept as a record.
 */
import type { ChatAction, ChatEntry, ChatSnapshot } from '../shared/browserAgent';
import { APPROVAL_TIMEOUT_MS, MAX_ROUTINES, meetingMessage, nearestMeeting, type MeetingSlot, type Routine, type RunRecord, type RunStatus } from '../shared/routines';
import { broadcast, handle } from './hub';
import * as store from './lib/routinesState';

/** How long a run may take to show its first sign of life before it counts as not started. */
export const START_TIMEOUT_MS = 45_000;
/** After asking the host to stop a run nobody answered, how long to wait for it to say so. */
const STOP_GRACE_MS = 10_000;

export interface RoutinesPanel {
  /** Opens the panel, switches to the companion, starts a new conversation and sends the text. */
  begin(job: { companionId: string; text: string; routine: { id: string; name: string } }): Promise<{ error?: string }>;
  chat(action: ChatAction): void;
  snapshot(): ChatSnapshot | undefined;
  choices(): Promise<Array<{ id: string; name: string; hue: number }>>;
}

export interface RoutinesContext {
  /** Absent in private windows, which have no agent and so no routines. */
  panel?: RoutinesPanel;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Where its handlers and events go: the hub's, unless a test says otherwise. */
  register?(handlers: Record<string, (...args: any[]) => unknown>): void;
  broadcast?(name: string, ...args: unknown[]): void;
  /** The connected calendar (shell/calendar.ts), for routines that run around meetings. */
  calendar?(): Promise<{ connected: boolean; meetings: MeetingSlot[] }>;
  /** A recorded meeting's notes for a calendar meeting, already fenced as untrusted (shell/meetings.ts). */
  meetingNotes?(meeting: MeetingSlot): Promise<string | undefined>;
}

export type RoutineStatus = 'running' | 'off' | 'finished' | 'overdue' | 'waiting' | 'scheduled';

/** What the sheet draws. */
export interface RoutineView extends Routine {
  status: RoutineStatus;
  /** Undefined when the companion has been removed. */
  companionName?: string;
  recordCount: number;
  lastRun?: { status: RunStatus; at: number };
}

export interface RoutinesView {
  available: boolean;
  routines: RoutineView[];
  overdue: number;
  /** The agent is working, so a routine can't start now. */
  busy: boolean;
  companions: Array<{ id: string; name: string; hue: number }>;
  limit: number;
  /** Whether a calendar is connected, and how many meetings it has coming up: meeting routines need one. */
  calendar: { connected: boolean; upcoming: number };
}

interface Active {
  routineId: string;
  recordId: string;
  name: string;
  text: string;
  /** The panel has said the conversation is new (an empty transcript): later snapshots are ours. */
  reset: boolean;
  started: boolean;
  sawBusy: boolean;
  entries: readonly ChatEntry[];
  card?: { id: string; timer: unknown };
  timedOut?: boolean;
  /** The user pressed New conversation while it ran. */
  userReset?: boolean;
  startTimer?: unknown;
  stopTimer?: unknown;
}

const SESSION_KEY = 'routinesSession';
const UNAVAILABLE = 'Routines aren’t available in private windows.';
const BUSY = 'The agent is busy. Try again when it has finished.';
const GONE = 'That routine doesn’t exist any more.';

const newId = () => crypto.randomUUID().slice(0, 8);

export function registerRoutines(ctx: RoutinesContext) {
  const panel = ctx.panel;
  const now = ctx.now ?? Date.now;
  const later = ctx.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const register = ctx.register ?? handle;
  const emit = ctx.broadcast ?? broadcast;
  const cancel = ctx.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: store.RoutinesState = store.EMPTY_STATE;
  let active: Active | undefined;
  let choices: Array<{ id: string; name: string; hue: number }> = [];
  let saving: Promise<unknown> = Promise.resolve();
  let lastBusy = false;
  let calendar: { connected: boolean; meetings: MeetingSlot[] } = { connected: false, meetings: [] };

  // ---- loading, saving, alarms ------------------------------------------------------------

  async function wasRestarted() {
    // Session storage lives as long as the browser does: if it's empty, Uranus Browser was started
    // since the last time we ran, and what came due meanwhile is overdue.
    try {
      const session = chrome.storage.session;
      const got = await session.get(SESSION_KEY);
      await session.set({ [SESSION_KEY]: now() });
      return !got[SESSION_KEY];
    } catch {
      return true;
    }
  }

  const loaded = panel
    ? (async () => {
        const [saved, launch, cal] = await Promise.all([store.loadState(chrome.storage.local, now()), wasRestarted(), ctx.calendar?.().catch(() => undefined)]);
        if (cal) calendar = cal;
        state = store.resume(saved, now(), launch, calendar.meetings);
        await refreshChoices();
        commit(state);
        void drain();
      })()
    : Promise.resolve();

  async function refreshChoices() {
    choices = (await panel?.choices()) ?? choices;
  }
  const companionExists = (id: string) => choices.some((c) => c.id === id);
  const companionName = (id: string) => choices.find((c) => c.id === id)?.name;

  /** Keeps a new state: shown, saved, and the alarms made to match. */
  function commit(next: store.RoutinesState) {
    state = next;
    emit('routines', view());
    saving = saving.then(() => store.saveState(chrome.storage.local, state)).catch((err) => console.warn('Uranus Browser routines: could not save', err));
    void syncAlarms();
    return saving;
  }

  async function syncAlarms() {
    const wanted = new Map(store.wantedAlarms(state).map((a) => [a.name, a.when]));
    const existing = await chrome.alarms.getAll();
    for (const alarm of existing) {
      if (alarm.name.startsWith(store.ALARM_PREFIX) && wanted.get(alarm.name) !== alarm.scheduledTime) await chrome.alarms.clear(alarm.name);
    }
    const kept = new Set(existing.filter((a) => wanted.get(a.name) === a.scheduledTime).map((a) => a.name));
    for (const [name, when] of wanted) if (!kept.has(name)) await chrome.alarms.create(name, { when });
  }

  // ---- what the sheet sees ------------------------------------------------------------------

  const idle = () => {
    const s = panel?.snapshot();
    return !active && (!s || s.status === 'idle');
  };

  function view(): RoutinesView {
    return {
      available: !!panel,
      busy: !idle(),
      overdue: store.overdueCount(state),
      companions: choices,
      limit: MAX_ROUTINES,
      calendar: { connected: calendar.connected, upcoming: calendar.meetings.filter((m) => m.start > now()).length },
      routines: state.routines.map((r) => {
        const records = store.recordsFor(state, r.id);
        const last = records.find((x) => x.status !== 'skipped') ?? records[0];
        const status: RoutineStatus =
          active?.routineId === r.id ? 'running' : !r.enabled ? 'off' : r.finished ? 'finished' : r.pending?.state === 'overdue' ? 'overdue' : r.pending?.state === 'waiting' ? 'waiting' : 'scheduled';
        return { ...r, status, companionName: companionName(r.companionId), recordCount: records.length, lastRun: last && { status: last.status, at: last.finishedAt ?? last.startedAt } };
      }),
    };
  }

  // ---- due, waiting, running ----------------------------------------------------------------

  /** Time has passed: note what came due, and start what is waiting if the agent is free. */
  function refresh() {
    let next = store.markDue(state, now(), { meetings: calendar.meetings });
    // The routine that is running when its next time comes round is skipped, not queued behind itself.
    if (active) {
      const r = next.routines.find((x) => x.id === active!.routineId);
      if (r?.pending && !state.routines.find((x) => x.id === r.id)?.pending) {
        next = store.addSkipped(store.clearPending(next, r.id), recordInit(r), 'The previous run was still going.');
      }
    }
    if (next !== state) void commit(next);
    void drain();
  }

  const recordInit = (routine: Routine): store.RecordInit => ({ id: newId(), routine, companionName: companionName(routine.companionId) ?? '', now: now() });

  async function drain() {
    if (!panel || !idle()) return;
    const waiting = store.nextWaiting(state);
    if (waiting) await start(waiting.id);
  }

  /** Starts a routine's run. Says why not when it can't. */
  async function start(id: string): Promise<{ error?: string }> {
    if (!panel) return { error: UNAVAILABLE };
    const routine = store.findRoutine(state, id);
    if (!routine) return { error: GONE };
    if (!idle()) return { error: BUSY };
    // Taken before anything is awaited, so nothing else can start meanwhile.
    const run: Active = { routineId: id, recordId: newId(), name: routine.name, text: routine.instructions, reset: false, started: false, sawBusy: false, entries: [] };
    active = run;
    // A meeting routine says which meeting it is for (the one it came due for; for Run now, the
    // nearest), and after a meeting, its notes if the user recorded it.
    if (routine.trigger.kind === 'meeting') {
      const meeting = routine.pending?.meeting ?? nearestMeeting(routine.trigger, now(), calendar.meetings);
      const notes = meeting && routine.trigger.when === 'after' ? await ctx.meetingNotes?.(meeting).catch(() => undefined) : undefined;
      run.text = meetingMessage(routine.instructions, routine.trigger, meeting, notes, now());
    }
    await refreshChoices();
    const companion = choices.find((c) => c.id === routine.companionId);
    await commit(store.startRecord(store.clearPending(state, id), { id: run.recordId, routine, companionName: companion?.name ?? '', now: now() }));
    if (!companion) {
      finish(run, 'failed', 'Its companion was removed. Edit the routine to pick another.');
      return { error: 'Its companion was removed. Edit the routine to pick another.' };
    }
    const began = await panel.begin({ companionId: companion.id, text: run.text, routine: { id: routine.id, name: routine.name } });
    if (began.error) {
      finish(run, 'failed', began.error);
      return began;
    }
    if (active === run && !run.sawBusy) {
      run.startTimer = later(() => {
        if (active === run && !run.sawBusy && !run.started) finish(run, 'failed', 'The agent didn’t start. Check that it is set up.');
      }, START_TIMEOUT_MS);
    }
    return {};
  }

  /** Ends the run: the record is closed with a trimmed copy of the conversation. */
  function finish(run: Active, status: RunStatus, reason?: string) {
    if (active !== run) return;
    active = undefined;
    for (const t of [run.startTimer, run.stopTimer, run.card?.timer]) if (t !== undefined) cancel(t);
    void commit(store.finishRecord(state, run.recordId, { status, reason, entries: run.entries, now: now() }));
    void drain();
  }

  /** The host says what the conversation looks like now (or, undefined, that its helper stopped). */
  function onChat(snapshot: ChatSnapshot | undefined) {
    const run = active;
    // The sheet disables Run now while the agent works.
    const busy = !idle();
    if (busy !== lastBusy) {
      lastBusy = busy;
      emit('routines', view());
    }
    if (!run) {
      if (snapshot?.status === 'idle') void loaded.then(drain);
      return;
    }
    if (!snapshot) return finish(run, 'failed', 'The agent’s helper stopped.');
    // Everything before the new conversation's empty transcript is the old one (or the panel saying hello).
    if (!run.reset) {
      if (snapshot.entries.length === 0) run.reset = true;
      return;
    }
    const own = snapshot.entries.some((e) => e.kind === 'user' && e.text === run.text);
    if (own) {
      run.started = true;
      run.entries = snapshot.entries;
    } else if (run.started) {
      return finish(run, 'stopped', run.userReset ? 'You started a new conversation.' : 'The conversation was cleared.');
    }
    if (snapshot.status !== 'idle' && !run.sawBusy) {
      run.sawBusy = true;
      if (run.startTimer !== undefined) cancel(run.startTimer);
    }
    watchCards(run, snapshot.entries);
    if (!own || snapshot.status !== 'idle') return void emit('routines', view());
    const notices = snapshot.entries.filter((e): e is Extract<ChatEntry, { kind: 'notice' }> => e.kind === 'notice');
    const error = notices.filter((n) => n.tone === 'error').at(-1);
    // Idle straight after the message went in, without an error, means the run hasn't begun yet.
    if (!run.sawBusy && !error) return;
    if (run.userReset) return finish(run, 'stopped', 'You started a new conversation.');
    if (run.timedOut) return finish(run, 'needed-you', 'Nobody answered an approval card for 10 minutes, so it was declined and the run stopped. Nothing was done.');
    if (notices.some((n) => n.text === 'Stopped.')) return finish(run, 'stopped', 'You stopped it.');
    if (error) return finish(run, 'failed', error.text);
    finish(run, 'done');
  }

  /** An approval card nobody answers stops the run. Each new card starts the clock again. */
  function watchCards(run: Active, entries: readonly ChatEntry[]) {
    const card = [...entries].reverse().find((e) => e.kind === 'approval' && e.state === 'pending');
    if (!card) {
      if (run.card) cancel(run.card.timer);
      run.card = undefined;
      return;
    }
    if (run.card?.id === card.id) return;
    if (run.card) cancel(run.card.timer);
    run.card = {
      id: card.id,
      timer: later(() => {
        if (active !== run || run.card?.id !== card.id) return;
        run.timedOut = true;
        // Stopping declines the card: nothing was done. If the host never says so, close the record anyway.
        panel?.chat({ action: 'stop' });
        run.stopTimer = later(() => finish(run, 'needed-you', 'Nobody answered an approval card for 10 minutes. Nothing was done.'), STOP_GRACE_MS);
      }, APPROVAL_TIMEOUT_MS),
    };
  }

  // ---- the sheet's requests -----------------------------------------------------------------

  const reply = async (result: store.Result<object>, keep?: Record<string, unknown>) => {
    if (!result.ok) return { error: result.reason, field: result.field };
    await commit(result.state);
    void drain();
    return { ...keep };
  };

  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R> | R) =>
    async (...args: A): Promise<R | { error: string }> => {
      if (!panel) return { error: UNAVAILABLE };
      await loaded;
      return fn(...args);
    };

  register({
    'routines:get': async (): Promise<RoutinesView> => {
      await loaded;
      await refreshChoices();
      if (panel) refresh();
      return view();
    },
    'routines:save': guarded(async (input: unknown) => {
      await refreshChoices();
      const saved = store.saveRoutine(state, input, { now: now(), newId, companionExists, meetings: calendar.meetings });
      return reply(saved, saved.ok ? { id: saved.id } : undefined);
    }),
    'routines:setEnabled': guarded(async (id: string, enabled: boolean) => {
      const result = store.setEnabled(state, String(id), !!enabled, now(), calendar.meetings);
      return reply(result);
    }),
    'routines:remove': guarded(async (id: string) => {
      if (active?.routineId === id) return { error: 'It is running now. Stop it first.' };
      return reply(store.removeRoutine(state, String(id)));
    }),
    /** Run now: also what an overdue item's button does. Not while the agent is busy. */
    'routines:runNow': guarded(async (id: string) => start(String(id))),
    /** Skip: an overdue or waiting run is dropped, and kept as a "skipped" record. */
    'routines:skip': guarded(async (id: string) => {
      const routine = store.findRoutine(state, String(id));
      if (!routine?.pending) return { error: 'There is nothing waiting to skip.' };
      await commit(store.addSkipped(store.clearPending(state, routine.id), recordInit(routine), 'You skipped this run.'));
      return {};
    }),
    'routines:history': guarded(async (id: string): Promise<{ records: RunRecord[] }> => ({ records: store.recordsFor(state, String(id)) })),
    'routines:deleteRecord': guarded(async (recordId: string) => reply(store.deleteRecord(state, String(recordId)))),
    'routines:clearHistory': guarded(async (routineId: string) => {
      await commit(store.clearHistory(state, String(routineId)));
      return {};
    }),
  });

  return {
    /** An alarm fired (background.ts listens for them in the first turn). */
    onAlarm: async (name: string) => {
      if (!name.startsWith(store.ALARM_PREFIX)) return;
      await loaded;
      refresh();
    },
    onChat,
    /** The calendar's meetings changed: meeting routines follow (a moved meeting moves its run). */
    onCalendar: async (next: { connected: boolean; meetings: MeetingSlot[] }) => {
      await loaded;
      calendar = next;
      refresh();
      emit('routines', view());
    },
    /**
     * What the panel asks the host to do, as it passes (background.ts): "New conversation" ends
     * a routine's run, and the host reports that as a plain idle, so it is noted here.
     */
    onAction: (action: ChatAction) => {
      if (active?.reset && action.action === 'reset') active.userReset = true;
    },
    /** For tests and diagnostics. */
    loaded,
  };
}
