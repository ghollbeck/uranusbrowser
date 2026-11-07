// End-to-end test of visual artifacts in the Agent panel, in a real Uranus Browser (no OpenAI calls):
//   - each kind (table, bar/line/pie chart, cards, one-pager) is drawn from a chat snapshot with
//     the right structure, text alternatives, a legend, and nothing clickable but the toolbar;
//   - page-looking text (HTML, links, formulas) stays text;
//   - a later snapshot with the same entry replaces the artifact in place;
//   - the layout holds from 320 to 720 px, in light and dark, with reduced motion off and on;
//   - Copy (real clipboard) and the downloads (CSV, SVG, PNG, Markdown) work on real clicks.
//
//   node chromium/tests/e2e-artifacts.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>]
//
// The installed app's bundled host is old and knows no show_artifact, so the chat entries are
// handed to the panel the way the shell hub would: the test wraps the panel page's own port
// (before its scripts run) and replays an `agent:chat` event into the listeners the page
// registered. Everything after that is the real panel code, CSS and DOM.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/Uranus Browser.app');
const shellDir = path.resolve(arg('--shell-dir', path.join(here, '../shell/dist')));
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const scratch = path.join(here, '.scratch', `artifacts-${Date.now()}`);
const profile = path.join(scratch, 'profile');
const downloads = path.join(scratch, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// ---- the shared module, for fixtures and expected exports -------------------------------------

const bundled = path.join(scratch, 'artifacts.mjs');
await build({ entryPoints: [path.join(here, '../shared/artifacts.ts')], outfile: bundled, bundle: true, format: 'esm', platform: 'node', logLevel: 'warning' });
const { validateArtifact, toCsv, toMarkdown } = await import(bundled);

const full = (over) => ({ id: null, kind: 'table', title: 'T', caption: null, columns: null, rows: null, chart_type: null, labels: null, series: null, unit: null, items: null, sections: null, ...over });
const make = (raw) => {
  const r = validateArtifact(raw);
  if (!r.ok) throw new Error(r.error);
  return r.artifact;
};

const FIXTURES = {
  table: make(
    full({
      id: 'laptops',
      kind: 'table',
      title: 'Laptop comparison',
      caption: 'Prices from the three product pages, in EUR.',
      columns: ['Model', 'Price', 'Weight', 'Battery', 'Verdict'],
      rows: [
        ['Aero 14', '1,299', '1.2 kg', '18 h', 'Best all-rounder, and the quietest fan of the three we looked at'],
        ['Zen Slim', '999', '1.0 kg', '14 h', 'Lightest'],
        ['=HYPERLINK("http://evil.example","click")', '1,499', '1.6 kg', '22 h', 'Longest battery'],
      ],
    }),
  ),
  bar: make(
    full({
      id: 'sales',
      kind: 'chart',
      title: 'Revenue by quarter',
      chart_type: 'bar',
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: 'Revenue', values: [120, 180, 150, 240] }],
      unit: 'k$',
      caption: 'Source: the investor page.',
    }),
  ),
  barMany: make(
    full({
      id: 'regions',
      kind: 'chart',
      title: 'Signups by region, 2025 and 2026',
      chart_type: 'bar',
      labels: ['North America', 'Western Europe', 'Eastern Europe', 'Latin America', 'Middle East and Africa', 'South Asia', 'East Asia', 'Oceania'],
      series: [
        { name: '2025', values: [4200, 3100, 900, 1500, 700, 2600, 3300, 400] },
        { name: '2026', values: [5100, 3300, 1400, 2100, 1100, 3900, 3600, 520] },
      ],
    }),
  ),
  line: make(
    full({
      id: 'growth',
      kind: 'chart',
      title: 'Monthly growth',
      chart_type: 'line',
      labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      series: [
        { name: 'Signups', values: [2.1, 2.8, 3.0, 3.9, 4.4, 4.1, 5.2, 5.9, 6.3, 6.1, 7.4, 8.2] },
        { name: 'Churn', values: [1.2, 1.1, 1.4, 1.0, 0.9, 1.3, 1.1, 0.8, 0.9, 1.0, 0.7, 0.6] },
      ],
      unit: '%',
    }),
  ),
  pie: make(
    full({
      id: 'share',
      kind: 'chart',
      title: 'Browser market share',
      chart_type: 'pie',
      labels: ['Chrome', 'Safari', 'Edge', 'Firefox', 'Other'],
      series: [{ name: 'Share', values: [65, 18, 5.2, 2.6, 9.2] }],
      unit: '%',
    }),
  ),
  cards: make(
    full({
      id: 'kpis',
      kind: 'cards',
      title: 'Key numbers',
      items: [
        { label: 'Monthly users', value: '1.24M', note: '+8% vs last month' },
        { label: 'Revenue', value: '$4.2M', note: null },
        { label: 'Churn', value: '2.1%', note: 'lowest this year' },
        { label: 'NPS', value: '61', note: null },
        { label: 'Support tickets', value: '1,204', note: 'median reply 2h 10m' },
        { label: 'Uptime', value: '99.97%', note: null },
      ],
    }),
  ),
  onepager: make(
    full({
      id: 'brief',
      kind: 'onepager',
      title: 'Vendor brief: Acme Cloud',
      sections: [
        { heading: 'Summary', body: 'Acme Cloud is a mid-sized hosting vendor. Pricing is transparent, support is slow outside Europe, and the contract has an auto-renewal clause.', bullets: [] },
        { heading: 'Strengths', body: '', bullets: ['Clear per-hour pricing', 'EU data residency', 'Good API docs'] },
        { heading: 'Risks', body: 'Auto-renewal after 12 months.\nNo SLA credit under 99.5%.', bullets: ['Support reply times of two days outside Europe'] },
      ],
    }),
  ),
  hostile: make(
    full({
      id: 'hostile',
      kind: 'table',
      title: '<img src=x onerror=document.title="pwned"> Totals',
      columns: ['Name', '<b>Link</b>'],
      rows: [
        ['<script>document.title="pwned"</script>', '[click](javascript:alert(1))'],
        ['https://evil.example/steal?x=1', '<a href="https://evil.example">here</a>'],
      ],
    }),
  ),
};

const entry = (id, artifact) => ({ kind: 'artifact', id, artifact });
const snapshot = (entries) => ({ status: 'idle', entries, provider: { id: 'openai', label: 'OpenAI API key', ready: true, model: 'gpt-test' } });
const baseEntries = (kinds) => [
  { kind: 'user', id: 'u1', text: 'Turn what you found into something visual.' },
  ...kinds.map((k, i) => entry(`a${i + 1}`, FIXTURES[k])),
  { kind: 'assistant', id: 's1', text: 'Done: that is on the page above.' },
];

// ---- launching ---------------------------------------------------------------------------------

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/Uranus Browser'),
    [`--user-data-dir=${profile}`, `--anus-shell-dir=${shellDir}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40'],
    { stdio: 'ignore' },
  );
  reap(browser);
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await Cdp.connect(webSocketDebuggerUrl);
  const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
  const hub = (name, ...args) =>
    frame.eval(`new Promise((resolve) => {
      const p = chrome.runtime.connect({ name: 'anus' });
      p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
      p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
    })`);
  return { browser, cdp, hub };
}

/**
 * Runs in the panel page before its own scripts: remembers the listeners the page adds to its
 * hub port, drops real `agent:chat` events (the old host's empty snapshot) once the test has
 * started, and lets the test replay a chat snapshot into those listeners.
 */
const HOOK = `(() => {
  const connect = chrome.runtime.connect.bind(chrome.runtime);
  const listeners = [];
  window.__locked = false;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args);
    const add = port.onMessage.addListener.bind(port.onMessage);
    port.onMessage.addListener = (fn) => {
      listeners.push(fn);
      return add((m) => { if (window.__locked && m && m.type === 'event' && m.name === 'agent:chat') return; fn(m); });
    };
    return port;
  };
  window.__emit = (snapshot) => { window.__locked = true; for (const fn of listeners) fn({ type: 'event', name: 'agent:chat', args: [snapshot] }); };
})();`;

async function openPanel(cdp, hub) {
  await hub('agentPanel:toggle');
  const t = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
  const panel = await cdp.session(t.targetId);
  await panel.send('Page.enable');
  await panel.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await panel.send('Page.reload');
  await wait(500);
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.body.dataset.side && typeof window.__emit === 'function'`), 'the panel page with the test hook');
  await wait(800); // the real host's first snapshot comes and is dropped
  return panel;
}

// ---- helpers -------------------------------------------------------------------------------------

const emit = async (panel, snap) => {
  await panel.eval(`window.__emit(${JSON.stringify(snap)})`);
  await wait(120);
};
const q = (panel, expr) => panel.eval(expr);
async function view(panel, width, scheme = 'light', reduced = false) {
  await panel.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
  await panel.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: scheme },
      { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
    ],
  });
  await wait(450); // the charts redraw to the new width
}
async function shotOf(panel, selector, name) {
  const rect = await q(panel, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 }; })()`);
  await wait(200);
  if (!rect || !shots) return;
  const rect2 = await q(panel, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16 }; })()`);
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png', clip: { ...rect2, scale: 1 } });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
}
async function click(panel, selector) {
  const at = await q(panel, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const pbpaste = () => execFileSync('pbpaste', { encoding: 'utf8' });
const pbcopy = (text) => execFileSync('pbcopy', { input: text });
const newest = (ext) => {
  const files = fs.readdirSync(downloads).filter((f) => f.endsWith(ext) && !f.endsWith('.crdownload'));
  return files.length ? path.join(downloads, files.sort((a, b) => fs.statSync(path.join(downloads, b)).mtimeMs - fs.statSync(path.join(downloads, a)).mtimeMs)[0]) : undefined;
};

// ---- the run -------------------------------------------------------------------------------------

const savedClipboard = (() => {
  try {
    return pbpaste();
  } catch {
    return '';
  }
})();
let { browser, cdp, hub } = await launch();
try {
  await hub('finishOnboarding');
  const panel = await openPanel(cdp, hub);
  const origin = `chrome-extension://${SHELL_ID}`;
  await cdp.send('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch((e) => console.log('  (could not grant clipboard permissions:', e.message, ')'));
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }).catch((e) => console.log('  (could not set the download folder:', e.message, ')'));
  await panel.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);

  const ALL = ['table', 'bar', 'barMany', 'line', 'pie', 'cards', 'onepager', 'hostile'];
  await view(panel, 400);
  await emit(panel, snapshot(baseEntries(ALL)));

  // ---- structure ----
  const count = (sel) => q(panel, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel, i = 0) => q(panel, `document.querySelectorAll(${JSON.stringify(sel)})[${i}]?.textContent ?? null`);
  check((await count('.art')) === ALL.length, `all ${ALL.length} artifacts are drawn`);
  check((await count('#empty:not([hidden])')) === 0, 'the empty state is gone');
  const nth = (n) => `#transcript > li:nth-child(${n + 1}) .art`; // child 1 is the user message

  // Table
  const T = nth(1);
  check((await text(`${T} .art-title`)) === 'Laptop comparison', 'table: titled');
  check((await count(`${T} table caption`)) === 1 && (await count(`${T} thead th[scope="col"]`)) === 5, 'table: a <table> with a caption and five column headers');
  check((await count(`${T} tbody th[scope="row"]`)) === 3, 'table: the first cell of each row is a row header');
  check((await q(panel, `getComputedStyle(document.querySelector(${JSON.stringify(`${T} tbody td.num`)})).textAlign`)) === 'right', 'table: numbers are right-aligned');
  check((await text(`${T} tbody th`, 2)).startsWith('=HYPERLINK('), 'table: a formula-looking cell is shown as plain text');
  check((await text(`${T} .art-caption`)).startsWith('Prices from'), 'table: the caption shows');
  check((await q(panel, `document.querySelector(${JSON.stringify(`${T} .art-scroll`)}).getAttribute('tabindex')`)) === '0', 'table: the scrollable box is keyboard-focusable');
  check((await count(`${T} .art-btn`)) === 2 && /Copy/.test(await text(`${T} .art-btn`, 0)) && /CSV/.test(await text(`${T} .art-btn`, 1)), 'table: toolbar has Copy and CSV');

  // Charts
  const B = nth(2);
  check((await count(`${B} svg.art-svg[role="img"]`)) === 1 && /^Bar chart: Revenue by quarter/.test(await q(panel, `document.querySelector(${JSON.stringify(`${B} svg.art-svg`)}).getAttribute('aria-label')`)), 'bar: an SVG image with a text alternative');
  check((await count(`${B} rect.art-bar`)) === 4, 'bar: one bar per quarter');
  check((await count(`${B} details.art-data tbody tr`)) === 4, 'bar: the data is also a real table, under “Show data”');
  check((await count(`${B} .art-legend:not([hidden]) li`)) === 0, 'bar: no legend for a single series');
  check((await count(`${B} .art-btn`)) === 3, 'bar: toolbar has Copy, SVG and PNG');
  const M = nth(3);
  check((await count(`${M} rect.art-bar`)) === 16 && (await count(`${M} .art-legend li`)) === 2, 'multi-series bar: 16 bars and a two-entry legend');
  check((await count(`${M} svg.art-svg`)) === 1 && (await q(panel, `document.querySelector(${JSON.stringify(`${M} svg.art-svg`)}).getBoundingClientRect().height`)) > 200, 'multi-series bar: many long labels switch to horizontal rows');
  const L = nth(4);
  check((await count(`${L} polyline.art-line`)) === 2 && (await count(`${L} circle.art-dot`)) === 24, 'line: two lines with 12 points each');
  const P = nth(5);
  check((await count(`${P} path.art-slice`)) === 5, 'pie: five slices');
  check((await count(`${P} .art-legend.pie li`)) === 5 && /65%/.test(await text(`${P} .art-legend.pie li`, 0)), 'pie: a legend with values and shares');
  const slices = await q(panel, `[...document.querySelectorAll(${JSON.stringify(`${P} .art-slice`)})].map(el => getComputedStyle(el).fill)`);
  check(new Set(slices).size === 5, 'pie: the five slices have five different colours');

  // Cards, one-pager
  const C = nth(6);
  check((await count(`${C} dl.art-cards .art-card`)) === 6 && (await text(`${C} .art-value`, 0)) === '1.24M', 'cards: six cards with their values');
  const O = nth(7);
  check((await count(`${O} .art-section`)) === 3 && (await count(`${O} h4`)) === 3 && (await count(`${O} li`)) === 4, 'one-pager: three sections, headings and bullets');
  check((await count(`${O} .art-btn`)) === 2 && /\.md/.test(await text(`${O} .art-btn`, 1)), 'one-pager: toolbar has Copy and .md');

  // ---- untrusted text stays text ----
  const H = nth(8);
  check((await text(`${H} .art-title`)).startsWith('<img src=x onerror='), 'hostile: a title that looks like HTML is shown as text');
  check((await count(`${H} img, ${H} script, ${H} a, ${H} iframe, ${H} b`)) === 0, 'hostile: no element was created from page-looking text');
  check((await q(panel, 'document.title')) === 'Agent', 'hostile: nothing ran');
  const interactive = await q(panel, `[...document.querySelectorAll('.art a, .art img, .art iframe, .art object, .art embed, .art foreignObject, .art [href], .art [src], .art [onclick], .art input, .art textarea')].length`);
  check(interactive === 0, 'no links, images, frames or inputs anywhere in any artifact');
  const focusables = await q(panel, `[...document.querySelectorAll('.art button, .art summary, .art [tabindex]')].every(el => el.matches('.art-btn, summary, .art-scroll'))`);
  check(focusables === true, 'the only focusable things are the toolbar buttons, “Show data” and scroll boxes');

  // ---- layout at 320, 360, 720 in light and dark; screenshots ----
  for (const scheme of ['light', 'dark']) {
    for (const width of [320, 360, 720]) {
      await view(panel, width, scheme);
      const overflow = await q(panel, `({ page: document.documentElement.scrollWidth - innerWidth, list: document.getElementById('transcript').scrollWidth - document.getElementById('transcript').clientWidth })`);
      check(overflow.page <= 0 && overflow.list <= 0, `${scheme} ${width}px: nothing makes the page scroll sideways`);
      const wide = await q(panel, `[...document.querySelectorAll('.art')].filter(el => el.scrollWidth > el.clientWidth + 1).length`);
      check(wide === 0, `${scheme} ${width}px: no artifact is wider than its card`);
      const svgFits = await q(panel, `[...document.querySelectorAll('.art-svg')].every(s => s.getBoundingClientRect().width <= s.parentElement.clientWidth + 1)`);
      check(svgFits, `${scheme} ${width}px: every chart fits its box`);
      const names = { table: 1, bar: 2, barMany: 3, line: 4, pie: 5, cards: 6, onepager: 7, hostile: 8 };
      for (const [name, n] of Object.entries(names)) await shotOf(panel, nth(n), `${name}-${width}-${scheme}`);
    }
  }
  await view(panel, 360);
  check((await q(panel, `document.querySelector(${JSON.stringify(`${T} .art-scroll`)}).hasAttribute('data-more')`)) === true, 'a table wider than the panel scrolls sideways and says so (edge fade at 360 px)');
  await view(panel, 720);
  const box720 = await q(panel, `(() => { const b = document.querySelector(${JSON.stringify(`${T} .art-scroll`)}); return { more: b.hasAttribute('data-more'), sw: b.scrollWidth, cw: b.clientWidth }; })()`);
  check(box720.more === false, `and at 720 px it fits, with no fade (${box720.sw} in ${box720.cw})`);
  // The charts follow the panel width.
  await view(panel, 720);
  const wide720 = await q(panel, `document.querySelector(${JSON.stringify(`${B} svg.art-svg`)}).getBoundingClientRect().width`);
  await view(panel, 320);
  const narrow320 = await q(panel, `document.querySelector(${JSON.stringify(`${B} svg.art-svg`)}).getBoundingClientRect().width`);
  check(wide720 > 600 && narrow320 < 300 && narrow320 > 200, `a chart is redrawn to the panel width (${Math.round(wide720)}px at 720, ${Math.round(narrow320)}px at 320)`);

  // ---- replace in place ----
  await view(panel, 400);
  const before = await count('#transcript > li');
  const edited = { ...FIXTURES.bar, title: 'Revenue by quarter (as a line)', type: 'line' };
  await emit(panel, snapshot(baseEntries(ALL).map((e) => (e.id === 'a2' ? entry('a2', edited) : e))));
  check((await count('#transcript > li')) === before, 'a replaced artifact does not add a row');
  check((await text(`${B} .art-title`)) === 'Revenue by quarter (as a line)' && (await count(`${B} polyline.art-line`)) === 1 && (await count(`${B} rect.art-bar`)) === 0, 'the artifact at the same place is now the new one (a line chart)');
  check((await text(`${T} .art-title`)) === 'Laptop comparison', 'the others are untouched');

  // ---- reduced motion ----
  await emit(panel, snapshot(baseEntries(['cards'])));
  await view(panel, 400, 'light', true);
  await emit(panel, snapshot(baseEntries(['cards', 'table'])));
  check((await q(panel, `getComputedStyle(document.querySelector('.art-row')).animationName`)) === 'none', 'reduced motion: no entrance animation');
  await view(panel, 400, 'light', false);
  check((await q(panel, `getComputedStyle(document.querySelector('.art-row')).animationName`)) === 'art-in', 'motion allowed: the quiet entrance is on');

  // ---- keyboard ----
  await emit(panel, snapshot(baseEntries(['table', 'bar', 'onepager'])));
  await q(panel, `document.querySelector('#transcript > li:nth-child(2) .art-btn').focus(), true`);
  check((await q(panel, `document.activeElement.classList.contains('art-btn')`)) === true, 'keyboard: a toolbar button takes focus');
  const focusRing = await q(panel, `getComputedStyle(document.activeElement).outlineStyle`);
  check(focusRing !== 'none', 'keyboard: the focused button shows a focus ring');
  await q(panel, `window.__tabs = []; true`);
  for (let i = 0; i < 4; i++) {
    await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await q(panel, `window.__tabs.push(document.activeElement.className || document.activeElement.tagName); true`);
  }
  check((await q(panel, `window.__tabs.length`)) === 4, 'keyboard: Tab moves on through the artifact');

  // ---- Copy and downloads, with real clicks ----
  await view(panel, 400);
  await emit(panel, snapshot(baseEntries(['table', 'bar', 'onepager', 'cards'])));
  const rowSel = (n) => `#transcript > li:nth-child(${n + 1}) .art`;
  // Copy the table with the keyboard (Enter on the focused button), so that path is tested too.
  pbcopy('before');
  await q(panel, `document.querySelector(${JSON.stringify(`${rowSel(1)} .art-btn`)}).scrollIntoView({ block: 'center' }), document.querySelector(${JSON.stringify(`${rowSel(1)} .art-btn`)}).focus(), true`);
  await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(async () => /Cop/i.test((await text(`${rowSel(1)} .art-status`)) ?? ''), 'the Copy status');
  const copiedStatus = await text(`${rowSel(1)} .art-status`);
  const clip = pbpaste();
  const expectMd = toMarkdown(FIXTURES.table);
  if (copiedStatus === 'Copied') check(clip === expectMd, 'Copy (Enter on the focused button) puts the table’s Markdown on the real clipboard');
  else check(false, `Copy reported: ${copiedStatus}`);
  check(clip.includes('\\=HYPERLINK') || clip.includes('=HYPERLINK'), 'the copied Markdown still carries the formula as text');
  // Copy the one-pager with a mouse click.
  pbcopy('before');
  await click(panel, `${rowSel(3)} .art-btn`);
  await until(async () => pbpaste() !== 'before', 'the one-pager copy', 8000).catch(() => undefined);
  check(pbpaste() === toMarkdown(FIXTURES.onepager), 'Copy (mouse click) puts the one-pager’s Markdown on the clipboard');
  check(/Copied/.test(await text(`${rowSel(3)} .art-status`)), 'and the card says “Copied”');

  // CSV download.
  await click(panel, `${rowSel(1)} .art-btn:nth-of-type(2)`);
  const csvPath = await until(async () => newest('.csv'), 'the CSV download', 15000).catch(() => undefined);
  check(!!csvPath, 'CSV: a file was saved by clicking the button');
  if (csvPath) {
    const csv = fs.readFileSync(csvPath, 'utf8');
    check(path.basename(csvPath) === 'laptop-comparison.csv', `CSV: file name is laptop-comparison.csv (${path.basename(csvPath)})`);
    check(csv === '﻿' + toCsv(FIXTURES.table), 'CSV: contents are the expected rows, with a BOM for spreadsheets');
    check(csv.includes("'=HYPERLINK("), 'CSV: the formula-looking cell is neutralised with a leading apostrophe');
  }
  // Cards CSV
  await click(panel, `${rowSel(4)} .art-btn:nth-of-type(2)`);
  const cardsCsv = await until(async () => newest('.csv') !== csvPath && newest('.csv'), 'the cards CSV', 15000).catch(() => undefined);
  check(!!cardsCsv && fs.readFileSync(cardsCsv, 'utf8').includes('Monthly users,1.24M'), 'CSV from cards has the values');
  // SVG and PNG of the bar chart.
  await click(panel, `${rowSel(2)} .art-btn:nth-of-type(2)`);
  const svgPath = await until(async () => newest('.svg'), 'the SVG download', 15000).catch(() => undefined);
  check(!!svgPath, 'SVG: a file was saved');
  if (svgPath) {
    const svg = fs.readFileSync(svgPath, 'utf8');
    check(svg.startsWith('<?xml') && svg.includes('<svg') && svg.includes('Revenue by quarter') && !/\sclass=/.test(svg), 'SVG: standalone (has the title, no CSS classes)');
    check(/fill="rgb\(/.test(svg), 'SVG: colours are written out, not left to CSS');
    check(!/<script|onerror|href=/i.test(svg), 'SVG: no scripts or links');
    check((svg.match(/<rect/g) ?? []).length >= 5, 'SVG: has the background and the four bars');
  }
  await click(panel, `${rowSel(2)} .art-btn:nth-of-type(3)`);
  const pngPath = await until(async () => newest('.png'), 'the PNG download', 15000).catch(() => undefined);
  check(!!pngPath, 'PNG: a file was saved');
  if (pngPath) {
    const png = fs.readFileSync(pngPath);
    const isPng = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    check(isPng && w === 1280 && h > 400, `PNG: a real PNG (${w}x${h}, drawn at 2x of 640 px wide)`);
    if (shots) fs.copyFileSync(pngPath, path.join(shots, 'saved-bar-chart.png'));
  }
  // Markdown of the one-pager.
  await click(panel, `${rowSel(3)} .art-btn:nth-of-type(2)`);
  const mdPath = await until(async () => newest('.md'), 'the Markdown download', 15000).catch(() => undefined);
  check(!!mdPath && fs.readFileSync(mdPath, 'utf8') === toMarkdown(FIXTURES.onepager), 'Markdown: the one-pager saved as .md matches');
  if (mdPath) check(/^vendor-brief-acme-cloud\.md$/.test(path.basename(mdPath)), 'Markdown: the file name comes from the title, safely');
  // The status line speaks too.
  check(/Saved/.test(await text(`${rowSel(3)} .art-status`)), 'a save is announced in the card’s status line');
} finally {
  browser.kill();
  try {
    pbcopy(savedClipboard);
  } catch {
    /* best effort */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
process.exit(failed.length ? 1 : 0);
