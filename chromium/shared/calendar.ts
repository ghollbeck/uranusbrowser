/**
 * Calendar reminders for meeting notes: the pure logic (no chrome.*, no Node) that the shell
 * uses to read the user's calendar and the tests check without a browser.
 *
 * The calendar is read from its private iCal (ICS) address, the "secret address" Google
 * Calendar, Outlook and iCloud give out. There is no OAuth, by design: no account is signed in
 * to and no token is kept, only that address, which the shell stores as a secret.
 *
 * What is here:
 *  - `checkCalendarUrl`: https only (`webcal://` is the same address over https), no name or
 *    password in front, and a masked form (host + "…") to show once saved.
 *  - `parseCalendar`: RFC 5545 line unfolding and property parsing, VEVENTs with DTSTART,
 *    DTEND or DURATION, SUMMARY, LOCATION, DESCRIPTION, URL, UID, STATUS, RRULE, EXDATE and
 *    RECURRENCE-ID. Times are UTC (`Z`), floating (this Mac's local time) or in a `TZID=` zone,
 *    converted with `Intl.DateTimeFormat` (no time-zone library). Outlook's Windows zone names
 *    ("W. Europe Standard Time") are mapped to IANA ones for the common cases; a zone nobody
 *    knows is read as local time rather than dropped.
 *  - `expandEvents`: the occurrences inside a window (the shell asks for the next day and a
 *    half), with recurring events expanded for FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL,
 *    COUNT, UNTIL, BYDAY (with ordinals for MONTHLY), BYMONTHDAY, BYSETPOS and WKST, minus
 *    EXDATEs, with RECURRENCE-ID overrides moving or cancelling one occurrence. A series keeps
 *    its wall-clock time across a daylight-saving change. Expansion jumps straight to the window
 *    when it can and has a hard cap on iterations, so a hostile or huge file can't spin.
 *  - `findMeetingLink`: the Google Meet, Zoom or Teams link in an event, through joinly's
 *    checked allowlist (`checkMeetingUrl`): https, the platform's own host as a whole name, no
 *    credentials or port, and a meeting path (a Meet code, Zoom /j/ or /my/, a Teams join link).
 *  - `liveMeetingTab`: whether a tab's address is a live meeting, for the "Record notes?" offer.
 *  - When to prompt: `dueForPrompt`, `startingSoon`, `meetingsToday`, `nextPromptAt`, and the
 *    meeting the reminder popup shows (`reminderMeeting`) until it ends.
 *
 * Event text is untrusted: someone else can put anything in an invitation. Titles are flattened
 * to one clipped line here, descriptions are only searched for a link and never kept, and the
 * shell renders what is kept as DOM text and never gives it to the model.
 */
import { checkMeetingUrl, type MeetingPlatform } from './joinly';

// ---- limits and timings ---------------------------------------------------------------------

/** The window of occurrences kept: from an hour ago to a day and a half ahead. */
export const WINDOW_BEFORE_MS = 60 * 60 * 1000;
export const WINDOW_AFTER_MS = 36 * 60 * 60 * 1000;
/** The reminder comes this long before a meeting starts and stays until it ends, unless dismissed. */
export const PROMPT_LEAD_MS = 2 * 60 * 1000;
/** A meeting whose calendar entry has no length (or ends before it starts) counts as this long. */
export const PROMPT_GRACE_MS = 10 * 60 * 1000;
/** The panel's strip appears this long before a meeting starts. */
export const SOON_MS = 5 * 60 * 1000;
/** The biggest calendar file read. Google's export has every event ever, so it can be large. */
export const MAX_ICS_CHARS = 15 * 1024 * 1024;
/** The most events read from one file, and the most occurrences kept from one window. */
export const MAX_EVENTS = 50_000;
export const MAX_OCCURRENCES = 200;
/** The most periods one recurrence rule is stepped through. */
export const MAX_RULE_STEPS = 5000;
export const MAX_TITLE_CHARS = 120;
const MAX_URL_CHARS = 2048;
const MAX_SEARCH_CHARS = 20_000;
const DAY_MS = 86_400_000;

// ---- the calendar address -----------------------------------------------------------------------

export type CalendarUrlCheck = { ok: true; url: string; host: string; shown: string } | { ok: false; reason: string };

/**
 * A private iCal address, checked. `webcal://` (what Outlook and iCloud hand out) is the same
 * address over https. `shown` is the host and an ellipsis: the rest of the address is the secret.
 */
export function checkCalendarUrl(raw: unknown): CalendarUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'The calendar address must be text.' };
  let text = raw.trim();
  if (!text) return { ok: false, reason: 'Paste your calendar’s private iCal address.' };
  if (text.length > MAX_URL_CHARS) return { ok: false, reason: 'That address is too long.' };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(text)) return { ok: false, reason: 'That address has characters a calendar address doesn’t.' };
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:/i, 'https:');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: 'That isn’t a valid address. It should start with https:// or webcal://' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Only https:// (or webcal://) calendar addresses are accepted.' };
  if (u.username || u.password) return { ok: false, reason: 'Addresses with a name or password in front are not accepted.' };
  if (!u.hostname.includes('.') || u.pathname.length < 2) return { ok: false, reason: 'That doesn’t look like a calendar’s address. Copy the whole secret iCal address.' };
  u.hash = '';
  return { ok: true, url: u.href, host: u.hostname, shown: maskCalendarUrl(u.href) };
}

/** What is shown of a saved calendar address: its host and an ellipsis. */
export function maskCalendarUrl(url: string): string {
  try {
    return `${new URL(url).hostname}…`;
  } catch {
    return '…';
  }
}

// ---- parsing ------------------------------------------------------------------------------------

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export type IcsTime =
  | { kind: 'date'; y: number; m: number; d: number }
  | { kind: 'utc' | 'floating'; y: number; m: number; d: number; h: number; mi: number; s: number }
  | { kind: 'zoned'; tz: string; y: number; m: number; d: number; h: number; mi: number; s: number };

/** One VEVENT as written in the file (text not yet cleaned). */
export interface CalendarEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  url: string;
  /** Google's X-GOOGLE-CONFERENCE or Outlook's Teams address, where the file has one. */
  conference: string;
  status: string;
  start: IcsTime;
  end?: IcsTime;
  durationMs?: number;
  rrule?: string;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
}

/** RFC 5545 §3.1: a line break followed by one space or tab continues the line. */
export function unfoldLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** One content line: NAME;PARAM=value;PARAM="quoted, value":VALUE. Undefined if it isn't one. */
export function parseLine(line: string): IcsProperty | undefined {
  const n = line.length;
  let i = 0;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  // A group prefix ("item1.URL") is dropped.
  const name = line.slice(0, i).replace(/^.*\./, '').toUpperCase();
  if (!name || i >= n) return undefined;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    i++;
    const eq = line.indexOf('=', i);
    if (eq < 0) return undefined;
    const key = line.slice(i, eq).toUpperCase();
    i = eq + 1;
    let value = '';
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return undefined;
        value += line.slice(i + 1, close);
        i = close + 1;
      } else {
        let j = i;
        while (j < n && line[j] !== ';' && line[j] !== ':' && line[j] !== ',') j++;
        value += line.slice(i, j);
        i = j;
      }
      if (line[i] !== ',') break;
      value += ',';
      i++;
    }
    params[key] = value;
  }
  if (line[i] !== ':') return undefined;
  return { name, params, value: line.slice(i + 1) };
}

/** TEXT values: \n is a line break, \, \; and \\ are themselves. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Outlook writes Windows zone names; the common ones, as IANA names. */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

const zoneCache = new Map<string, string | undefined>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA zone a TZID names, or undefined (the time is then read as local). Accepts IANA names,
 * Windows names, and prefixed forms like "/mozilla.org/20050126_1/Europe/Berlin".
 */
export function resolveZone(tzid: string): string | undefined {
  const name = tzid.trim().replace(/^"|"$/g, '');
  if (zoneCache.has(name)) return zoneCache.get(name);
  let found: string | undefined;
  if (Object.hasOwn(WINDOWS_ZONES, name)) found = WINDOWS_ZONES[name];
  else if (/^[A-Za-z0-9_.+\-/]{1,64}$/.test(name)) {
    const parts = name.split('/').filter(Boolean);
    for (let k = parts.length; k >= 1 && !found; k--) {
      const candidate = parts.slice(-k).join('/');
      if (isZone(candidate)) found = candidate;
    }
  }
  zoneCache.set(name, found);
  return found;
}

/** A DATE or DATE-TIME value; undefined if it isn't one. */
export function parseTime(value: string, params: Record<string, string> = {}): IcsTime | undefined {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params.VALUE === 'DATE') {
    if (!date) return undefined;
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return validDate(y, m, d) ? { kind: 'date', y, m, d } : undefined;
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return undefined;
  const [y, m, d, h, mi, s] = dt.slice(1, 7).map(Number);
  if (!validDate(y, m, d) || h > 23 || mi > 59 || s > 60) return undefined;
  const fields = { y, m, d, h, mi, s: Math.min(s, 59) };
  if (dt[7]) return { kind: 'utc', ...fields };
  const tz = params.TZID ? resolveZone(params.TZID) : undefined;
  if (tz === 'UTC') return { kind: 'utc', ...fields };
  return tz ? { kind: 'zoned', tz, ...fields } : { kind: 'floating', ...fields };
}

function validDate(y: number, m: number, d: number) {
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** A DURATION value in milliseconds ("PT45M", "P1D", "-PT15M", "P1W"). */
export function parseDuration(value: string): number | undefined {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match || value.trim().replace(/^[+-]/, '') === 'P' || /T$/.test(value.trim())) return undefined;
  const [, sign, w, d, h, m, s] = match;
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/**
 * The events in an iCalendar file. Nested components (alarms) are skipped, and so is anything
 * that isn't a VEVENT with a start. Stops after MAX_EVENTS.
 */
export function parseCalendar(text: string): { events: CalendarEvent[]; truncated: boolean } {
  const events: CalendarEvent[] = [];
  const stack: string[] = [];
  let props: IcsProperty[] | undefined;
  for (const line of unfoldLines(text.length > MAX_ICS_CHARS ? text.slice(0, MAX_ICS_CHARS) : text)) {
    if (!line) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const kind = prop.value.trim().toUpperCase();
      stack.push(kind);
      if (kind === 'VEVENT' && stack.length <= 2) props = [];
      continue;
    }
    if (prop.name === 'END') {
      const kind = prop.value.trim().toUpperCase();
      // Tolerate an END that doesn't match: unwind to the component it names.
      const at = stack.lastIndexOf(kind);
      if (at >= 0) stack.length = at;
      if (kind === 'VEVENT' && props) {
        const event = eventFrom(props);
        props = undefined;
        if (event) events.push(event);
        if (events.length >= MAX_EVENTS) return { events, truncated: true };
      }
      continue;
    }
    if (props && stack[stack.length - 1] === 'VEVENT') props.push(prop);
  }
  return { events, truncated: false };
}

function eventFrom(props: IcsProperty[]): CalendarEvent | undefined {
  const first = (name: string) => props.find((p) => p.name === name);
  const text = (name: string) => unescapeText(first(name)?.value ?? '');
  const startProp = first('DTSTART');
  const start = startProp && parseTime(startProp.value, startProp.params);
  if (!start) return undefined;
  const endProp = first('DTEND');
  const end = endProp ? parseTime(endProp.value, endProp.params) : undefined;
  const durationProp = first('DURATION');
  const durationMs = durationProp ? parseDuration(durationProp.value) : undefined;
  const recurrenceProp = first('RECURRENCE-ID');
  const exdates: IcsTime[] = [];
  for (const p of props) {
    if (p.name !== 'EXDATE') continue;
    for (const v of p.value.split(',')) {
      const t = parseTime(v, p.params);
      if (t) exdates.push(t);
    }
  }
  return {
    uid: (first('UID')?.value ?? '').trim().slice(0, 300),
    summary: text('SUMMARY'),
    location: text('LOCATION'),
    description: text('DESCRIPTION').slice(0, MAX_SEARCH_CHARS),
    url: (first('URL')?.value ?? '').trim(),
    conference: (first('X-GOOGLE-CONFERENCE')?.value ?? first('X-MICROSOFT-SKYPETEAMSMEETINGURL')?.value ?? '').trim(),
    status: (first('STATUS')?.value ?? '').trim().toUpperCase(),
    start,
    end,
    durationMs,
    rrule: first('RRULE')?.value.trim(),
    exdates,
    recurrenceId: recurrenceProp ? parseTime(recurrenceProp.value, recurrenceProp.params) : undefined,
  };
}

// ---- time ----------------------------------------------------------------------------------------

function daysInMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days since 1970-01-01 of a calendar date (no zone involved). */
const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const civilOf = (day: number) => {
  const date = new Date(day * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};
const weekday = (day: number) => (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)

function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** How far ahead of UTC the zone's clocks are at an instant, in milliseconds. */
function zoneOffset(epoch: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - (epoch - (((epoch % 1000) + 1000) % 1000));
}

/** The instant a wall-clock time in a zone happens. In a spring-forward gap it lands just after. */
export function zonedToEpoch(t: { y: number; m: number; d: number; h: number; mi: number; s: number }, tz: string): number {
  const wall = Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi, t.s);
  const first = zoneOffset(wall, tz);
  const second = zoneOffset(wall - first, tz);
  return wall - second;
}

/** The instant an ICS time names. Floating times and dates are this Mac's local time. */
export function toEpoch(t: IcsTime): number {
  if (t.kind === 'date') return new Date(t.y, t.m - 1, t.d).getTime();
  if (t.kind === 'zoned') return zonedToEpoch(t, t.tz);
  if (t.kind === 'utc') return Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi, t.s);
  return new Date(t.y, t.m - 1, t.d, t.h, t.mi, t.s).getTime();
}

/** The same kind of time as `like`, on another calendar day, at `like`'s time of day. */
function onDay(like: IcsTime, day: number): IcsTime {
  const c = civilOf(day);
  return like.kind === 'date' ? { kind: 'date', ...c } : { ...like, ...c };
}

// ---- recurrence ------------------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: IcsTime;
  byDay: Array<{ n: number; wd: number }>;
  byMonthDay: number[];
  bySetPos: number[];
  wkst: number;
}

/** An RRULE, or undefined for one this doesn't expand (the event then counts once, at its start). */
export function parseRule(value: string): RecurrenceRule | undefined {
  const parts = new Map<string, string>();
  for (const piece of value.split(';')) {
    const [k, v] = piece.split('=');
    if (k && v !== undefined) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return undefined;
  // Rules that narrow by month, week number, hour or minute aren't expanded: better one miss than wrong prompts.
  for (const k of ['BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']) if (parts.has(k)) return undefined;
  const interval = Math.max(1, Math.min(1000, Number(parts.get('INTERVAL') ?? 1) || 1));
  const countText = parts.get('COUNT');
  const count = countText !== undefined && /^\d+$/.test(countText) ? Number(countText) : undefined;
  const untilText = parts.get('UNTIL');
  const until = untilText ? parseTime(untilText) : undefined;
  const byDay: RecurrenceRule['byDay'] = [];
  for (const item of (parts.get('BYDAY') ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
    if (!m) return undefined;
    byDay.push({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) });
  }
  const numbers = (key: string) => (parts.get(key) ?? '').split(',').filter(Boolean).map(Number);
  const byMonthDay = numbers('BYMONTHDAY');
  const bySetPos = numbers('BYSETPOS');
  if ([...byMonthDay, ...bySetPos].some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > 366)) return undefined;
  const wkst = WEEKDAYS.indexOf(parts.get('WKST') ?? 'MO');
  return { freq, interval, count, until, byDay, byMonthDay, bySetPos, wkst: wkst < 0 ? 1 : wkst };
}

function applySetPos(days: number[], setPos: number[]): number[] {
  if (!setPos.length) return days;
  const picked = setPos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((d): d is number => d !== undefined);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** The calendar days a rule's `period`-th period offers (sorted), before DTSTART is applied. */
function periodDays(rule: RecurrenceRule, start: { y: number; m: number; d: number; day: number }, period: number): number[] {
  const step = period * rule.interval;
  if (rule.freq === 'DAILY') {
    const day = start.day + step;
    const c = civilOf(day);
    if (rule.byDay.length && !rule.byDay.some((b) => b.wd === weekday(day))) return [];
    if (rule.byMonthDay.length && !rule.byMonthDay.some((md) => (md > 0 ? md : daysInMonth(c.y, c.m) + md + 1) === c.d)) return [];
    return [day];
  }
  if (rule.freq === 'WEEKLY') {
    const weekStart = start.day - ((weekday(start.day) - rule.wkst + 7) % 7) + step * 7;
    const wds = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [weekday(start.day)];
    const days = [...new Set(wds.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)))].sort((a, b) => a - b);
    return applySetPos(days, rule.bySetPos);
  }
  if (rule.freq === 'MONTHLY') {
    const index = start.y * 12 + (start.m - 1) + step;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    const length = daysInMonth(y, m);
    const first = dayNumber(y, m, 1);
    let days: number[];
    const fromMonthDays = rule.byMonthDay.map((md) => (md > 0 ? md : length + md + 1)).filter((d) => d >= 1 && d <= length).map((d) => first + d - 1);
    if (rule.byDay.length) {
      const fromDays: number[] = [];
      for (const { n, wd } of rule.byDay) {
        const all: number[] = [];
        for (let d = 0; d < length; d++) if (weekday(first + d) === wd) all.push(first + d);
        if (n === 0) fromDays.push(...all);
        else {
          const pick = n > 0 ? all[n - 1] : all[all.length + n];
          if (pick !== undefined) fromDays.push(pick);
        }
      }
      days = rule.byMonthDay.length ? fromDays.filter((d) => fromMonthDays.includes(d)) : fromDays;
    } else if (rule.byMonthDay.length) days = fromMonthDays;
    else days = start.d <= length ? [first + start.d - 1] : [];
    return applySetPos([...new Set(days)].sort((a, b) => a - b), rule.bySetPos);
  }
  // YEARLY: the same month and day (29 February only in leap years).
  const y = start.y + step;
  return start.d <= daysInMonth(y, start.m) ? [dayNumber(y, start.m, start.d)] : [];
}

/** How many whole periods lie before the window, to skip them (only when nothing needs counting). */
function periodsBefore(rule: RecurrenceRule, start: { y: number; m: number; day: number }, fromDay: number): number {
  const gap = fromDay - start.day;
  if (gap <= 0) return 0;
  const units = rule.freq === 'DAILY' ? gap : rule.freq === 'WEEKLY' ? Math.floor(gap / 7) : rule.freq === 'MONTHLY' ? (civilOf(fromDay).y - start.y) * 12 + civilOf(fromDay).m - start.m : civilOf(fromDay).y - start.y;
  // One period of slack on each side: a period can start before the window and reach into it.
  return Math.max(0, Math.floor(units / rule.interval) - 2);
}

/**
 * The start instants of a recurring event that fall in [from - durationMs, to], before EXDATE
 * and overrides are applied. DTSTART itself is always the first occurrence, as RFC 5545 says.
 */
export function ruleStarts(startTime: IcsTime, rule: RecurrenceRule, from: number, to: number, durationMs: number): number[] {
  const out: number[] = [];
  const civil = { y: startTime.y, m: startTime.m, d: startTime.d, day: dayNumber(startTime.y, startTime.m, startTime.d) };
  const startEpoch = toEpoch(startTime);
  const untilEpoch = rule.until ? (rule.until.kind === 'date' ? undefined : toEpoch(rule.until)) : undefined;
  const untilDay = rule.until?.kind === 'date' ? dayNumber(rule.until.y, rule.until.m, rule.until.d) : undefined;
  const counting = rule.count !== undefined;
  // Skip whole periods before the window: from the day before (zones), unless COUNT needs every one.
  const fromDay = Math.floor((from - durationMs) / DAY_MS) - 1;
  let period = counting ? 0 : periodsBefore(rule, civil, fromDay);
  let generated = 0;
  let sawStart = period > 0;
  const take = (day: number, epoch: number): 'stop' | 'go' => {
    if (counting && generated >= rule.count!) return 'stop';
    if (untilDay !== undefined ? day > untilDay : untilEpoch !== undefined && epoch > untilEpoch) return 'stop';
    generated++;
    if (epoch > to) return 'stop';
    if (epoch + Math.max(durationMs, 0) >= from) out.push(epoch);
    return out.length >= MAX_OCCURRENCES ? 'stop' : 'go';
  };
  for (let steps = 0; steps < MAX_RULE_STEPS; steps++, period++) {
    const days = periodDays(rule, civil, period).filter((d) => d >= civil.day);
    if (!sawStart && (days[0] ?? Infinity) > civil.day) {
      sawStart = true;
      if (take(civil.day, startEpoch) === 'stop') return out;
    }
    for (const day of days) {
      sawStart = true;
      const epoch = day === civil.day ? startEpoch : toEpoch(onDay(startTime, day));
      if (take(day, epoch) === 'stop') return out;
    }
  }
  return out;
}

// ---- occurrences ------------------------------------------------------------------------------------

export interface MeetingLink {
  url: string;
  platform: MeetingPlatform;
  /** The address without its query (a Zoom passcode lives there), for showing. */
  shown: string;
}

/** One occurrence of an event inside the window, with its text already cleaned. */
export interface Occurrence {
  id: string;
  uid: string;
  start: number;
  end: number;
  allDay: boolean;
  title: string;
  link?: MeetingLink;
}

/** 16 hex digits from two 32-bit FNV-1a hashes: a short, stable id for text that may be long or odd. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** A stable id for one occurrence: its event's UID and start, hashed (UIDs can be long and odd). */
export const occurrenceId = (uid: string, start: number) => `ev-${shortHash(`${uid}\u0000${start}`)}`;

/** Event text made safe to keep: one line, no control characters, clipped. */
export function cleanEventText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function durationOf(event: CalendarEvent, startEpoch: number): number {
  if (event.end) {
    const end = toEpoch(event.end);
    if (Number.isFinite(end) && end >= startEpoch) return end - startEpoch;
  }
  if (event.durationMs !== undefined && event.durationMs >= 0) return event.durationMs;
  return event.start.kind === 'date' ? DAY_MS : 0;
}

/**
 * Every occurrence that overlaps [from, to], sorted by start: recurring events expanded,
 * EXDATEs removed, RECURRENCE-ID overrides applied, cancelled ones dropped. At most
 * MAX_OCCURRENCES.
 */
export function expandEvents(events: readonly CalendarEvent[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  // The occurrences an override replaces (moved or cancelled), by UID.
  const replaced = new Map<string, Set<number>>();
  for (const e of events) {
    if (!e.recurrenceId) continue;
    const set = replaced.get(e.uid) ?? new Set<number>();
    set.add(toEpoch(e.recurrenceId));
    replaced.set(e.uid, set);
  }
  const add = (e: CalendarEvent, start: number, duration: number, link: MeetingLink | undefined) => {
    if (!Number.isFinite(start) || start > to || start + duration < from) return;
    out.push({
      id: occurrenceId(e.uid, start),
      uid: e.uid,
      start,
      end: start + duration,
      allDay: e.start.kind === 'date',
      title: cleanEventText(e.summary, MAX_TITLE_CHARS) || 'Untitled event',
      link,
    });
  };
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    const startEpoch = toEpoch(e.start);
    if (!Number.isFinite(startEpoch)) continue;
    const duration = durationOf(e, startEpoch);
    const rule = !e.recurrenceId && e.rrule ? parseRule(e.rrule) : undefined;
    let link: MeetingLink | undefined | null = null;
    const linkOf = () => (link === null ? (link = findMeetingLink(e.conference, e.url, e.location, e.description)) : link);
    if (!rule) {
      if (startEpoch <= to && startEpoch + duration >= from) add(e, startEpoch, duration, linkOf());
      continue;
    }
    const skip = new Set<number>([...e.exdates.map(toEpoch), ...(replaced.get(e.uid) ?? [])]);
    const skipDays = new Set(e.exdates.filter((x) => x.kind === 'date').map((x) => dayNumber(x.y, x.m, x.d)));
    for (const start of ruleStarts(e.start, rule, from, to, duration)) {
      if (skip.has(start)) continue;
      if (skipDays.size && e.start.kind === 'date') {
        const d = new Date(start);
        if (skipDays.has(dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate()))) continue;
      }
      add(e, start, duration, linkOf());
    }
  }
  out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return out.slice(0, MAX_OCCURRENCES);
}

// ---- meeting links -----------------------------------------------------------------------------------

/** A Meet code path: "/abc-defg-hij", or "/meet/abc-defg-hij", where Meet sends a visitor who isn't signed in. */
const MEET_CODE = /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i;

/** Whether a checked address is a meeting itself, not the platform's home or settings page. */
function isMeetingPath(platform: MeetingPlatform, u: URL): boolean {
  if (platform === 'Google Meet') return MEET_CODE.test(u.pathname);
  if (platform === 'Zoom') return /^\/(j|my)\/[A-Za-z0-9._-]+\/?$/.test(u.pathname);
  return /^\/(l\/meetup-join|meet)\/./.test(u.pathname);
}

/** A single address, if it is a Google Meet, Zoom or Teams meeting link (joinly's allowlist, plus the path). */
export function meetingLinkOf(raw: string): MeetingLink | undefined {
  const checked = checkMeetingUrl(raw);
  if (!checked.ok) return undefined;
  const u = new URL(checked.url);
  if (!isMeetingPath(checked.platform, u)) return undefined;
  return { url: checked.url, platform: checked.platform, shown: checked.shown };
}

/** The first meeting link in these texts, in order (the conference field, URL, LOCATION, DESCRIPTION). */
export function findMeetingLink(...texts: string[]): MeetingLink | undefined {
  for (const text of texts) {
    if (!text) continue;
    const candidates = text.slice(0, MAX_SEARCH_CHARS).replace(/&amp;/g, '&').match(/https:\/\/[^\s<>"'`()[\]{}\\|^]+/gi) ?? [];
    for (const candidate of candidates) {
      const link = meetingLinkOf(candidate.replace(/[.,;:!?>*]+$/, ''));
      if (link) return link;
    }
  }
  return undefined;
}

/**
 * Whether a tab's address is a live meeting (not the platform's home page): a Meet code, a Zoom
 * join or web-client page, or a Teams join link. `key` names the meeting, to remember a "Not now".
 */
export function liveMeetingTab(address: string): { platform: MeetingPlatform; key: string } | undefined {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
  const host = u.hostname.toLowerCase();
  // The key is the code alone, so both forms of one meeting's address are the same meeting.
  if (host === 'meet.google.com') return MEET_CODE.test(u.pathname) ? { platform: 'Google Meet', key: `meet:/${u.pathname.replace(/^\/(?:meet\/)?|\/$/g, '').toLowerCase()}` } : undefined;
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    const id = /^\/(?:j|wc(?:\/join)?|s)\/(\d{6,})/.exec(u.pathname)?.[1];
    if (id) return { platform: 'Zoom', key: `zoom:${id}` };
    return /^\/(?:j|my)\/./.test(u.pathname) || /^\/wc\/./.test(u.pathname) ? { platform: 'Zoom', key: `zoom:${u.pathname.slice(0, 120)}` } : undefined;
  }
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    const where = `${u.pathname}${u.search}${u.hash}`;
    if (/^\/(l\/meetup-join|meet)\/./.test(u.pathname)) return { platform: 'Microsoft Teams', key: `teams:${u.pathname.slice(0, 160)}` };
    if (/meetup-join|meetingjoin=true|pre-join-calling|\/modern-calling\//i.test(where)) return { platform: 'Microsoft Teams', key: `teams:${where.slice(0, 160)}` };
  }
  return undefined;
}

// ---- when to prompt -------------------------------------------------------------------------------------

/** A meeting kept for the panel and the prompts: a timed occurrence with a meeting link. */
export interface CalendarMeeting {
  id: string;
  title: string;
  start: number;
  end: number;
  platform: MeetingPlatform;
  url: string;
  shown: string;
}

/** What a click on the meeting reminder (the windows' card, the floating panel) asks for. */
export type ReminderAction = 'join' | 'record' | 'assistant' | 'dismiss';

/** The meeting the floating panel on the pointer's display shows (native-host/reminderPopup.ts). */
export interface ReminderSpec {
  /** The occurrence id (`ev-…`). */
  id: string;
  title: string;
  /** "Google Meet", "Zoom", "Microsoft Teams". */
  platform: string;
  start: number;
  end: number;
  /** Whether "Record + AI assistant" is offered (joinly is on). */
  assistant: boolean;
}

/** The meetings among occurrences: timed (all-day events are skipped) and with a meeting link. */
export function meetingsFrom(occurrences: readonly Occurrence[]): CalendarMeeting[] {
  return occurrences
    .filter((o): o is Occurrence & { link: MeetingLink } => !o.allDay && !!o.link)
    .map((o) => ({ id: o.id, title: o.title, start: o.start, end: o.end, platform: o.link.platform, url: o.link.url, shown: o.link.shown }));
}

/** When a meeting counts as over: its end, but never sooner than the prompt's grace after it starts. */
const endOf = (m: CalendarMeeting) => Math.max(m.end, m.start + PROMPT_GRACE_MS);

/** Whether a meeting is in its reminder window now: from 2 minutes before the start until it ends. */
export const inPromptWindow = (m: CalendarMeeting, now: number) => m.start - PROMPT_LEAD_MS <= now && now < endOf(m);

/**
 * Meetings to notify about now, not yet handled: from 2 minutes before the start until the end,
 * so one already going on (the app just started, or the calendar was just read) is prompted at once.
 */
export function dueForPrompt(list: readonly CalendarMeeting[], now: number, handled: (id: string) => boolean): CalendarMeeting[] {
  return list.filter((m) => inPromptWindow(m, now) && !handled(m.id));
}

/**
 * When the reminders next change (for an alarm): a meeting not yet handled comes into its window,
 * or one in its window (`shown`: still on screen) ends. Undefined if nothing is coming.
 */
export function nextPromptAt(list: readonly CalendarMeeting[], now: number, handled: (id: string) => boolean, shown: (id: string) => boolean = () => false): number | undefined {
  let next: number | undefined;
  for (const m of list) {
    const opens = m.start - PROMPT_LEAD_MS;
    const at = opens > now ? (handled(m.id) ? undefined : opens) : inPromptWindow(m, now) && shown(m.id) ? endOf(m) : undefined;
    if (at !== undefined && (next === undefined || at < next)) next = at;
  }
  return next;
}

/**
 * The meeting the reminder popup shows now: in its window and not dismissed (or opened); the one
 * that started first when two overlap, since the later one gets its turn once that is answered.
 */
export function reminderMeeting(list: readonly CalendarMeeting[], now: number, dismissed: (id: string) => boolean): CalendarMeeting | undefined {
  return [...list].sort((a, b) => a.start - b.start).find((m) => inPromptWindow(m, now) && !dismissed(m.id));
}

/** The meeting the panel's strip offers: starting within 5 minutes or going on, not dismissed. */
export function startingSoon(list: readonly CalendarMeeting[], now: number, dismissed: (id: string) => boolean): CalendarMeeting | undefined {
  return [...list].sort((a, b) => a.start - b.start).find((m) => m.start - SOON_MS <= now && now < endOf(m) && !dismissed(m.id));
}

/** The next `n` meetings today (this Mac's day) that haven't ended, in order. */
export function meetingsToday(list: readonly CalendarMeeting[], now: number, n = 3): CalendarMeeting[] {
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  return [...list]
    .filter((m) => m.start < midnight && endOf(m) > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, n);
}

/**
 * The reminder's status line and how far the meeting is: "Live · 17 min in · until 22:45", or
 * "In 2 min · 20:15–22:45" before it starts. `progress` is 0 before the start, 1 at the end.
 */
export function reminderStatus(m: { start: number; end: number }, now: number, time: (ms: number) => string) {
  const live = now >= m.start;
  const minutes = Math.max(0, Math.round((now - m.start) / 60_000));
  const ahead = Math.max(0, Math.round((m.start - now) / 60_000));
  // `lead` and `tail` are the two halves, for where the whole line doesn't fit.
  const lead = live ? `Live · ${minutes ? `${minutes} min in` : 'just started'}` : ahead ? `In ${ahead} min` : 'Starting';
  const tail = live ? `until ${time(m.end)}` : `${time(m.start)}–${time(m.end)}`;
  const progress = m.end > m.start ? Math.min(1, Math.max(0, (now - m.start) / (m.end - m.start))) : 0;
  return { live, text: `${lead} · ${tail}`, lead, tail, progress };
}

/** "starts in 2 min", "starts now", "started 4 min ago". */
export function startsIn(start: number, now: number): string {
  const minutes = Math.round((start - now) / 60_000);
  if (minutes > 0) return `starts in ${minutes} min`;
  if (minutes === 0) return 'starts now';
  return `started ${-minutes} min ago`;
}

/**
 * Meetings the "Agent in a meeting" sheet offers to join without pasting a link: going on now or
 * later today (or within the next 12 hours), soonest first. Their links already passed joinly's
 * allowlist (`meetingLinkOf`); the sheet checks again when one is picked.
 */
export function meetingsToOffer(meetings: readonly CalendarMeeting[], now: number): CalendarMeeting[] {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const until = Math.max(end.getTime(), now + 12 * 3_600_000);
  return meetings.filter((m) => m.end > now && m.start < until).sort((a, b) => a.start - b.start);
}
