/**
 * Meeting notes, per profile (chrome.storage.local): the live recording's accumulating
 * transcript, saved meetings and the list that shows them. Plain functions on plain data, so
 * what is kept, capped and refused is testable without a browser.
 *
 * Layout: `meetings:index` holds a small row per meeting (the list); each meeting is its own
 * key `meeting:<id>` (so opening one reads one value); `meetings:live` is a snapshot of the
 * recording in progress, so a crash loses seconds, not the meeting; `meetings:settings`.
 */
import type { EngineId, EngineInfo } from '../../shared/meetingProtocol';
import { AUTO_LANGUAGE, restoreLanguage } from '../../shared/meetingLanguages';
import { labelOthers, participantsFrom, cleanParticipantList, cleanParticipantName, type SpeakerObservation } from '../../shared/meetingNames';
import {
  MAX_MEETINGS,
  MAX_SEGMENTS,
  MAX_SEGMENT_CHARS,
  MAX_TITLE,
  cleanLine,
  fallbackMeetingTitle,
  restoreSegments,
  type MeetingMeta,
  type MeetingRecord,
  type MeetingSummary,
  type StoredSegment,
  SUMMARY_SECTIONS,
} from '../../shared/meetings';

export const INDEX_KEY = 'meetings:index';
export const LIVE_KEY = 'meetings:live';
export const SETTINGS_KEY = 'meetings:settings';
export const TEST_MODE_KEY = 'meetings:testMode';
export const TEST_FIXTURE_KEY = 'meetings:testFixture';
export const recordKey = (id: string) => `meeting:${id}`;

export interface MeetingSettings {
  /** `auto` uses OpenAI when it is ready, else the local engine when one is installed. */
  engine: EngineId | 'auto';
  /**
   * Which microphone: this Mac's built-in one, or whatever macOS has as the input. An iPhone
   * (Continuity) or AirPods can become the default and then drop out mid-call, so the built-in one is the default.
   */
  mic: 'builtin' | 'default' | 'device';
  /** For `device`: the microphone picked from the list (its id on this profile, and its name). */
  micDevice?: { id: string; label: string };
  /** The spoken language (ISO 639-1, shared/meetingLanguages.ts), or `auto` to let the engine guess per chunk. */
  language: string;
}
export const DEFAULT_SETTINGS: MeetingSettings = { engine: 'auto', mic: 'builtin', language: AUTO_LANGUAGE };

export function restoreSettings(raw: unknown): MeetingSettings {
  const r = raw as Partial<MeetingSettings> | undefined;
  const id = typeof r?.micDevice?.id === 'string' ? r.micDevice.id.slice(0, 200) : '';
  const label = typeof r?.micDevice?.label === 'string' ? r.micDevice.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
  const device = id && label ? { id, label } : undefined;
  const engine = r?.engine === 'openai' || r?.engine === 'local' ? r.engine : 'auto';
  const language = restoreLanguage(r?.language);
  if (r?.mic === 'device' && device) return { engine, mic: 'device', micDevice: device, language };
  return { engine, mic: r?.mic === 'default' ? 'default' : 'builtin', language };
}

/** The engine to record with, or why there is none. */
export function chooseEngine(setting: MeetingSettings['engine'], engines: EngineInfo[]): { engine: EngineInfo } | { error: string } {
  const ready = (id: EngineId) => engines.find((e) => e.id === id && e.ready);
  if (setting !== 'auto') {
    const picked = ready(setting);
    if (picked) return { engine: picked };
    const info = engines.find((e) => e.id === setting);
    return { error: info?.detail || 'That transcription engine isn’t available.' };
  }
  const found = ready('openai') ?? ready('local');
  if (found) return { engine: found };
  return { error: engines.find((e) => e.id === 'openai')?.detail || 'No transcription engine is available.' };
}

// ---- the recording in progress ----------------------------------------------------------------

export interface LiveMeeting {
  id: string;
  startedAt: number;
  host: string;
  provider: string;
  engine: EngineId;
  model: string;
  segments: StoredSegment[];
  /** What the meeting page's highlighted tile said over time (never saved with the meeting). */
  observations: SpeakerObservation[];
  names: string[];
  gaps: Array<{ start_ms: number; end_ms: number }>;
  othersCaptured: boolean;
  lastMs: number;
}

export function newLive(init: { id: string; startedAt: number; host: string; provider: string; engine: EngineId; model: string; othersCaptured: boolean }): LiveMeeting {
  return { ...init, segments: [], observations: [], names: [], gaps: [], lastMs: 0 };
}

/** Adds a transcribed chunk. Returns the new segment, or undefined if it was empty or over the cap. */
export function addSegment(live: LiveMeeting, channel: 'Me' | 'Others', startMs: number, endMs: number, text: string): StoredSegment | undefined {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT_CHARS);
  live.lastMs = Math.max(live.lastMs, endMs);
  if (!clean || live.segments.length >= MAX_SEGMENTS) return undefined;
  const segment: StoredSegment = { id: live.segments.length + 1, speaker: channel, channel, start_ms: Math.max(0, Math.round(startMs)), end_ms: Math.max(Math.round(endMs), Math.round(startMs) + 1), text: clean };
  live.segments.push(segment);
  return segment;
}

export function addGap(live: LiveMeeting, startMs: number, endMs: number) {
  live.lastMs = Math.max(live.lastMs, endMs);
  const last = live.gaps.at(-1);
  if (last && startMs <= last.end_ms + 1) last.end_ms = Math.max(last.end_ms, endMs);
  else if (live.gaps.length < 500) live.gaps.push({ start_ms: Math.round(startMs), end_ms: Math.round(endMs) });
}

/** Records a poll of the meeting page: who was highlighted, and the names visible. */
export function addObservation(live: LiveMeeting, t: number, speaker: string | null, names: unknown) {
  const name = cleanParticipantName(speaker);
  // Every poll is kept: a name only holds for a few seconds after it was seen (see speakerIntervals).
  if (live.observations.length < 40_000) live.observations.push({ t: Math.max(0, Math.round(t)), name });
  for (const n of cleanParticipantList(names)) {
    if (!live.names.some((x) => x.toLowerCase() === n.toLowerCase()) && live.names.length < 100) live.names.push(n);
  }
}

/** The finished record: "Others" lines named from the page's timeline where it was clear. */
export function toRecord(live: LiveMeeting, endedBy: NonNullable<MeetingMeta['endedBy']>, durationMs: number, title?: string): MeetingRecord {
  const endMs = Math.max(durationMs, live.lastMs);
  const segments = labelOthers(
    [...live.segments].sort((a, b) => a.start_ms - b.start_ms || a.id - b.id).map((s, i) => ({ ...s, id: i + 1 })),
    live.observations,
    endMs,
  );
  const participants = [...new Set([...participantsFrom(live.observations, endMs), ...live.names])].slice(0, 60);
  return {
    id: live.id,
    title: cleanLine(title, MAX_TITLE) || fallbackMeetingTitle(live.startedAt),
    startedAt: live.startedAt,
    durationMs: endMs,
    host: live.host,
    provider: live.provider,
    engine: `${live.engine}:${live.model}`,
    hasSummary: false,
    endedBy,
    segmentCount: segments.length,
    segments,
    participants: participants.length ? participants : undefined,
    gaps: live.gaps.length ? live.gaps : undefined,
    othersCaptured: live.othersCaptured,
  };
}

// ---- saved meetings ---------------------------------------------------------------------------------

export function metaOf(r: MeetingRecord): MeetingMeta {
  return {
    id: r.id,
    title: r.title,
    titleEdited: r.titleEdited || undefined,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    host: r.host,
    provider: r.provider,
    engine: r.engine,
    hasSummary: !!r.summary,
    endedBy: r.endedBy,
    segmentCount: r.segmentCount,
  };
}

const ENDED = new Set(['user', 'tab-closed', 'limit', 'lost', 'error', 'recovered']);

function restoreSummary(raw: unknown): MeetingSummary | undefined {
  const s = raw as Partial<MeetingSummary> | undefined;
  if (!s || typeof s !== 'object' || !s.items || typeof s.items !== 'object') return undefined;
  const items = {} as MeetingSummary['items'];
  for (const section of SUMMARY_SECTIONS) {
    const list = (s.items as Record<string, unknown>)[section];
    items[section] = (Array.isArray(list) ? list : []).slice(0, 100).flatMap((i: any) =>
      i && typeof i.text === 'string' && Number.isFinite(i.t) ? [{ t: Math.max(0, Number(i.t)), speaker: cleanLine(i.speaker, 80) || 'Others', text: i.text.slice(0, MAX_SEGMENT_CHARS) }] : [],
    );
  }
  return {
    items,
    model: cleanLine(s.model, 60) || 'unknown',
    method: s.method === 'extractive' ? 'extractive' : 'model',
    warning: typeof s.warning === 'string' ? cleanLine(s.warning, 300) : null,
    at: Number.isFinite(s.at) ? Number(s.at) : 0,
  };
}

/** A saved meeting, checked: anything odd is dropped, and a record with no id isn't one. */
export function restoreRecord(raw: unknown): MeetingRecord | undefined {
  const r = raw as Partial<MeetingRecord> | undefined;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 64) return undefined;
  const segments = restoreSegments(r.segments);
  const startedAt = Number.isFinite(r.startedAt) ? Number(r.startedAt) : 0;
  const summary = restoreSummary(r.summary);
  const record: MeetingRecord = {
    id: r.id,
    title: cleanLine(r.title, MAX_TITLE) || fallbackMeetingTitle(startedAt),
    titleEdited: r.titleEdited ? true : undefined,
    startedAt,
    durationMs: Number.isFinite(r.durationMs) ? Math.max(0, Number(r.durationMs)) : 0,
    host: cleanLine(r.host, 120),
    provider: cleanLine(r.provider, 40),
    engine: cleanLine(r.engine, 80),
    hasSummary: !!summary,
    endedBy: ENDED.has(String(r.endedBy)) ? (r.endedBy as MeetingMeta['endedBy']) : undefined,
    segmentCount: segments.length,
    segments,
    summary,
    summaryError: typeof r.summaryError === 'string' ? cleanLine(r.summaryError, 300) : undefined,
    participants: Array.isArray(r.participants) ? cleanParticipantList(r.participants) : undefined,
    gaps: Array.isArray(r.gaps)
      ? r.gaps.slice(0, 500).flatMap((g) => (Number.isFinite(g?.start_ms) && Number.isFinite(g?.end_ms) ? [{ start_ms: Number(g.start_ms), end_ms: Number(g.end_ms) }] : []))
      : undefined,
    othersCaptured: typeof r.othersCaptured === 'boolean' ? r.othersCaptured : undefined,
  };
  return record;
}

/** The saved list, newest first, with anything odd dropped and repeats removed. */
export function restoreIndex(raw: unknown): MeetingMeta[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MeetingMeta[] = [];
  for (const m of raw) {
    const r = restoreRecord({ ...m, segments: [] });
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ ...metaOf(r), hasSummary: !!m.hasSummary, segmentCount: Number.isFinite(m.segmentCount) ? Number(m.segmentCount) : 0 });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_MEETINGS);
}

export const upsertMeta = (index: MeetingMeta[], meta: MeetingMeta) => [meta, ...index.filter((m) => m.id !== meta.id)].sort((a, b) => b.startedAt - a.startedAt);
export const removeMeta = (index: MeetingMeta[], id: string) => index.filter((m) => m.id !== id);
export const atCapacity = (index: MeetingMeta[]) => index.length >= MAX_MEETINGS;

/** A user-typed title: one line, no markup characters; empty is refused. */
export function checkTitle(raw: unknown): { ok: true; title: string } | { ok: false; reason: string } {
  const title = cleanLine(raw, MAX_TITLE);
  if (!title) return { ok: false, reason: 'A title can’t be empty.' };
  return { ok: true, title };
}

/** The snapshot of a recording that was running when the background stopped, checked. */
export function restoreLive(raw: unknown): LiveMeeting | undefined {
  const l = raw as Partial<LiveMeeting> | undefined;
  if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !l.id || l.id.length > 64) return undefined;
  const live = newLive({
    id: l.id,
    startedAt: Number.isFinite(l.startedAt) ? Number(l.startedAt) : Date.now(),
    host: cleanLine(l.host, 120),
    provider: cleanLine(l.provider, 40),
    engine: l.engine === 'local' ? 'local' : 'openai',
    model: cleanLine(l.model, 60),
    othersCaptured: !!l.othersCaptured,
  });
  live.segments = restoreSegments(l.segments);
  live.observations = (Array.isArray(l.observations) ? l.observations : []).flatMap((o) =>
    Number.isFinite(o?.t) ? [{ t: Number(o.t), name: cleanParticipantName(o.name) }] : [],
  );
  live.names = cleanParticipantList(l.names);
  live.gaps = (Array.isArray(l.gaps) ? l.gaps : []).flatMap((g) => (Number.isFinite(g?.start_ms) && Number.isFinite(g?.end_ms) ? [{ start_ms: Number(g.start_ms), end_ms: Number(g.end_ms) }] : []));
  live.lastMs = Number.isFinite(l.lastMs) ? Number(l.lastMs) : 0;
  return live;
}
