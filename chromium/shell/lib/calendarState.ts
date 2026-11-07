/**
 * Calendar reminders, per profile (chrome.storage.local): plain functions on plain data, so what
 * is kept and what is refused is testable without a browser. The background (shell/calendar.ts)
 * does the reading and writing.
 *
 * Layout:
 *  - `calendar:url`: the private iCal address. It works like a password (anyone with it can read
 *    the calendar), so it has a key of its own, is never sent to a page except as `maskCalendarUrl`,
 *    never logged, and never given to the model.
 *  - `calendar:settings`: whether to offer recording when the tab you are on is a meeting.
 *  - `calendar:cache`: the meetings with a link in the current window (titles already cleaned,
 *    no descriptions), when they were read, and the last error. Lets a background that woke up
 *    for an alarm prompt without fetching first.
 *  - `calendar:marks`: what has been dismissed or notified, per occurrence id (UID + start,
 *    hashed) or meeting tab, each until it no longer matters.
 */
import { MAX_OCCURRENCES, MAX_TITLE_CHARS, cleanEventText, meetingLinkOf, shortHash, type CalendarMeeting } from '../../shared/calendar';

export const URL_KEY = 'calendar:url';
export const SETTINGS_KEY = 'calendar:settings';
export const CACHE_KEY = 'calendar:cache';
export const MARKS_KEY = 'calendar:marks';

export interface CalendarSettings {
  /** Offer to record when the active tab is a Meet, Zoom or Teams meeting. On by default. */
  offerTabs: boolean;
}

export const DEFAULT_SETTINGS: CalendarSettings = { offerTabs: true };

export function restoreSettings(raw: unknown): CalendarSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { offerTabs: o.offerTabs !== false };
}

export interface CalendarCache {
  checkedAt?: number;
  /** Plain-language reason the last read failed. Never contains the address. */
  error?: string;
  /** How many events the file had, and when that was (for "Checked at…"). */
  events?: number;
  meetings: CalendarMeeting[];
}

export const EMPTY_CACHE: CalendarCache = { meetings: [] };

/** A stored cache, checked again: every link through the allowlist, every title cleaned. */
export function restoreCache(raw: unknown): CalendarCache {
  if (!raw || typeof raw !== 'object') return EMPTY_CACHE;
  const o = raw as Record<string, unknown>;
  const meetings: CalendarMeeting[] = [];
  for (const m of Array.isArray(o.meetings) ? o.meetings.slice(0, MAX_OCCURRENCES) : []) {
    if (!m || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    const link = typeof x.url === 'string' ? meetingLinkOf(x.url) : undefined;
    if (!link || typeof x.id !== 'string' || !ID.test(x.id) || !Number.isFinite(x.start) || !Number.isFinite(x.end)) continue;
    meetings.push({
      id: x.id,
      title: cleanEventText(typeof x.title === 'string' ? x.title : '', MAX_TITLE_CHARS) || 'Untitled event',
      start: Number(x.start),
      end: Math.max(Number(x.end), Number(x.start)),
      platform: link.platform,
      url: link.url,
      shown: link.shown,
    });
  }
  return {
    checkedAt: Number.isFinite(o.checkedAt) ? Number(o.checkedAt) : undefined,
    error: typeof o.error === 'string' ? o.error.slice(0, 300) : undefined,
    events: Number.isFinite(o.events) ? Number(o.events) : undefined,
    meetings,
  };
}

/** Occurrence ids (`ev-…`) and meeting-tab ids (`tab-…`). */
export const ID = /^(ev|tab)-[0-9a-f]{16}$/;

export interface CalendarMarks {
  /** Dismissed: no notification and no strip for it. Value: until when it is remembered. */
  dismissed: Record<string, number>;
  /** A notification was shown for it: not shown again. */
  prompted: Record<string, number>;
}

export const EMPTY_MARKS: CalendarMarks = { dismissed: {}, prompted: {} };
const MAX_MARKS = 500;

function restoreMap(raw: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([id, until]) => ID.test(id) && typeof until === 'number' && until > now)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, MAX_MARKS);
  for (const [id, until] of entries) out[id] = until as number;
  return out;
}

/** Stored marks, with anything expired or odd dropped. */
export function restoreMarks(raw: unknown, now: number): CalendarMarks {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { dismissed: restoreMap(o.dismissed, now), prompted: restoreMap(o.prompted, now) };
}

/** Marks with one more entry (kept until `until`), expired ones dropped. */
export function mark(marks: CalendarMarks, kind: keyof CalendarMarks, id: string, until: number, now: number): CalendarMarks {
  if (!ID.test(id)) return marks;
  return restoreMarks({ ...marks, [kind]: { ...marks[kind], [id]: Math.max(until, marks[kind][id] ?? 0) } }, now);
}

/** How long a mark is kept: a day past the meeting's start (a tab's "Not now", 12 hours). */
export const MARK_AFTER_MS = 24 * 60 * 60 * 1000;
export const TAB_MARK_MS = 12 * 60 * 60 * 1000;

/** The id a meeting tab's "Not now" is remembered under (its meeting, not its whole address). */
export const tabId = (key: string) => `tab-${shortHash(key)}`;
