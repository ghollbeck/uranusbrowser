// End-to-end test of picking several tabs in the sidebar, in a real Uranus Browser (no AI involved):
//   - ⌘-click starts a selection with the tab you're on, ⇧-click picks a run, a plain click lets go;
//   - the bar at the bottom pins them together and unpins them; dragging them moves them together;
//   - their right-click menu acts on all of them; dropping them on another Space moves them there;
//   - ⌫ archives them; Delete asks first, then removes them.
//
//   node chromium/tests/e2e-multiselect.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>]
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
const app = arg('--app', '/Applications/Uranus Browser.app');
const shellDir = arg('--shell-dir');
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `multiselect-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

const fixture = await startFixtureServer(0);
fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
const browser = spawn(path.join(app, 'Contents/MacOS/Uranus Browser'), flags, { stdio: 'ignore' });
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
const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);

await hub('finishOnboarding');
await wait(800);
for (const n of [1, 2, 3, 4, 5]) await hub('newTab', `${fixture.url}?tab=${n}`);
await until(() => frame.eval(`document.querySelectorAll('#today [data-tab-id]').length === 5`), 'five today tabs');
await wait(600);

const ids = (zone) => frame.eval(`[...document.querySelectorAll('#${zone} [data-tab-id]')].map((el) => el.dataset.tabId)`);
const picked = () => frame.eval(`[...document.querySelectorAll('[data-tab-id].selected')].map((el) => el.dataset.tabId)`);
const barShown = () => frame.eval(`!document.getElementById('selection-bar').hidden`);
const today = await ids('today');

// Real clicks, so modifiers reach the page as a user's would. ⌘ = 4, ⇧ = 8.
async function click(selector, modifiers = 0, button = 'left') {
  const at = await frame.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await frame.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1, modifiers });
  }
  await wait(150);
}
const row = (id) => `[data-tab-id="${id}"]`;
const key = async (name, code) => {
  await frame.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await frame.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
  await wait(200);
};
/** HTML drag and drop, as the page sees it: the picked rows' dragstart, then a drop on `target`. */
const drag = (fromSelector, targetSelector) =>
  frame.eval(`(() => {
    const dt = new DataTransfer();
    const from = document.querySelector(${JSON.stringify(fromSelector)});
    const to = document.querySelector(${JSON.stringify(targetSelector)});
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return dt.types.join(',');
  })()`);
async function shot(name) {
  if (!shots) return;
  const r = await frame.eval(`(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const { data } = await frame.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

// ---- picking -------------------------------------------------------------------------
await click(row(today[0]));
await until(() => frame.eval(`document.querySelector('${row(today[0])}').classList.contains('active')`), 'the first tab to open');
check(!(await barShown()) && (await picked()).length === 0, 'a plain click opens a tab and picks nothing');
await click(row(today[2]), 4);
let p = await picked();
check(p.length === 2 && p.includes(today[0]) && p.includes(today[2]), '⌘-click picks that tab along with the one you are on');
check(await barShown(), 'the bar shows for two or more');
check((await frame.eval(`document.getElementById('selection-count').textContent`)) === '2 tabs', 'it says how many: “2 tabs”');
await click(row(today[4]), 8);
p = await picked();
check(p.length === 3 && [today[2], today[3], today[4]].every((id) => p.includes(id)), '⇧-click picks the run from the last ⌘-clicked tab');
await click(row(today[1]), 4);
check((await picked()).length === 4, '⌘-click adds one more');
await click(row(today[1]), 4);
check((await picked()).length === 3, 'and ⌘-click again takes it back out');
await shot('1-picked');
await key('Escape', 27);
check((await picked()).length === 0 && !(await barShown()), 'Escape lets go of them');

// ---- pin together, unpin, drag ----------------------------------------------------------
await click(row(today[1]), 4); // with today[0], the active one
await click(row(today[3]), 4);
const trio = [today[0], today[1], today[3]];
await click('#sel-pin');
await until(async () => (await ids('pinned')).length === 3, 'three pinned tabs');
check(JSON.stringify(await ids('pinned')) === JSON.stringify(trio), 'Pin pins them together, in sidebar order');
check((await picked()).length === 3, 'and they stay picked');
check((await frame.eval(`document.getElementById('sel-pin').dataset.tip`)) === 'Unpin', 'now the bar offers Unpin');
await shot('2-pinned');
await click('#sel-pin');
await until(async () => (await ids('pinned')).length === 0, 'none pinned');
check((await ids('today')).length === 5, 'Unpin puts them back in today');
const types = await drag(row(today[0]), '#pinned');
check(types.includes('application/x-anus-tabs'), 'dragging a picked tab carries all of the picked ones');
await until(async () => (await ids('pinned')).length === 3, 'three pinned by drag');
check(JSON.stringify(await ids('pinned')) === JSON.stringify(trio), 'dropping them on the pinned area pins them together');
await drag(row(today[1]), `#today ${row(today[2])}`);
await until(async () => (await ids('pinned')).length === 0, 'unpinned by drag');
const order = await ids('today');
check(JSON.stringify(order.slice(order.indexOf(today[0]), order.indexOf(today[2]) + 1)) === JSON.stringify([...trio, today[2]]), 'dropping them before a today tab puts them there, together');

// ---- the menu, a new folder ------------------------------------------------------------
await click(row(today[0]), 2, 'right');
await until(() => frame.eval(`!!document.querySelector('.shell-menu-layer')`), 'the menu');
const menu = await frame.eval(`document.querySelector('.shell-menu-layer').innerText`);
check(/Pin 3 Tabs/.test(menu) && /Archive 3 Tabs/.test(menu) && /Delete 3 Tabs/.test(menu) && /Pin Together in New Folder/.test(menu), 'right-click on a picked tab shows the menu for all three');
await key('Escape', 27);
await until(() => frame.eval(`!document.querySelector('.shell-menu-layer')`), 'the menu to close');
await click('#sel-folder');
await until(() => frame.eval(`!!document.querySelector('#pinned .folder')`), 'a folder');
const inFolder = await frame.eval(`[...document.querySelectorAll('#pinned .folder [data-tab-id]')].map((el) => el.dataset.tabId)`);
check(JSON.stringify(inFolder) === JSON.stringify(trio), 'Pin together in a new folder puts them in one folder');
await shot('3-folder');

// ---- another Space ---------------------------------------------------------------------
await hub('newSpace');
await until(() => frame.eval(`document.querySelectorAll('#spaces .space-dot').length === 2`), 'a second Space');
await frame.eval(`document.getElementById('space-done')?.click()`);
await click('#spaces .space-dot:first-child');
await until(() => frame.eval(`document.querySelector('#spaces .space-dot:first-child').classList.contains('active')`), 'back in the first Space');
await wait(400);
check((await picked()).length === 0, 'switching Spaces lets go of the picked tabs');
await click(row(today[2]), 4);
await click(row(today[4]), 4);
const pair = (await picked()).length === 3 ? await picked() : [today[2], today[4]];
await drag(row(today[4]), '#spaces .space-dot:last-child');
await until(async () => !(await ids('today')).includes(today[4]), 'the tabs to leave');
check(!(await ids('today')).includes(today[2]) && !(await ids('today')).includes(today[4]), `dropping them on another Space moves them there (${pair.length} picked)`);
await click('#spaces .space-dot:last-child');
await until(async () => (await ids('today')).includes(today[4]), 'the tabs in the other Space');
check((await ids('today')).includes(today[2]), 'and they are there, in its today list');

// ---- archive, delete -------------------------------------------------------------------
await click(row(await ids('today').then((t) => t[0])));
const there = await ids('today');
await click(row(there[1]), 4);
check((await picked()).length === 2, 'two picked in the other Space');
await key('Backspace', 8);
await until(async () => (await ids('today')).length === 0, 'the archived tabs to go');
check(true, '⌫ archives the picked tabs');
await click('#spaces .space-dot:first-child');
await until(() => frame.eval(`document.querySelector('#spaces .space-dot:first-child').classList.contains('active')`), 'the first Space');
await wait(400);
const left = await frame.eval(`[...document.querySelectorAll('#pinned [data-tab-id], #today [data-tab-id]')].map((el) => el.dataset.tabId)`);
await click(row(left[0]));
await click(row(left[1]), 4);
await click('#sel-delete');
await until(() => frame.eval(`!!document.querySelector('.shell-dialog')`), 'the delete dialog');
const dialog = await frame.eval(`document.querySelector('.shell-dialog').innerText`);
check(/Delete 2 tabs\?/.test(dialog) && /not kept in the archive/.test(dialog), 'Delete asks first, and says they won’t be in the archive');
await shot('4-delete-dialog');
await frame.eval(`[...document.querySelectorAll('.shell-dialog button')].find((b) => b.textContent === 'Delete').click()`);
await until(async () => {
  const now = await frame.eval(`[...document.querySelectorAll('[data-tab-id]')].map((el) => el.dataset.tabId)`);
  return !now.includes(left[0]) && !now.includes(left[1]);
}, 'the deleted tabs to go');
check(true, 'confirming removes them');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
fixture.close?.();
process.exit(failed.length ? 1 : 0);
