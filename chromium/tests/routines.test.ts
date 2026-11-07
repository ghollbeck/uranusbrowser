// Routines' pure rules: when something next runs (local time, daylight saving, month ends,
// weekdays, intervals, once-only), what counts as overdue, how text and limits are checked,
// and how records are trimmed and capped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEntry } from '../shared/browserAgent';
import {
  LATE_GRACE_MS,
  MAX_RECORDS,
  MAX_RECORDS_PER_ROUTINE,
  MAX_ROUTINE_INSTRUCTIONS,
  MAX_ROUTINE_NAME,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_TRANSCRIPT_ENTRY,
  capRecords,
  checkRoutine,
  checkTrigger,
  cleanRoutineMark,
  describeDays,
  describeTrigger,
  describeWhen,
  dueState,
  formatTime,
  nextRun,
  normaliseDays,
  parseTime,
  restoreRecord,
  routineNotice,
  trimTranscript,
  type RunRecord,
  type Trigger,
} from '../shared/routines';

const zone = (tz: string) => void (process.env.TZ = tz);
/** A local time on the given zone's calendar. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const daily = (time: string, days = [0, 1, 2, 3, 4, 5, 6]): Trigger => ({ kind: 'daily', time, days });
const MIN = 60_000;

test('times of day are HH:MM, 24 hours', () => {
  assert.deepEqual(parseTime('09:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(parseTime('9:05'), { hours: 9, minutes: 5 });
  assert.deepEqual(parseTime('23:59'), { hours: 23, minutes: 59 });
  for (const bad of ['24:00', '12:60', '12', '', 'ab:cd', '12:5', null, 900, undefined]) assert.equal(parseTime(bad), undefined, String(bad));
});

test('weekday sets are sorted, unique and in range', () => {
  assert.deepEqual(normaliseDays([5, 1, 1, 3]), [1, 3, 5]);
  assert.deepEqual(normaliseDays([7, -1, 2.5, '3', 0]), [0]);
  assert.deepEqual(normaliseDays('mon'), []);
});

test('daily: the next time is strictly after the moment asked about', () => {
  zone('Europe/Berlin');
  const t = daily('09:00');
  assert.equal(nextRun(t, at(2026, 5, 12, 8, 59, 59)), at(2026, 5, 12, 9));
  assert.equal(nextRun(t, at(2026, 5, 12, 9)), at(2026, 5, 13, 9), 'exactly on the time: tomorrow');
  assert.equal(nextRun(t, at(2026, 5, 12, 9, 0, 1)), at(2026, 5, 13, 9));
  assert.equal(nextRun(t, at(2026, 5, 12, 23, 59)), at(2026, 5, 13, 9));
  assert.equal(nextRun(daily('00:00'), at(2026, 5, 12, 23, 59)), at(2026, 5, 13, 0));
});

test('daily: weekday masks (0 is Sunday)', () => {
  zone('Europe/Berlin');
  const weekdays = daily('09:00', [1, 2, 3, 4, 5]);
  // 2026-05-15 is a Friday.
  assert.equal(new Date(at(2026, 5, 15)).getDay(), 5);
  assert.equal(nextRun(weekdays, at(2026, 5, 15, 9, 30)), at(2026, 5, 18, 9), 'Friday after 09:30: Monday');
  assert.equal(nextRun(weekdays, at(2026, 5, 16, 12)), at(2026, 5, 18, 9), 'Saturday: Monday');
  assert.equal(nextRun(weekdays, at(2026, 5, 17, 23, 59)), at(2026, 5, 18, 9), 'Sunday night: Monday');
  assert.equal(nextRun(daily('09:00', [0, 6]), at(2026, 5, 15, 9, 30)), at(2026, 5, 16, 9), 'weekend: Saturday');
  assert.equal(nextRun(daily('09:00', [0]), at(2026, 5, 17, 10)), at(2026, 5, 24, 9), 'only Sunday, after its time: a week on');
  assert.equal(nextRun(daily('09:00', [3]), at(2026, 5, 13, 8)), at(2026, 5, 13, 9), 'Wednesday morning: today');
  assert.equal(nextRun(daily('09:00', []), at(2026, 5, 13)), undefined, 'no days: never');
  assert.equal(nextRun({ kind: 'daily', time: '25:00', days: [1] }, at(2026, 5, 13)), undefined, 'no valid time: never');
});

test('daily: month, year and leap-day ends', () => {
  zone('Europe/Berlin');
  const t = daily('09:00');
  assert.equal(nextRun(t, at(2026, 1, 31, 10)), at(2026, 2, 1, 9));
  assert.equal(nextRun(t, at(2026, 12, 31, 10)), at(2027, 1, 1, 9));
  assert.equal(nextRun(t, at(2028, 2, 28, 10)), at(2028, 2, 29, 9), 'leap year');
  assert.equal(nextRun(t, at(2027, 2, 28, 10)), at(2027, 3, 1, 9), 'not a leap year');
  assert.equal(nextRun(daily('09:00', [1]), at(2026, 4, 30, 10)), at(2026, 5, 4, 9), 'Thursday 30 April: Monday 4 May');
  assert.equal(nextRun(daily('23:59'), at(2026, 6, 30, 23, 59)), at(2026, 7, 1, 23, 59));
});

test('daily across clocks going forward (Berlin, 29 March 2026): a time that does not exist runs just after the gap, once', () => {
  zone('Europe/Berlin');
  const t = daily('02:30');
  const first = nextRun(t, at(2026, 3, 28, 3));
  assert.ok(first);
  const d = new Date(first!);
  assert.deepEqual([d.getMonth(), d.getDate()], [2, 29], 'still on the 29th');
  assert.equal(formatTime(first!), '03:30', '02:30 does not exist: 03:30');
  // The run that just happened doesn't repeat, and the day after is normal.
  assert.equal(nextRun(t, first!), at(2026, 3, 30, 2, 30));
  // A time before the gap is untouched; one after it too.
  assert.equal(formatTime(nextRun(daily('01:30'), at(2026, 3, 28, 12))!), '01:30');
  assert.equal(formatTime(nextRun(daily('09:00'), at(2026, 3, 28, 12))!), '09:00');
  // The day is 23 hours long: 09:00 to 09:00 is 23 hours.
  const sat = at(2026, 3, 28, 9);
  assert.equal(nextRun(daily('09:00'), sat)! - sat, 23 * 60 * MIN);
});

test('daily across clocks going back (Berlin, 25 October 2026): a time that happens twice runs once', () => {
  zone('Europe/Berlin');
  const t = daily('02:30');
  const first = nextRun(t, at(2026, 10, 24, 12))!;
  assert.equal(formatTime(first), '02:30');
  assert.equal(new Date(first).getDate(), 25);
  const second = nextRun(t, first)!;
  assert.equal(new Date(second).getDate(), 26, 'not again an hour later');
  assert.equal(second, at(2026, 10, 26, 2, 30));
  // The day is 25 hours long.
  const sat = at(2026, 10, 24, 9);
  assert.equal(nextRun(daily('09:00'), sat)! - sat, 25 * 60 * MIN, 'Sat 09:00 to Sun 09:00 spans the repeated hour: 25 hours');
  const sun = at(2026, 10, 25, 9);
  assert.equal(nextRun(daily('09:00'), sun)! - sun, 24 * 60 * MIN);
  const sunEarly = at(2026, 10, 25, 1, 0);
  assert.equal(nextRun(daily('09:00'), sunEarly)! - sunEarly, 9 * 60 * MIN, '01:00 to 09:00 spans the repeated hour: 9 hours');
});

test('daily in another zone (New York, 8 March and 1 November 2026)', () => {
  zone('America/New_York');
  const t = daily('02:30');
  const forward = nextRun(t, at(2026, 3, 7, 12))!;
  assert.equal(formatTime(forward), '03:30');
  assert.equal(new Date(forward).getDate(), 8);
  assert.equal(nextRun(t, forward), at(2026, 3, 9, 2, 30));
  const bt = daily('01:30');
  const once = nextRun(bt, at(2026, 10, 31, 12))!;
  const next = nextRun(bt, once)!;
  assert.equal(new Date(once).getDate(), 1);
  assert.equal(new Date(next).getDate(), 2, 'the repeated 01:30 does not run twice');
  // The same wall-clock time has a different offset after the change.
  zone('Europe/Berlin');
});

test('interval: counted from its anchor, so a late run does not shift the rest', () => {
  const anchor = at(2026, 5, 12, 10);
  const t: Trigger = { kind: 'interval', minutes: 30, anchor };
  assert.equal(nextRun(t, anchor), anchor + 30 * MIN, 'the first run is one step after the anchor');
  assert.equal(nextRun(t, anchor - 5 * MIN), anchor + 30 * MIN, 'before the anchor: still one step after it');
  assert.equal(nextRun(t, anchor + 29 * MIN + 59_000), anchor + 30 * MIN);
  assert.equal(nextRun(t, anchor + 30 * MIN), anchor + 60 * MIN, 'exactly on a point: the next one');
  // Found 17 minutes after a point (a late wake-up): the next is the following point, not 30 minutes after now.
  assert.equal(nextRun(t, anchor + 77 * MIN), anchor + 90 * MIN);
  assert.equal(nextRun(t, anchor + 24 * 60 * MIN + 1), anchor + 24 * 60 * MIN + 30 * MIN);
  assert.equal(nextRun({ kind: 'interval', minutes: 15, anchor }, anchor + 1), anchor + 15 * MIN);
  assert.equal(nextRun({ kind: 'interval', minutes: 0, anchor }, anchor), undefined, 'a zero step never runs');
  assert.equal(nextRun({ kind: 'interval', minutes: 30, anchor: NaN }, anchor), undefined);
});

test('once: runs at its time, then never', () => {
  const when = at(2026, 5, 12, 18);
  const t: Trigger = { kind: 'once', at: when };
  assert.equal(nextRun(t, when - 1), when);
  assert.equal(nextRun(t, when), undefined, 'at the time: it is due, not next');
  assert.equal(nextRun(t, when + MIN), undefined);
});

test('due, on time or missed', () => {
  const due = at(2026, 5, 12, 9);
  assert.equal(dueState(due, due - 1), 'not-due');
  assert.equal(dueState(due, due), 'on-time');
  assert.equal(dueState(due, due + LATE_GRACE_MS), 'on-time');
  assert.equal(dueState(due, due + LATE_GRACE_MS + 1), 'missed');
  assert.equal(dueState(due, due + 3 * 60 * 60_000), 'missed');
});

test('next-run text reads naturally', () => {
  zone('Europe/Berlin');
  const now = at(2026, 5, 12, 10, 30); // a Tuesday
  assert.equal(describeWhen(at(2026, 5, 12, 18), now), 'Today 18:00');
  assert.equal(describeWhen(at(2026, 5, 13, 9), now), 'Tomorrow 09:00');
  assert.equal(describeWhen(at(2026, 5, 11, 9), now), 'Yesterday 09:00');
  assert.equal(describeWhen(at(2026, 5, 15, 9), now), 'Fri 09:00');
  assert.equal(describeWhen(at(2026, 5, 9, 9), now), 'Sat 09:00');
  assert.equal(describeWhen(at(2026, 5, 19, 7, 5), now), '19 May 07:05');
  assert.equal(describeWhen(at(2027, 1, 2, 7, 5), now), '2 Jan 2027 07:05');
  assert.equal(describeWhen(at(2026, 5, 13, 0, 0), at(2026, 5, 12, 23, 59)), 'Tomorrow 00:00', 'by calendar day, not by 24 hours');
  // Across the 23-hour day.
  assert.equal(describeWhen(at(2026, 3, 30, 9), at(2026, 3, 28, 9)), 'Mon 09:00');
  assert.equal(describeDays([1, 2, 3, 4, 5]), 'Weekdays');
  assert.equal(describeDays([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(describeDays([6, 0]), 'Weekends');
  assert.equal(describeDays([0, 3, 1]), 'Mon, Wed, Sun');
  assert.equal(describeTrigger(daily('09:00', [1, 2, 3, 4, 5]), now), 'Weekdays at 09:00');
  assert.equal(describeTrigger({ kind: 'interval', minutes: 30, anchor: 0 }, now), 'Every 30 minutes');
  assert.equal(describeTrigger({ kind: 'interval', minutes: 60, anchor: 0 }, now), 'Every hour');
  assert.equal(describeTrigger({ kind: 'interval', minutes: 120, anchor: 0 }, now), 'Every 2 hours');
  assert.equal(describeTrigger({ kind: 'interval', minutes: 90, anchor: 0 }, now), 'Every 90 minutes');
  assert.equal(describeTrigger({ kind: 'interval', minutes: 1440, anchor: 0 }, now), 'Every day');
  assert.equal(describeTrigger({ kind: 'once', at: at(2026, 5, 13, 9) }, now), 'Once, Tomorrow 09:00');
});

test('triggers are checked: the shortest interval is 15 minutes', () => {
  zone('Europe/Berlin');
  const now = at(2026, 5, 12, 10, 7, 33);
  const bad = (input: unknown) => checkTrigger(input, now) as { ok: false; reason: string; field?: string };
  assert.equal(bad({ kind: 'interval', minutes: 14 }).field, 'minutes');
  assert.match(bad({ kind: 'interval', minutes: 14 }).reason, /15 minutes/);
  assert.equal(bad({ kind: 'interval', minutes: 0 }).ok, false);
  assert.equal(bad({ kind: 'interval', minutes: -30 }).ok, false);
  assert.equal(bad({ kind: 'interval', minutes: 20.5 }).field, 'minutes');
  assert.equal(bad({ kind: 'interval', minutes: 'soon' }).ok, false);
  assert.equal(bad({ kind: 'interval', minutes: 10081 }).ok, false);
  assert.deepEqual(checkTrigger({ kind: 'interval', minutes: 15 }, now), { ok: true, value: { kind: 'interval', minutes: 15, anchor: at(2026, 5, 12, 10, 7) } }, 'anchored on the minute');
  assert.deepEqual(checkTrigger({ kind: 'interval', minutes: '45', anchor: 1000 }, now), { ok: true, value: { kind: 'interval', minutes: 45, anchor: 1000 } });
  assert.equal(bad({ kind: 'daily', time: '9am', days: [1] }).field, 'time');
  assert.equal(bad({ kind: 'daily', time: '09:00', days: [] }).field, 'days');
  assert.equal(bad({ kind: 'daily', time: '09:00', days: [9] }).field, 'days');
  assert.deepEqual(checkTrigger({ kind: 'daily', time: '9:05', days: [3, 1, 1] }, now), { ok: true, value: { kind: 'daily', time: '09:05', days: [1, 3] } });
  assert.equal(bad({ kind: 'once', at: now - 1 }).field, 'at', 'in the past');
  assert.equal(bad({ kind: 'once', at: now + 10_000 }).field, 'at', 'seconds ahead round down to the past');
  assert.equal(bad({ kind: 'once', at: NaN }).field, 'at');
  assert.equal(bad({ kind: 'once', at: now + 6 * 366 * 86_400_000 }).field, 'at');
  assert.deepEqual(checkTrigger({ kind: 'once', at: now + 2 * 60 * MIN + 5000 }, now), { ok: true, value: { kind: 'once', at: at(2026, 5, 12, 12, 7) } });
  assert.equal(bad({ kind: 'weekly' }).ok, false);
  assert.equal(bad(null).ok, false);
  // An unchanged once-only time in the past can be kept when the rest is edited.
  const past = at(2026, 5, 12, 9);
  assert.equal(checkTrigger({ kind: 'once', at: past }, now, past).ok, true);
  assert.equal(checkTrigger({ kind: 'once', at: past - MIN }, now, past).ok, false);
});

test('a routine is checked and cleaned: names, instructions, companion', () => {
  zone('Europe/Berlin');
  const now = at(2026, 5, 12, 10);
  const exists = (id: string) => id === 'general' || id === 'sales';
  const base = { name: 'Morning digest', companionId: 'general', instructions: 'Read the page.', trigger: { kind: 'daily', time: '09:00', days: [1] } };
  const fail = (input: unknown) => checkRoutine(input, now, exists) as { ok: false; reason: string; field?: string };
  assert.equal(checkRoutine(base, now, exists).ok, true);
  assert.equal(fail({ ...base, name: '   ' }).field, 'name');
  assert.equal(fail({ ...base, name: '\u0007\u0000' }).field, 'name', 'control characters only');
  assert.equal(fail({ ...base, companionId: 'ghost' }).field, 'companion');
  assert.equal(fail({ ...base, companionId: 7 }).field, 'companion');
  assert.equal(fail({ ...base, instructions: '  \n ' }).field, 'instructions');
  assert.equal(fail({ ...base, trigger: { kind: 'interval', minutes: 5 } }).field, 'minutes');
  assert.equal(fail(null).field, 'name');
  const long = checkRoutine({ ...base, name: 'N'.repeat(500), instructions: 'x'.repeat(9000) }, now, exists);
  assert.ok(long.ok);
  if (long.ok) {
    assert.equal(long.value.name.length, MAX_ROUTINE_NAME);
    assert.ok(long.value.name.endsWith('…'));
    assert.equal(long.value.instructions.length, MAX_ROUTINE_INSTRUCTIONS);
  }
  const messy = checkRoutine({ ...base, name: '  Daily\u0000\u0007   digest\n of   news ', instructions: 'line one\r\n\r\n\r\n\r\nline\u0000 two' }, now, exists);
  assert.ok(messy.ok);
  if (messy.ok) {
    assert.equal(messy.value.name, 'Daily digest of news');
    assert.equal(messy.value.instructions, 'line one\n\nline two');
    assert.equal(messy.value.enabled, true);
  }
  const off = checkRoutine({ ...base, enabled: false }, now, exists);
  assert.ok(off.ok && off.value.enabled === false);
  // Fields that are not part of a routine are not carried over.
  const extra = checkRoutine({ ...base, __proto__: { x: 1 }, nextAt: 5, pending: { state: 'waiting' }, id: 'zzz' }, now, exists);
  assert.ok(extra.ok);
  assert.deepEqual(Object.keys((extra as { value: object }).value).sort(), ['companionId', 'enabled', 'instructions', 'name', 'trigger']);
});

test('the routine marker and notice the host shows are checked and clamped', () => {
  assert.deepEqual(cleanRoutineMark({ id: 'abc', name: ' Morning \u0000 digest ' }), { id: 'abc', name: 'Morning digest' });
  assert.equal(cleanRoutineMark({ id: '', name: 'x' }), undefined);
  assert.equal(cleanRoutineMark({ id: 'a'.repeat(65), name: 'x' }), undefined);
  assert.equal(cleanRoutineMark({ id: 'a', name: '   ' }), undefined);
  assert.equal(cleanRoutineMark({ id: 'a', name: 5 }), undefined);
  assert.equal(cleanRoutineMark('nope'), undefined);
  assert.equal(cleanRoutineMark(undefined), undefined);
  assert.equal(cleanRoutineMark({ id: 'a', name: 'n'.repeat(200) })!.name.length, MAX_ROUTINE_NAME);
  assert.equal(routineNotice('Morning digest'), 'Routine: Morning digest');
});

test('a record keeps a trimmed, plain-text copy of the conversation', () => {
  const entries: ChatEntry[] = [
    { kind: 'notice', id: 'c1', text: 'Routine: Digest', tone: 'info' },
    { kind: 'user', id: 'c2', text: 'Read this page', page: { title: 'T', host: 'h' } },
    { kind: 'tool', id: 'c3', tool: 'read_page', summary: 'Read the page', state: 'done', detail: '3 headings' },
    { kind: 'approval', id: 'c4', summary: 'Type “x” into Name', reasons: ['r'], tab: { title: 't', host: 'h' }, state: 'declined', full: 'FULL TEXT' },
    { kind: 'assistant', id: 'c5', text: 'The title is Hello' },
  ];
  const { lines, truncated } = trimTranscript(entries);
  assert.equal(truncated, false);
  assert.deepEqual(lines.map((l) => l.kind), ['notice', 'user', 'tool', 'approval', 'assistant']);
  assert.deepEqual(lines[2], { kind: 'tool', text: 'Read the page (3 headings)', state: 'done' });
  assert.deepEqual(lines[3], { kind: 'approval', text: 'Type “x” into Name', state: 'declined' });
  assert.ok(!JSON.stringify(lines).includes('FULL TEXT'), 'only summaries, not the whole of a card');
  assert.ok(!JSON.stringify(lines).includes('"page"'), 'no page chips');
});

test('a record is capped: entries, text per entry, and text in all', () => {
  const many: ChatEntry[] = Array.from({ length: 200 }, (_, i) => ({ kind: 'assistant', id: `c${i}`, text: `line ${i}` }));
  const a = trimTranscript(many);
  assert.equal(a.lines.length, MAX_TRANSCRIPT_ENTRIES);
  assert.equal(a.truncated, true);
  assert.equal(a.lines.at(-1)!.text, 'line 199', 'the end of the conversation is what is kept');
  const big: ChatEntry[] = [{ kind: 'assistant', id: 'c1', text: 'y'.repeat(50_000) }];
  const b = trimTranscript(big);
  assert.equal(b.lines[0].text.length, MAX_TRANSCRIPT_ENTRY);
  const heavy: ChatEntry[] = Array.from({ length: 30 }, (_, i) => ({ kind: 'assistant', id: `c${i}`, text: String(i % 10).repeat(900) }));
  const c = trimTranscript(heavy);
  assert.ok(c.lines.reduce((n, l) => n + l.text.length, 0) <= MAX_TRANSCRIPT_CHARS);
  assert.ok(c.lines.length < 30 && c.truncated);
  assert.equal(c.lines.at(-1)!.text, '9'.repeat(900));
  // Page-derived markup stays text; control characters go.
  const d = trimTranscript([{ kind: 'assistant', id: 'c1', text: '<img src=x onerror=alert(1)>\u0000\u0007 ok' }]);
  assert.equal(d.lines[0].text, '<img src=x onerror=alert(1)> ok');
  assert.deepEqual(trimTranscript([]), { lines: [], truncated: false });
});

const rec = (id: string, routineId: string, startedAt: number): RunRecord => ({ id, routineId, routineName: 'R', companionId: 'general', companionName: 'General', startedAt, status: 'done', transcript: [] });

test('history keeps the newest 30 per routine and 150 in all', () => {
  const mine = Array.from({ length: 45 }, (_, i) => rec(`a${i}`, 'a', 1000 + i));
  const capped = capRecords([...mine, rec('b0', 'b', 5)]);
  assert.equal(capped.filter((r) => r.routineId === 'a').length, MAX_RECORDS_PER_ROUTINE);
  assert.equal(capped[0].id, 'a44', 'newest first');
  assert.ok(!capped.some((r) => r.id === 'a14'), 'the 15 oldest of that routine are gone');
  assert.ok(capped.some((r) => r.id === 'b0'), 'another routine is untouched');
  const lots = Array.from({ length: 12 }, (_, r) => Array.from({ length: 30 }, (_, i) => rec(`r${r}-${i}`, `r${r}`, r * 100 + i))).flat();
  assert.equal(capRecords(lots).length, MAX_RECORDS);
});

test('a saved record is checked again when loaded', () => {
  const ok = restoreRecord({ ...rec('x', 'a', 5), transcript: [{ kind: 'tool', text: 'hi', state: 'done' }, { kind: 'evil', text: 'x' }, { kind: 'user', text: 5 }, { kind: 'assistant', text: 'a', state: '<b>' }] });
  assert.ok(ok);
  assert.deepEqual(ok!.transcript, [{ kind: 'tool', text: 'hi', state: 'done' }, { kind: 'user', text: '' }, { kind: 'assistant', text: 'a' }]);
  assert.equal(restoreRecord({ ...rec('x', 'a', 5), status: 'weird' }), undefined);
  assert.equal(restoreRecord({ ...rec('', 'a', 5) }), undefined);
  assert.equal(restoreRecord(null), undefined);
  const long = restoreRecord({ ...rec('x', 'a', 5), routineName: 'n'.repeat(300), reason: 'r'.repeat(900), transcript: Array.from({ length: 99 }, () => ({ kind: 'notice', text: 'z'.repeat(5000) })) });
  assert.equal(long!.routineName.length, MAX_ROUTINE_NAME);
  assert.ok(long!.reason!.length <= 240);
  assert.equal(long!.transcript.length, MAX_TRANSCRIPT_ENTRIES);
  assert.ok(long!.transcript.every((l) => l.text.length <= MAX_TRANSCRIPT_ENTRY));
});

test('a run record keeps an artifact as a one-line notice, never its data', async () => {
  const { trimTranscript } = await import('../shared/routines');
  const artifact = { kind: 'table', title: 'Prices', columns: ['A'], rows: [['secret-looking cell']] } as never;
  const { lines } = trimTranscript([{ kind: 'artifact', id: 'a1', artifact }]);
  assert.deepEqual(lines, [{ kind: 'notice', text: 'Showed a table: Prices' }]);
  assert.ok(!JSON.stringify(lines).includes('secret-looking cell'));
});
