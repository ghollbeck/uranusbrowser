// End-to-end test of ⌘Z in the sidebar, in a real UrAnus Browser (no AI involved):
//   - a tab closed with its ✕ comes back with ⌘Z, in the same place, open and showing its page;
//   - Clear (all Today tabs) is one undo; a deleted pinned tab goes back into its folder;
//   - ⌘Z in a text field is left alone (the field's own undo).
//
//   node chromium/tests/e2e-undoclose.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist]
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
const profile = path.join(here, '.scratch', `undoclose-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

const fixture = await startFixtureServer(0);
fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40'];
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
const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);

await hub('finishOnboarding');
await wait(800);
for (const n of [1, 2, 3, 4]) await hub('newTab', `${fixture.url}?tab=${n}`);
await until(() => frame.eval(`document.querySelectorAll('#today [data-tab-id]').length === 4`), 'four today tabs');
await wait(600);

const ids = (zone) => frame.eval(`[...document.querySelectorAll('#${zone} [data-tab-id]')].map((el) => el.dataset.tabId)`);
const row = (id) => `[data-tab-id="${id}"]`;
const pages = async () => (pages.last = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(fixture.url)).map((t) => t.url));
async function click(selector) {
  const at = await frame.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await frame.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  await wait(150);
}
/** ⌘Z as a key press reaching the sidebar page. */
async function undo() {
  const z = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 };
  await frame.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...z });
  await frame.send('Input.dispatchKeyEvent', { type: 'keyUp', ...z });
  await wait(300);
}

const order = await ids('today');
const second = order[1];
await click(row(second));
await until(() => frame.eval(`document.querySelector('${row(second)}').classList.contains('active')`), 'the second tab to open');
await until(async () => (await pages()).some((u) => u.includes('tab=')), 'its page');
const livePages = await pages();
await frame.eval(`document.querySelector('${row(second)} .close').click()`);
await until(async () => !(await ids('today')).includes(second), 'the tab to close');
await until(async () => (await pages()).length < livePages.length, 'its page to close');
const secondUrl = livePages.find((u) => !pages.last.includes(u));
check(true, 'the ✕ closes the tab');

// Focus the sidebar as a click on an empty part of it would, then ⌘Z.
await click('#today');
await undo();
await until(async () => (await ids('today')).includes(second), 'the tab to come back', 5000).catch(() => undefined);
check(JSON.stringify(await ids('today')) === JSON.stringify(order), '⌘Z in the sidebar brings it back in the same place');
check(await frame.eval(`document.querySelector('${row(second)}')?.classList.contains('active') ?? false`), 'and shows it');
const reopened = await until(async () => (await pages()).includes(secondUrl), 'a page for it', 8000).catch(() => false);
check(!!secondUrl && reopened, `its page opens again (${secondUrl})`);

await hub('clearToday');
await until(async () => (await ids('today')).length === 0, 'Today to clear');
await click('#sidebar');
await undo();
await until(async () => (await ids('today')).length === 4, 'all four back', 5000).catch(() => undefined);
check(JSON.stringify(await ids('today')) === JSON.stringify(order), 'Clear is one undo: all four come back, in order');

await hub('moveTabs', [order[0], order[2]], { zone: 'pinned' });
await until(async () => (await ids('pinned')).length === 2, 'two pinned');
await hub('pinInNewFolder', [order[0], order[2]]);
await until(() => frame.eval(`!!document.querySelector('#pinned .folder')`), 'a folder');
await hub('deleteTabs', [order[2]]);
await until(async () => !(await ids('pinned')).includes(order[2]), 'the pinned tab to go');
await click('#sidebar');
await undo();
await until(async () => (await ids('pinned')).includes(order[2]), 'the pinned tab back', 5000).catch(() => undefined);
const inFolder = await frame.eval(`[...document.querySelectorAll('#pinned .folder [data-tab-id]')].map((el) => el.dataset.tabId)`);
check(inFolder.includes(order[2]), 'a deleted pinned tab goes back into its folder');

await hub('archiveTabs', [order[3]]);
await until(async () => !(await ids('today')).includes(order[3]), 'the last tab to go');
await frame.eval(`(() => { const i = document.createElement('input'); i.id = 'probe'; document.body.append(i); i.focus(); })()`);
await undo();
check(!(await ids('today')).includes(order[3]), '⌘Z in a text field is left to the field');
await frame.eval(`document.getElementById('probe').remove()`);
await click('#today');
await undo();
await until(async () => (await ids('today')).includes(order[3]), 'the archived tab back', 5000).catch(() => undefined);
check((await ids('today')).includes(order[3]), 'archived tabs come back too');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
fixture.close?.();
process.exit(failed.length ? 1 : 0);
