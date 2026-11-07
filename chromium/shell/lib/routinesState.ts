/**
 * Routines and their run records, per profile (chrome.storage.local). Plain functions on plain
 * data, so what the scheduler decides is testable without a browser: what comes due, what
 * waits, what a restart turns into "overdue", and what a change to a routine does to its
 * schedule. The checks and the time arithmetic live in shared/routines.ts.
 */
import {
  MAX_ROUTINES,
  MAX_WAIT_MS,
  capRecords,
  checkRoutine,
  checkTrigger,
  cleanName,
  dueState,
  meetingAt,
  nextRun,
  restoreRecord,
  trimTranscript,
  type Routine,
  type RoutineField,
  type RunRecord,
  type RunStatus,
  type Trigger,
  type MeetingSlot,
} from '../../shared/routines';
import type { ChatEntry } from '../../shared/browserAgent';
import { cleanBlock, cleanLine, MAX_INSTRUCTIONS } from '../../shared/companions';

export const ROUTINES_KEY = 'routines';
export const RUNS_KEY = 'routineRuns';

export interface RoutinesState {
  routines: Routine[];
  /** Newest first. */
  records: RunRecord[];
}

export const EMPTY_STATE: RoutinesState = { routines: [], records: [] };

export type Fail = { ok: false; reason: string; field?: RoutineField };
export type Result<Extra extends object = object> = ({ ok: true; state: RoutinesState } & Extra) | Fail;

const finite = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);

export const findRoutine = (state: RoutinesState, id: string) => state.routines.find((r) => r.id === id);
export const overdueCount = (state: RoutinesState) => state.routines.filter((r) => r.pending?.state === 'overdue').length;
export const recordsFor = (state: RoutinesState, routineId: string) => state.records.filter((r) => r.routineId === routineId);

const replace = (state: RoutinesState, id: string, change: (r: Routine) => Routine): RoutinesState => ({
  ...state,
  routines: state.routines.map((r) => (r.id === id ? change(r) : r)),
});

/** A saved trigger, checked again: it came from storage, not from the form. */
function restoreTrigger(raw: unknown, now: number): Trigger | undefined {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Same rules as the form, except that a once-only time may already be past.
  if (t.kind === 'once') return Number.isFinite(t.at) ? { kind: 'once', at: Number(t.at) } : undefined;
  const checked = checkTrigger(t, now);
  return checked.ok ? checked.value : undefined;
}

/** A meeting kept with a pending run, checked again: it came from storage (and, before that, from an invitation). */
function restoreSlot(raw: unknown): MeetingSlot | undefined {
  const m = (raw && typeof raw === 'object' ? raw : undefined) as Partial<MeetingSlot> | undefined;
  if (!m || typeof m.id !== 'string' || !Number.isFinite(m.start) || !Number.isFinite(m.end)) return undefined;
  return { id: m.id.slice(0, 64), title: cleanLine(m.title, 200) || 'Untitled event', start: Number(m.start), end: Number(m.end), platform: cleanLine(m.platform, 40) };
}

/** Saved state, checked: anything odd is dropped, limits hold, and the schedule is worked out afresh. */
export function restore(savedRoutines: unknown, savedRecords: unknown, now: number): RoutinesState {
  const routines: Routine[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(savedRoutines) ? savedRoutines : []) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Routine>;
    const id = typeof r.id === 'string' ? r.id.slice(0, 64) : '';
    const name = cleanName(r.name);
    const instructions = cleanBlock(r.instructions, MAX_INSTRUCTIONS);
    const companionId = typeof r.companionId === 'string' ? r.companionId.slice(0, 64) : '';
    const trigger = restoreTrigger(r.trigger, now);
    if (!id || ids.has(id) || !name || !instructions || !companionId || !trigger || routines.length >= MAX_ROUTINES) continue;
    ids.add(id);
    const pendingState = r.pending?.state === 'waiting' || r.pending?.state === 'overdue' ? r.pending.state : undefined;
    const routine: Routine = { id, name, companionId, instructions, trigger, enabled: r.enabled !== false, createdAt: finite(r.createdAt, now) };
    if (Number.isFinite(r.nextAt)) routine.nextAt = Number(r.nextAt);
    if (pendingState) {
      const meeting = restoreSlot(r.pending?.meeting);
      routine.pending = { since: finite(r.pending?.since, now), state: pendingState, ...(meeting ? { meeting } : {}) };
    }
    if (r.finished) routine.finished = true;
    routines.push(routine);
  }
  const records = capRecords((Array.isArray(savedRecords) ? savedRecords : []).map(restoreRecord).filter((r): r is RunRecord => !!r && ids.has(r.routineId)));
  return { routines, records };
}

/**
 * Brings saved state up to date when the shell starts.
 *  - `launch`: the browser was (re)started. Everything that came due while it was closed, and
 *    everything that was waiting for the agent, becomes overdue: nothing runs on its own.
 *  - otherwise only the background woke up again (the browser stayed open): what came due
 *    moments ago still counts as on time.
 * Runs that were in progress are closed as interrupted: the conversation went with the helper.
 */
export function resume(state: RoutinesState, now: number, launch: boolean, meetings: readonly MeetingSlot[] = []): RoutinesState {
  let next: RoutinesState = {
    ...state,
    records: state.records.map((r) =>
      r.status === 'running' ? { ...r, status: 'failed' as RunStatus, finishedAt: now, reason: 'Uranus Browser closed before the run finished.' } : r,
    ),
  };
  next = {
    ...next,
    routines: next.routines.map((r) => {
      if (r.pending?.state === 'waiting' && launch) r = { ...r, pending: { ...r.pending, state: 'overdue' } };
      if (!r.enabled) return { ...r, nextAt: undefined, pending: undefined };
      return r;
    }),
  };
  next = markDue(next, now, { launch, meetings });
  // Anything not yet due is worked out afresh: a changed time zone or clock moves a daily time.
  return {
    ...next,
    routines: next.routines.map((r) => {
      if (!r.enabled || r.finished || (r.nextAt !== undefined && r.nextAt <= now)) return r;
      const at = nextRun(r.trigger, now, meetings);
      return at === r.nextAt ? r : { ...r, nextAt: at };
    }),
  };
}

/**
 * What came due at `now`. Each enabled routine whose time has passed gets a pending run, and
 * its next time moves on: `waiting` if it's on time (it starts when the agent is free),
 * `overdue` if it was missed. A routine that already has one pending keeps it: due times don't
 * pile up. Waiting runs that waited too long become overdue.
 * `launch`: treat every due time as missed.
 */
export function markDue(state: RoutinesState, now: number, options: { launch?: boolean; meetings?: readonly MeetingSlot[] } = {}): RoutinesState {
  const meetings = options.meetings ?? [];
  return {
    ...state,
    routines: state.routines.map((r) => {
      let routine = r;
      if (routine.pending?.state === 'waiting' && now - routine.pending.since > MAX_WAIT_MS) routine = { ...routine, pending: { ...routine.pending, state: 'overdue' } };
      if (!routine.enabled || routine.finished) return routine;
      let at = routine.nextAt;
      if (at === undefined) {
        // A routine that should have a next time and doesn't (a once-only that never got one).
        at = routine.pending || routine.trigger.kind === 'once' ? undefined : nextRun(routine.trigger, now, meetings);
        return at === undefined ? routine : { ...routine, nextAt: at };
      }
      const due = dueState(at, now);
      if (due === 'not-due') {
        // Meetings move and get cancelled: a meeting trigger's next time follows the calendar.
        if (routine.trigger.kind !== 'meeting' || !options.meetings) return routine;
        const moved = nextRun(routine.trigger, now, meetings);
        return moved === at ? routine : { ...routine, nextAt: moved };
      }
      const state: 'waiting' | 'overdue' = options.launch || due === 'missed' ? 'overdue' : 'waiting';
      // A meeting run remembers which meeting it is for, while the calendar still has it.
      const meeting = meetingAt(routine.trigger, at, meetings);
      const pending = routine.pending ?? { since: at, state, ...(meeting ? { meeting } : {}) };
      return { ...routine, pending, nextAt: nextRun(routine.trigger, now, meetings) };
    }),
  };
}

/** The routine whose run has waited longest for the agent, if any is waiting. */
export function nextWaiting(state: RoutinesState): Routine | undefined {
  return state.routines
    .filter((r) => r.enabled && r.pending?.state === 'waiting')
    .sort((a, b) => a.pending!.since - b.pending!.since)[0];
}

/** Makes or edits a routine. A new one starts on; its schedule counts from `now`. */
export function saveRoutine(
  state: RoutinesState,
  input: unknown,
  ctx: { now: number; newId: () => string; companionExists: (id: string) => boolean; meetings?: readonly MeetingSlot[] },
): Result<{ id: string }> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const existing = typeof raw.id === 'string' && raw.id ? findRoutine(state, raw.id) : undefined;
  if (typeof raw.id === 'string' && raw.id && !existing) return { ok: false, reason: 'That routine doesn’t exist any more.' };
  if (!existing && state.routines.length >= MAX_ROUTINES) return { ok: false, reason: `You can have up to ${MAX_ROUTINES} routines.`, field: 'limit' };
  const keepOnce = existing?.trigger.kind === 'once' ? existing.trigger.at : undefined;
  // An interval counts from where it started, unless its length changed.
  const given = raw.trigger as Record<string, unknown> | undefined;
  const trigger = existing?.trigger.kind === 'interval' && given?.kind === 'interval' && given.minutes === existing.trigger.minutes ? { ...given, anchor: existing.trigger.anchor } : given;
  const checked = checkRoutine({ ...raw, trigger, enabled: raw.enabled ?? existing?.enabled }, ctx.now, ctx.companionExists, keepOnce);
  if (!checked.ok) return checked;
  const v = checked.value;
  if (!existing) {
    const id = ctx.newId();
    const routine: Routine = { id, name: v.name, companionId: v.companionId, instructions: v.instructions, trigger: v.trigger, enabled: v.enabled, createdAt: ctx.now, nextAt: v.enabled ? nextRun(v.trigger, ctx.now, ctx.meetings) : undefined };
    return { ok: true, state: { ...state, routines: [...state.routines, routine] }, id };
  }
  // A new time starts afresh: a once-only that already ran can run again.
  const changedTime = JSON.stringify(existing.trigger) !== JSON.stringify(v.trigger);
  const finished = changedTime ? undefined : existing.finished;
  const nextAt = !v.enabled || finished ? undefined : changedTime || existing.nextAt === undefined ? nextRun(v.trigger, ctx.now, ctx.meetings) : existing.nextAt;
  const next: Routine = { ...existing, name: v.name, companionId: v.companionId, instructions: v.instructions, trigger: v.trigger, enabled: v.enabled, finished, nextAt, pending: v.enabled ? existing.pending : undefined };
  return { ok: true, state: replace(state, existing.id, () => next), id: existing.id };
}

/** Turns a routine on or off. Off: nothing is scheduled and nothing waits. */
export function setEnabled(state: RoutinesState, id: string, enabled: boolean, now: number, meetings: readonly MeetingSlot[] = []): Result {
  const r = findRoutine(state, id);
  if (!r) return { ok: false, reason: 'That routine doesn’t exist any more.' };
  if (!enabled) return { ok: true, state: replace(state, id, (x) => ({ ...x, enabled: false, nextAt: undefined, pending: undefined })) };
  if (r.finished) return { ok: false, reason: 'This routine already ran. Edit its time to run it again.' };
  const at = nextRun(r.trigger, now, meetings);
  // A meeting routine with no meeting coming up is on all the same: it waits for one.
  if (at === undefined && r.trigger.kind !== 'meeting') return { ok: false, reason: 'Its time has passed. Edit it to pick a new one.', field: 'at' };
  return { ok: true, state: replace(state, id, (x) => ({ ...x, enabled: true, nextAt: at })) };
}

/** Removes a routine and its history. */
export function removeRoutine(state: RoutinesState, id: string): Result {
  if (!findRoutine(state, id)) return { ok: false, reason: 'That routine is already gone.' };
  return { ok: true, state: { routines: state.routines.filter((r) => r.id !== id), records: state.records.filter((r) => r.routineId !== id) } };
}

/**
 * The pending run is dealt with (started or skipped). A once-only routine is then finished,
 * for good; a repeating one carries on from its next time.
 */
export function clearPending(state: RoutinesState, id: string): RoutinesState {
  return replace(state, id, (r) => {
    const { pending: _gone, ...rest } = r;
    return r.trigger.kind === 'once' && r.pending ? { ...rest, finished: true, nextAt: undefined } : rest;
  });
}

// ---- records ----------------------------------------------------------------------------

export interface RecordInit {
  id: string;
  routine: Routine;
  companionName: string;
  now: number;
}

/** A run has begun: its record is there at once, and closed when it ends. */
export function startRecord(state: RoutinesState, init: RecordInit): RoutinesState {
  const record: RunRecord = {
    id: init.id,
    routineId: init.routine.id,
    routineName: init.routine.name,
    companionId: init.routine.companionId,
    companionName: cleanLine(init.companionName, 40),
    startedAt: init.now,
    status: 'running',
    transcript: [],
  };
  return { ...state, records: capRecords([record, ...state.records]) };
}

export function finishRecord(
  state: RoutinesState,
  recordId: string,
  end: { status: RunStatus; reason?: string; entries?: readonly ChatEntry[]; now: number },
): RoutinesState {
  const { lines, truncated } = trimTranscript(end.entries ?? []);
  return {
    ...state,
    records: state.records.map((r) =>
      r.id === recordId
        ? { ...r, status: end.status, finishedAt: end.now, reason: end.reason ? cleanLine(end.reason, 240) : undefined, transcript: lines, truncated: truncated || undefined }
        : r,
    ),
  };
}

/** A run that never happened (skipped by the user, or because the last one was still going). */
export function addSkipped(state: RoutinesState, init: RecordInit, reason: string): RoutinesState {
  const started = startRecord(state, init);
  return finishRecord(started, init.id, { status: 'skipped', reason, now: init.now });
}

export function deleteRecord(state: RoutinesState, recordId: string): Result {
  const rec = state.records.find((r) => r.id === recordId);
  if (!rec) return { ok: false, reason: 'That record is already gone.' };
  if (rec.status === 'running') return { ok: false, reason: 'It is still running.' };
  return { ok: true, state: { ...state, records: state.records.filter((r) => r.id !== recordId) } };
}

/** Clears a routine's history, except for a run that's still going. */
export function clearHistory(state: RoutinesState, routineId: string): RoutinesState {
  return { ...state, records: state.records.filter((r) => r.routineId !== routineId || r.status === 'running') };
}

/** The alarms the schedule needs: one per routine with a next time. */
export function wantedAlarms(state: RoutinesState): Array<{ name: string; when: number }> {
  return state.routines.filter((r) => r.enabled && !r.finished && r.nextAt !== undefined).map((r) => ({ name: alarmName(r.id), when: r.nextAt! }));
}

export const ALARM_PREFIX = 'routine:';
export const alarmName = (id: string) => `${ALARM_PREFIX}${id}`;

/** Storage as this module uses it, so tests can hand it a fake. */
export interface RoutinesStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadState(storage: RoutinesStorage, now: number): Promise<RoutinesState> {
  const saved = await storage.get([ROUTINES_KEY, RUNS_KEY]);
  return restore(saved[ROUTINES_KEY], saved[RUNS_KEY], now);
}

export const saveState = (storage: RoutinesStorage, state: RoutinesState) => storage.set({ [ROUTINES_KEY]: state.routines, [RUNS_KEY]: state.records });
