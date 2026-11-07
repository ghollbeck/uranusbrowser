// End-to-end test of where the Agent panel sits, in a real UrAnus Browser with the panel patch (0042):
//   - opening it from the shell docks it on the right, about 400 px wide, beside the page
//     (the page area shrinks; the panel covers neither the page nor the sidebar);
//   - dragging its dock handle across the window docks it on the left;
//   - after quitting and reopening UrAnus Browser with the same profile it is still on the left;
//   - dragging it back docks it right; Escape closes it.
// Takes window screenshots of each layout with macOS screencapture (needs Screen Recording
// permission for the terminal; without it the pictures show only the desktop).
//
//   node chromium/tests/e2e-layout.mjs [--app /Applications/UrAnus Browser.app] [--shots <dir>] [--url <page>]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';
import { startFixtureServer } from './fixture-server.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shots = arg('--shots');
const profile = path.join(here, '.scratch', `layout-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};
if (shots) fs.mkdirSync(shots, { recursive: true });
const fixture = await startFixtureServer(0);
const url = arg('--url', fixture.url);

/** Starts UrAnus Browser on the test profile; resolves with what the checks need. */
async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/UrAnus Browser'),
    [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40'],
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
      p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? true); } });
      p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
    })`);
  return { browser, cdp, frame, hub };
}

async function panelOf(cdp) {
  const t = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
  const panel = await cdp.session(t.targetId);
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.body.dataset.side`), 'the panel page');
  return panel;
}

/** The panel's and the page's place in the window, in screen points. */
async function geometry(panel, page) {
  const p = await panel.eval(`({ w: innerWidth, side: document.body.dataset.side, focused: document.hasFocus() })`);
  const g = await page.eval(`({ w: innerWidth, h: innerHeight })`);
  const win = await panel.eval(`(async () => { const id = Number(new URLSearchParams(location.search).get('window')); const w = await chrome.windows.get(id); return { left: w.left, top: w.top, width: w.width, height: w.height }; })()`);
  return { panel: p, page: g, win };
}

function screenshot(name, win) {
  if (!shots) return;
  const file = path.join(shots, `${name}.png`);
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', `-R${win.left},${win.top},${win.width},${win.height}`, file]);
    console.log(`  screenshot: ${file}`);
  } catch (err) {
    console.log(`  (no screenshot: ${err.message})`);
  }
}

/** Drags the dock handle to `screenFraction` of the window's width, with real mouse events. */
async function dragHandle(panel, win, screenFraction) {
  const h = await panel.eval(`(() => { const r = document.getElementById('dock-handle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const mouse = (type, x, y, buttons) => panel.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  // Where the panel's view sits on screen, from a pointer event's screen and client x.
  await panel.eval(`addEventListener('pointermove', (e) => (window.__offset = e.screenX - e.clientX), { once: true }), true`);
  await mouse('mouseMoved', h.x, h.y, 0);
  const offset = await until(() => panel.eval('window.__offset'), 'a pointer event', 5000);
  const targetX = win.left + win.width * screenFraction - offset;
  await mouse('mousePressed', h.x, h.y, 1);
  for (let i = 1; i <= 12; i++) await mouse('mouseMoved', h.x + ((targetX - h.x) * i) / 12, h.y, 1);
  await wait(200);
  await mouse('mouseReleased', targetX, h.y, 0);
}

// ---- first launch: right, then drag left -------------------------------------------

let { browser, cdp, frame, hub } = await launch();
await hub('finishOnboarding');
await hub('newTab', url);
let page = await cdp.session((await cdp.waitTarget((t) => t.type === 'page' && t.url.startsWith(url.split('#')[0]))).targetId);
await until(() => page.eval(`document.readyState === 'complete'`), 'the page');
const fullPageWidth = await page.eval('innerWidth');

check(await frame.eval(`!document.getElementById('btn-agent').hidden`), 'the sidebar toolbar shows the Agent button');
await frame.eval(`document.getElementById('btn-agent').click(), true`);
let panel = await panelOf(cdp);
await until(async () => (await page.eval('innerWidth')) < fullPageWidth - 300, 'the page area to make room');
let g = await geometry(panel, page);
check(g.panel.side === 'right', `opens docked right (${g.panel.side})`);
check(Math.abs(g.panel.w - 400) <= 2, `about 400 px wide (${g.panel.w})`);
check(!g.panel.focused, 'opening it from the toolbar leaves keyboard focus with the page');
check(fullPageWidth - g.page.w >= 390 && fullPageWidth - g.page.w <= 410, `the page area shrank by the panel's width (${fullPageWidth} → ${g.page.w} px), so nothing is covered`);
check(await frame.eval(`document.getElementById('btn-agent').getAttribute('aria-pressed') === 'true'`), 'the button shows it is on (aria-pressed)');
await wait(600);
screenshot('1-docked-right', g.win);

await dragHandle(panel, g.win, 0.2);
await until(() => panel.eval(`document.body.dataset.side === 'left'`), 'the panel to dock left', 20000).catch(() => undefined);
g = await geometry(panel, page);
check(g.panel.side === 'left', `dragging the handle to the left docks it left (${g.panel.side})`);
await wait(600);
screenshot('2-docked-left', g.win);

// Resize from the keyboard: the inner edge, ArrowRight widens a left-docked panel.
await panel.eval(`document.getElementById('resize').focus(), true`);
for (let i = 0; i < 3; i++) {
  await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
}
await until(async () => (await panel.eval('innerWidth')) >= 440, 'the panel to widen', 10000).catch(() => undefined);
const widened = await panel.eval('innerWidth');
check(widened >= 440, `the resize edge widens it from the keyboard (${widened} px)`);

// ---- quit and reopen with the same profile ------------------------------------------

browser.kill();
await new Promise((r) => browser.once('exit', r));
await wait(1500);
({ browser, cdp, frame, hub } = await launch());
await hub('agentPanel:toggle');
panel = await panelOf(cdp);
// The web page (not one of UrAnus Browser's own internal pages, which are also page targets).
const pageTarget = await cdp.waitTarget((t) => t.type === 'page' && /^https?:/.test(t.url));
page = await cdp.session(pageTarget.targetId);
await wait(800);
g = await geometry(panel, page);
check(g.panel.side === 'left', `after a restart it is still docked left (${g.panel.side})`);
check(Math.abs(g.panel.w - widened) <= 2, `and keeps its width (${g.panel.w} px)`);

await dragHandle(panel, g.win, 0.85);
await until(() => panel.eval(`document.body.dataset.side === 'right'`), 'the panel to dock right', 20000).catch(() => undefined);
check((await panel.eval('document.body.dataset.side')) === 'right', 'dragging it back docks it right');

// Escape in the panel closes it and gives the page the keyboard back.
await panel.eval(`document.getElementById('input').focus(), true`);
await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await until(async () => (await page.eval('innerWidth')) > g.page.w + 300, 'the panel to close', 15000).catch(() => undefined);
check((await page.eval('innerWidth')) > g.page.w + 300, 'Escape closes it and the page takes the room back');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
fixture.server.close();
process.exit(failed.length ? 1 : 0);
