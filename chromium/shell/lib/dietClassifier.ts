/**
 * The Algorithm Diet classifier (port of DietClassifier.swift). Deterministic and fast (rules only);
 * the on-device model is consulted separately for what the rules can't place, and its answers come
 * back in as `hints`.
 *
 * For one visit:
 *  1. Plumbing first: login, OAuth and redirect pages are kept but never counted.
 *  2. Site: exact host + first path segment, then the host, then each parent domain, then known suffixes (.edu, .vercel.app).
 *     A model hint for the host wins over "unknown".
 *  3. URL shape: YouTube /shorts and TikTok are short-form, /watch is a video, Google /search is a search (its query is
 *     the "title"), Reddit /r/<sub> takes the subreddit name as extra text.
 *  4. Title: phrase cues per category. On "container" sites (YouTube, Reddit, X, search engines, unknown sites) a clear
 *     title signal decides the category, so a YouTube lecture counts as learning and a Reddit war thread as news.
 *  5. Nutrients: the category's base profile, then title and behaviour adjustments: learning cues add protein and
 *     fiber, clickbait adds sugar, outrage adds salt, long focused sessions add fiber, long feed sessions and late-night
 *     junk add fat. The Nutri-Score grade follows from bad minus good points.
 */
import { CATEGORY, clampNutrients, isContainer, isLearning, normalizedHost, ZERO, type ContentKind, type DietCategory, type DietLabel, type DietVisit } from './dietModel';
import { CLICKBAIT_CUES, DOMAINS, HOST_PREFIXES, OUTRAGE_CUES, PLUMBING_HOST_PREFIXES, PLUMBING_PATH_FRAGMENTS, STOPWORDS, SUFFIXES, TITLE_CUES } from './dietRules';

export interface DietHints {
  /** host -> category from the on-device model (or the user). */
  hosts: Record<string, DietCategory>;
  /** "host|title" -> category from the on-device model, for videos and container pages. */
  titles: Record<string, DietCategory>;
}

export const hintKey = (host: string, title: string) => `${host}|${title.toLowerCase()}`;

const LETTER = /[\p{L}]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;

interface Parsed {
  url?: URL;
  host: string;
  path: string;
}

function parse(raw: string, fallbackHost: string): Parsed {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  const host = normalizedHost(url?.hostname || fallbackHost);
  let path = url?.pathname ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it encoded
  }
  // Swift's URL.path is "" for a bare origin; a lone "/" carries no segment either way.
  return { url, host, path: path.toLowerCase() };
}

export function classify(v: DietVisit, hints: DietHints = { hosts: {}, titles: {} }): DietLabel {
  const { url, host, path } = parse(v.url, v.host);
  const [text, kind, extra] = contentText(url, host, path, v.title);
  const lowered = `${text} ${extra} ${v.channel ?? ''} ${v.description ?? ''} ${(v.excerpt ?? '').slice(0, 1200)}`.toLowerCase();

  // 1. plumbing
  if (isPlumbing(host, path, v.title)) return { category: 'plumbing', kind: 'page', confidence: 0.95, method: 'path', nutrients: { ...ZERO }, topics: [] };

  // 2. site
  let category: DietCategory;
  let confidence: number;
  let method: DietLabel['method'];
  const site = siteCategory(host, path);
  if (site) [category, confidence, method] = [site, 0.9, 'domain'];
  else if (hints.hosts[host]) [category, confidence, method] = [hints.hosts[host], 0.75, 'model'];
  else [category, confidence, method] = ['other', 0.2, 'fallback'];

  // 3. URL shape
  if (kind === 'short') [category, confidence, method] = ['shortVideo', 0.95, 'path'];

  // 4. title
  const scores = cueScores(lowered);
  const hint = kind !== 'short' ? hints.titles[hintKey(host, v.title)] : undefined;
  if (hint) {
    [category, confidence, method] = [hint, 0.8, 'model'];
  } else if (kind !== 'short' && (isContainer(category) || category === 'ai')) {
    const best = bestCue(scores);
    if (best && best[1] >= (category === 'other' || kind === 'video' || kind === 'search' ? 1 : 2)) {
      // An AI chat about code is still an AI chat; only switch it for strong signals.
      if (category !== 'ai' || best[1] >= 3) {
        category = best[0];
        confidence = Math.min(0.85, 0.45 + 0.12 * best[1]);
        method = 'title';
      }
    }
  }
  if (category === 'other' && kind === 'search') [category, confidence, method] = ['reference', 0.6, 'path'];

  // 5. nutrients
  const n = { ...CATEGORY[category].nutrients };
  if (category === 'other') confidence = Math.min(confidence, 0.3);
  const learn = (scores.get('learning') ?? 0) + (scores.get('research') ?? 0);
  if (learn > 0) {
    n.protein += Math.min(3, learn);
    n.fiber += Math.min(2, learn);
  }
  const bait = count(CLICKBAIT_CUES, lowered) + (shouting(text) ? 1 : 0);
  if (bait > 0) {
    n.sugar += Math.min(6, bait * 2);
    n.fat += Math.min(2, bait);
    if (bait >= 2) {
      n.protein -= 1;
      n.fiber -= 1;
      n.vitamins -= 1;
    }
  }
  const outrage = count(OUTRAGE_CUES, lowered);
  if (outrage > 0) n.salt += Math.min(4, outrage * 2);
  const minutes = v.seconds / 60;
  if (minutes >= 10 && ['learning', 'research', 'building', 'culture', 'work'].includes(category)) n.fiber += 2;
  if (minutes >= 15 && ['social', 'shortVideo', 'video', 'streaming', 'games', 'shopping'].includes(category)) n.fat += 2;
  if (new Date(v.at).getHours() < 5 && n.sugar >= 5) n.fat += 1;
  if (kind === 'video' && (v.watchSeconds ?? 0) > 0 && isLearning(category)) n.fiber += 1;

  return { category, kind, confidence, method, nutrients: clampNutrients(n), topics: topics(text, host) };
}

// ---- pieces (exported so tests can poke at them) ----

export function isPlumbing(host: string, path: string, title: string) {
  if (lookup(host, path) === 'plumbing') return true;
  if (PLUMBING_HOST_PREFIXES.some((p) => host.startsWith(p))) return true;
  if (PLUMBING_PATH_FRAGMENTS.some((p) => path.includes(p))) return true;
  const t = title.toLowerCase();
  return ['sign in', 'log in', 'login', 'anmelden', 'redirecting', 'verify your', 'two-factor', 'consent'].some(
    (c) => t === c || t.startsWith(`${c} `) || t.startsWith(`${c} -`) || t.startsWith(`${c} –`),
  );
}

export function siteCategory(host: string, path: string): DietCategory | undefined {
  const found = lookup(host, path);
  if (found) return found;
  const prefix = HOST_PREFIXES.find(([p]) => host.startsWith(p));
  if (prefix) return prefix[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'building';
  return SUFFIXES.find(([s]) => host.endsWith(s))?.[1];
}

/** Exact host + first path segment, exact host, then parent domains (docs.google.com -> google.com). */
export function lookup(host: string, path: string): DietCategory | undefined {
  const first = path.split('/').find(Boolean);
  let h = host;
  for (;;) {
    if (first !== undefined) {
      const c = DOMAINS[`${h}/${first}`];
      if (c) return c;
    }
    if (Object.hasOwn(DOMAINS, h)) return DOMAINS[h];
    const dot = h.indexOf('.');
    if (dot < 0 || !h.slice(dot + 1).includes('.')) return undefined;
    h = h.slice(dot + 1);
  }
}

/** The text worth classifying, the kind of content, and extra text the URL gives away (search query, subreddit). */
export function contentText(url: URL | undefined, host: string, path: string, title: string): [string, ContentKind, string] {
  const q = (name: string) => url?.searchParams.get(name) ?? undefined;
  const clean = stripSiteSuffix(title, host);

  if (host.endsWith('youtube.com') || host === 'youtu.be') {
    if (path.startsWith('/shorts')) return [clean, 'short', ''];
    if (path.startsWith('/watch') || host === 'youtu.be') return [clean, 'video', ''];
    const s = q('search_query');
    if (path.startsWith('/results') && s !== undefined) return [s, 'search', ''];
    return [clean, 'feed', ''];
  }
  if (host.endsWith('tiktok.com') || (host.endsWith('instagram.com') && path.startsWith('/reel'))) return [clean, 'short', ''];
  const searchHosts = ['google.', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'ecosia.org', 'startpage.com', 'kagi.com', 'yahoo.com'];
  if (searchHosts.some((s) => host.startsWith(s) || host.includes(`.${s}`) || host === s)) {
    const s = q('q') ?? q('p');
    if (s && !path.startsWith('/maps')) return [s, 'search', ''];
  }
  if (host.endsWith('reddit.com')) {
    const parts = path.split('/').filter(Boolean);
    const sub = parts.length >= 2 && parts[0] === 'r' ? parts[1] : '';
    return [clean, parts.length > 3 ? 'page' : 'feed', sub];
  }
  if (['x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'linkedin.com', 'threads.net', 'bsky.app'].includes(host)) {
    return [clean, path.includes('/status/') || path.includes('/posts/') || path.includes('/p/') ? 'page' : 'feed', ''];
  }
  if (host === 'github.com' || host === 'gitlab.com') {
    // "owner/repo: description": the owner is not a topic
    return [clean.replace(/[\p{L}\p{N}_.-]+\/(?=[\p{L}\p{N}_.-])/gu, ''), 'page', ''];
  }
  if (host.endsWith('vimeo.com') || host.endsWith('twitch.tv') || host.endsWith('netflix.com')) return [clean, 'video', ''];
  return [clean, 'page', ''];
}

/** "How X works - YouTube" -> "How X works"; "(3) Feed | LinkedIn" -> "Feed". */
export function stripSiteSuffix(title: string, host: string) {
  let t = title.trim().replace(/^\(\d+\+?\)\s*/, ''); // "(3) " unread counts
  const labels = host.split('.');
  const site = labels.length >= 2 ? labels[labels.length - 2].toLowerCase() : host;
  for (const sep of [' - ', ' | ', ' – ', ' — ', ' · ', ' :: ']) {
    const at = t.lastIndexOf(sep);
    if (at < 0) continue;
    const tail = t.slice(at + sep.length).toLowerCase().replaceAll(' ', '');
    if (tail.includes(site) || site.includes(tail) || [...tail].length <= 14) {
      t = t.slice(0, at);
      break;
    }
  }
  return t;
}

export function cueScores(lowered: string) {
  const out = new Map<DietCategory, number>();
  for (const [c, cues] of TITLE_CUES) {
    let s = 0;
    for (const cue of cues) if (matches(cue, lowered)) s += cue.includes(' ') ? 1.5 : 1;
    if (s > 0) out.set(c, s + (c === 'learning' ? 0.25 : 0)); // ties go to learning ("swiftui tutorial")
  }
  return out;
}

function bestCue(scores: Map<DietCategory, number>): [DietCategory, number] | undefined {
  let best: [DietCategory, number] | undefined;
  for (const [c, s] of scores) if (!best || s > best[1]) best = [c, s];
  return best;
}

/** Up to 4 topic words or two-word phrases from the cleaned title (search queries count too). */
export function topics(text: string, host: string) {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\- ]/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''));
  const picked: string[] = [];
  let prev: string | undefined;
  for (const w of words) {
    const length = [...w].length;
    const hyphens = [...w].filter((c) => c === '-').length;
    const digits = [...w].filter((c) => DIGIT.test(c)).length;
    const ok = length >= 3 && length <= 18 && !STOPWORDS.has(w) && LETTER.test(w) && hyphens <= 1 && digits * 3 <= length && !host.includes(w);
    if (ok) {
      if (prev !== undefined && picked.length < 4 && !prev.includes('-') && !w.includes('-') && !picked.includes(`${prev} ${w}`)) {
        const i = picked.indexOf(prev);
        if (i >= 0) picked[i] = `${prev} ${w}`;
        else picked.push(`${prev} ${w}`);
        prev = undefined;
        continue;
      }
      if (picked.length < 4 && !picked.includes(w)) picked.push(w);
      prev = w;
    } else {
      prev = undefined;
    }
  }
  return picked;
}

/** Whole-word match for single short words, substring match for phrases and symbols. */
export function matches(cue: string, text: string) {
  let at = text.indexOf(cue);
  if (at < 0) return false;
  if (cue.includes(' ') || !LETTER.test(cue) || [...cue].length > 6) return true;
  const boundary = (c: string | undefined) => c === undefined || !ALNUM.test(c);
  while (at >= 0) {
    if (boundary(text[at - 1]) && boundary(text[at + cue.length])) return true;
    at = text.indexOf(cue, at + cue.length);
  }
  return false;
}

export const count = (cues: readonly string[], text: string) => cues.reduce((n, c) => n + (matches(c, text) ? 1 : 0), 0);

/** MORE THAN HALF THE WORDS IN CAPITALS. */
export function shouting(text: string) {
  const words = text.split(' ').filter((w) => [...w].length >= 3 && LETTER.test(w));
  if (words.length < 3) return false;
  const caps = words.filter((w) => w === w.toUpperCase() && w !== w.toLowerCase()).length;
  return caps / words.length > 0.5;
}
