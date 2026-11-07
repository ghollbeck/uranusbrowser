// End-to-end test of the theme switch on web pages, in a real UrAnus Browser: clicking the sidebar's
// light/dark button fades the page on the same one-second curve as UrAnus Browser's own pages.
//   1. A page that recolours itself with prefers-color-scheme: a View Transition runs on it.
//   2. A page the server themes (it reads the Sec-CH-Prefers-Color-Scheme hint, as Google does):
//      the tab loads the new page, and that arrival is a cross-document View Transition. The
//      tab's scroll position is kept, the hint it sends is the new scheme, and no fade rule is
//      left in the page afterwards.
//   3. The same page at an address with a #fragment (going there again would only scroll): it
//      still fades, and the fragment is still in the address.
//   4. A page that runs its own navigations (the Navigation API's intercept): it keeps its
//      document, so the tab plainly reloads; it still switches.
//   5. A Space with separate cookies, on an origin UrAnus Browser hasn't seen before: its page
//      request comes without a tab, so the tab is found by its origin; it still switches.
//   6. A new tab opened while UrAnus Browser is dark (macOS light) is served dark: Chromium alone
//      would tell its first request macOS's scheme.
// Local pages only (no network). Takes a minute: it starts a throwaway UrAnus Browser on a fresh profile.
//
//   node chromium/tests/e2e-themefade.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = arg('--shell-dir');
const binary = arg('--binary', 'UrAnus Browser');
const port = arg('--port-name', 'anus');
const profile = path.join(here, '.scratch', `themefade-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// ---- the two pages ------------------------------------------------------------------------

const hints = [];
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url.startsWith('/server')) {
    const hint = req.headers['sec-ch-prefers-color-scheme'];
    hints.push({ path: `${req.headers.host}${req.url}`, hint });
    // Like Google: asks for the hint, and builds a different page for each scheme.
    res.setHeader('Accept-CH', 'Sec-CH-Prefers-Color-Scheme');
    res.setHeader('Critical-CH', 'Sec-CH-Prefers-Color-Scheme');
    res.setHeader('Vary', 'Sec-CH-Prefers-Color-Scheme');
    res.setHeader('Cache-Control', 'private, max-age=0');
    const dark = hint === 'dark';
    // ?intercept: the page turns every navigation into one of its own, as single-page apps do.
    const intercept = req.url.includes('intercept')
      ? `<script>navigation.addEventListener('navigate', (e) => { if (e.canIntercept && !e.hashChange) e.intercept({ handler: async () => {} }); });</script>`
      : '';
    return res.end(`<!doctype html><body style="margin:0;height:3000px;font:36px system-ui;background:${dark ? '#202124' : '#fff'};color:${dark ? '#eee' : '#111'}">served for hint=${hint}${intercept}</body>`);
  }
  res.end(`<!doctype html><meta name=color-scheme content="light dark"><style>
    body{margin:0;height:100vh;background:#fff;color:#111;font:36px system-ui}
    @media (prefers-color-scheme: dark){body{background:#101820;color:#eee}}</style><body>css page</body>`);
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;
// The same server under another origin, for a page UrAnus Browser has never seen.
const otherOrigin = `http://127.0.0.1:${server.address().port}`;

// ---- launch ---------------------------------------------------------------------------------

fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', '--window-position=60,40'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
const browser = reap(spawn(path.join(app, 'Contents/MacOS', binary), flags, { stdio: 'ignore' }));
const portFile = path.join(profile, 'DevToolsActivePort');
const devtools = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${devtools}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);
const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: ${JSON.stringify(port)} });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? true); } });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);
await wait(1500);
await hub('finishOnboarding');

/** Opens `url` in a tab and records, in every document it shows, what the View Transitions do. */
async function openRecorded(url, { record = true } = {}) {
  await hub('newTab', url);
  await frame.eval(`chrome.windows.getAll().then((ws) => ws[0] && chrome.windows.update(ws[0].id, { focused: true }))`);
  const target = await cdp.waitTarget((t) => t.type === 'page' && t.url.startsWith(url));
  const page = await cdp.session(target.targetId);
  if (!record) {
    await until(() => page.eval(`document.readyState === 'complete'`), 'the page to load', 30000);
    await wait(2500);
    return page;
  }
  await page.send('Page.enable');
  // Kept in sessionStorage, which outlives each document: [time in document, what, ...].
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const log = (...a) => { const l = JSON.parse(sessionStorage.__vt || '[]'); l.push([Math.round(performance.now()), ...a]); sessionStorage.__vt = JSON.stringify(l); };
      addEventListener('pagereveal', (e) => {
        log('pagereveal', !!e.viewTransition, document.adoptedStyleSheets.length);
        if (e.viewTransition) e.viewTransition.finished.then(() => log('finished'), () => log('skipped'));
      });
      let last = -1;
      const poll = () => {
        const n = document.getAnimations().filter((a) => String((a.effect && a.effect.pseudoElement) || '').includes('view-transition')).length;
        if (n !== last) { last = n; log('animations', n); }
        setTimeout(poll, 16);
      };
      poll();
    })()`,
  });
  await page.eval('location.reload(), true').catch(() => undefined);
  await until(() => page.eval(`document.readyState === 'complete'`), 'the page to load', 30000);
  await wait(2500); // the client hint is noted, the tab is on screen
  return page;
}
const logOf = async (page) => JSON.parse((await page.eval(`sessionStorage.__vt || '[]'`)) || '[]');
const clickTheme = () => frame.eval(`document.getElementById('btn-theme').click(), true`);
const bg = (page) => page.eval(`getComputedStyle(document.body).backgroundColor`);

// ---- 1. a page that recolours itself --------------------------------------------------------

{
  const page = await openRecorded(`${base}/css`);
  check((await bg(page)) === 'rgb(255, 255, 255)', 'the CSS page starts light');
  await page.eval(`sessionStorage.__vt = '[]', true`);
  await clickTheme();
  await wait(2500);
  check((await bg(page)) === 'rgb(16, 24, 32)', 'it is dark after the switch');
  const log = await logOf(page);
  const ran = log.filter((e) => e[1] === 'animations' && e[2] > 0);
  const over = log.filter((e) => e[1] === 'animations' && e[2] === 0).pop();
  check(ran.length > 0, 'a View Transition ran on it (a crossfade, not a cut)');
  check(!!ran.length && !!over && over[0] - ran[0][0] > 800 && over[0] - ran[0][0] < 1500, `the transition lasts about a second (${ran.length && over ? over[0] - ran[0][0] : '?'} ms)`);
  await clickTheme();
  await wait(2500);
  check((await bg(page)) === 'rgb(255, 255, 255)', 'and back to light');
}

// ---- 2-5. pages the server themes ------------------------------------------------------------

const switchLog = () => frame.eval(`chrome.storage.local.get('themeSwitchLog').then((v) => v.themeSwitchLog || [])`);

/** Switches the theme `rounds` times on a server-themed page; `fade` says whether each switch must cross-fade. */
async function serverPage(label, page, { rounds, fade, hash = '', how }) {
  await page.eval(`scrollTo(0, 600), true`);
  await wait(300);
  for (let round = 0; round < rounds; round++) {
    // The theme carries over from the last section: each click goes to the other one.
    const scheme = (await page.eval(`matchMedia('(prefers-color-scheme: dark)').matches`)) ? 'light' : 'dark';
    await page.eval(`sessionStorage.__vt = '[]', true`);
    const where = await page.eval(`location.host + location.pathname + location.search`);
    const mine = () => hints.filter((h) => h.path === where);
    const before = mine().length;
    await clickTheme();
    await until(async () => (await page.eval(`document.body.innerText`).catch(() => '')).includes(`hint=${scheme}`), `the ${scheme} page`, 15000).catch(() => undefined);
    await wait(2200);
    const what = `${label}, ${scheme}`;
    const asked = mine().slice(before);
    check(asked.length === 1 && asked[0].hint === scheme, `${what}: the tab asked the server once, with the hint ${scheme} (${asked.map((h) => h.hint).join(', ') || 'not at all'}; all its requests: ${mine().map((h) => h.hint).join(', ')})`);
    check((await page.eval(`document.body.innerText`)).includes(`hint=${scheme}`), `${what}: the new page is shown`);
    if (fade) {
      const log = await logOf(page);
      const reveal = log.find((e) => e[1] === 'pagereveal');
      check(!!reveal && reveal[2] === true, `${what}: the new page arrived with a cross-document View Transition`);
      const started = log.find((e) => e[1] === 'animations' && e[2] > 0);
      const finished = log.find((e) => e[1] === 'finished');
      check(!!started && !!finished && finished[0] - started[0] > 800 && finished[0] - started[0] < 1500, `${what}: it lasts about a second (${started && finished ? finished[0] - started[0] : '?'} ms)`);
      const y = await page.eval(`scrollY`);
      check(Math.abs(y - 600) <= 2, `${what}: the tab is still scrolled to 600 (${y})`);
    }
    if (hash) check((await page.eval(`location.hash`)) === hash, `${what}: the address still ends in ${hash}`);
    check((await page.eval(`document.adoptedStyleSheets.length`)) === 0, `${what}: no fade rule is left in the page`);
    if (how) {
      const last = (await switchLog()).pop();
      const entry = last?.tabs?.find((t) => how.test(t.how || ''));
      check(!!entry, `${what}: the switch log matches ${how} (${JSON.stringify(last?.tabs)})`);
    }
  }
}

{
  const page = await openRecorded(`${base}/server`);
  check((await page.eval(`document.body.innerText`)).includes('hint=light'), 'the server page starts light');
  await serverPage('server page', page, { rounds: 3, fade: true, how: /^fade$/ });
  const ours = () => frame.eval(`chrome.scripting.getRegisteredContentScripts().then((s) => s.filter((x) => x.id.startsWith('anus-view-transition-')).length)`);
  const scripts = await ours();
  await wait(6500);
  const left = await ours();
  check(left === 0, `the one-shot content script is gone (${scripts} right after, ${left} later)`);
}
{
  const page = await openRecorded(`${base}/server?frag=1#frag`);
  await serverPage('#fragment', page, { rounds: 2, fade: true, hash: '#frag', how: /^fade$/ });
}
{
  const page = await openRecorded(`${base}/server?intercept=1`);
  await serverPage('intercepting page', page, { rounds: 2, fade: false, how: /^kept, reloaded$/ });
}
{
  // Separate cookies for the Space on screen; its tabs reopen in the Space's own partition.
  const state = await frame.eval(`chrome.storage.local.get('state').then((v) => JSON.parse(v.state))`);
  await hub('setSpaceIsolated', state.activeSpaceId ?? state.spaces[0].id, true);
  await wait(2000);
  // Not reloaded for a recorder: this first load is the one that comes without a tab.
  const page = await openRecorded(`${otherOrigin}/server?isolated=1`, { record: false });
  const partition = await frame.eval(`chrome.tabs.query({ active: true, url: ${JSON.stringify(`${otherOrigin}/*`)} }).then(([t]) => t && chrome.${port}Private.getTabPartition(t.id))`);
  check(!!partition, `the tab is in its Space's own partition (${partition})`);
  await serverPage('separate cookies', page, { rounds: 2, fade: false, how: /^(fade|kept, reloaded|reload)/ });
  const found = (await switchLog()).some((e) => e.tabs.some((t) => t.origin === otherOrigin && /by origin/.test(t.how)));
  check(found, 'separate cookies: the first switch found the tab by its origin');
}

// ---- 6. a new tab in the scheme that isn't macOS's -------------------------------------------

{
  let macDark = false;
  try {
    macDark = execFileSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().includes('Dark');
  } catch {
    // not set: macOS is light
  }
  const want = macDark ? 'light' : 'dark';
  if ((await frame.eval(`matchMedia('(prefers-color-scheme: dark)').matches`)) !== (want === 'dark')) {
    await clickTheme();
    await wait(2500);
  }
  const page = await openRecorded(`${base}/server?newtab=1`, { record: false });
  const text = await page.eval(`document.body.innerText`);
  check(text.includes(`hint=${want}`), `a new tab opened while UrAnus Browser is ${want} (macOS ${macDark ? 'dark' : 'light'}) is served ${want} (${text})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
server.close();
await wait(2000); // the browser is still writing its profile as it quits
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch {
  // left under tests/.scratch
}
process.exit(failed.length ? 1 : 0);
