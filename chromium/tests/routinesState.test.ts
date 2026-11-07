// What happens to routines as time passes and as the user changes them: what comes due, what
// waits, what a restart turns into "overdue", and what each edit does to the schedule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LATE_GRACE_MS, MAX_RECORDS_PER_ROUTINE, MAX_ROUTINES, MAX_WAIT_MS, type Routine } from '../shared/routines';
import * as s from '../shell/lib/routinesState';

process.env.TZ = 'Europe/Berlin';
const at = (y: number, mo: number, d: number, h = 0, mi = 0, sec = 0) => new Date(y, mo - 1, d, h, mi, sec).getTime();
const MIN = 60_000;
const NOW = at(2026, 5, 12, 10, 0); // a Tuesday
let n = 0;
const newId = () => `id${++n}`;
const ctx = (now = NOW) => ({ now, newId, companionExists: (id: string) => id === 'general' || id === 'sales' });
const form = (over: Record<string, unknown> = {}) => ({ name: 'Digest', companionId: 'general', instructions: 'Read it.', trigger: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, ...over });
const must = <T extends object>(r: s.Result<T>) => {
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r as Extract<s.Result<T>, { ok: true }>;
};
const make = (state: s.RoutinesState = s.EMPTY_STATE, over: Record<string, unknown> = {}, now = NOW) => {
  const r = must(s.saveRoutine(state, form(over), ctx(now)));
  return { state: r.state, id: r.id, routine: () => s.findRoutine(r.state, r.id)! };
};

test('a new routine starts on, with its first time worked out from now', () => {
  const { routine, state } = make();
  assert.equal(state.routines.length, 1);
  assert.equal(routine().enabled, true);
  assert.equal(routine().nextAt, at(2026, 5, 13, 9), 'Tuesday 10:00: the next weekday 09:00 is Wednesday');
  assert.equal(routine().createdAt, NOW);
  assert.equal(routine().pending, undefined);
  const off = make(s.EMPTY_STATE, { enabled: false });
  assert.equal(off.routine().enabled, false);
  assert.equal(off.routine().nextAt, undefined, 'off: no time');
});

test('an interval counts from the moment it was saved', () => {
  const { routine } = make(s.EMPTY_STATE, { trigger: { kind: 'interval', minutes: 45 } });
  assert.deepEqual(routine().trigger, { kind: 'interval', minutes: 45, anchor: NOW });
  assert.equal(routine().nextAt, NOW + 45 * MIN);
});

test('at most 20 routines', () => {
  let state = s.EMPTY_STATE;
  for (let i = 0; i < MAX_ROUTINES; i++) state = must(s.saveRoutine(state, form({ name: `R${i}` }), ctx())).state;
  assert.equal(state.routines.length, 20);
  const over = s.saveRoutine(state, form({ name: 'one more' }), ctx());
  assert.ok(!over.ok);
  assert.match((over as s.Fail).reason, /up to 20/);
  assert.equal((over as s.Fail).field, 'limit');
  // Editing one is still fine at the limit.
  assert.ok(s.saveRoutine(state, form({ id: state.routines[0].id, name: 'renamed' }), ctx()).ok);
});

test('what is refused says why, and changes nothing', () => {
  const { state } = make();
  for (const [input, field] of [
    [form({ name: '' }), 'name'],
    [form({ companionId: 'ghost' }), 'companion'],
    [form({ instructions: '' }), 'instructions'],
    [form({ trigger: { kind: 'interval', minutes: 14 } }), 'minutes'],
    [form({ trigger: { kind: 'once', at: NOW - MIN } }), 'at'],
    [form({ id: 'nope' }), undefined],
  ] as const) {
    const r = s.saveRoutine(state, input, ctx());
    assert.ok(!r.ok, JSON.stringify(input));
    assert.equal((r as s.Fail).field, field);
  }
});

test('editing: a new time starts afresh; the same time keeps its schedule', () => {
  const a = make(s.EMPTY_STATE, { trigger: { kind: 'interval', minutes: 30 } });
  const later = NOW + 50 * MIN;
  // Rename only: the interval keeps its anchor, so it stays on the same grid.
  const renamed = must(s.saveRoutine(a.state, form({ id: a.id, name: 'Renamed', trigger: { kind: 'interval', minutes: 30 } }), ctx(later)));
  assert.equal(s.findRoutine(renamed.state, a.id)!.nextAt, a.routine().nextAt, 'nextAt kept');
  assert.deepEqual(s.findRoutine(renamed.state, a.id)!.trigger, a.routine().trigger);
  // A different length starts counting from the edit.
  const longer = must(s.saveRoutine(a.state, form({ id: a.id, trigger: { kind: 'interval', minutes: 60 } }), ctx(later)));
  assert.deepEqual(s.findRoutine(longer.state, a.id)!.trigger, { kind: 'interval', minutes: 60, anchor: later });
  assert.equal(s.findRoutine(longer.state, a.id)!.nextAt, later + 60 * MIN);
  // Daily changed to another time of day.
  const d = make();
  const moved = must(s.saveRoutine(d.state, form({ id: d.id, trigger: { kind: 'daily', time: '18:30', days: [1, 2, 3, 4, 5] } }), ctx()));
  assert.equal(s.findRoutine(moved.state, d.id)!.nextAt, at(2026, 5, 12, 18, 30), 'today at 18:30');
  assert.equal(s.findRoutine(moved.state, d.id)!.id, d.id);
  assert.equal(s.findRoutine(moved.state, d.id)!.createdAt, NOW);
});

test('editing a once-only routine whose time has gone is fine unless the time changes to the past', () => {
  const o = make(s.EMPTY_STATE, { trigger: { kind: 'once', at: NOW + 10 * MIN } });
  const past = NOW + 3 * 60 * MIN;
  const kept = s.saveRoutine(o.state, form({ id: o.id, name: 'Renamed', trigger: { kind: 'once', at: NOW + 10 * MIN } }), ctx(past));
  assert.ok(kept.ok, 'same time, in the past: allowed');
  const changed = s.saveRoutine(o.state, form({ id: o.id, trigger: { kind: 'once', at: NOW + 20 * MIN } }), ctx(past));
  assert.ok(!changed.ok, 'a different time must be in the future');
});

test('turning a routine off clears its schedule and anything waiting; on works it out again', () => {
  const a = make();
  const due = s.markDue(a.state, a.routine().nextAt! + MIN);
  assert.equal(s.findRoutine(due, a.id)!.pending?.state, 'waiting');
  const off = must(s.setEnabled(due, a.id, false, NOW));
  assert.equal(s.findRoutine(off.state, a.id)!.enabled, false);
  assert.equal(s.findRoutine(off.state, a.id)!.nextAt, undefined);
  assert.equal(s.findRoutine(off.state, a.id)!.pending, undefined);
  const on = must(s.setEnabled(off.state, a.id, true, NOW));
  assert.equal(s.findRoutine(on.state, a.id)!.nextAt, at(2026, 5, 13, 9));
  assert.ok(!s.setEnabled(on.state, 'ghost', true, NOW).ok);
});

test('a once-only routine finishes when its run is handled, and cannot be turned on again', () => {
  const o = make(s.EMPTY_STATE, { trigger: { kind: 'once', at: NOW + 10 * MIN } });
  const due = s.markDue(o.state, NOW + 11 * MIN);
  assert.equal(s.findRoutine(due, o.id)!.pending?.state, 'waiting');
  assert.equal(s.findRoutine(due, o.id)!.nextAt, undefined, 'no next time');
  const handled = s.clearPending(due, o.id);
  assert.equal(s.findRoutine(handled, o.id)!.finished, true);
  assert.equal(s.findRoutine(handled, o.id)!.pending, undefined);
  assert.deepEqual(s.wantedAlarms(handled), []);
  const again = s.setEnabled(handled, o.id, true, NOW + 12 * MIN);
  assert.ok(!again.ok);
  assert.match((again as s.Fail).reason, /already ran/);
  // Picking a new time makes it runnable again.
  const rescheduled = must(s.saveRoutine(handled, form({ id: o.id, trigger: { kind: 'once', at: NOW + 60 * MIN } }), ctx(NOW + 12 * MIN)));
  assert.equal(s.findRoutine(rescheduled.state, o.id)!.finished, undefined);
  assert.equal(s.findRoutine(rescheduled.state, o.id)!.nextAt, NOW + 60 * MIN);
  // A repeating routine's handled run leaves its schedule alone.
  const r = make();
  const waiting = s.markDue(r.state, r.routine().nextAt! + MIN);
  const cleared = s.clearPending(waiting, r.id);
  assert.equal(s.findRoutine(cleared, r.id)!.finished, undefined);
  assert.equal(s.findRoutine(cleared, r.id)!.nextAt, s.findRoutine(waiting, r.id)!.nextAt);
});

test('markDue: on time waits for the agent; a long gap is overdue; the next time moves on', () => {
  const a = make();
  const dueAt = a.routine().nextAt!;
  assert.equal(s.findRoutine(s.markDue(a.state, dueAt - 1), a.id)!.pending, undefined, 'nothing yet');
  const onTime = s.findRoutine(s.markDue(a.state, dueAt + 2000), a.id)!;
  assert.deepEqual(onTime.pending, { since: dueAt, state: 'waiting' });
  assert.equal(onTime.nextAt, at(2026, 5, 14, 9), 'Thursday');
  const edge = s.findRoutine(s.markDue(a.state, dueAt + LATE_GRACE_MS), a.id)!;
  assert.equal(edge.pending?.state, 'waiting');
  const late = s.findRoutine(s.markDue(a.state, dueAt + LATE_GRACE_MS + 1), a.id)!;
  assert.equal(late.pending?.state, 'overdue');
  const missed = s.findRoutine(s.markDue(a.state, dueAt + 3 * 24 * 60 * MIN), a.id)!;
  assert.deepEqual(missed.pending, { since: dueAt, state: 'overdue' });
  assert.ok(missed.nextAt! > dueAt + 3 * 24 * 60 * MIN, 'the days that passed do not each count: one overdue item, then the next future time');
});

test('markDue: launching makes everything due overdue, however recent', () => {
  const a = make();
  const dueAt = a.routine().nextAt!;
  const r = s.findRoutine(s.markDue(a.state, dueAt + 1000, { launch: true }), a.id)!;
  assert.equal(r.pending?.state, 'overdue');
});

test('markDue: due times do not pile up, and the oldest is kept', () => {
  const a = make(s.EMPTY_STATE, { trigger: { kind: 'interval', minutes: 15 } });
  const first = a.routine().nextAt!;
  let state = s.markDue(a.state, first + 1000);
  const since = s.findRoutine(state, a.id)!.pending!.since;
  state = s.markDue(state, first + 15 * MIN + 1000);
  assert.equal(s.findRoutine(state, a.id)!.pending!.since, since, 'still the first one');
  assert.equal(s.findRoutine(state, a.id)!.pending!.state, 'waiting', 'a second 15 minutes later is still within the wait');
});

test('markDue: a run that waited too long for the agent becomes overdue', () => {
  const a = make(s.EMPTY_STATE, { trigger: { kind: 'interval', minutes: 7 * 24 * 60 } });
  const dueAt = a.routine().nextAt!;
  const waiting = s.markDue(a.state, dueAt + 1000);
  assert.equal(s.findRoutine(waiting, a.id)!.pending!.state, 'waiting');
  assert.equal(s.findRoutine(s.markDue(waiting, dueAt + MAX_WAIT_MS), a.id)!.pending!.state, 'waiting');
  assert.equal(s.findRoutine(s.markDue(waiting, dueAt + MAX_WAIT_MS + MIN), a.id)!.pending!.state, 'overdue');
});

test('disabled routines never come due', () => {
  const a = make(s.EMPTY_STATE, { enabled: false });
  assert.equal(s.findRoutine(s.markDue(a.state, NOW + 100 * 24 * 60 * MIN), a.id)!.pending, undefined);
  assert.deepEqual(s.wantedAlarms(a.state), []);
  // Even if a disabled routine somehow has a stale time saved, it is cleared on start.
  const stale: s.RoutinesState = { ...a.state, routines: [{ ...a.routine(), nextAt: NOW - MIN, pending: { since: NOW - MIN, state: 'waiting' } }] };
  const resumed = s.resume(stale, NOW, false);
  assert.equal(resumed.routines[0].pending, undefined);
  assert.equal(resumed.routines[0].nextAt, undefined);
});

test('nextWaiting: the one that has waited longest, only if enabled', () => {
  let state = make(s.EMPTY_STATE, { name: 'A', trigger: { kind: 'interval', minutes: 30 } }).state;
  state = make(state, { name: 'B', trigger: { kind: 'interval', minutes: 15 } }).state;
  const [a, b] = state.routines;
  state = s.markDue(state, NOW + 16 * MIN);
  state = s.markDue(state, NOW + 31 * MIN);
  assert.equal(s.nextWaiting(state)!.id, b.id, 'B came due first (at 15 minutes)');
  assert.equal(s.findRoutine(state, a.id)!.pending!.since, NOW + 30 * MIN);
  state = s.clearPending(state, b.id);
  assert.equal(s.nextWaiting(state)!.id, a.id);
  state = s.clearPending(state, a.id);
  assert.equal(s.nextWaiting(state), undefined);
});

test('resume at launch: waiting and missed become overdue; nothing is left to run by itself', () => {
  let state = make(s.EMPTY_STATE, { name: 'Daily' }).state;
  state = make(state, { name: 'Often', trigger: { kind: 'interval', minutes: 30 } }).state;
  state = make(state, { name: 'Once', trigger: { kind: 'once', at: NOW + 20 * MIN } }).state;
  state = make(state, { name: 'Off', enabled: false }).state;
  // UrAnus Browser was waiting on one (on time), then quit; the next day it is started again.
  const waiting = s.markDue(state, NOW + 31 * MIN);
  assert.ok(waiting.routines.some((r) => r.pending?.state === 'waiting'));
  const launch = s.resume(waiting, NOW + 26 * 60 * MIN, true);
  assert.equal(s.nextWaiting(launch), undefined, 'nothing waiting to start by itself');
  const by = (name: string) => launch.routines.find((r) => r.name === name)!;
  assert.equal(by('Daily').pending?.state, 'overdue');
  assert.equal(by('Often').pending?.state, 'overdue');
  assert.equal(by('Once').pending?.state, 'overdue');
  assert.equal(by('Off').pending, undefined);
  assert.equal(s.overdueCount(launch), 3);
  // Everything still has a future time (except the once-only).
  assert.ok(by('Daily').nextAt! > NOW + 26 * 60 * MIN);
  assert.ok(by('Often').nextAt! > NOW + 26 * 60 * MIN);
  assert.equal(by('Once').nextAt, undefined);
});

test('resume when only the background woke up: a run that just came due is on time', () => {
  const a = make();
  const dueAt = a.routine().nextAt!;
  const woken = s.resume(a.state, dueAt + 30_000, false);
  assert.equal(s.findRoutine(woken, a.id)!.pending?.state, 'waiting');
  const slept = s.resume(a.state, dueAt + 2 * 60 * MIN, false);
  assert.equal(s.findRoutine(slept, a.id)!.pending?.state, 'overdue');
});

test('resume closes runs that were in progress, and works times out afresh', () => {
  const a = make();
  let state = s.startRecord(a.state, { id: 'rec1', routine: a.routine(), companionName: 'General', now: NOW });
  assert.equal(state.records[0].status, 'running');
  const resumed = s.resume(state, NOW + MIN, true);
  assert.equal(resumed.records[0].status, 'failed');
  assert.match(resumed.records[0].reason!, /closed before/);
  assert.equal(resumed.records[0].finishedAt, NOW + MIN);
  // A daily time saved under another time zone is moved to this one.
  state = { ...a.state, routines: [{ ...a.routine(), nextAt: at(2026, 5, 13, 3) }] };
  assert.equal(s.resume(state, NOW, true).routines[0].nextAt, at(2026, 5, 13, 9));
});

test('removing a routine removes its history, and its alarm is no longer wanted', () => {
  const a = make();
  const b = make(a.state, { name: 'Other' });
  let state = s.startRecord(b.state, { id: 'r1', routine: a.routine(), companionName: 'General', now: NOW });
  state = s.finishRecord(state, 'r1', { status: 'done', now: NOW + MIN });
  assert.deepEqual(s.wantedAlarms(state).map((x) => x.name).sort(), [s.alarmName(a.id), s.alarmName(b.id)].sort());
  const removed = must(s.removeRoutine(state, a.id));
  assert.deepEqual(removed.state.routines.map((r) => r.id), [b.id]);
  assert.equal(removed.state.records.length, 0);
  assert.deepEqual(s.wantedAlarms(removed.state).map((x) => x.name), [s.alarmName(b.id)]);
  assert.ok(!s.removeRoutine(removed.state, a.id).ok);
});

test('records: started, finished with a trimmed transcript, skipped, deleted, cleared', () => {
  const a = make();
  let state = s.startRecord(a.state, { id: 'r1', routine: a.routine(), companionName: 'General', now: NOW });
  assert.deepEqual(state.records[0], { id: 'r1', routineId: a.id, routineName: 'Digest', companionId: 'general', companionName: 'General', startedAt: NOW, status: 'running', transcript: [] });
  assert.ok(!s.deleteRecord(state, 'r1').ok, 'a running record is not deleted');
  state = s.finishRecord(state, 'r1', { status: 'done', now: NOW + MIN, entries: [{ kind: 'assistant', id: 'c1', text: 'hello' }] });
  assert.equal(state.records[0].status, 'done');
  assert.equal(state.records[0].finishedAt, NOW + MIN);
  assert.deepEqual(state.records[0].transcript, [{ kind: 'assistant', text: 'hello' }]);
  state = s.addSkipped(state, { id: 'r2', routine: a.routine(), companionName: 'General', now: NOW + 2 * MIN }, 'You skipped this run.');
  assert.equal(state.records[0].id, 'r2', 'newest first');
  assert.equal(state.records[0].status, 'skipped');
  assert.equal(state.records[0].reason, 'You skipped this run.');
  state = s.startRecord(state, { id: 'r3', routine: a.routine(), companionName: 'General', now: NOW + 3 * MIN });
  const cleared = s.clearHistory(state, a.id);
  assert.deepEqual(cleared.records.map((r) => r.id), ['r3'], 'the run in progress stays');
  const deleted = must(s.deleteRecord(state, 'r1'));
  assert.deepEqual(deleted.state.records.map((r) => r.id), ['r3', 'r2']);
  assert.ok(!s.deleteRecord(deleted.state, 'r1').ok);
});

test('history is capped at 30 per routine as records are added', () => {
  const a = make();
  let state = a.state;
  for (let i = 0; i < 40; i++) state = s.addSkipped(state, { id: `r${i}`, routine: a.routine(), companionName: 'General', now: NOW + i * MIN }, 'x');
  assert.equal(state.records.length, MAX_RECORDS_PER_ROUTINE);
  assert.equal(state.records[0].id, 'r39');
  assert.equal(state.records.at(-1)!.id, 'r10');
});

test('saved state is checked when loaded: junk is dropped, text clamped, limits hold', () => {
  const good: Routine = { id: 'a', name: 'Good', companionId: 'general', instructions: 'Do it', trigger: { kind: 'daily', time: '09:00', days: [1] }, enabled: true, createdAt: NOW, nextAt: NOW + 1000 };
  const saved = [
    good,
    { ...good, id: 'a' }, // duplicate id
    { ...good, id: 'b', name: '' },
    { ...good, id: 'c', instructions: '   ' },
    { ...good, id: 'd', trigger: { kind: 'interval', minutes: 5, anchor: 0 } },
    { ...good, id: 'e', trigger: { kind: 'sometimes' } },
    { ...good, id: 'f', companionId: 12 },
    { ...good, id: 'g', name: 'x'.repeat(1000), instructions: 'y'.repeat(10000), enabled: false, pending: { since: 1, state: 'overdue' } },
    { ...good, id: 'h', pending: { since: 5, state: 'bogus' }, nextAt: 'soon' },
    { ...good, id: 'i', trigger: { kind: 'once', at: NOW - 5 * MIN } },
    null,
    'text',
    42,
  ];
  const state = s.restore(saved, [], NOW);
  assert.deepEqual(state.routines.map((r) => r.id), ['a', 'g', 'h', 'i']);
  const g = state.routines[1];
  assert.equal(g.name.length, 60);
  assert.equal(g.instructions.length, 2000);
  assert.equal(g.enabled, false);
  assert.equal(state.routines[2].pending, undefined);
  assert.equal(state.routines[2].nextAt, undefined);
  assert.deepEqual(state.routines[3].trigger, { kind: 'once', at: NOW - 5 * MIN }, 'a once-only time in the past is kept');
  assert.deepEqual(s.restore('nope', undefined, NOW), s.EMPTY_STATE);
  const many = Array.from({ length: 50 }, (_, i) => ({ ...good, id: `m${i}` }));
  assert.equal(s.restore(many, [], NOW).routines.length, MAX_ROUTINES);
  // Records of routines that don't exist are dropped.
  const rec = { id: 'x', routineId: 'a', routineName: 'Good', companionId: 'general', companionName: 'General', startedAt: 1, status: 'done', transcript: [] };
  assert.deepEqual(s.restore([good], [rec, { ...rec, id: 'y', routineId: 'zzz' }, 7], NOW).records.map((r) => r.id), ['x']);
});

test('state is saved under two keys and loads back the same', async () => {
  const stored = new Map<string, unknown>();
  const storage = {
    get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)])),
    set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => stored.set(k, structuredClone(v))),
  };
  const a = make();
  const state = s.addSkipped(a.state, { id: 'r1', routine: a.routine(), companionName: 'General', now: NOW }, 'x');
  await s.saveState(storage, state);
  assert.deepEqual([...stored.keys()].sort(), ['routineRuns', 'routines']);
  assert.deepEqual(await s.loadState(storage, NOW), state);
  assert.deepEqual(await s.loadState({ get: async () => ({}), set: async () => {} }, NOW), s.EMPTY_STATE);
});

test('alarms are wanted for enabled routines with a next time, by name', () => {
  const a = make(s.EMPTY_STATE, { name: 'A' });
  const b = make(a.state, { name: 'B', enabled: false });
  const c = make(b.state, { name: 'C', trigger: { kind: 'interval', minutes: 20 } });
  assert.deepEqual(
    s.wantedAlarms(c.state).map((x) => x.name),
    [s.alarmName(a.id), s.alarmName(c.id)],
  );
  assert.ok(s.alarmName('abc').startsWith(s.ALARM_PREFIX));
});
