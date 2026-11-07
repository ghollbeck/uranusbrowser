// End-to-end test of two windows, in a real UrAnus Browser (no AI involved):
//   - each window shows its own tab: opening or picking one in window 2 leaves window 1 alone;
//   - picking in window 2 the tab window 1 shows moves it over, and window 1's page says so
//     (with "Show Here"), its sidebar marking the tab; focusing window 1 doesn't take it back;
//   - that page is the tab as it left, frozen and faded, not the empty new tab page;
//   - "Show Here" takes it back (its picture is deleted), and then window 2 is the one told;
//   - closing window 2 keeps its tabs in the sidebar.
//
//   node chromium/tests/e2e-windows.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = arg('--shell-dir');
const shots = arg('--shots');
const profile = path.join(here, '.scratch', `windows-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

const fixture = await startFixtureServer(0);
fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1200,800', '--window-position=60,40'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
const browser = spawn(path.join(app, 'Contents/MacOS/UrAnus Browser'), flags, { stdio: 'ignore' });
reap(browser);
process.on('exit', () => browser.kill());
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(err);
    process.exit(1);
  });
}

const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);
const isFrame = (t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`);
const firstFrame = await cdp.waitTarget(isFrame);
const frame1 = await cdp.session(firstFrame.targetId);
const win1 = await frame1.eval('chrome.anusPrivate.getWindowId()');

/** A command from a page of window `windowId`, as its sidebar sends it (it says its window first). */
const hubIn = (frame, windowId, name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
    p.postMessage({ type: 'window', id: ${windowId} });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);
/** The address Chromium shows in each window. */
const shown = async () =>
  Object.fromEntries((await frame1.eval(`chrome.tabs.query({ active: true }).then((t) => t.map((x) => [x.windowId, x.pendingUrl || x.url]))`)).map(([w, u]) => [w, u]));
const ids = (frame) => frame.eval(`[...document.querySelectorAll('#today [data-tab-id]')].map((el) => el.dataset.tabId)`);
const activeRow = (frame) => frame.eval(`document.querySelector('#today .row.active')?.dataset.tabId`);
const marked = (frame) => frame.eval(`[...document.querySelectorAll('#today [data-tab-id]')].filter((el) => el.querySelector('.window-mark')).map((el) => el.dataset.tabId)`);
/** The UrAnus Browser tab whose page has this address. */
const tabAt = (part) =>
  frame1.eval(`Promise.all([chrome.storage.session.get(null), chrome.tabs.query({})]).then(([s, tabs]) => {
    const live = Object.entries(s).find(([k]) => k.endsWith('live'))?.[1] ?? {};
    const chromeId = tabs.find((t) => (t.pendingUrl || t.url).includes(${JSON.stringify(part)}))?.id;
    return Object.entries(live).find(([, c]) => c === chromeId)?.[0];
  })`);
const isNewTabPage = (u = '') => u.startsWith('chrome://newtab') || u.startsWith(`chrome-extension://${SHELL_ID}/newtab.html`);

await hubIn(frame1, win1, 'finishOnboarding');
await wait(800);
await hubIn(frame1, win1, 'newTab', `${fixture.url}?tab=a1`);
await hubIn(frame1, win1, 'newTab', `${fixture.url}?tab=a2`);
await until(async () => (await ids(frame1)).length >= 2, 'two tabs in window 1');
await until(async () => (await shown())[win1]?.includes('tab=a2'), 'window 1 shows a2');
const a1 = await until(() => tabAt('tab=a1'), 'a1');
const a2 = await until(() => tabAt('tab=a2'), 'a2');

// ---- a second window ---------------------------------------------------------------
const win2 = await frame1.eval('chrome.windows.create({ focused: true, left: 700, top: 80, width: 1000, height: 760 }).then((w) => w.id)');
const frame2 = await cdp.session((await cdp.waitTarget((t) => isFrame(t) && t.targetId !== firstFrame.targetId)).targetId);
await until(async () => (await frame2.eval('chrome.anusPrivate.getWindowId()')) === win2, 'window 2 frame');
await wait(1200);

await hubIn(frame2, win2, 'newTab', `${fixture.url}?tab=b1`);
await until(async () => (await shown())[win2]?.includes('tab=b1'), 'window 2 shows b1', 15000).catch(() => false);
let now = await shown();
check(now[win2]?.includes('tab=b1'), `window 2 shows its new tab (${now[win2]})`);
check(now[win1]?.includes('tab=a2'), `window 1 still shows its own tab (${now[win1]})`);
const b1 = await until(() => tabAt('tab=b1'), 'b1');
const highlighted = async () => [await activeRow(frame1), await activeRow(frame2)];
await until(async () => (await highlighted()).join() === [a2, b1].join(), 'own highlights', 5000).catch(() => false);
const rows = await highlighted();
check(rows.join() === [a2, b1].join(), `each sidebar highlights its own window's tab (${rows.map((id) => ({ [a1]: 'a1', [a2]: 'a2', [b1]: 'b1' })[id] ?? id)})`);

// Picking, in window 2, a tab window 1 doesn't show: it just moves over.
await hubIn(frame2, win2, 'activate', a1);
await until(async () => (await shown())[win2]?.includes('tab=a1'), 'window 2 shows a1', 15000).catch(() => false);
now = await shown();
check(now[win2]?.includes('tab=a1') && now[win1]?.includes('tab=a2'), `a tab window 1 had behind moves to window 2; window 1 unchanged (${now[win1]} | ${now[win2]})`);

// ---- picking the tab the other window has on screen ----------------------------------
await hubIn(frame2, win2, 'activate', a2);
await until(async () => (await shown())[win2]?.includes('tab=a2'), 'window 2 shows a2', 15000).catch(() => false);
now = await shown();
check(now[win2]?.includes('tab=a2'), `window 2 takes the tab window 1 showed (${now[win2]})`);
check(isNewTabPage(now[win1]), `window 1 shows its new tab page instead (${now[win1]})`);
const notice = async (windowId) => {
  const target = (await cdp.targets()).find((t) => t.type === 'page' && isNewTabPage(t.url) && t.attached !== undefined);
  for (const t of (await cdp.targets()).filter((t) => t.type === 'page' && isNewTabPage(t.url))) {
    const s = await cdp.session(t.targetId);
    const w = await s.eval('chrome.tabs.getCurrent().then((t) => t.windowId)');
    if (w === windowId)
      return {
        page: s,
        ...(await s.eval(`({
          hidden: document.getElementById('parked-view').hidden,
          title: document.getElementById('elsewhere-title').textContent,
          shot: (() => { const img = document.getElementById('parked-shot'); return !img.hidden && img.complete && img.naturalWidth > 0; })(),
          emptyState: !document.getElementById('empty-state').hidden,
        })`)),
      };
  }
  return target && undefined;
};
const told = await until(async () => {
  const n = await notice(win1);
  return n && !n.hidden && n;
}, 'notice in window 1', 15000).catch(() => undefined);
check(!!told, `window 1's page says the tab is open in another window ("${told?.title}")`);
const shown1 = await until(async () => (await notice(win1))?.shot, 'the frozen page', 5000).catch(() => false);
check(!!shown1, "window 1 shows the page as it left, frozen under the notice");
check(!(await notice(win1))?.emptyState, "window 1 doesn't show the empty new tab page");
check((await marked(frame1)).includes(a2), "window 1's sidebar marks the tab as open in another window");
check((await activeRow(frame1)) === a2, "window 1's sidebar keeps the tab selected");
if (shots && told) {
  fs.mkdirSync(shots, { recursive: true });
  const save = async (session, name) => {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
  };
  await save(told.page, 'window1-newtab-notice.png');
  await save(frame1, 'window1-sidebar.png');
  await save(frame2, 'window2-sidebar.png');
}

// Focusing window 1 doesn't pull the tab back.
await frame1.eval(`chrome.windows.update(${win1}, { focused: true }).then(() => true)`);
await hubIn(frame1, win1, 'colorScheme', false);
await wait(1500);
now = await shown();
check(now[win2]?.includes('tab=a2') && isNewTabPage(now[win1]), `focusing window 1 leaves the tab in window 2 (${now[win1]} | ${now[win2]})`);

// "Show Here" takes it back; now window 2 is told.
if (told) {
  await told.page.eval(`document.getElementById('elsewhere-show').click()`);
  await until(async () => (await shown())[win1]?.includes('tab=a2'), 'window 1 shows a2 again', 15000).catch(() => false);
}
now = await shown();
check(now[win1]?.includes('tab=a2'), `"Show Here" brings the tab back to window 1 (${now[win1]})`);
check(isNewTabPage(now[win2]), `window 2 then shows its notice (${now[win2]})`);
const told2 = await until(async () => {
  const n = await notice(win2);
  return n && !n.hidden && n;
}, 'notice in window 2', 15000).catch(() => undefined);
check(!!told2, 'window 2 is told the tab is open in another window');
check(!!(await until(async () => (await notice(win2))?.shot, 'window 2 frozen page', 5000).catch(() => false)), 'window 2 shows the page frozen too');
check((await hubIn(frame1, win1, 'parkedShot', win1)) === true, "window 1's picture is deleted once it shows the live page again");

// Windows stay independent: window 2 picks b1, window 1 keeps a2.
await hubIn(frame2, win2, 'activate', b1);
await until(async () => (await shown())[win2]?.includes('tab=b1'), 'window 2 shows b1', 15000).catch(() => false);
now = await shown();
check(now[win2]?.includes('tab=b1') && now[win1]?.includes('tab=a2'), `picking another tab in window 2 leaves window 1 alone (${now[win1]} | ${now[win2]})`);

// Closing window 2 keeps its tabs.
await frame1.eval(`chrome.windows.remove(${win2}).then(() => true)`);
await wait(1500);
const left = await ids(frame1);
check([a1, a2, b1].every((id) => left.includes(id)), "closing window 2 keeps its tabs in the sidebar");
check((await shown())[win1]?.includes('tab=a2'), 'window 1 still shows its tab');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
browser.kill();
fixture.close?.();
process.exit(failed.length ? 1 : 0);
