// The Algorithm Diet's desktop port (shell/lib/diet*.ts) against the iOS app's golden cases
// (mobile/app/Tools/diet-check.swift), plus history import, period stats and the chat's retrieval.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORIES, CATEGORY, counts, grade, gradeFor, type DietCategory, type DietVisit, type NutriGrade } from '../shell/lib/dietModel';
import { classify, stripSiteSuffix, topics, matches } from '../shell/lib/dietClassifier';
import { computeStats, importVisits, rangeInterval, type Labeled } from '../shell/lib/dietStats';
import { categoryNamed, fallbackAnswer, notes, parseAnswer, plan, relevantPages } from '../shell/lib/dietChat';

const at = (hour = 14) => new Date(2026, 9, 20, hour).getTime();
const visit = (url: string, title: string, seconds = 60, hour = 14, extra: Partial<DietVisit> = {}): DietVisit => ({
  id: 0,
  url,
  host: new URL(url).hostname,
  title,
  at: at(hour),
  seconds,
  source: 'test',
  ...extra,
});

const GOLDEN: Array<[string, string, DietCategory, NutriGrade?, number?]> = [
  ['https://accounts.google.com/v3/signin/identifier', 'Sign in - Google Accounts', 'plumbing'],
  ['https://github.com/login/oauth/authorize?client_id=x', 'Authorize', 'plumbing'],
  ['https://www.youtube.com/watch?v=aircAruvnKk', 'But what is a neural network? | Deep learning chapter 1 - YouTube', 'learning', 'A'],
  ['https://www.youtube.com/watch?v=1', 'MIT 6.006 Lecture 1: Algorithms and Computation - YouTube', 'learning', 'A'],
  ['https://www.youtube.com/watch?v=2', 'I Survived 100 Days in Minecraft Hardcore - YouTube', 'games'],
  ['https://www.youtube.com/watch?v=3', 'SHOCKING PRANK GONE WRONG!!! - YouTube', 'video', 'E'],
  ['https://www.youtube.com/shorts/abc', 'funny cat #shorts - YouTube', 'shortVideo', 'E'],
  ['https://www.youtube.com/watch?v=4', 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams - YouTube', 'music'],
  ['https://www.youtube.com/watch?v=5', 'Some random title without cues - YouTube', 'video', 'C'],
  ['https://www.tiktok.com/@x/video/1', 'TikTok', 'shortVideo', 'E'],
  ['https://www.instagram.com/reel/abc/', 'Instagram', 'shortVideo'],
  ['https://www.instagram.com/', 'Instagram', 'social', 'D'],
  ['https://x.com/home', 'Home / X', 'social'],
  ['https://www.reddit.com/r/MachineLearning/comments/1/some_title/', '[D] Fine-tuning tips for small LLMs : r/MachineLearning', 'learning'],
  ['https://arxiv.org/abs/1706.03762', '[1706.03762] Attention Is All You Need', 'research', 'A'],
  ['https://openreview.net/forum?id=1', 'Some paper | OpenReview', 'research'],
  ['https://github.com/ggml-org/llama.cpp', 'GitHub - ggml-org/llama.cpp: LLM inference in C/C++', 'building', 'A'],
  ['http://localhost:5173/', 'Vite App', 'building'],
  ['http://127.0.0.1:8000/docs', 'FastAPI - Swagger UI', 'building'],
  ['https://abc.supabase.co/rest/v1', '', 'building'],
  ['https://docs.google.com/document/d/1/edit', 'Plan - Google Docs', 'work', 'B'],
  ['https://chatgpt.com/c/1', 'Swift concurrency help', 'ai', 'B'],
  ['https://www.google.com/search?q=swiftui+tutorial+navigationstack', 'swiftui tutorial navigationstack - Google Search', 'learning'],
  ['https://www.google.com/search?q=weather+zurich', 'weather zurich - Google Search', 'reference'],
  ['https://www.nytimes.com/2026/10/20/world/war.html', 'War Crisis Deepens as Leaders Slam Attack', 'news', 'D'],
  ['https://www.netflix.com/watch/1', 'Netflix', 'streaming', 'D'],
  ['https://www.amazon.de/dp/1', 'Amazon.de: USB-C cable', 'shopping'],
  ['https://open.spotify.com/playlist/1', 'Spotify – Focus', 'music'],
  ['https://en.wikipedia.org/wiki/Nutri-Score', 'Nutri-Score - Wikipedia', 'learning', 'A'],
  ['https://www.pornhub.com/', 'x', 'adult', 'E'],
  ['https://t.co/abc', '', 'plumbing'],
  ['https://paulgraham.com/greatwork.html', 'How to Do Great Work', 'culture', 'A'],
  ['https://somerandomblog.example/post', 'Introduction to linear algebra for beginners', 'learning'],
  ['https://www.linkedin.com/feed/', '(5) Feed | LinkedIn', 'social', undefined, 1200],
  ['https://www.ethz.ch/en.html', 'Homepage | ETH Zurich', 'learning'],
];

test('every golden case of the iOS classifier comes out the same', () => {
  const failures: string[] = [];
  for (const [url, title, category, g, seconds] of GOLDEN) {
    const l = classify(visit(url, title, seconds ?? 60));
    if (l.category !== category || (g && grade(l.nutrients) !== g))
      failures.push(`${url} "${title}" -> ${l.category} ${grade(l.nutrients)} (${l.method}); want ${category} ${g ?? ''}`);
  }
  assert.deepEqual(failures, []);
});

test('the pieces: site suffixes, topics, grades, base profiles, word matching', () => {
  assert.equal(stripSiteSuffix('How X works - YouTube', 'youtube.com'), 'How X works');
  assert.equal(stripSiteSuffix('(3) Feed | LinkedIn', 'linkedin.com'), 'Feed');
  assert.ok(topics('Attention Is All You Need', 'arxiv.org').includes('attention'));
  assert.equal(gradeFor(-20), 'A');
  assert.equal(gradeFor(0), 'C');
  assert.equal(gradeFor(20), 'E');
  assert.equal(grade(CATEGORY.learning.nutrients), 'A');
  assert.equal(grade(CATEGORY.shortVideo.nutrients), 'E');
  assert.ok(matches('war', 'the war goes on'));
  assert.ok(!matches('war', 'software'), 'short words need word boundaries');
  assert.ok(matches('how to', 'how to cook'));
});

test('model hints decide unknown sites and container titles', () => {
  const unknown = visit('https://weird-tool.example/', 'Weird Tool');
  assert.equal(classify(unknown).category, 'other');
  assert.equal(classify(unknown, { hosts: { 'weird-tool.example': 'building' }, titles: {} }).category, 'building');
  const v = visit('https://www.youtube.com/watch?v=9', 'A neutral title - YouTube');
  assert.equal(classify(v, { hosts: {}, titles: { 'youtube.com|a neutral title - youtube': 'culture' } }).category, 'culture');
});

test('history import: capped known durations, gap estimates per profile, junk rows dropped', () => {
  const t = 1_790_000_000;
  const rows = importVisits({
    version: 1,
    visits: [
      { url: 'https://a.example/', title: 'A', visitedAt: t, seconds: 0, profile: 'p1' },
      { url: 'https://b.example/', title: 'B', visitedAt: t + 2, seconds: 0, profile: 'p2' },
      { url: 'https://c.example/', title: 'C', visitedAt: t + 100, seconds: 7200, profile: 'p1' },
      { url: 'https://a.example/2', title: 'A2', visitedAt: t + 1000, profile: 'p1' },
      { url: 'chrome://settings', title: 'S', visitedAt: t + 5 },
      { url: 'not a url', title: 'x', visitedAt: t + 6 },
    ],
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].seconds, 100, 'gap to the next visit in the same profile');
  assert.equal(rows[1].seconds, 30, 'last visit of its profile');
  assert.equal(rows[2].seconds, 1800, 'known duration capped at 30 min');
  assert.equal(rows[3].source, 'import:p1');
  assert.equal(rows[0].at, t * 1000);
  assert.throws(() => importVisits({ version: 2, visits: [] }));
  assert.throws(() => importVisits({ nope: true }));
});

test('period stats: time-weighted grade, slices, sites, days, swaps; logins never count', () => {
  const items: Labeled[] = [
    visit('https://arxiv.org/abs/1', 'Attention Is All You Need', 1800),
    visit('https://www.tiktok.com/@x/video/1', 'TikTok', 1800, 22),
    visit('https://accounts.google.com/signin', 'Sign in', 600),
  ].map((v, i) => {
    const w = { ...v, id: i + 1 };
    return [w, classify(w)];
  });
  const s = computeStats(items, at(0) - 1, at(23) + 1);
  assert.equal(s.visits, 2);
  assert.equal(s.seconds, 3600);
  assert.deepEqual(
    s.slices.map((x) => x.category).sort(),
    ['research', 'shortVideo'],
  );
  assert.equal(s.sites.length, 2);
  assert.equal(s.days.length, 1);
  assert.equal(s.swaps[0]?.cut, 'shortVideo');
  assert.ok(s.swaps[0].to < s.grade || s.swaps[0].to === s.grade);
  assert.equal(s.estimatedSeconds, 3600);
  assert.ok(s.topics.some(([t]) => t.includes('attention')));
  const [start, end] = rangeInterval('today', at(15));
  assert.ok(start <= at(14) && end > at(14));
});

test('chat: plans read the period and focus; retrieval and the no-model answer stay truthful', () => {
  const now = new Date(2026, 9, 21, 12).getTime();
  const p = plan('What did I learn this month?', now);
  assert.equal(p.rangeLabel, 'this month');
  assert.ok(p.focus.has('learning') && p.kinds.has('search'));
  assert.equal(plan('Which videos did I watch lately?', now).rangeLabel, 'the last two weeks');
  assert.equal(plan('what about the last 3 days', now).rangeLabel, 'the last 3 days');
  assert.equal(plan('anything in March?', now).rangeLabel, 'in March');

  const items: Labeled[] = [
    visit('https://www.youtube.com/watch?v=aircAruvnKk', 'But what is a neural network? | Deep learning chapter 1 - YouTube', 900),
    visit('https://www.google.com/search?q=transformer+attention', 'transformer attention - Google Search', 30),
    visit('https://x.com/home', 'Home / X', 1200),
  ].map((v, i) => {
    const w = { ...v, id: i + 1 };
    return [w, classify(w)];
  });
  const [text, stats] = notes(p, items);
  assert.match(text, /Things they searched for: "transformer attention"/);
  assert.match(text, /\[1\] .*neural network/);
  const pages = relevantPages(p, items, 12);
  assert.ok(pages.every(([, l]) => l.category !== 'social'), 'learning questions skip the feed');
  const answer = fallbackAnswer(p, stats, pages);
  assert.match(answer, /grade [A-E]/);
  assert.match(answer, /neural network/);
});

test('model answers: JSON anywhere in the reply, synonyms, junk dropped', () => {
  const a = parseAnswer('Sure! {"1": "learning", "2": "Short-form video", "3": "banana", "x": "news", "4": "coding"} done');
  assert.deepEqual([...a], [
    [1, 'learning'],
    [2, 'shortVideo'],
    [4, 'building'],
  ]);
  assert.equal(parseAnswer('no json').size, 0);
  for (const c of CATEGORIES) assert.equal(categoryNamed(c), c);
  assert.ok(counts('learning') && !counts('plumbing'));
});

test('sampling: only uninterrupted time counts, playback follows the video clock', async () => {
  const { elapsedSince, watchedSince } = await import('../shell/diet');
  assert.equal(elapsedSince(undefined, 5000), 0, 'the first sample adds nothing');
  assert.equal(elapsedSince(1000, 6000), 5000);
  assert.equal(elapsedSince(1000, 12_000), 0, 'a late timer (sleep, a frozen worker) is not browsing');
  assert.equal(elapsedSince(6000, 1000), 0);
  assert.equal(watchedSince(10, 15, 5), 5);
  assert.equal(watchedSince(10, 20, 5), 10, '2× speed counts 2×');
  assert.equal(watchedSince(10, 10, 5), 0, 'paused');
  assert.equal(watchedSince(10, 200, 5), 0, 'a seek is not watching');
  assert.equal(watchedSince(20, 10, 5), 0, 'seeking back');
  assert.equal(watchedSince(undefined, 10, 5), 0);
  assert.equal(watchedSince(10, 15, 0), 0);
});
