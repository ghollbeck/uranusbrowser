/**
 * Reading exported history (mobile/app/Tools/export-history.py) and summing a period up. Port of
 * DietStats.swift; pure, no UI and no database.
 */
import { add, CATEGORY, counts, grade, GRADES, health, isLearning, isMeasured, normalizedHost, points, scale, ZERO, type DietCategory, type DietLabel, type DietVisit, type NutriGrade, type Nutrients } from './dietModel';

export interface ExportRow {
  url: string;
  title?: string | null;
  visitedAt: number;
  seconds?: number | null;
  profile?: string | null;
}

export class DietImportError extends Error {
  override readonly name = 'DietImportError';
}

/**
 * Chromium's visit_duration is 0 for many visits and hours for tabs left open, so: a known duration is capped at
 * 30 min; an unknown one is the gap to the next visit (5 s ... 5 min), or 30 s for the last one.
 */
export function importVisits(file: unknown, source = 'import'): Omit<DietVisit, 'id'>[] {
  const f = file as { version?: number; visits?: ExportRow[] };
  if (!f || typeof f !== 'object' || !Array.isArray(f.visits)) throw new DietImportError('That file isn’t a history export.');
  if (f.version !== undefined && f.version !== 1) throw new DietImportError('Unsupported history export version.');
  const rows = f.visits
    .filter((r) => {
      if (!r || typeof r.url !== 'string' || typeof r.visitedAt !== 'number' || !Number.isFinite(r.visitedAt)) return false;
      try {
        const u = new URL(r.url);
        return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.visitedAt - b.visitedAt);
  // Profiles are independent timelines; a visit in one must not shorten another profile's estimate.
  const nextByProfile = new Map<string, number>();
  const estimates = rows.map(() => 30);
  for (let i = rows.length - 1; i >= 0; i--) {
    const profile = rows[i].profile ?? '';
    const next = nextByProfile.get(profile);
    if (next !== undefined) estimates[i] = Math.min(300, Math.max(5, next - rows[i].visitedAt));
    nextByProfile.set(profile, rows[i].visitedAt);
  }
  return rows.map((r, i) => {
    const known = typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? r.seconds : 0;
    return {
      url: r.url,
      host: normalizedHost(new URL(r.url).hostname),
      title: r.title ?? '',
      at: r.visitedAt * 1000,
      seconds: known > 0 ? Math.min(known, 1800) : estimates[i],
      source: r.profile ? `${source}:${r.profile}` : source,
    };
  });
}

export interface Slice {
  category: DietCategory;
  seconds: number;
  share: number;
  nutrients: Nutrients;
}
export interface Site {
  host: string;
  seconds: number;
  visits: number;
  nutrients: Nutrients;
  category: DietCategory;
}
export interface Day {
  /** Local midnight, ms. */
  day: number;
  seconds: number;
  nutrients: Nutrients;
}
export interface Swap {
  cut: DietCategory;
  cutSeconds: number;
  from: NutriGrade;
  to: NutriGrade;
  newHealth: number;
}

export interface DietStats {
  start: number;
  end: number;
  seconds: number;
  measuredSeconds: number;
  estimatedSeconds: number;
  watchSeconds: number;
  visits: number;
  /** Time-weighted average nutrients of everything counted. */
  nutrients: Nutrients;
  grade: NutriGrade;
  health: number;
  slices: Slice[];
  sites: Site[];
  days: Day[];
  topics: Array<[string, number]>;
  gradeSeconds: Record<NutriGrade, number>;
  /** Visits per grade (for the classification counters). */
  gradeCounts: Record<NutriGrade, number>;
  swaps: Swap[];
}

export type Labeled = [DietVisit, DietLabel];

const perGrade = () => Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<NutriGrade, number>;

export const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Sums `items` inside [start, end). Logins and redirects are skipped. */
export function computeStats(items: readonly Labeled[], start: number, end: number): DietStats {
  const s: DietStats = {
    start,
    end,
    seconds: 0,
    measuredSeconds: 0,
    estimatedSeconds: 0,
    watchSeconds: 0,
    visits: 0,
    nutrients: { ...ZERO },
    grade: 'C',
    health: 50,
    slices: [],
    sites: [],
    days: [],
    topics: [],
    gradeSeconds: perGrade(),
    gradeCounts: perGrade(),
    swaps: [],
  };
  const bySlice = new Map<DietCategory, { seconds: number; n: Nutrients }>();
  const bySite = new Map<string, { seconds: number; visits: number; n: Nutrients; cats: Map<DietCategory, number> }>();
  const byDay = new Map<number, { seconds: number; n: Nutrients }>();
  const byTopic = new Map<string, number>();
  const topicDays = new Set<string>();
  let total = { ...ZERO };

  for (const [v, l] of items) {
    if (!(v.at >= start && v.at < end && counts(l.category))) continue;
    const g = grade(l.nutrients);
    s.visits += 1;
    s.gradeCounts[g] += 1;
    const w = Number.isFinite(v.seconds) ? Math.max(v.seconds, 0) : 0;
    if (w <= 0) continue;
    s.seconds += w;
    if (isMeasured(v)) s.measuredSeconds += w;
    else s.estimatedSeconds += w;
    if (isMeasured(v) && Number.isFinite(v.watchSeconds ?? 0)) s.watchSeconds += Math.max(0, v.watchSeconds ?? 0);
    const weighted = scale(l.nutrients, w);
    total = add(total, weighted);
    const sl = bySlice.get(l.category) ?? { seconds: 0, n: { ...ZERO } };
    bySlice.set(l.category, { seconds: sl.seconds + w, n: add(sl.n, weighted) });
    const site = bySite.get(v.host) ?? { seconds: 0, visits: 0, n: { ...ZERO }, cats: new Map() };
    site.seconds += w;
    site.visits += 1;
    site.n = add(site.n, weighted);
    site.cats.set(l.category, (site.cats.get(l.category) ?? 0) + w);
    bySite.set(v.host, site);
    const d = startOfDay(v.at);
    const dd = byDay.get(d) ?? { seconds: 0, n: { ...ZERO } };
    byDay.set(d, { seconds: dd.seconds + w, n: add(dd.n, weighted) });
    s.gradeSeconds[g] += w;
    if (isLearning(l.category) || l.kind === 'search' || l.kind === 'video') {
      for (const t of l.topics) {
        const key = `${t}|${d}`;
        if (topicDays.has(key)) continue; // days a topic came up, so one tab left open all day counts once
        topicDays.add(key);
        byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
      }
    }
  }
  if (s.seconds <= 0) return s;
  s.nutrients = scale(total, 1 / s.seconds);
  s.grade = grade(s.nutrients);
  s.health = health(s.nutrients);
  s.slices = [...bySlice]
    .map(([category, v]) => ({ category, seconds: v.seconds, share: v.seconds / s.seconds, nutrients: scale(v.n, 1 / v.seconds) }))
    .sort((a, b) => b.seconds - a.seconds);
  s.sites = [...bySite]
    .map(([host, v]) => ({
      host,
      seconds: v.seconds,
      visits: v.visits,
      nutrients: scale(v.n, 1 / v.seconds),
      category: [...v.cats].reduce((a, b) => (b[1] > a[1] ? b : a))[0],
    }))
    .sort((a, b) => b.seconds - a.seconds);
  s.days = [...byDay].map(([day, v]) => ({ day, seconds: v.seconds, nutrients: scale(v.n, 1 / v.seconds) })).sort((a, b) => a.day - b.day);
  s.topics = [...byTopic].sort((a, b) => b[1] - a[1]).slice(0, 24);
  s.swaps = swaps(s, bySlice);
  return s;
}

/** "Halve your time on X and swap it for learning": the three junkiest slices and the grade you'd get. */
function swaps(s: DietStats, bySlice: Map<DietCategory, { seconds: number; n: Nutrients }>): Swap[] {
  const total = [...bySlice.values()].reduce((a, b) => add(a, b.n), { ...ZERO });
  const learning = CATEGORY.learning.nutrients;
  return s.slices
    .filter((sl) => points(sl.nutrients) > 0 && sl.share >= 0.03)
    .sort((a, b) => points(b.nutrients) * b.seconds - points(a.nutrients) * a.seconds)
    .slice(0, 3)
    .map((sl) => {
      const cut = sl.seconds / 2;
      const swapped = add(add(total, scale(sl.nutrients, -cut)), scale(learning, cut));
      const n = scale(swapped, 1 / s.seconds);
      return { cut: sl.category, cutSeconds: cut, from: s.grade, to: grade(n), newHealth: health(n) };
    });
}

export type DietRange = 'today' | 'week' | 'month' | 'all';
export const RANGES: Array<{ id: DietRange; title: string }> = [
  { id: 'today', title: 'Today' },
  { id: 'week', title: '7 days' },
  { id: 'month', title: '30 days' },
  { id: 'all', title: 'All' },
];

export function rangeInterval(range: DietRange, now = Date.now()): [number, number] {
  const today = startOfDay(now);
  const back = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d.getTime();
  };
  const end = now + 1000;
  switch (range) {
    case 'today':
      return [today, end];
    case 'week':
      return [back(6), end];
    case 'month':
      return [back(29), end];
    default:
      return [-8.64e15, end];
  }
}
