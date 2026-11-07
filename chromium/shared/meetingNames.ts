/**
 * Who said what, in a meeting: two sources of names, both pure so they can be tested.
 *
 *  1. The meeting page itself. While recording, the shell polls the meeting tab (on demand,
 *     never with a content script) for the name on the active-speaker tile; that gives a
 *     timeline of (time, name). `labelOthers` merges it into the transcript by overlap, the
 *     way joinly does (src joinly/services/stt/deepgram.py: the speaker with the most overlap
 *     wins, and needs a minimum share of the segment, else the line stays unnamed).
 *  2. What people say about themselves: "I'm Alice". Clear first-person introductions only,
 *     from OpenWhisper's src/main/recorder/names.ts (MIT licensed). These are only ever
 *     suggestions for the user to accept, because one person introducing themselves says
 *     nothing about the others on the call.
 *
 * Only the user's own microphone is "Me". Names from the page apply to the "Others" channel.
 */
import { cleanLine, type StoredSegment } from './meetings';

// ---- the page's active-speaker timeline ------------------------------------------------------

/** What one poll of the meeting page saw: the name on the highlighted tile, or none. */
export interface SpeakerObservation {
  /** Milliseconds on the recording clock. */
  t: number;
  name: string | null;
}

export interface NamedInterval {
  start: number;
  end: number;
  name: string;
}

/** A name is kept only if it is short, one line, and not the page's word for the user themselves. */
const SELF = /^(?:you|me|yourself|du|ich|vous|tú|tu|presentation|presenting|you \(presenting\)|unknown|participant|guest)$/i;
export function cleanParticipantName(raw: unknown): string | null {
  const name = cleanLine(raw, 60).replace(/\s*\((?:you|host|presenter|organizer|guest|me)\)\s*$/i, '').trim();
  if (!name || name.length < 2 || SELF.test(name)) return null;
  // Meeting UIs put controls in the same spans ("Mute", "Pin"); a name has a letter and no brackets.
  if (!/\p{L}/u.test(name) || /[<>{}[\]]/.test(name)) return null;
  return name;
}

/**
 * Turns polls into intervals. A name holds until the next poll, but never longer than
 * `maxHoldMs` (a closed tab or a stalled poll must not name a whole stretch of silence).
 */
export function speakerIntervals(observations: SpeakerObservation[], endMs: number, maxHoldMs = 3000): NamedInterval[] {
  const sorted = [...observations].filter((o) => Number.isFinite(o.t) && o.t >= 0).sort((a, b) => a.t - b.t);
  const out: NamedInterval[] = [];
  sorted.forEach((o, i) => {
    const name = cleanParticipantName(o.name);
    if (!name) return;
    const next = sorted[i + 1]?.t ?? endMs;
    const end = Math.min(next, o.t + maxHoldMs, endMs);
    if (end > o.t) out.push({ start: o.t, end, name });
  });
  return out;
}

export interface LabelOptions {
  /** How far a highlight can lag or lead the sound it belongs to (the tile lights a moment late). */
  slackMs?: number;
  /** The share of the segment the winning name must cover, 0 to 1. */
  minShare?: number;
  /** Or, for short segments, at least this many milliseconds. */
  minMs?: number;
  /** The winner must also hold at least this fraction of all named time in the segment. */
  dominance?: number;
}

/**
 * The name for a stretch of speech, or null: the speaker whose highlighted time overlaps it
 * most, if that overlap is a real part of the segment (at least `minShare` of it or `minMs`)
 * and the winner is clearly ahead of anyone else in it (`dominance`).
 */
export function nameForSpan(intervals: NamedInterval[], start: number, end: number, options: LabelOptions = {}): string | null {
  const slack = options.slackMs ?? 600;
  const minShare = options.minShare ?? 0.1;
  const minMs = options.minMs ?? 800;
  const dominance = options.dominance ?? 0.5;
  const from = start - slack;
  const to = end + slack;
  const time = new Map<string, number>();
  for (const interval of intervals) {
    const overlap = Math.min(interval.end, to) - Math.max(interval.start, from);
    if (overlap > 0) time.set(interval.name, (time.get(interval.name) ?? 0) + overlap);
  }
  let best: string | null = null;
  let bestTime = 0;
  let total = 0;
  for (const [name, ms] of time) {
    total += ms;
    if (ms > bestTime) {
      best = name;
      bestTime = ms;
    }
  }
  const length = Math.max(1, end - start);
  if (!best || bestTime < Math.min(length * minShare, minMs)) return null;
  return bestTime / total >= dominance ? best : null;
}

/**
 * Names the "Others" lines from the page's timeline. "Me" stays "Me", and a line with no
 * clear name stays "Others". Returns new segments; the input is not changed.
 */
export function labelOthers(segments: StoredSegment[], observations: SpeakerObservation[], endMs: number, options: LabelOptions = {}): StoredSegment[] {
  const intervals = speakerIntervals(observations, endMs);
  if (!intervals.length) return segments.map((s) => ({ ...s }));
  return segments.map((s) => {
    if (s.channel !== 'Others') return { ...s };
    const name = nameForSpan(intervals, s.start_ms, s.end_ms, options);
    return { ...s, speaker: name ?? 'Others' };
  });
}

/** The distinct names a timeline saw, most time first. */
export function participantsFrom(observations: SpeakerObservation[], endMs: number): string[] {
  const time = new Map<string, number>();
  for (const i of speakerIntervals(observations, endMs)) time.set(i.name, (time.get(i.name) ?? 0) + (i.end - i.start));
  return [...time.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** The participant list read from the page: cleaned, distinct, bounded. */
export function cleanParticipantList(raw: unknown, max = 60): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const name = cleanParticipantName(entry);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
    if (out.length >= max) break;
  }
  return out;
}

// ---- self-introductions ----------------------------------------------------------------------

/** Extracts only clear first-person introductions; ordinary name mentions are ignored. */
const NAME = "([\\p{Lu}][\\p{L}'’-]*(?:\\s+[\\p{Lu}][\\p{L}'’-]*){0,2})";
const INTRO_PATTERNS = [
  new RegExp(`\\b[Mm]y name is\\s+${NAME}`, 'u'),
  new RegExp(`\\b[Ii] am\\s+${NAME}`, 'u'),
  new RegExp(`\\b[Ii]'m\\s+${NAME}`, 'u'),
  new RegExp(`\\b[Ii]ch hei(?:ß|ss)e\\s+${NAME}`, 'u'),
  new RegExp(`\\b[Mm]ein [Nn]ame ist\\s+${NAME}`, 'u'),
  new RegExp(`\\b[Ii]ch bin\\s+${NAME}`, 'u'),
];

const NOT_A_NAME = /^(?:A|An|The|And|But|Or|So|Very|Glad|Happy|Here|From|At|In|Working|Trying|Calling|Doing|Going|Looking|Just|Still|Actually|Not)$/u;

export function extractIntroductionName(text: string): string | null {
  for (const pattern of INTRO_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const name = match[1].trim();
    if (name && name.length <= 48 && !name.split(/\s+/u).some((word) => NOT_A_NAME.test(word))) return name;
  }
  return null;
}

export function introductionIsInWindow(startMs: number, endMs: number): boolean {
  // Capture uses fractional milliseconds; placed segments use whole ones. Allow their
  // rounding difference at the origin.
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= -1 && startMs < 120_000 && endMs > Math.max(0, startMs) && endMs <= 120_000;
}

export interface NameSuggestions {
  Me?: string;
  Others?: string;
}

/**
 * Names people gave for themselves in the first two minutes: one per channel, and only when
 * that channel has exactly one distinct introduction. The "Others" suggestion is a guess about
 * ONE of possibly many people; the UI offers it, never applies it.
 */
export function suggestSpeakerNames(segments: StoredSegment[]): NameSuggestions {
  const found: Record<'Me' | 'Others', Set<string>> = { Me: new Set(), Others: new Set() };
  for (const s of segments) {
    if (!introductionIsInWindow(s.start_ms, s.end_ms)) continue;
    const name = extractIntroductionName(s.text);
    if (name) found[s.channel].add(name);
  }
  const out: NameSuggestions = {};
  if (found.Me.size === 1) out.Me = [...found.Me][0];
  if (found.Others.size === 1) out.Others = [...found.Others][0];
  // The same introduction on both channels is the microphone hearing the speakers: no evidence for either.
  if (out.Me && out.Others && out.Me.toLowerCase() === out.Others.toLowerCase()) return {};
  return out;
}

/** Renames every line of one speaker label (the user accepted a suggestion, or typed a name). */
export function renameSpeaker(segments: StoredSegment[], from: string, to: string): StoredSegment[] {
  const name = cleanLine(to, 60);
  if (!name) return segments;
  return segments.map((s) => (s.speaker === from ? { ...s, speaker: name } : s));
}
