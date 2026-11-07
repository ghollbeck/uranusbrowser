/**
 * Algorithm Diet: what you read and watch, sorted into categories and scored like food (Nutri-Score A-E).
 * The desktop port of the iOS app's mobile/app/Sources/Diet/DietModels.swift. Pure values, no I/O,
 * so tests/diet.test.ts checks them in Node.
 */

/**
 * "Nutrients" of a piece of content, each 0...10.
 * Good: protein (you learn something), fiber (depth, focus), vitamins (creativity, culture, people).
 * Bad: sugar (quick-hit entertainment), salt (outrage, anxiety), fat (endless feeds, compulsive use).
 */
export interface Nutrients {
  protein: number;
  fiber: number;
  vitamins: number;
  sugar: number;
  salt: number;
  fat: number;
}

const KEYS = ['protein', 'fiber', 'vitamins', 'sugar', 'salt', 'fat'] as const;

export const ZERO: Nutrients = { protein: 0, fiber: 0, vitamins: 0, sugar: 0, salt: 0, fat: 0 };

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export const nutrients = (protein: number, fiber: number, vitamins: number, sugar: number, salt: number, fat: number): Nutrients => ({
  protein,
  fiber,
  vitamins,
  sugar,
  salt,
  fat,
});

export function add(a: Nutrients, b: Nutrients): Nutrients {
  const out = { ...ZERO };
  for (const k of KEYS) out[k] = a[k] + b[k];
  return out;
}

export function scale(a: Nutrients, k: number): Nutrients {
  const out = { ...ZERO };
  for (const key of KEYS) out[key] = a[key] * k;
  return out;
}

export function clampNutrients(a: Nutrients): Nutrients {
  const out = { ...ZERO };
  for (const k of KEYS) out[k] = clamp(a[k], 0, 10);
  return out;
}

/** Nutri-Score style: bad points minus good points, -30 (healthiest) ... +30. */
export const points = (n: Nutrients) => n.sugar + n.salt + n.fat - (n.protein + n.fiber + n.vitamins);
/** 0 (junk) ... 100 (superfood), for the big score number. */
export const health = (n: Nutrients) => clamp(((30 - points(n)) / 60) * 100, 0, 100);

export type NutriGrade = 'A' | 'B' | 'C' | 'D' | 'E';
export const GRADES: readonly NutriGrade[] = ['A', 'B', 'C', 'D', 'E'];

export function gradeFor(p: number): NutriGrade {
  if (p <= -12) return 'A';
  if (p <= -4) return 'B';
  if (p <= 4) return 'C';
  if (p <= 12) return 'D';
  return 'E';
}
export const grade = (n: Nutrients) => gradeFor(points(n));

export const VERDICT: Record<NutriGrade, string> = { A: 'Superfood', B: 'Wholesome', C: 'Balanced', D: 'Snacky', E: 'Junk food' };
export const GRADE_COLOR: Record<NutriGrade, string> = { A: '#038141', B: '#85BB2F', C: '#FECB02', D: '#EE8100', E: '#E63E11' };
/** Text on top of the grade colour. */
export const GRADE_INK: Record<NutriGrade, string> = { A: '#fff', B: 'rgb(0 0 0 / 78%)', C: 'rgb(0 0 0 / 78%)', D: '#fff', E: '#fff' };

/** Fixed category list. The ids are what the on-device model is asked to answer with. */
export const CATEGORIES = [
  'learning',
  'research',
  'building',
  'work',
  'ai',
  'communication',
  'reference',
  'news',
  'culture',
  'music',
  'video',
  'streaming',
  'social',
  'shortVideo',
  'shopping',
  'games',
  'finance',
  'lifestyle',
  'adult',
  'plumbing',
  'other',
] as const;
export type DietCategory = (typeof CATEGORIES)[number];

interface CategoryInfo {
  title: string;
  /** One line for the on-device model's category list. */
  hint: string;
  /** Lucide icon name (ui/diet.ts draws it). */
  icon: string;
  color: string;
  /** Base nutrients before title and time adjustments. */
  nutrients: Nutrients;
}

export const CATEGORY: Record<DietCategory, CategoryInfo> = {
  learning: { title: 'Learning', hint: 'courses, tutorials, documentation, wikis, explainers', icon: 'graduation', color: '#2FA36B', nutrients: nutrients(8, 7, 3, 1, 0, 0) },
  research: { title: 'Research & papers', hint: 'scientific papers, journals, academic sites, conferences', icon: 'fileSearch', color: '#1E7F5C', nutrients: nutrients(9, 9, 2, 0, 0, 0) },
  building: { title: 'Building & code', hint: 'code, GitHub, developer tools, hosting and cloud dashboards, localhost', icon: 'hammer', color: '#5B5BF0', nutrients: nutrients(6, 7, 3, 0, 0, 0) },
  work: { title: 'Work & productivity', hint: 'office documents, mail, calendars, project and admin tools', icon: 'briefcase', color: '#3B82F6', nutrients: nutrients(3, 5, 1, 0, 1, 0) },
  ai: { title: 'AI assistants', hint: 'AI chat assistants', icon: 'sparkle', color: '#B45CF2', nutrients: nutrients(6, 4, 2, 1, 0, 0) },
  communication: { title: 'Messages & calls', hint: 'messengers, video calls, chat apps', icon: 'messages', color: '#14B8A6', nutrients: nutrients(1, 2, 5, 1, 1, 1) },
  reference: { title: 'Search & reference', hint: 'search engines, maps, dictionaries, translators', icon: 'search', color: '#64748B', nutrients: nutrients(3, 1, 1, 1, 0, 1) },
  news: { title: 'News', hint: 'news sites and current events', icon: 'newspaper', color: '#F59E0B', nutrients: nutrients(4, 3, 1, 2, 5, 2) },
  culture: { title: 'Long reads & culture', hint: 'blogs, essays, books, podcasts, art, long-form writing', icon: 'book', color: '#84CC16', nutrients: nutrients(5, 6, 6, 2, 0, 0) },
  music: { title: 'Music & audio', hint: 'music and audio streaming', icon: 'music', color: '#EC4899', nutrients: nutrients(0, 1, 5, 3, 0, 1) },
  video: { title: 'Video', hint: 'video sites, entertainment videos', icon: 'play', color: '#F97316', nutrients: nutrients(2, 2, 3, 6, 1, 4) },
  streaming: { title: 'Streaming & TV', hint: 'TV shows and films', icon: 'tv', color: '#EF4444', nutrients: nutrients(0, 2, 4, 7, 0, 4) },
  social: { title: 'Social feeds', hint: 'social networks, forums, feeds', icon: 'users', color: '#E11D48', nutrients: nutrients(1, 0, 3, 5, 4, 6) },
  shortVideo: { title: 'Short-form video', hint: 'TikTok, Reels, YouTube Shorts', icon: 'zap', color: '#DC2626', nutrients: nutrients(0, 0, 1, 9, 3, 9) },
  shopping: { title: 'Shopping', hint: 'online shops, deals, marketplaces', icon: 'bag', color: '#D97706', nutrients: nutrients(0, 1, 1, 5, 1, 4) },
  games: { title: 'Games', hint: 'games and gaming', icon: 'gamepad', color: '#8B5CF6', nutrients: nutrients(1, 2, 3, 7, 0, 5) },
  finance: { title: 'Money', hint: 'banking, investing, crypto, payments', icon: 'trending', color: '#0EA5E9', nutrients: nutrients(3, 3, 0, 2, 3, 2) },
  lifestyle: { title: 'Life, travel & health', hint: 'travel, food, health, housing, jobs, sport', icon: 'leaf', color: '#22C55E', nutrients: nutrients(2, 2, 3, 2, 1, 1) },
  adult: { title: 'Adult & gambling', hint: 'adult content, gambling, betting', icon: 'octagon', color: '#7F1D1D', nutrients: nutrients(0, 0, 0, 10, 4, 10) },
  plumbing: { title: 'Logins & redirects', hint: 'login pages, redirects, account and consent pages', icon: 'key', color: '#9CA3AF', nutrients: ZERO },
  other: { title: 'Uncategorised', hint: 'none of the above', icon: 'help', color: '#A1A1AA', nutrients: nutrients(2, 2, 2, 3, 2, 2) },
};

/** Logins and redirects are not content: they are kept but never counted in the diet. */
export const counts = (c: DietCategory) => c !== 'plumbing';
/** Categories whose sites carry every kind of content, so the title decides (a YouTube lecture is learning). */
export const isContainer = (c: DietCategory) => c === 'video' || c === 'social' || c === 'reference' || c === 'other' || c === 'culture';
/** Categories that count as "learning" for chat questions like "what did I learn". */
export const isLearning = (c: DietCategory) => c === 'learning' || c === 'research' || c === 'building' || c === 'culture' || c === 'ai';

export type ContentKind = 'page' | 'video' | 'short' | 'search' | 'feed';

/** One visit to one page, live or imported. `at` is milliseconds since 1970. */
export interface DietVisit {
  id: number;
  url: string;
  host: string;
  title: string;
  at: number;
  /** Time on the page (estimated for imports), and how much of it a video was playing. */
  seconds: number;
  watchSeconds?: number;
  description?: string;
  channel?: string;
  /** A bounded excerpt of an article or visible video transcript, extracted only from the active page. */
  excerpt?: string;
  /** "live" for measured visits, "import" or "import:<profile>" for history imports. */
  source: string;
}

export const isMeasured = (v: DietVisit) => v.source === 'live';

export type LabelMethod = 'domain' | 'path' | 'title' | 'model' | 'fallback';

/** The classifier's verdict for one visit. */
export interface DietLabel {
  category: DietCategory;
  kind: ContentKind;
  confidence: number;
  method: LabelMethod;
  nutrients: Nutrients;
  topics: string[];
}

/** "youtube.com" from "m.youtube.com" or "www.youtube.com". */
export function normalizedHost(raw: string) {
  let h = raw.toLowerCase();
  for (const p of ['www.', 'm.', 'mobile.', 'amp.']) if (h.startsWith(p)) h = h.slice(p.length);
  return h;
}

/** "2h 05m", "14m", "40s". */
export function duration(seconds: number) {
  const s = Math.round(seconds);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}
