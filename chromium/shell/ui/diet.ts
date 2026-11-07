/**
 * Algorithm Diet: your browsing as a diet. Score, plate, nutrition facts, categories, days, sites,
 * topics and a plan, plus the animated classification run, the chat with your history and every
 * recorded page. The desktop port of the iOS app's DietView/DietEngine/DietChat (same cards, same
 * numbers); visits come from the background's live tracker (diet.ts) and from history imports.
 * The on-device model is Underdog Woof 2B through Uranus Browser's helper; without it the rules
 * classify and the chat answers from the numbers.
 */
import { cmd, invoke, on } from '../client';
import { classify, hintKey, stripSiteSuffix, type DietHints } from '../lib/dietClassifier';
import * as db from '../lib/dietDb';
import { CATEGORIES, CATEGORY, counts, duration, grade, GRADE_COLOR, GRADES, isMeasured, VERDICT, type DietCategory, type DietLabel, type DietVisit, type NutriGrade } from '../lib/dietModel';
import { computeStats, importVisits, RANGES, rangeInterval, type DietRange, type DietStats, type Labeled } from '../lib/dietStats';
import { CLASSIFY_SYSTEM, classifyPrompt, fallbackAnswer, notes, parseAnswer, plan, relevantPages, SUGGESTIONS, SYSTEM } from '../lib/dietChat';
import { renderMarkdown } from './markdownView';
import { icon } from './dietIcons';
import { gradeChip, h, iconTile, plate, scoreStrip, siteIcon } from './dietParts';

interface ModelInfo {
  ready: boolean;
  label: string;
  detail: string;
}
interface Tick {
  id: number;
  title: string;
  host: string;
  category: DietCategory;
  grade: NutriGrade;
}
interface Run {
  phase: string;
  detail: string;
  fraction: number;
  counts: Record<NutriGrade, number>;
  tick?: Tick;
  usedModel: boolean;
}
interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  sources: Array<{ n: number; title: string; url: string }>;
  pending: boolean;
}

const CLASSIFIED_KEY = 'diet.classifiedOnce';
const perGrade = () => Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<NutriGrade, number>;
const fmt = (n: number) => n.toLocaleString('en-US');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private window or blocked storage: the hero comes back next time, nothing else depends on it
    }
  },
};

const S = {
  loaded: false,
  importing: false,
  visits: [] as DietVisit[],
  labels: new Map<number, DietLabel>(),
  hints: { hosts: {}, titles: {} } as DietHints,
  range: 'week' as DietRange,
  stats: computeStats([], 0, 0),
  run: undefined as Run | undefined,
  runToken: 0,
  model: undefined as ModelInfo | undefined,
  tracking: true,
  lastRun: '',
  modelLog: { asked: 0, parsed: 0, bad: 0 },
  chat: [] as ChatMessage[],
  chatToken: 0,
  drawn: false,
};

const labeled = (): Labeled[] => S.visits.flatMap((v) => (S.labels.has(v.id) ? [[v, S.labels.get(v.id)!] as Labeled] : []));
const classifiedOnce = () => storage.get(CLASSIFIED_KEY) === '1';
const setClassifiedOnce = (on: boolean) => storage.set(CLASSIFIED_KEY, on ? '1' : '0');

// ---- loading ----

async function load() {
  render();
  const [visits, hints] = await Promise.all([db.allVisits(), db.hints()]);
  S.hints = hints;
  S.visits = visits;
  S.labels = new Map(visits.map((v) => [v.id, classify(v, hints)]));
  S.loaded = true;
  refreshStats(false);
  if (S.range === 'week' && S.stats.seconds === 0 && visits.length && visits[visits.length - 1].at < Date.now() - 7 * 86_400_000) S.range = 'all';
  refreshStats();
  void refreshModel();
  S.tracking = (await invoke<boolean>('diet:tracking').catch(() => true)) !== false;
  render();
  const hash = location.hash.slice(1);
  if (hash === 'chat') openChat();
  if (hash === 'history') openHistory();
}

async function refreshModel() {
  S.model = await invoke<ModelInfo>('diet:model').catch(() => undefined);
  render();
}

function refreshStats(draw = true) {
  const [start, end] = rangeInterval(S.range);
  S.stats = computeStats(labeled(), start, end);
  if (draw) render();
}

let statsTimer: number | undefined;
const refreshSoon = () => {
  clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => refreshStats(), 600);
};

// Live visits from the background tracker: add or update, label, and redraw shortly.
on('diet:visit', (v: DietVisit) => {
  if (!S.loaded) return;
  const i = S.visits.findIndex((x) => x.id === v.id);
  if (i >= 0) S.visits[i] = v;
  else S.visits.push(v);
  S.labels.set(v.id, classify(v, S.hints));
  refreshSoon();
});
on('diet:hints', async (found: Partial<DietHints>) => {
  S.hints = await db.hints();
  const hosts = new Set(Object.keys(found.hosts ?? {}));
  const titles = new Set(Object.keys(found.titles ?? {}));
  for (const v of S.visits) if (hosts.has(v.host) || titles.has(hintKey(v.host, v.title))) S.labels.set(v.id, classify(v, S.hints));
  refreshSoon();
});
on('diet:tracking', (onOff: boolean) => {
  S.tracking = onOff;
  render();
});

// ---- import / erase ----

const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'diet-import' }) as HTMLInputElement;
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) await importHistory(await file.text());
});

async function importHistory(text: string) {
  S.importing = true;
  render();
  try {
    const parsed = importVisits(JSON.parse(text));
    const added = await db.insertVisits(parsed);
    S.visits.push(...added);
    S.visits.sort((a, b) => a.at - b.at);
    for (const v of added) S.labels.set(v.id, classify(v, S.hints));
    toast(`Imported ${fmt(added.length)} visits${parsed.length > added.length ? ` (${fmt(parsed.length - added.length)} already there)` : ''}`);
    if (added.length) setClassifiedOnce(false);
    S.importing = false;
    refreshStats(false);
    if (added.length && S.range !== 'all' && S.stats.seconds === 0) S.range = 'all';
    S.drawn = false;
    refreshStats();
  } catch (err) {
    S.importing = false;
    toast(`That file isn’t a history export (${err instanceof Error ? err.message : 'unreadable'}).`);
    render();
  }
}

async function eraseAll() {
  if (!S.loaded || S.importing) return;
  if (!confirm('Erase every visit and label?\n\nYour tabs and browser history are not touched.')) return;
  cancelRun();
  await db.eraseAll();
  cmd('diet:reset')();
  S.visits = [];
  S.labels = new Map();
  S.hints = { hosts: {}, titles: {} };
  setClassifiedOnce(false);
  refreshStats();
}

// ---- the classification run (DietEngine.performRun) ----

function startRun(useModel = true) {
  if (S.run || !S.visits.length) return;
  const token = ++S.runToken;
  S.run = { phase: 'Reading your history', detail: `${fmt(S.visits.length)} visits`, fraction: 0, counts: perGrade(), usedModel: false };
  render();
  void performRun(token, useModel).finally(() => {
    if (S.runToken === token) S.run = undefined;
    render();
  });
}

function cancelRun() {
  S.runToken++;
  S.run = undefined;
  render();
}

async function performRun(token: number, useModel: boolean) {
  const alive = () => S.runToken === token;
  const model = useModel ? await invoke<ModelInfo>('diet:model').catch(() => undefined) : undefined;
  const ready = !!model?.ready;
  if (!alive() || !S.run) return;
  S.run.usedModel = ready;
  const rulesShare = ready ? 0.3 : 1;

  // Phase 1: every visit through the rules, in chunks, so the bar and counters move as it goes.
  const snapshot = [...S.visits];
  const fresh = new Map<number, DietLabel>();
  const counted = perGrade();
  const chunk = Math.max(200, Math.floor(snapshot.length / 120));
  for (let i = 0; i < snapshot.length; ) {
    if (!alive()) return;
    const part = snapshot.slice(i, i + chunk);
    let last: [DietVisit, DietLabel] | undefined;
    for (const v of part) {
      const l = classify(v, S.hints);
      fresh.set(v.id, l);
      if (counts(l.category)) {
        counted[grade(l.nutrients)] += 1;
        if (v.title) last = [v, l];
      }
    }
    i += part.length;
    if (last) S.run.tick = { id: i, title: stripSiteSuffix(last[0].title, last[0].host), host: last[0].host, category: last[1].category, grade: grade(last[1].nutrients) };
    S.run.counts = { ...counted };
    S.run.fraction = (rulesShare * i) / snapshot.length;
    S.run.detail = `${fmt(i)} of ${fmt(snapshot.length)} visits`;
    renderRun();
    await sleep(18);
  }
  if (!alive()) return;
  S.labels = fresh;

  if (ready) {
    await askAboutSites(snapshot, rulesShare, 0.75, alive);
    if (alive()) await askAboutVideos(snapshot, 0.75, 1, alive);
  }
  if (!alive()) return;
  S.labels = new Map(S.visits.map((v) => [v.id, classify(v, S.hints)]));
  const all = computeStats(labeled(), ...rangeInterval('all'));
  S.lastRun = `${fmt(all.visits)} visits · ${fmt(all.sites.length)} sites · grade ${all.grade}`;
  S.run.fraction = 1;
  S.run.counts = all.gradeCounts;
  S.run.phase = 'Done';
  S.run.detail = S.lastRun;
  renderRun();
  S.drawn = false;
  refreshStats();
  await sleep(900);
  if (alive()) setClassifiedOnce(true);
}

/** Sites the rules don't know, busiest first, 12 per prompt. */
async function askAboutSites(snapshot: DietVisit[], from: number, to: number, alive: () => boolean) {
  const byHost = new Map<string, { n: number; titles: string[] }>();
  for (const v of snapshot) {
    if (S.labels.get(v.id)?.category !== 'other' || S.hints.hosts[v.host] || !v.host) continue;
    const e = byHost.get(v.host) ?? { n: 0, titles: [] };
    e.n += 1;
    if (e.titles.length < 3 && v.title && !e.titles.includes(v.title.slice(0, 70))) e.titles.push(v.title.slice(0, 70));
    byHost.set(v.host, e);
  }
  const hosts = [...byHost].sort((a, b) => b[1].n - a[1].n).slice(0, 120);
  const batches: Array<typeof hosts> = [];
  for (let i = 0; i < hosts.length; i += 12) batches.push(hosts.slice(i, i + 12));
  for (const [b, batch] of batches.entries()) {
    if (!alive() || !S.run) return;
    S.run.phase = 'Asking Woof about new sites';
    S.run.detail = `${Math.min((b + 1) * 12, hosts.length)} of ${hosts.length} sites the rules don’t know`;
    renderRun();
    const lines = batch.map(([host, e], n) => `${n + 1}. ${host}${e.titles.length ? ` — pages: ${e.titles.map((t) => `"${t}"`).join(', ')}` : ''}`);
    const answer = await ask('website', lines);
    if (!alive() || !S.run) return;
    const found: Record<string, DietCategory> = {};
    batch.forEach(([host], n) => {
      const c = answer.get(n + 1);
      if (c) found[host] = c;
    });
    Object.assign(S.hints.hosts, found);
    await db.saveHints({ hosts: found });
    const shown = Object.entries(found).find(([, c]) => c !== 'other');
    if (shown) S.run.tick = { id: 1_000_000 + b, title: byHost.get(shown[0])?.titles[0] ?? shown[0], host: shown[0], category: shown[1], grade: grade(CATEGORY[shown[1]].nutrients) };
    updateLabels(snapshot.filter((v) => found[v.host]));
    S.run.fraction = from + ((to - from) * (b + 1)) / batches.length;
    renderRun();
  }
}

/** Videos whose title gave the rules nothing to go on, newest first, 15 per prompt. */
async function askAboutVideos(snapshot: DietVisit[], from: number, to: number, alive: () => boolean) {
  const seen = new Set<string>();
  const picked: DietVisit[] = [];
  for (let i = snapshot.length - 1; i >= 0 && picked.length < 150; i--) {
    const v = snapshot[i];
    const l = S.labels.get(v.id);
    if (l?.kind !== 'video' || l.method !== 'domain' || !v.title) continue;
    const key = hintKey(v.host, v.title);
    if (S.hints.titles[key] || seen.has(key)) continue;
    seen.add(key);
    picked.push(v);
  }
  const batches: DietVisit[][] = [];
  for (let i = 0; i < picked.length; i += 15) batches.push(picked.slice(i, i + 15));
  for (const [b, batch] of batches.entries()) {
    if (!alive() || !S.run) return;
    S.run.phase = 'Sorting video titles with Woof';
    S.run.detail = `${Math.min((b + 1) * 15, picked.length)} of ${picked.length} video titles`;
    renderRun();
    const lines = batch.map((v, n) => `${n + 1}. "${stripSiteSuffix(v.title, v.host).slice(0, 90)}"${v.channel ? ` by ${v.channel}` : ''}`);
    const answer = await ask('video', lines);
    if (!alive() || !S.run) return;
    const found: Record<string, DietCategory> = {};
    batch.forEach((v, n) => {
      const c = answer.get(n + 1);
      if (c) found[hintKey(v.host, v.title)] = c;
    });
    Object.assign(S.hints.titles, found);
    await db.saveHints({ titles: found });
    const first = batch.find((v) => found[hintKey(v.host, v.title)]);
    if (first) {
      const c = found[hintKey(first.host, first.title)];
      S.run.tick = { id: 2_000_000 + b, title: stripSiteSuffix(first.title, first.host), host: first.host, category: c, grade: grade(CATEGORY[c].nutrients) };
    }
    updateLabels(snapshot.filter((v) => found[hintKey(v.host, v.title)]));
    S.run.fraction = from + ((to - from) * (b + 1)) / batches.length;
    renderRun();
  }
}

function updateLabels(changed: DietVisit[]) {
  for (const v of changed) S.labels.set(v.id, classify(v, S.hints));
  if (!S.run) return;
  const c = perGrade();
  for (const l of S.labels.values()) if (counts(l.category)) c[grade(l.nutrients)] += 1;
  S.run.counts = c;
}

/** One prompt, one JSON object back: {"1": "learning", ...}. Unknown words are dropped. */
async function ask(thing: 'website' | 'video', lines: string[]) {
  const text = await invoke<string>('diet:complete', { system: CLASSIFY_SYSTEM, user: classifyPrompt(thing, lines), maxTokens: 24 * lines.length + 40 }).catch(() => '');
  const answer = parseAnswer(text);
  S.modelLog.asked += lines.length;
  S.modelLog.parsed += answer.size;
  if (!answer.size) S.modelLog.bad += 1;
  return answer;
}

// ---- drawing ----

const app = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;

function card(title: string | undefined, subtitle: string | undefined, ...body: Array<Node | false | null | undefined>) {
  return h('section', { class: 'card' }, title ? h('header', { class: 'card-head' }, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null) : null, ...body);
}

function button(label: string, onClick: () => void, cls = 'btn', iconName?: string) {
  return h('button', { class: cls, type: 'button', onclick: onClick }, iconName ? icon(iconName, 16) : null, label);
}

function render() {
  document.documentElement.style.setProperty('--grade-tint', GRADE_COLOR[S.stats.grade]);
  const animate = !S.drawn;
  const main = h('main', { class: 'column' });
  main.append(topbar());
  if (!S.loaded || S.importing) {
    main.append(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), S.importing ? h('p', {}, 'Importing your history…') : null));
  } else if (!S.visits.length) {
    main.append(emptyState(), modelCard());
  } else {
    if (!classifiedOnce() && !S.run && S.visits.some((v) => !isMeasured(v))) main.append(classifyHero());
    main.append(rangePicker());
    if (S.stats.visits === 0) {
      main.append(card('Nothing in this range', undefined, h('p', { class: 'muted' }, 'Pick a longer range, or browse a bit: pages you open in Uranus Browser are added as you go.')));
    } else {
      main.append(scoreCard(animate), consumptionCard(), nutritionFacts(animate), categoriesCard(animate));
      if (S.stats.days.length > 1) main.append(daysCard(animate));
      main.append(sitesCard());
      if (S.stats.topics.length) main.append(topicsCard());
      main.append(planCard());
      if (S.loaded && S.stats.visits) S.drawn = true;
    }
    main.append(modelCard());
  }
  main.append(
    h(
      'p',
      { class: 'footer' },
      'Analysis stays on this Mac. Pages you read in Uranus Browser are recorded and classified automatically while its window is in front and you are at the Mac (or a video is playing); incognito windows are never recorded. Other browsers and apps are not monitored: import their history to include it. Video topics come from the page’s text, not the video itself.',
    ),
  );
  app.replaceChildren(main, fileInput);
  renderRun();
}

function topbar() {
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    menuItem('Import History…', 'import', () => fileInput.click()),
    menuItem('Classify Again', 'wand', () => startRun(), !S.visits.length || !!S.run),
    menuItem(S.tracking ? 'Track Browsing ✓' : 'Track Browsing', 'record', () => void invoke('diet:tracking', !S.tracking)),
    h('hr'),
    menuItem('Erase Diet Data', 'trash', () => void eraseAll(), !S.loaded || S.importing, 'danger'),
  );
  const more = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Diet options', title: 'Diet options', 'aria-haspopup': 'menu' }, icon('more', 18));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => (menu.hidden = true), { once: true });
  return h(
    'header',
    { class: 'topbar' },
    h('h1', {}, 'Algorithm Diet'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Chat with history', title: 'Chat with history', disabled: !S.visits.length, onclick: openChat }, icon('chat', 18)),
    h('div', { class: 'menu-anchor' }, more, menu),
  );
}

function menuItem(label: string, iconName: string, onClick: () => void, disabled = false, cls = '') {
  return h('button', { class: `menu-item ${cls}`.trim(), type: 'button', role: 'menuitem', disabled, onclick: onClick }, icon(iconName, 15), label);
}

function emptyState() {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon('utensils', 40)),
    h('h2', {}, 'You are what you browse'),
    h('p', { class: 'muted' }, 'Pages and videos you open in Uranus Browser are sorted into a diet and scored A to E, all on this Mac. Incognito windows are never recorded.'),
    button('Start browsing', () => window.close(), 'btn primary wide', 'globe'),
    h('p', { class: 'muted small' }, 'Tracking and classification happen automatically as you browse. Importing past history is optional.'),
    button('Import past history…', () => fileInput.click(), 'btn link'),
  );
}

function classifyHero() {
  return card(
    undefined,
    undefined,
    h(
      'div',
      { class: 'hero-row' },
      h('span', { class: 'hero-icon' }, icon('wand', 22)),
      h(
        'div',
        {},
        h('strong', {}, `${fmt(S.visits.length)} visits ready`),
        h('p', { class: 'muted small' }, S.model?.ready ? `Rules first, then ${S.model.label} on this Mac for what they can’t place.` : 'Rules sort them on this Mac. Set up Woof 2B below for the unknown ones.'),
      ),
    ),
    button('Classify my history', () => startRun(), 'btn primary wide'),
  );
}

function rangePicker() {
  return h(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': 'Range' },
    ...RANGES.map((r) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(r.id === S.range),
          class: r.id === S.range ? 'on' : '',
          onclick: () => {
            S.range = r.id;
            S.drawn = false;
            refreshStats();
          },
        },
        r.title,
      ),
    ),
  );
}

const rangeTitle = () => RANGES.find((r) => r.id === S.range)!.title;

function scoreCard(animate: boolean) {
  const s = S.stats;
  const top = s.slices[0];
  return card(
    undefined,
    undefined,
    h(
      'div',
      { class: 'score-row' },
      plate(s.slices, s.health, 140, 22, animate),
      h(
        'div',
        { class: 'score-text' },
        h('h2', { class: 'verdict' }, VERDICT[s.grade]),
        h('p', { class: 'muted' }, `${duration(s.seconds)} · ${fmt(s.visits)} pages`),
        top ? h('p', { class: 'mostly', style: `color:${CATEGORY[top.category].color}` }, icon(CATEGORY[top.category].icon, 14), `Mostly ${CATEGORY[top.category].title.toLowerCase()}`) : null,
      ),
    ),
    scoreStrip(s.grade, animate),
  );
}

function consumptionCard() {
  const s = S.stats;
  const row = (k: string, v: string) => h('div', { class: 'kv' }, h('span', {}, k), h('span', { class: 'num' }, v));
  return card(
    'Your consumption',
    `${rangeTitle()} · this browser and imported history`,
    row('Measured browsing', duration(s.measuredSeconds)),
    row('Estimated from imports', duration(s.estimatedSeconds)),
    row('Video playback', duration(s.watchSeconds)),
    h('p', { class: 'muted small' }, 'Playback follows the video’s clock, so 2× speed adds 2× playback. Imported history has no watch-time measurement.'),
    button('Explore pages & videos', openHistory, 'btn bordered wide', 'list'),
  );
}

function nutritionFacts(animate: boolean) {
  const n = S.stats.nutrients;
  const rows: Array<[string, string, number, boolean]> = [
    ['Protein', 'learning', n.protein, true],
    ['Fiber', 'depth & focus', n.fiber, true],
    ['Vitamins', 'culture & people', n.vitamins, true],
    ['Sugar', 'quick hits', n.sugar, false],
    ['Salt', 'outrage & anxiety', n.salt, false],
    ['Fat', 'endless feeds', n.fat, false],
  ];
  const points = n.sugar + n.salt + n.fat - n.protein - n.fiber - n.vitamins;
  const box = h('section', { class: `card facts${animate ? ' grow' : ''}` }, h('h2', { class: 'facts-title' }, 'Nutrition Facts'), h('p', { class: 'facts-sub' }, `Time-weighted points, 0–10 · ${rangeTitle().toLowerCase()}`), h('div', { class: 'rule thick' }));
  rows.forEach(([name, what, value, good], i) => {
    box.append(
      h(
        'div',
        { class: 'fact' },
        h('strong', {}, name),
        h('span', { class: 'muted small' }, what),
        h('span', { class: 'bar' }, h('span', { class: `fill ${good ? 'good' : 'bad'}`, style: `--w:${(value / 10) * 100}%` })),
        h('span', { class: 'num small' }, value.toFixed(1)),
      ),
    );
    if (i === 2) box.append(h('div', { class: 'rule mid' }));
    else if (i < 5) box.append(h('div', { class: 'rule' }));
  });
  box.append(
    h('div', { class: 'rule thick' }),
    h('p', { class: 'muted tiny num' }, `Score = sugar + salt + fat − protein − fiber − vitamins = ${points >= 0 ? '+' : ''}${points.toFixed(1)} → ${S.stats.grade}`),
    h('p', { class: 'muted tiny' }, 'A ≤ −12 · B ≤ −4 · C ≤ 4 · D ≤ 12 · E > 12. Category, title and session length affect the points. This is a browsing reflection score, inspired by food labels; it is not the official food Nutri-Score.'),
  );
  return box;
}

function categoriesCard(animate: boolean) {
  return card(
    'On your plate',
    'Time by category',
    ...S.stats.slices.slice(0, 9).map((s) =>
      h(
        'div',
        { class: `cat-row${animate ? ' grow' : ''}` },
        iconTile(s.category),
        h(
          'div',
          { class: 'cat-main' },
          h('div', { class: 'cat-line' }, h('span', {}, CATEGORY[s.category].title), h('span', { class: 'num muted' }, duration(s.seconds))),
          h('span', { class: 'cat-bar', style: `--w:${Math.max(1, s.share * 100)}%;--tint:${CATEGORY[s.category].color}` }),
        ),
        gradeChip(grade(s.nutrients)),
      ),
    ),
  );
}

function daysCard(animate: boolean) {
  const days = S.stats.days.slice(-14);
  const peak = Math.max(...days.map((d) => d.seconds), 1);
  const weekday = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'narrow' });
  return card(
    'Day by day',
    'Bar height is time, colour is the day’s grade',
    h(
      'div',
      { class: `days${animate ? ' grow' : ''}` },
      ...days.map((d) =>
        h(
          'div',
          { class: 'day', title: `${new Date(d.day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${duration(d.seconds)} · grade ${grade(d.nutrients)}` },
          h('span', { class: 'day-bar', style: `--h:${Math.max(6, (96 * d.seconds) / peak)}px;background:${GRADE_COLOR[grade(d.nutrients)]}` }),
          h('span', { class: 'muted tiny' }, weekday(d.day)),
        ),
      ),
    ),
  );
}

function sitesCard() {
  return card(
    'Top sites',
    undefined,
    ...S.stats.sites.slice(0, 8).map((s) =>
      h(
        'div',
        { class: 'site-row' },
        siteIcon(s.host),
        h('div', { class: 'site-main' }, h('span', { class: 'ellipsis' }, s.host), h('span', { class: 'muted small' }, `${CATEGORY[s.category].title} · ${fmt(s.visits)} visits`)),
        h('span', { class: 'num muted' }, duration(s.seconds)),
        gradeChip(grade(s.nutrients)),
      ),
    ),
  );
}

function topicsCard() {
  return card('Ingredients', 'Topics from what you learned, searched and watched', h('div', { class: 'chips' }, ...S.stats.topics.slice(0, 18).map(([t], i) => h('span', { class: `chip${i < 3 ? ' strong' : ''}` }, t))));
}

function planCard() {
  const swaps = S.stats.swaps;
  return card(
    'Your diet plan',
    'Swap half the time for learning and see your grade',
    swaps.length ? null : h('p', { class: 'good' }, icon('check', 16), 'Nothing junky enough to cut. Keep it up.'),
    ...swaps.map((sw) =>
      h(
        'div',
        { class: 'cat-row' },
        iconTile(sw.cut),
        h('div', { class: 'cat-main' }, h('span', {}, `Halve ${CATEGORY[sw.cut].title.toLowerCase()}`), h('span', { class: 'muted small' }, `${duration(sw.cutSeconds)} less`)),
        gradeChip(sw.from),
        h('span', { class: 'muted' }, icon('arrowRight', 14)),
        gradeChip(sw.to),
      ),
    ),
  );
}

function modelCard() {
  const m = S.model;
  const log = S.modelLog.asked ? ` · sorted ${S.modelLog.parsed} of ${S.modelLog.asked}` : '';
  return card(
    'On-device model',
    'Underdog Woof 2B 1.1 · Apache-2.0 · private inference on this Mac',
    h(
      'div',
      { class: 'model-row' },
      h('span', { class: m?.ready ? 'good' : 'muted' }, icon(m?.ready ? 'check' : 'cpu', 18)),
      h('span', { class: 'model-text' }, m ? (m.ready ? `${m.label} is set up on this Mac. It starts on the first question and stops after a few idle minutes${log}.` : m.detail) : 'Checking…'),
      button('Check', () => void refreshModel(), 'btn bordered small'),
    ),
    m?.ready ? null : h('p', { class: 'muted small' }, 'Sorts sites the rules don’t know and answers your questions. Without it, rules and quick answers still work. It comes with OpenWhisper (Settings › Intelligence › Underdog).'),
  );
}

// ---- the run card ----

let runCard: HTMLElement | undefined;
let lastTick = -1;

function renderRun() {
  const r = S.run;
  if (!r) {
    runCard = undefined;
    lastTick = -1;
    overlay.querySelector('.run-scrim')?.remove();
    return;
  }
  if (!runCard || !overlay.contains(runCard)) {
    runCard = h('div', { class: 'run-card', role: 'dialog', 'aria-label': 'Classifying your history' });
    overlay.append(h('div', { class: 'run-scrim' }, runCard));
    runCard.append(
      h('div', { class: 'run-head' }, h('div', {}, h('strong', { class: 'run-phase' }), h('p', { class: 'run-detail muted small num' })), h('span', { class: 'run-pct' })),
      h('div', { class: 'progress' }, h('span', { class: 'progress-fill' }), h('span', { class: 'progress-head' })),
      h('div', { class: 'run-tick' }),
      h('div', { class: 'buckets' }, ...GRADES.map((g) => h('div', { class: 'bucket', style: `--tint:${GRADE_COLOR[g]}`, 'data-grade': g }, gradeChip(g, 26), h('span', { class: 'num small muted' })))),
      h('div', { class: 'run-foot' }, h('span', { class: 'run-model muted small' }), h('span', { class: 'spacer' }), button('Stop', cancelRun, 'btn link')),
    );
  }
  runCard.querySelector('.run-phase')!.textContent = r.phase;
  runCard.querySelector('.run-detail')!.textContent = r.detail;
  runCard.querySelector('.run-pct')!.textContent = `${Math.round(r.fraction * 100)}%`;
  (runCard.querySelector('.progress') as HTMLElement).style.setProperty('--f', String(Math.max(0, Math.min(1, r.fraction))));
  runCard.querySelector('.progress')!.classList.toggle('running', r.fraction > 0.01 && r.fraction < 0.999);
  const model = runCard.querySelector('.run-model')!;
  model.replaceChildren(...(r.usedModel ? [icon('cpu', 14), 'Woof 2B is thinking on this Mac'] : []));
  for (const g of GRADES) {
    const b = runCard.querySelector(`[data-grade="${g}"]`) as HTMLElement;
    const label = b.querySelector('span.num')!;
    const text = new Intl.NumberFormat('en-US', { notation: 'compact' }).format(r.counts[g] ?? 0);
    if (label.textContent !== text) {
      label.textContent = text;
      b.classList.remove('bump');
      void b.offsetWidth;
      b.classList.add('bump');
    }
  }
  if (r.tick && r.tick.id !== lastTick) {
    lastTick = r.tick.id;
    const t = r.tick;
    const slot = runCard.querySelector('.run-tick')!;
    for (const old of slot.children) old.classList.add('out');
    setTimeout(() => slot.querySelectorAll('.out').forEach((e) => e.remove()), 300);
    slot.append(
      h(
        'div',
        { class: 'tick' },
        gradeChip(t.grade, 30),
        h(
          'div',
          { class: 'tick-main' },
          h('span', { class: 'ellipsis' }, t.title),
          h('span', { class: 'muted small tick-line' }, h('span', { class: 'ellipsis' }, t.host), icon('arrowRight', 12), h('span', { style: `color:${CATEGORY[t.category].color}` }, CATEGORY[t.category].title)),
        ),
      ),
    );
  }
}

// ---- sheets: chat and pages ----

function sheet(title: string, body: HTMLElement, onClose?: () => void, wide = false) {
  overlay.querySelector('.sheet-scrim')?.remove();
  const close = () => {
    scrim.remove();
    onClose?.();
    if (location.hash) history.replaceState(null, '', location.pathname);
  };
  const scrim = h(
    'div',
    { class: 'sheet-scrim', onclick: (e: MouseEvent) => e.target === scrim && close() },
    h('div', { class: `sheet${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title }, h('header', { class: 'sheet-head' }, h('strong', {}, title), button('Done', close, 'btn link')), body),
  );
  overlay.append(scrim);
  document.addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape' || !scrim.isConnected) return document.removeEventListener('keydown', esc);
    close();
    document.removeEventListener('keydown', esc);
  });
  return scrim;
}

function openChat() {
  if (!S.visits.length) return;
  const list = h('div', { class: 'chat-list' });
  const draft = h('textarea', { class: 'chat-input', rows: 1, placeholder: 'Ask about your history', 'aria-label': 'Ask about your history' }) as HTMLTextAreaElement;
  const send = h('button', { class: 'send', type: 'button', 'aria-label': 'Send' }, icon('arrowUp', 16));
  const chips = h('div', { class: 'chips scroll' });
  const body = h('div', { class: 'chat' }, list, h('div', { class: 'composer' }, chips, h('div', { class: 'field' }, draft, send)));
  const busy = () => S.chat.some((m) => m.pending);

  const draw = () => {
    list.replaceChildren();
    if (!S.chat.length) {
      list.append(
        h('span', { class: 'pill muted small' }, icon(S.model?.ready ? 'cpu' : 'chart', 14), S.model?.ready ? `${S.model.label} · on this Mac` : 'Quick answers from your numbers (Woof 2B isn’t set up yet)'),
        h('h3', {}, 'What do you want to know about your browsing?'),
        ...SUGGESTIONS.map((s) => h('button', { class: 'suggestion', type: 'button', onclick: () => askChat(s) }, h('span', {}, s), icon('arrowUpRight', 14))),
      );
    }
    for (const m of S.chat) {
      if (m.role === 'user') {
        list.append(h('div', { class: 'bubble user' }, m.text));
        continue;
      }
      const bubble = h('div', { class: 'bubble assistant' });
      if (m.pending) bubble.append(h('span', { class: 'dots' }, h('i'), h('i'), h('i')));
      else bubble.append(renderMarkdown(m.text, { open: (url) => cmd('diet:open-url')(url) }));
      if (m.sources.length && !m.pending)
        bubble.append(h('div', { class: 'sources' }, ...m.sources.map((s) => h('button', { class: 'source', type: 'button', title: s.url, onclick: () => cmd('diet:open-url')(s.url) }, `[${s.n}] ${s.title}`))));
      list.append(bubble);
    }
    chips.replaceChildren(...(S.chat.length && !busy() ? SUGGESTIONS.map((s) => h('button', { class: 'chip button', type: 'button', onclick: () => askChat(s) }, s)) : []));
    send.replaceChildren(icon(busy() ? 'stop' : 'arrowUp', 16));
    send.setAttribute('aria-label', busy() ? 'Stop' : 'Send');
    list.scrollTop = list.scrollHeight;
  };

  async function askChat(question: string) {
    const q = question.trim();
    if (!q || busy()) return;
    draft.value = '';
    const token = ++S.chatToken;
    const answer: ChatMessage = { role: 'assistant', text: '', sources: [], pending: true };
    S.chat.push({ role: 'user', text: q, sources: [], pending: false }, answer);
    draw();
    const p = plan(q);
    const items = labeled();
    const [text, stats] = notes(p, items);
    const pages = relevantPages(p, items, 12);
    answer.sources = pages.flatMap(([v], i) => (/^https?:\/\//.test(v.url) ? [{ n: i + 1, title: stripSiteSuffix(v.title, v.host), url: v.url }] : []));
    const info = await invoke<ModelInfo>('diet:model').catch(() => undefined);
    let reply = '';
    if (info?.ready) reply = await invoke<string>('diet:complete', { system: SYSTEM, user: `Notes:\n${text}\n\nQuestion: ${q}`, maxTokens: 420 }).catch(() => '');
    if (token !== S.chatToken) return;
    answer.text = reply.trim() || fallbackAnswer(p, stats, pages);
    answer.pending = false;
    draw();
  }

  const stop = () => {
    S.chatToken++;
    const last = S.chat[S.chat.length - 1];
    if (last?.pending) {
      last.pending = false;
      last.text ||= 'Stopped.';
    }
    draw();
  };
  send.addEventListener('click', () => (busy() ? stop() : void askChat(draft.value)));
  draft.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy()) void askChat(draft.value);
    }
  });
  sheet('Ask your history', body, stop);
  draw();
  draft.focus();
}

function openHistory() {
  let query = '';
  let category: DietCategory | '' = '';
  let limit = 100;
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Title, site or topic', 'aria-label': 'Search pages' }) as HTMLInputElement;
  const select = h('select', { class: 'select', 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), ...CATEGORIES.map((c) => h('option', { value: c }, CATEGORY[c].title))) as HTMLSelectElement;
  const summary = h('p', { class: 'muted small' });
  const list = h('div', { class: 'history-list' });
  const body = h('div', { class: 'history' }, h('div', { class: 'history-filters' }, search, select), summary, list);

  const matches = () => {
    const [start, end] = rangeInterval(S.range);
    const term = query.trim().toLowerCase();
    const out: Labeled[] = [];
    for (let i = S.visits.length - 1; i >= 0; i--) {
      const v = S.visits[i];
      const l = S.labels.get(v.id);
      if (!l || v.at < start || v.at >= end || (category && l.category !== category)) continue;
      if (term && ![v.title, v.host, v.description ?? '', v.excerpt ?? ''].some((s) => s.toLowerCase().includes(term))) continue;
      out.push([v, l]);
    }
    return out;
  };
  const draw = () => {
    const results = matches();
    summary.textContent = `${fmt(results.length)} visits · ${rangeTitle()}`;
    list.replaceChildren(
      ...results.slice(0, limit).map(([v, l]) =>
        h(
          'button',
          { class: 'visit', type: 'button', onclick: () => detail(v, l) },
          gradeChip(grade(l.nutrients)),
          h(
            'span',
            { class: 'visit-main' },
            h('span', { class: 'clamp2' }, v.title || v.host),
            h('span', { class: 'muted small' }, `${v.host} · ${new Date(v.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`),
            h('span', { class: 'muted small' }, `${duration(v.seconds)} ${isMeasured(v) ? 'measured' : 'estimated'} · ${CATEGORY[l.category].title}`),
          ),
          icon('chevronRight', 14),
        ),
      ),
      results.length > limit ? button('Show 100 more', () => ((limit += 100), draw()), 'btn bordered wide') : '',
      results.length ? '' : h('p', { class: 'muted' }, 'No recorded pages match these filters.'),
    );
  };
  const detail = (v: DietVisit, l: DietLabel) => {
    const kv = (k: string, val: string) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, val));
    const back = button('All pages', () => body.replaceChildren(h('div', { class: 'history-filters' }, search, select), summary, list), 'btn link', 'chevronLeft');
    body.replaceChildren(
      back,
      h(
        'div',
        { class: 'detail' },
        h('h3', {}, v.title || v.host),
        /^https?:\/\//.test(v.url) ? button('Open recorded page', () => cmd('diet:open-url')(v.url), 'btn link', 'external') : '',
        v.channel ? kv('Channel', v.channel) : '',
        h('p', { class: 'muted small' }, new Date(v.at).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })),
        h('h4', {}, 'Consumption'),
        kv(isMeasured(v) ? 'Measured browsing' : 'Estimated browsing', duration(v.seconds)),
        isMeasured(v) ? kv('Video playback', duration(v.watchSeconds ?? 0)) : '',
        h('p', { class: 'muted small' }, isMeasured(v) ? 'Measured while this page was in front in Uranus Browser. Playback follows the video’s clock.' : 'Estimated from desktop visit durations or the gap to the next visit in the same profile. This is not measured watch time.'),
        h('h4', {}, 'Why this score?'),
        kv('Category', CATEGORY[l.category].title),
        kv('Grade', grade(l.nutrients)),
        kv('Evidence', l.method[0].toUpperCase() + l.method.slice(1)),
        h('p', { class: 'muted small' }, `${Math.round(l.confidence * 100)}% rule/model confidence is a heuristic, not a calibrated probability.`),
        h('p', { class: 'muted small' }, counts(l.category) ? 'Category sets the starting points. Content cues and session length adjust them; the period’s score is weighted by browsing time.' : 'Logins and redirects are kept here and left out of consumption totals.'),
        v.description ? h('h4', {}, 'Description') : '',
        v.description ? h('p', {}, v.description) : '',
        v.excerpt ? h('h4', {}, 'Recorded excerpt') : '',
        v.excerpt ? h('p', { class: 'excerpt' }, v.excerpt) : '',
      ),
    );
  };
  let typing: number | undefined;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = window.setTimeout(() => {
      query = search.value;
      limit = 100;
      draw();
    }, 150);
  });
  select.addEventListener('change', () => {
    category = select.value as DietCategory | '';
    limit = 100;
    draw();
  });
  sheet('Pages & videos', body, undefined, true);
  draw();
  search.focus();
}

// ---- toast ----

function toast(text: string) {
  overlay.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, text);
  overlay.append(t);
  setTimeout(() => t.classList.add('out'), 3000);
  setTimeout(() => t.remove(), 3400);
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#chat') openChat();
  if (location.hash === '#history') openHistory();
});

void load();
