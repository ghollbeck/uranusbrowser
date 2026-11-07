// End-to-end test of the Algorithm Diet in a real UrAnus Browser with a throwaway profile, this
// worktree's shell (--anus-shell-dir) and native host. No network: pages for real hostnames are
// served by a local fixture server through --host-resolver-rules.
//   1. Live tracking: an article and a short video, each in front for a while, become measured
//      visits (time, title, the article's excerpt) with the right category.
//   2. The toolbar's Diet button sits next to the Agent button; hovering it shows today's summary
//      (grade, hour strip, the category breakdown); a click opens the Diet page.
//   3. Optional (--history <export.json>, from mobile/app/Tools/export-history.py): the import,
//      the cards, the classification run with Underdog Woof on this Mac (--model), the chat and
//      the pages list. The export is personal data: it only goes into the throwaway profile,
//      which is deleted at the end (keep --shots outside the repo).
//
//   node chromium/tests/e2e-diet.mjs [--app /Applications/UrAnus Browser.app] [--bundled] [--history file.json] [--model] [--shots dir]
// --bundled tests the app's own shell and host (a packaged build) instead of this worktree's.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = path.resolve(arg('--shell-dir', path.join(root, 'chromium/shell/dist')));
const hostScript = path.join(root, 'chromium/native-host/dist/anus-host.cjs');
const history = arg('--history') && path.resolve(arg('--history'));
const useModel = process.argv.includes('--model');
const bundled = process.argv.includes('--bundled');
const shots = arg('--shots') && path.resolve(arg('--shots'));
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `diet-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// ---- fixture pages for real hostnames ----

const PAGES = {
  'en.wikipedia.org': `<!doctype html><title>Linear algebra - Wikipedia</title><meta name="description" content="Linear algebra is the branch of mathematics concerning linear equations.">
    <body style="margin:0;font:16px sans-serif"><article style="padding:20px"><h1>Linear algebra</h1><p>Linear algebra is the branch of mathematics concerning linear equations and linear maps and their representations in vector spaces and through matrices.</p><form><input value="secret-form-value"></form></article><video id=v muted playsinline style="width:160px;height:90px"></video><canvas id=c width=16 height=16 hidden></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');let n=0;setInterval(()=>{x.fillStyle='hsl('+(n++*20%360)+',80%,50%)';x.fillRect(0,0,16,16)},100);const v=document.getElementById('v');v.srcObject=c.captureStream(10);v.play();</script></body>`,
  'www.tiktok.com': `<!doctype html><title>TikTok - Make Your Day</title><body style="margin:0"><div style="height:200px;background:#111"></div><video id=v muted playsinline style="width:160px;height:90px"></video><canvas id=c width=16 height=16 hidden></canvas><script>const c=document.getElementById('c'),x=c.getContext('2d');let n=0;setInterval(()=>{x.fillStyle='hsl('+(n++*20%360)+',80%,50%)';x.fillRect(0,0,16,16)},100);const v=document.getElementById('v');v.srcObject=c.captureStream(10);v.play();</script></body>`,
};
// HTTPS, since Wikipedia and TikTok are HSTS-preloaded: a throwaway self-signed certificate, trusted
// only by this test's browser (--ignore-certificate-errors on a throwaway profile).
const certDir = fs.mkdtempSync(path.join(here, '.scratch', 'diet-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=diet-e2e', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
const server = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, (req, res) => {
  const host = String(req.headers.host ?? '').split(':')[0];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGES[host] ?? '<!doctype html><title>Fixture</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/** A DevTools session whose evaluations give up after 60 s, saying which one, instead of hanging the test. */
const guarded = (session) => {
  const evaluate = session.eval;
  session.eval = (expression) =>
    Promise.race([evaluate(expression), new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluation timed out: ${String(expression).slice(0, 90)}`)), 60000))]);
  return session;
};

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/UrAnus Browser'),
    [
      `--user-data-dir=${profile}`,
      ...(bundled ? [] : [`--anus-shell-dir=${shellDir}`]),
      `--host-resolver-rules=MAP en.wikipedia.org 127.0.0.1:${port}, MAP www.tiktok.com 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-media-suspend',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      '--use-mock-keychain', '--disable-features=MacAppCodeSignClone',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1360,900',
      '--window-position=60,40',
    ],
    { stdio: 'ignore' },
  );
  reap(browser);
  const portFile = path.join(profile, 'DevToolsActivePort');
  const devtools = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${devtools}/json/version`)).json();
  const cdp = await Cdp.connect(webSocketDebuggerUrl);
  const frame = guarded(await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId));
  // This profile's native host = the worktree's built host (it has dietComplete), unless --bundled.
  if (!bundled) {
  const hosts = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(hosts, { recursive: true });
  const launcher = path.join(profile, 'anus-host');
  fs.writeFileSync(launcher, `#!/bin/sh\nexport ANUS_AI_DIR="${path.join(profile, 'ai')}"\nexec "${process.execPath}" "${hostScript}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(hosts, 'dev.oprimo.anus.host.json'),
    JSON.stringify({ name: 'dev.oprimo.anus.host', description: 'diet e2e', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${SHELL_ID}/`] }),
  );
  }
  const hub = (name, ...args) =>
    frame.eval(`new Promise((resolve, reject) => {
      const p = chrome.runtime.connect({ name: 'anus' });
      p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ? { error: m.error } : m.value ?? true); } });
      p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
      setTimeout(() => reject(new Error('no reply from ${name}')), 120000);
    })`);
  return { browser, cdp, frame, hub };
}

/**
 * Tries to bring the test browser to the front. If another app stays in front (you're working),
 * the tracker still counts the fixture pages, because their video is playing.
 */
function focusWindow() {
  try {
    execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${state.browser.pid}).activateWithOptions(3)`], { stdio: 'ignore', timeout: 5000 });
  } catch {
    // not allowed to activate: fine, see above
  }
}

/** The live visits in the profile's Diet store, read from the sidebar page (same origin). */
const liveVisits = (frame) =>
  frame.eval(`new Promise((resolve) => {
    const req = indexedDB.open('anus-diet');
    req.onupgradeneeded = () => req.transaction.abort(); // not there yet: never create it from the test
    req.onsuccess = () => {
      if (!req.result.objectStoreNames.contains('visits')) return (req.result.close(), resolve([]));
      const all = req.result.transaction('visits').objectStore('visits').getAll();
      all.onsuccess = () => (req.result.close(), resolve(all.result.filter((v) => v.source === 'live').map((v) => ({ host: v.host, title: v.title, seconds: v.seconds, excerpt: v.excerpt ?? '' }))));
    };
    req.onerror = () => resolve([]);
  })`);

/** What the tracker sees, from the shell's service worker, for a failure message. */
async function trackerView(cdp) {
  const sw = await cdp.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${SHELL_ID}/background.js`), 5000).catch(() => undefined);
  if (!sw) return 'no service worker target';
  const s = await cdp.session(sw.targetId);
  return s.eval(`Promise.all([chrome.windows.getLastFocused({ windowTypes: ['normal'] }), chrome.idle.queryState(120), chrome.tabs.query({ active: true, lastFocusedWindow: true })]).then(([w, idle, tabs]) => JSON.stringify({ focused: w.focused, state: w.state, idle, tab: tabs[0]?.url }))`).catch((e) => String(e));
}

async function shot(session, name) {
  if (!shots) return;
  await wait(500);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

async function mouse(session, selector, type = 'click') {
  const at = await session.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!at) throw new Error(`nothing matches ${selector}`);
  if (type === 'hover') return session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  for (const t of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await session.send('Input.dispatchMouseEvent', { type: t, x: at.x, y: at.y, button: 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: 1 });
}

let state;
try {
  state = await launch();
  const { cdp, frame, hub } = state;
  await until(() => frame.eval(`document.readyState === 'complete' && !!document.getElementById('btn-diet')`), 'the sidebar');

  // A new profile starts with the tour over the window: skip it, as a person would.
  await frame.eval(`document.querySelector('.tour-skip')?.click(), true`);
  await wait(800);

  // ---- the button ----
  const placement = await frame.eval(`(() => {
    const b = document.getElementById('btn-diet'), a = document.getElementById('btn-agent');
    return { visible: !!b && !b.hidden && b.getBoundingClientRect().width > 0, afterAgent: a?.nextElementSibling === b, icon: !!b?.querySelector('svg path') };
  })()`);
  check(placement.visible && placement.icon, 'the Diet button is in the sidebar toolbar with its icon');
  check(placement.afterAgent, 'it sits right after the Agent (chat) button');

  // ---- live tracking ----
  const idle = await frame.eval(`chrome.idle.queryState(120)`);
  if (idle !== 'active') console.log(`  note: the Mac reports "${idle}"; live tracking waits for input or a playing video`);
  await frame.eval(`chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => chrome.tabs.update(t.id, { url: 'https://en.wikipedia.org/wiki/Linear_algebra' })).then(() => true)`);
  focusWindow();
  await until(async () => ((await liveVisits(frame)).some((v) => v.host === 'en.wikipedia.org' && v.seconds >= 10)), 'a measured Wikipedia visit', 60000).catch(async (err) => {
    console.log('  tracker sees:', await trackerView(cdp), JSON.stringify(await liveVisits(frame)));
    throw err;
  });
  const wiki = (await liveVisits(frame)).find((v) => v.host === 'en.wikipedia.org');
  check(wiki?.title === 'Linear algebra - Wikipedia', 'the visit has the page title');
  check(/branch of mathematics/.test(wiki?.excerpt ?? '') && !/secret-form-value/.test(wiki?.excerpt ?? ''), 'the excerpt is the article text, without form values');
  check(wiki.seconds >= 10 && wiki.seconds < 60, `time is measured from samples (${Math.round(wiki.seconds)} s)`);

  await frame.eval(`chrome.tabs.create({ url: 'https://www.tiktok.com/@x/video/1', active: true }).then(() => true)`);
  focusWindow();
  await until(async () => ((await liveVisits(frame)).some((v) => v.host === 'tiktok.com' && v.seconds >= 5)), 'a measured TikTok visit', 60000).catch(async (err) => {
    console.log('  tracker sees:', await trackerView(cdp), JSON.stringify((await liveVisits(frame)).map((v) => [v.host, Math.round(v.seconds)])));
    throw err;
  });
  check(true, 'switching tabs starts a new visit');

  // ---- the hover summary ----
  // CDP's synthetic mouse doesn't reach the window frame's page (the toolbar is clicked through the DOM in e2e-layout too).
  await frame.eval(`document.getElementById('btn-diet').dispatchEvent(new MouseEvent('mouseenter')), true`);
  await until(() => frame.eval(`document.getElementById('diet-pop')?.classList.contains('shown')`), 'the summary on hover', 10000).catch(async (err) => {
    console.log('  hover state:', await frame.eval(`JSON.stringify({ pop: !!document.getElementById('diet-pop'), hovered: document.getElementById('btn-diet').matches(':hover'), rect: document.getElementById('btn-diet').getBoundingClientRect(), vis: document.visibilityState, w: innerWidth })`));
    throw err;
  });
  const pop = await frame.eval(`(() => {
    const p = document.getElementById('diet-pop'), r = p.getBoundingClientRect();
    return { text: p.innerText, rows: p.querySelectorAll('.dp-row').length, hours: p.querySelectorAll('.dp-hours span').length, chip: !!p.querySelector('.grade-chip'), inside: r.left >= 0 && r.right <= innerWidth + 1 };
  })()`);
  check(pop.chip && /Today · /.test(pop.text), 'the summary shows today’s grade and time');
  check(/Learning/.test(pop.text) && /Short-form video/.test(pop.text) && pop.rows >= 2, 'its breakdown lists the categories (Learning, Short-form video)');
  check(pop.hours >= 1 && pop.inside, 'it has the hour strip and fits in the sidebar');
  await shot(frame, 'diet-hover');
  await frame.eval(`document.getElementById('btn-diet').dispatchEvent(new MouseEvent('mouseleave')), true`);
  await until(() => frame.eval(`!document.getElementById('diet-pop').classList.contains('shown')`), 'the summary hides', 5000);
  check(true, 'it hides when the pointer leaves');

  // ---- the page ----
  await frame.eval(`document.getElementById('btn-diet').click(), true`);
  const target = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/diet.html`), 20000);
  const page = guarded(await cdp.session(target.targetId));
  await until(() => page.eval(`!!document.querySelector('.topbar') && !document.querySelector('.loading')`), 'the Diet page', 20000);
  const cards = await page.eval(`[...document.querySelectorAll('.card-head h2, .facts-title, .verdict')].map((e) => e.textContent)`);
  check(cards.includes('Nutrition Facts') && cards.includes('On your plate') && cards.includes('Your consumption'), `the page shows the iOS cards (${cards.length})`);
  await page.eval(`[...document.querySelectorAll('.segmented button')].find((b) => b.textContent === 'Today')?.click(), true`);
  await wait(800);
  const measured = await page.eval(`document.querySelector('.kv .num')?.textContent`);
  check(!!measured && measured !== '0s', `measured browsing today: ${measured}`);
  await shot(page, 'diet-page-live');

  if (history) {
    const { root: doc } = await page.send('DOM.getDocument', {});
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#diet-import' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [history] });
    const toast = await until(() => page.eval(`document.querySelector('.toast')?.textContent`), 'the import toast', 120000);
    const expected = JSON.parse(fs.readFileSync(history, 'utf8')).visits.length;
    check(/^Imported [\d,]+ visits/.test(toast), toast);
    await until(() => page.eval(`!document.querySelector('.loading')`), 'the page after import', 60000);
    await page.eval(`[...document.querySelectorAll('.segmented button')].find((b) => b.textContent === 'All')?.click(), true`);
    await wait(1200);
    const all = await page.eval(`({ verdict: document.querySelector('.verdict')?.textContent, score: document.querySelector('.plate-score')?.textContent, pages: document.querySelector('.score-text .muted')?.textContent, sites: document.querySelectorAll('.site-row').length, days: document.querySelectorAll('.day').length, topics: document.querySelectorAll('.chip').length, swaps: document.querySelectorAll('.card:has(.card-head h2) .cat-row').length })`);
    console.log('  all-time:', JSON.stringify(all), `(export: ${expected} rows)`);
    check(!!all.verdict && Number(all.score) > 0, `all-time score: ${all.verdict}, health ${all.score}`);
    check(all.sites === 8 && all.days === 14 && all.topics > 0, 'sites, 14 days and ingredients are filled');
    await shot(page, 'diet-page-all');

    // The classification run: rules, then (with --model) Woof on this Mac for unknown sites and videos.
    const model = await hub('diet:model');
    console.log('  model:', JSON.stringify(model));
    if (useModel) check(model?.ready === true, `Underdog Woof is available (${model?.label})`);
    const started = Date.now();
    await page.eval(`(document.querySelector('.card .btn.primary') ?? null)?.click() ?? [...document.querySelectorAll('.menu-item')].find((b) => /Classify Again/.test(b.textContent))?.click(), true`);
    await until(() => page.eval(`!!document.querySelector('.run-card')`), 'the run card', 10000);
    await wait(1500);
    await shot(page, 'diet-run');
    const sawModelPhase = { yes: false };
    await until(
      async () => {
        const phase = await page.eval(`document.querySelector('.run-phase')?.textContent ?? 'gone'`);
        if (/Woof/.test(phase)) sawModelPhase.yes = true;
        if (sawModelPhase.yes && !sawModelPhase.shot) {
          sawModelPhase.shot = true;
          await shot(page, 'diet-run-woof');
        }
        return phase === 'gone' || phase === 'Done';
      },
      'the classification run',
      20 * 60000,
    );
    await until(() => page.eval(`!document.querySelector('.run-card')`), 'the run card closes', 30000);
    console.log(`  run took ${Math.round((Date.now() - started) / 1000)} s`);
    if (useModel && model?.ready) {
      const hints = await frame.eval(`new Promise((resolve) => { const req = indexedDB.open('anus-diet'); req.onsuccess = () => { const tx = req.result.transaction(['hostHints', 'titleHints']); const a = tx.objectStore('hostHints').count(), b = tx.objectStore('titleHints').count(); tx.oncomplete = () => { req.result.close(); resolve({ hosts: a.result, titles: b.result }); }; }; })`);
      check(sawModelPhase.yes, 'the run asked Woof (its phases showed)');
      check(hints.hosts > 0, `Woof sorted ${hints.hosts} unknown sites and ${hints.titles} video titles (saved as hints)`);
    }
    const after = await page.eval(`({ verdict: document.querySelector('.verdict')?.textContent, score: document.querySelector('.plate-score')?.textContent, hero: !!document.querySelector('.hero-row') })`);
    check(!after.hero, `after the run: ${after.verdict}, health ${after.score}; the classify card is gone`);
    await shot(page, 'diet-page-classified');

    // The chat with your history.
    await page.eval(`document.querySelector('[aria-label="Chat with history"]').click(), true`);
    await until(() => page.eval(`!!document.querySelector('.suggestion')`), 'the chat', 10000);
    await page.eval(`document.querySelector('.suggestion').click(), true`);
    const answer = await until(
      () => page.eval(`(() => { const b = [...document.querySelectorAll('.bubble.assistant')].pop(); return b && !b.querySelector('.dots') ? b.innerText : false; })()`),
      'the chat answer',
      300000,
    );
    console.log(`  answer: ${answer.slice(0, 400).replace(/\n/g, ' / ')}`);
    check(answer.length > 40, 'the chat answered');
    if (useModel && model?.ready) check(!/Quick answer from your numbers/.test(answer), 'the answer came from Woof, not the numbers fallback');
    const sources = await page.eval(`document.querySelectorAll('.bubble.assistant .source').length`);
    check(sources > 0, `it cites ${sources} recorded pages`);
    await shot(page, 'diet-chat');
    await page.eval(`[...document.querySelectorAll('.sheet-head .btn')].find((b) => b.textContent === 'Done').click(), true`);

    // Every recorded page.
    await page.eval(`[...document.querySelectorAll('.btn')].find((b) => /Explore pages/.test(b.textContent)).click(), true`);
    await until(() => page.eval(`document.querySelectorAll('.visit').length > 0`), 'the pages list', 10000);
    await page.eval(`(() => { const s = document.querySelector('.search'); s.value = 'arxiv'; s.dispatchEvent(new Event('input')); })(), true`);
    await wait(600);
    const found = await page.eval(`({ n: document.querySelectorAll('.visit').length, summary: document.querySelector('.history .muted.small')?.textContent })`);
    check(found.n > 0, `search in pages & videos works (${found.summary})`);
    await page.eval(`document.querySelector('.visit').click(), true`);
    const detail = await page.eval(`document.querySelector('.detail')?.innerText ?? ''`);
    check(/Why this score\?/i.test(detail) && /Evidence/.test(detail), 'a visit shows why it got its score');
    await shot(page, 'diet-history');
  }
} catch (err) {
  check(false, `failed: ${err instanceof Error ? err.message : err}`);
} finally {
  state?.browser.kill();
  server.close();
  await wait(1500);
  // The profile may hold an imported history: never leave it behind.
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(certDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
