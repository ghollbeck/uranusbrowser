// End-to-end test of the meeting reminder for a meeting already going on, in a real Uranus Browser
// with a throwaway profile (no network: the calendar's last reading is seeded in the profile):
//   - after a restart the meeting, started 20 minutes ago, is prompted at once (one notification);
//   - the sidebar's reminder card shows it (title as text, platform, Join, Join & record, Dismiss);
//   - the native host puts up the floating panel (an osascript process) on the pointer's display;
//   - Dismiss on the card closes the card and the panel (until Uranus Browser is reopened);
//   - Join on the card (a second meeting) opens the meeting link in a new tab and closes both;
//   - reopened, the card and panel come back for a meeting still going on; the notification doesn't.
//
//   node chromium/tests/e2e-reminder.mjs [--app /Applications/Uranus Browser.app] [--shots <dir>]
// With --shots, the panel's own picture is saved too (ANUS_REMINDER_SNAPSHOT).
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
const shots = arg('--shots') && path.resolve(arg('--shots'));
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `reminder-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const env = { ...process.env, ...(shots ? { ANUS_REMINDER_SNAPSHOT: path.join(shots, 'panel.png') } : {}) };
  const browser = spawn(
    path.join(app, 'Contents/MacOS/Uranus Browser'),
    [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1280,820', '--window-position=60,40'],
    { stdio: 'ignore', env },
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
  return { browser, cdp, frame, hub };
}

async function restart(state) {
  state.browser.kill();
  await new Promise((r) => state.browser.once('exit', r));
  await wait(1500);
  const next = await launch();
  // The tour can come back on a fresh profile's restart; it covers the window.
  await next.hub('finishOnboarding');
  await wait(800);
  return next;
}

/** The floating panels running for this profile's host (osascript with the panel's script). */
const panels = () => {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', 'AnusReminderTarget'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};
const visible = (frame, selector) => frame.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`);
async function click(frame, selector) {
  const at = await frame.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await frame.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
async function shot(frame, name) {
  await wait(500);
  if (!shots) return;
  const { data } = await frame.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

// ---- a meeting going on for 20 minutes, read before the app started ------------------------------

const before = panels();
let state = await launch();
await state.hub('finishOnboarding');
const now = Date.now();
const MEET = 'https://meet.google.com/abc-defg-hij';
await state.frame.eval(`chrome.storage.local.set({
  // The AI assistant (joinly) switched on, so the reminder offers "Record + AI assistant" (nothing joins).
  joinly: { enabled: true, endpoint: 'http://127.0.0.1:9/mcp' },
  'calendar:url': 'https://calendar.google.com/calendar/ical/test%40example.com/private-0000/basic.ics',
  'calendar:cache': { checkedAt: Date.now(), events: 2, meetings: [
    { id: 'ev-0123456789abcdef', title: 'Reminder check <b>live</b>', start: ${now - 20 * 60_000}, end: ${now + 60 * 60_000}, platform: 'Google Meet', url: '${MEET}', shown: 'meet.google.com/abc-defg-hij' },
    { id: 'ev-fedcba9876543210', title: 'Second meeting', start: ${now - 5 * 60_000}, end: ${now + 30 * 60_000}, platform: 'Zoom', url: 'https://acme.zoom.us/j/123456789', shown: 'acme.zoom.us/j/123456789' },
    { id: 'ev-1111111111111111', title: 'Over', start: ${now - 90 * 60_000}, end: ${now - 30 * 60_000}, platform: 'Google Meet', url: '${MEET}', shown: 'x' },
  ] },
}).then(() => true)`);
state = await restart(state);

const notes = await until(async () => {
  const all = await state.frame.eval(`new Promise((r) => chrome.notifications.getAll(r))`);
  return Object.keys(all ?? {}).length >= 2 ? all : false;
}, 'the notifications', 20000).catch(() => ({}));
check(Object.keys(notes).length === 2, `a meeting already going on is prompted at once, both live ones, not the one that's over (${Object.keys(notes).length})`);

await until(() => visible(state.frame, '#meeting-reminder.shown'), 'the card', 15000).catch(() => undefined);
check(await visible(state.frame, '#meeting-reminder.shown'), 'the sidebar shows the reminder card');
const card = (await state.frame.eval(`document.querySelector('#meeting-reminder')?.textContent ?? ''`)) ?? '';
check(/Reminder check <b>live<\/b>/.test(card) && /Live · 20 min in/.test(card) && /until \d/.test(card), 'the card names the meeting that started first, as text, with its live line');
check((await state.frame.eval(`document.querySelector('#meeting-reminder .mr-platform')?.dataset.tip`)) === 'Google Meet', 'the platform icon names Google Meet');
const width = Number(await state.frame.eval(`document.querySelector('#meeting-reminder .mr-progress i')?.style.width.replace('%', '')`));
check(width > 15 && width < 30, `the progress bar shows 20 of 80 minutes gone (${width}%)`);
check(!!(await state.frame.eval(`document.querySelector('#meeting-reminder button[data-action="assistant"]')?.getClientRects().length`)), 'with the AI assistant on, Record + AI assistant is on the same row');
check(new Set(await state.frame.eval(`[...document.querySelectorAll('#meeting-reminder .mr-actions button')].map((b) => Math.round(b.getBoundingClientRect().top))`)).size === 1, 'all the buttons are on one row');
check(/Join/.test(card) && /Join & record/.test(card) && (await state.frame.eval(`!!document.querySelector('#meeting-reminder .mr-close[data-action="dismiss"]')`)), 'the card has Join, Join & record and ✕ to dismiss');
await shot(state.frame, 'card');

const up = await until(async () => panels() > before, 'the floating panel', 15000).catch(() => false);
check(!!up, 'the native host shows the floating panel');
if (shots) await until(async () => fs.existsSync(path.join(shots, 'panel.png')), 'the panel picture', 8000).catch(() => undefined);

// ---- Dismiss: both go, and the next meeting takes its turn ------------------------------------------------

await click(state.frame, '#meeting-reminder .mr-close');
await until(async () => /Second meeting/.test((await state.frame.eval(`document.querySelector('#meeting-reminder')?.textContent ?? ''`)) ?? ''), 'the next card', 10000).catch(() => undefined);
check(/Second meeting/.test((await state.frame.eval(`document.querySelector('#meeting-reminder')?.textContent ?? ''`)) ?? ''), 'after Dismiss the card shows the other meeting going on');
await wait(1500);
check(panels() === before + 1, 'one panel is up, now for the other meeting');

// ---- Join: opens the meeting and closes both ---------------------------------------------------------------

const tabsBefore = await state.frame.eval(`chrome.tabs.query({}).then((t) => t.length)`);
await click(state.frame, '#meeting-reminder button[data-action="join"]');
await until(() => state.frame.eval(`chrome.tabs.query({}).then((t) => t.some((x) => (x.pendingUrl || x.url || '').includes('acme.zoom.us')))`), 'the meeting tab', 10000).catch(() => undefined);
check(await state.frame.eval(`chrome.tabs.query({}).then((t) => t.some((x) => (x.pendingUrl || x.url || '').includes('acme.zoom.us')))`), `Join opens the meeting link in a new tab (${tabsBefore} tabs before)`);
await until(async () => !(await visible(state.frame, '#meeting-reminder')), 'the card to go', 10000).catch(() => undefined);
check(!(await visible(state.frame, '#meeting-reminder')), 'after Join the card is gone');
await until(async () => panels() === before, 'the panel to go', 10000).catch(() => undefined);
check(panels() === before, 'after Join the floating panel is gone');

// ---- reopened: the card and the panel come back for meetings still going on, answered or not ----------

state = await restart(state);
await until(() => visible(state.frame, '#meeting-reminder.shown'), 'the card again', 15000).catch(() => undefined);
check(/Reminder check/.test((await state.frame.eval(`document.querySelector('#meeting-reminder')?.textContent ?? ''`)) ?? ''), 'after a restart the card is back for the meeting going on, though it was answered');
check(!!(await until(async () => panels() > before, 'the panel again', 15000).catch(() => false)), 'and the panel is back');
const notesAgain = await state.frame.eval(`new Promise((r) => chrome.notifications.getAll(r))`);
check(Object.keys(notesAgain ?? {}).length === 0, 'the macOS notification is not repeated (once per meeting)');

state.browser.kill();
await wait(1000);
fs.rmSync(profile, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
