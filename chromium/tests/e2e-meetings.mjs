// End-to-end test of meeting notes, in a real UrAnus Browser with a throwaway profile, through the real
// Agent panel (real mouse clicks):
//   - the panel's mic button, the sheet, the privacy text and the reminder; Start, the recording
//     bar, the live transcript, Stop; closing the panel while recording asks first;
//   - the notes (quotes of the transcript, with the speaker names read from a Meet-like page),
//     rename, Copy as Markdown, Discuss in chat, restart persistence, delete and Delete all;
//   - a recording ends by itself when its tab closes and when the helper goes away;
//   - a failed start shows why and offers the one-time microphone permission page.
//
// What it CANNOT do here: a real microphone and a real meeting tab (macOS shows its own
// microphone prompt, and Chromium's tab capture needs an extension "invocation" that only a
// toolbar click or keyboard command gives). So the capture page plays recorded speech made with
// `say` (shell test mode: a storage flag only this test sets) in place of the microphone and
// the tab, and everything else (offscreen page, audio worklet, chunking, WAV, background, host,
// OpenAI, storage, panel) is the real path. Transcription and notes use a few real, cheap
// OpenAI calls through the built host of THIS worktree (the installed app's bundled host is
// older and has no meeting methods); the profile's NativeMessagingHosts entry is pointed at it.
//
//   node chromium/tests/e2e-meetings.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir <dist>]
//        [--shots <dir>] [--bundled-host]
// It needs the OpenAI key in the Keychain (it checks first and says so).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';
import { makeSpeech, startMockServer } from './meetings-fixtures.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const bundledHost = process.argv.includes('--bundled-host'); // use the app's own (new) host, as shipped
const shellDir = path.resolve(arg('--shell-dir', path.join(root, 'chromium/shell/dist')));
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `meetings-profile-${Date.now()}`);
const results = [];
const step = (name) => console.log(`… ${name}`);
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// The host of this worktree, built, and a launcher the throwaway profile points at.
execFileSync(process.execPath, [path.join(root, 'chromium/native-host/build.mjs')], { stdio: 'inherit' });
const hostScript = path.join(root, 'chromium/native-host/dist/anus-host.cjs');

console.log('making test speech with `say` …');
const speech = makeSpeech(path.join(profile, 'speech'));
const { server, meetUrl, plainUrl } = await startMockServer();

/** A DevTools session whose evaluations give up after 45 s, saying which one, instead of hanging the test. */
const guarded = (session) => {
  const evaluate = session.eval;
  session.eval = (expression) =>
    Promise.race([evaluate(expression), new Promise((_, reject) => setTimeout(() => reject(new Error(`evaluation timed out: ${String(expression).slice(0, 90)}`)), 45000))]);
  return session;
};

async function launch() {
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/UrAnus Browser'),
    [
      `--user-data-dir=${profile}`,
      `--anus-shell-dir=${shellDir}`,
      '--remote-debugging-port=0',
      '--use-mock-keychain', '--disable-features=MacAppCodeSignClone',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      '--window-position=60,40',
    ],
    { stdio: 'ignore' },
  );
  reap(browser);
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await Cdp.connect(webSocketDebuggerUrl);
  const frame = guarded(await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId));
  // Point THIS throwaway profile's native host at the worktree's built host (after the app has written its own entry),
  // unless --bundled-host: then the packaged app's own host is what is tested.
  if (!bundledHost) {
  const hosts = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(hosts, { recursive: true });
  const launcher = path.join(profile, 'anus-host');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${hostScript}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(hosts, 'dev.oprimo.anus.host.json'),
    JSON.stringify({ name: 'dev.oprimo.anus.host', description: 'meetings e2e', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${SHELL_ID}/`] }),
  );
  }
  // A call through the shell's hub, like a page's invoke(); it gives up after 30 s so a stuck call shows up.
  const hub = (name, ...args) =>
    frame.eval(`new Promise((resolve, reject) => {
      const p = chrome.runtime.connect({ name: 'anus' });
      p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
      p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
      setTimeout(() => reject(new Error('no reply from ${name}')), 30000);
    })`);
  return { browser, cdp, frame, hub };
}

async function openPanel(cdp, hub) {
  await hub('agentPanel:toggle');
  const t = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
  const panel = guarded(await cdp.session(t.targetId));
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.body.dataset.side && !!document.getElementById('meetings')`), 'the panel page');
  return panel;
}

async function shot(panel, name) {
  await wait(450);
  if (!shots) return;
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

/** Real mouse events at an element's centre. */
async function click(panel, selector) {
  const at = await panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const clickText = async (panel, selector, text) => {
  const i = await panel.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].findIndex((e) => e.textContent.trim() === ${JSON.stringify(text)})`);
  if (i < 0) throw new Error(`no ${selector} with text "${text}"`);
  const at = await panel.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})][${i}]; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
};
const key = async (panel, name, code) => {
  await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
};
const text = (panel, selector) => panel.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (panel, selector) => panel.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (panel, selector) => panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`);
const sheetOpen = (panel) => visible(panel, '#meetings-sheet');
const panelTarget = async (cdp) => !!(await cdp.targets()).find((t) => t.url.includes('/agent.html'));

// ---- first launch: the sheet, without recording ------------------------------------------------------------

let { browser, cdp, frame, hub } = await launch();
await hub('finishOnboarding');
const engines = (await hub('meetings:get')).view.engines;
if (!engines.find((e) => e.id === 'openai')?.ready) {
  console.error('This test needs the OpenAI key in the macOS Keychain (chromium/scripts/set-openai-key.sh) and a working host build.');
  browser.kill();
  server.close();
  process.exit(2);
}
await hub('newTab', meetUrl);
await wait(2500);
await frame.eval(`chrome.storage.local.set({ 'meetings:testMode': true, 'meetings:testFixture': { me: ${JSON.stringify(speech.me.toString('base64'))}, others: ${JSON.stringify(speech.others.toString('base64'))} } })`);
let panel = await openPanel(cdp, hub);
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await until(() => text(panel, '#page-chip-title').then((t) => t === 'Meet mock'), 'the current tab chip');

check((await panel.eval(`document.getElementById('meetings').getAttribute('aria-label')`)) === 'Meeting notes', 'the header has a Meeting notes button');
check((await panel.eval(`document.getElementById('meetings').getAttribute('aria-expanded')`)) === 'false' && !(await sheetOpen(panel)), 'the sheet starts closed');
await click(panel, '#meetings');
await until(() => sheetOpen(panel), 'the sheet to open');
check((await panel.eval(`document.getElementById('meetings').getAttribute('aria-expanded')`)) === 'true', 'opening it sets aria-expanded');
check((await text(panel, '#meetings-title')) === 'Meeting notes', 'the sheet is titled Meeting notes');
await until(() => panel.eval(`!!document.getElementById('mt-primary')`), 'the Start button');
check((await text(panel, '#mt-primary')).includes('Start recording'), 'there is a Start recording button');
check(/Records the tab you are on:\s*Meet mock/.test(await text(panel, '.mt-tab')), 'it names the tab it will record');
check(!(await panel.eval(`!!document.querySelector('.mt-reminder')`)), 'the recorder card has no recording reminder box');
check(/not saved anywhere|never leaves it/.test(await text(panel, '.mt-card')) && /stays in this browser profile/.test(await text(panel, '.mt-card')), 'it says where audio and text go');
check(/never logged/.test(await text(panel, '.mt-past')), 'it says transcripts are never logged and stay local');
check((await panel.eval(`document.activeElement?.id`)) === 'mt-primary', 'focus moves into the sheet');
// The pickers are UrAnus Browser's own dropdowns, not the OS menu: real clicks open one, choose, and close it.
check((await count(panel, '#mt-language.fs-native')) === 1 && (await count(panel, '.mt-miclabel button.fs-trigger')) === 2, 'Microphone and Language are UrAnus Browser dropdowns');
await click(panel, 'button.fs-trigger.mt-language');
await until(() => panel.eval(`!!document.querySelector('.fs-menu:popover-open')`), 'the language list to open');
check((await count(panel, '.fs-menu:popover-open .fs-item')) > 20, 'the language list names every language');
await shot(panel, 'meetings-5-language-list');
await clickText(panel, '.fs-menu:popover-open .fs-item', 'German');
await until(() => panel.eval(`document.querySelector('button.fs-trigger.mt-language')?.textContent.trim() === 'German'`), 'German to be chosen');
check(!(await panel.eval(`!!document.querySelector('.fs-menu:popover-open')`)), 'choosing closes the list');
await click(panel, 'button.fs-trigger.mt-language');
await until(() => panel.eval(`!!document.querySelector('.fs-menu:popover-open')`), 'the language list to reopen');
await clickText(panel, '.fs-menu:popover-open .fs-item', 'Automatic');
await until(() => panel.eval(`document.querySelector('button.fs-trigger.mt-language')?.textContent.trim() === 'Automatic'`), 'Automatic to be chosen again');
check((await count(panel, '.mt-engine')) === 3, 'three engine choices: Automatic, OpenAI, On this Mac');
check((await text(panel, '#mt-past-title')).startsWith('Your meetings'), 'the empty list says so');
// (The Upcoming card above has an empty state of its own when no calendar is connected.)
check(/No meetings yet/.test(await text(panel, '.memory-empty:not(.mt-up-empty)')), 'with an explanation of what is saved');

await hub('agentPanel:resize', 360);
await wait(500);
await shot(panel, 'meetings-1-idle-light-360');
await hub('agentPanel:resize', 720);
await wait(500);
await shot(panel, 'meetings-2-idle-light-720');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await shot(panel, 'meetings-3-idle-dark-720');
await hub('agentPanel:resize', 360);
await wait(500);
await shot(panel, 'meetings-4-idle-dark-360');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// Escape closes the sheet first, then the panel.
await key(panel, 'Escape', 27);
await until(async () => !(await sheetOpen(panel)), 'the sheet to close on Escape', 10000).catch(() => undefined);
check(!(await sheetOpen(panel)) && (await panelTarget(cdp)), 'Escape closes the sheet and leaves the panel open');
check((await panel.eval(`document.activeElement?.id`)) === 'meetings', 'focus returns to the mic button');
// (The old "only one sheet at a time" step opened the companions sheet from the header button, which the
// composer's selector replaced; that selector is under an open sheet, so the case can no longer arise.)
await click(panel, '#meetings');
await until(() => sheetOpen(panel), 'the sheet again');
await key(panel, 'Escape', 27);
await wait(300);

// ---- the name reader, against a Meet-like page ------------------------------------------------------------------

const reader = (
  await build({ entryPoints: [path.join(root, 'chromium/shell/lib/meetingsDom.ts')], bundle: true, format: 'iife', globalName: '__reader', write: false })
).outputFiles[0].text;
const meetTarget = await cdp.waitTarget((t) => t.url.startsWith(meetUrl));
const meetPage = guarded(await cdp.session(meetTarget.targetId));
await meetPage.eval(reader);
const read = async (name) => {
  await meetPage.eval(`window.__speak(${JSON.stringify(name)})`);
  return JSON.parse(await meetPage.eval(`JSON.stringify(__reader.readMeetingPage('Google Meet'))`));
};
const alice = await read('Alice Example');
check(alice.speaker === 'Alice Example' && alice.names.includes('Bob Example'), 'the reader finds the highlighted speaker and the names on the tiles (Meet-like page)');
check((await read('Bob Example')).speaker === 'Bob Example', 'and follows the highlight to another tile');
check((await read(null)).speaker === null, 'with nobody highlighted the speaker is null');
check((await read('You')).speaker === null, 'the user’s own tile ("You") is never named as a speaker');
check(JSON.parse(await meetPage.eval(`JSON.stringify(__reader.readMeetingPage('Zoom'))`)).speaker === null, 'a page that does not look like the provider fails soft (no name, no error)');
check(!(await meetPage.eval(`!!document.querySelector('[data-anus], iframe, script[src]')`)), 'the reader added nothing to the page');

// ---- a recording, from the panel ---------------------------------------------------------------------------------------

await hub('agentPanel:resize', 400);
await wait(700); // the panel relayouts; a click now could land where a button used to be
await click(panel, '#meetings');
await until(() => sheetOpen(panel), 'the sheet');
await until(() => panel.eval(`!!document.getElementById('mt-primary') && !document.getElementById('mt-primary').disabled`), 'Start to be enabled');
await click(panel, '#mt-primary');
await until(() => panel.eval(`document.getElementById('meetings').classList.contains('recording')`), 'the recording indicator on the mic button', 60000);
check((await text(panel, '#mt-primary')) === 'Stop', 'the Start button became Stop, in the recorder card');
check(/Recording/.test(await text(panel, '#mt-card-title')) && (await count(panel, '.mt-meter')) === 1, 'the card shows Recording with a level meter for Me only (no tab audio yet)');
const hint = await text(panel, '#mt-tab-hint');
check(/^Remote participants’ audio isn’t being captured yet\..*“UrAnus Browser: add this tab’s audio to the meeting notes”/.test(hint ?? ''), 'Start only begins the microphone and says plainly how to add the others’ audio (right-click item, shortcut)');
check(!/and the tab’s sound are/.test((await text(panel, '.mt-card')) ?? ''), 'it does not claim the others are being recorded');
await shot(panel, 'meetings-4b-recording-no-tab-audio-light-400');
// The gesture path (what the context-menu item and the shortcut run), but invoked from the test, so it is NOT a real
// user gesture: Chromium refuses, and the panel says what to do instead.
await hub('meetings:testGesture', false);
await until(() => panel.eval(`/didn’t allow capturing this tab/.test(document.getElementById('meetings-body').textContent)`), 'the refusal message', 15000);
check(true, 'when Chromium refuses the tab (no real menu click or shortcut), the panel says so and how to retry, and still records the microphone');
check(!(await panel.eval(`!!document.getElementById('mt-meter-others')`)), 'and still no Others meter');
// The same path with the grant faked (recorded speech stands in for the tab): "Others" starts from now.
await hub('meetings:testGesture', true);
await until(() => count(panel, '.mt-meter').then((n) => n === 2), 'the Others meter after the tab audio attaches', 20000);
const began = Date.now();
check(!(await panel.eval(`!!document.getElementById('mt-tab-hint')`)), 'once the tab’s audio is added the how-to goes away');
check(/127\.0\.0\.1: the microphone and the tab’s sound are/.test((await text(panel, '.mt-card .sheet-hint')) ?? ''), 'and the card names the site whose audio is now added');
// A second gesture on the same tab changes nothing.
await hub('meetings:testGesture', true);
await until(() => panel.eval(`/already being added/.test(document.getElementById('meetings-body').textContent)`), 'the repeat message', 10000);
check((await count(panel, '.mt-meter')) === 2, 'a second click on the same tab is a harmless no-op');
check((await panel.eval(`document.getElementById('meetings').getAttribute('aria-label')`)).includes('recording in progress'), 'the mic button’s label says a recording is in progress');
check(!(await panel.eval(`/Tell the other people/.test(document.getElementById('meetings-body').textContent)`)), 'the recorder card shows the recording, not the intro');
await shot(panel, 'meetings-5-recording-light-400');
// With the sheet closed the panel still shows a recording bar.
await click(panel, '#meetings-close');
await until(() => visible(panel, '#rec-bar'), 'the recording bar');
check((await text(panel, '#rec-bar-text')) === 'Recording', 'with the sheet closed a recording bar says Recording');
check((await panel.eval(`document.getElementById('meetings').classList.contains('recording')`)), 'and the mic button shows the recording dot');

// Move the highlight on the Meet-like page to follow the speech (Alice, then Bob), from when the recording began.
const schedule = [[0, 'Alice Example'], [9000, null], [10500, 'Bob Example'], [Math.round(speech.bobWindow[1]) + 500, null]];
const runSchedule = (async () => {
  for (const [ms, name] of schedule) {
    const wake = began + ms - Date.now();
    if (wake > 0) await wait(wake);
    await meetPage.eval(`window.__speak(${JSON.stringify(name)})`).catch(() => undefined);
  }
})();
await shot(panel, 'meetings-5-recording-light-400');

// Closing the panel while recording asks first.
await click(panel, '#close');
await until(() => visible(panel, '#rec-bar-ask'), 'the question about closing', 5000);
check((await panelTarget(cdp)) && (await visible(panel, '#rec-bar-ask')), 'closing the panel while recording asks first (the panel stays)');
check((await text(panel, '#rec-bar-ask')).includes('Stop and close') && (await text(panel, '#rec-bar-ask')).includes('Keep recording'), 'with Stop and close / Keep recording / Cancel');
await shot(panel, 'meetings-6-close-question-light-400');
await click(panel, '#rec-bar-cancel');
check(!(await visible(panel, '#rec-bar-ask')) && (await panelTarget(cdp)), 'Cancel leaves the panel and the recording as they were');
await key(panel, 'Escape', 27); // the panel would close: it asks instead
await until(() => visible(panel, '#rec-bar-ask'), 'the question on Escape', 5000).catch(() => undefined);
check((await visible(panel, '#rec-bar-ask')) && (await panelTarget(cdp)), 'Escape asks too, rather than closing a recording’s panel');
await key(panel, 'Escape', 27);
check(!(await visible(panel, '#rec-bar-ask')), 'and Escape again withdraws the question');

{
  await click(panel, '#rec-bar-open');
  await until(() => sheetOpen(panel), 'the sheet during the recording');
  await until(() => count(panel, '.mt-line').then((n) => n >= 2), 'live transcript lines', 60000);
  const lines = await panel.eval(`[...document.querySelectorAll('#mt-live .mt-line')].map((l) => l.querySelector('.mt-who').textContent + ': ' + l.querySelector('.mt-text').textContent)`);
  check(lines.some((l) => l.startsWith('Me: ') && /recording logs/i.test(l)), 'the live transcript shows what “Me” said, from the microphone channel');
  check(lines.some((l) => /^Alice Example: /.test(l) && /Thursday/i.test(l)), 'and Alice’s line is labelled with her name from the meeting page');
  check((await panel.eval(`document.getElementById('mt-live').getAttribute('role')`)) === 'log', 'the live transcript is a log region');
  await shot(panel, 'meetings-7-live-light-400');
  await until(() => count(panel, '.mt-line').then((n) => n >= 3), 'Bob’s line', 60000);
  check((await panel.eval(`[...document.querySelectorAll('#mt-live .mt-who')].some((w) => w.textContent === 'Bob Example')`)), 'Bob’s line is labelled “Bob Example”');
}
await runSchedule;
await wait(1000);

// Stop (from the bar, with the sheet closed) answers at once.
if (await sheetOpen(panel)) await click(panel, '#meetings-close');
await until(() => visible(panel, '#rec-bar'), 'the bar before Stop');
const stopClicked = Date.now();
await click(panel, '#rec-bar-stop');
await until(() => panel.eval(`!document.getElementById('meetings').classList.contains('recording') || document.getElementById('rec-bar-text').textContent !== 'Recording'`), 'Stop to take effect', 5000);
check(Date.now() - stopClicked < 4000, 'Stop takes effect at once (the bar changes within a few seconds)');
await until(() => panel.eval(`!document.getElementById('meetings').classList.contains('recording')`), 'the recording to finish', 60000);
check(!(await visible(panel, '#rec-bar')), 'the bar goes away when the recording is over');

// ---- the saved meeting -----------------------------------------------------------------------------------------------------

await click(panel, '#meetings');
await until(() => sheetOpen(panel), 'the sheet to look at the saved meeting');
await until(() => count(panel, '.mt-row').then((n) => n === 1), 'the meeting in the list', 30000);
check((await count(panel, '.mt-row')) === 1, 'the recording is saved to the list');
const rowMeta = await text(panel, '.mt-row-meta');
check(/Google Meet/.test(rowMeta), 'with its provider and when it was');
await until(() => panel.eval(`!!document.querySelector('.mt-row .mt-badge')`), 'the notes to be written', 90000);
await shot(panel, 'meetings-8-list-light-400');
await click(panel, '.mt-row');
await until(() => panel.eval(`!!document.getElementById('meeting-title-input')`), 'the meeting view');
check(await visible(panel, '#meetings-back'), 'the meeting view has a back button');
const title = await panel.eval(`document.getElementById('meeting-title-input').value`);
check(title.length > 0 && title.length <= 72, `the meeting has a title (“${title}”)`);
{
  const items = await panel.eval(`[...document.querySelectorAll('.mt-summary .mt-section')].map((s) => ({ h: s.querySelector('.mt-section-title').textContent, items: [...s.querySelectorAll('.mt-item')].map((i) => i.querySelector('.mt-who').textContent + '|' + i.querySelector('.mt-quote').textContent) }))`);
  check(items.map((s) => s.h).join() === 'Overview,Decisions,Action items,Open questions', 'the notes have Overview, Decisions, Action items and Open questions');
  const all = items.flatMap((s) => s.items);
  const transcript = await panel.eval(`[...document.querySelectorAll('.mt-lines .mt-text')].map((t) => t.textContent)`);
  check(all.length > 0 && all.every((i) => transcript.some((t) => t.includes(i.split('|')[1]))), 'every line of the notes is quoted word for word from the transcript');
  check(items.find((s) => s.h === 'Action items').items.some((i) => /regression tests/i.test(i)), 'an action item (“I will write the regression tests…”) is in the notes');
  check(items.find((s) => s.h === 'Decisions').items.some((i) => /Thursday/i.test(i) && i.startsWith('Alice Example|')), 'a decision is attributed to Alice Example');
  check(items.find((s) => s.h === 'Open questions').items.some((i) => /summary model/i.test(i)), 'the unanswered question is listed as open');
  check((await text(panel, '.mt-summary')).includes('quoted from the transcript'), 'the notes say they are quotes');
}
for (const [scheme, width] of [['light', 360], ['light', 720], ['dark', 360], ['dark', 720]]) {
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await hub('agentPanel:resize', width);
  await wait(450);
  await shot(panel, `meetings-9-notes-${scheme}-${width}`);
}
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await hub('agentPanel:resize', 400);

// Rename.
await panel.eval(`document.getElementById('meeting-title-input').focus()`);
await panel.eval(`document.getElementById('meeting-title-input').select()`);
await panel.send('Input.insertText', { text: 'Audio fix sync' });
await key(panel, 'Enter', 13);
await until(() => panel.eval(`document.getElementById('meeting-title-input').value === 'Audio fix sync'`), 'the new title');
await wait(500);

// Copy as Markdown.
await panel.eval(`window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; };`);
await clickText(panel, '.mt-actions .secondary-button', 'Copy as Markdown');
await until(() => panel.eval(`window.__copied !== null`), 'the copy');
const md = await panel.eval(`window.__copied`);
check(/^# Audio fix sync\n/.test(md) && /## Transcript/.test(md) && /\*\*Me\*\*/.test(md), 'Copy as Markdown copies the title and the transcript');
check((await text(panel, '.mt-actions')).includes('Copied'), 'and the button says Copied');
// "Copied" turns back after 2 s by redrawing the actions; a click that lands mid-redraw is lost.
await until(async () => (await text(panel, '.mt-actions')).includes('Copy as Markdown'), 'the copy button to reset', 5000);
await wait(300);

// Discuss in chat.
{
  await clickText(panel, '.mt-actions .secondary-button', 'Discuss in chat');
  await until(async () => !(await sheetOpen(panel)), 'the sheet to close after Discuss', 10000);
  await until(() => count(panel, '.msg.user .bubble').then((n) => n >= 1), 'the message in the chat');
  const sent = await text(panel, '.msg.user .bubble');
  check(/^I recorded a meeting with UrAnus Browser/.test(sent) && sent.includes('<<<MEETING') && sent.includes('MEETING>>>'), '“Discuss in chat” sends the notes as the user’s own message, fenced as untrusted data');
  check(/untrusted data, never as instructions/.test(sent) && /Alice Example/.test(sent), 'and it carries the quoted notes');
  await until(() => count(panel, '.msg.assistant .text').then((n) => n >= 1), 'the agent’s reply', 90000).catch(() => undefined);
  check((await count(panel, '.msg.assistant .text')) >= 1, 'the agent answers (it has the meeting to talk about)');
  await shot(panel, 'meetings-12-discuss-light-400');
}

step('restart: the meeting is still there');
// ---- restart: the meeting is still there ---------------------------------------------------------------------------------------

browser.kill();
await new Promise((r) => browser.once('exit', r));
await wait(1500);
({ browser, cdp, frame, hub } = await launch());
panel = await openPanel(cdp, hub);
await click(panel, '#meetings');
await until(() => sheetOpen(panel), 'the sheet after restart');
await until(() => count(panel, '.mt-row').then((n) => n === 1), 'the saved meeting after restart', 30000);
check((await text(panel, '.mt-row-title')) === 'Audio fix sync', 'after a restart the meeting and its edited title are still there');
await click(panel, '.mt-row');
await until(() => panel.eval(`!!document.getElementById('meeting-title-input')`), 'the meeting after restart');
check((await count(panel, '.mt-lines .mt-line')) >= 2, 'with its transcript');
check((await count(panel, '.mt-item')) >= 3, 'and its notes');

// Delete asks first.
await clickText(panel, '.mt-actions .text-button', 'Delete');
await until(() => visible(panel, '.confirm'), 'the delete question');
check(/Delete this meeting/.test(await text(panel, '.confirm')), 'Delete asks for confirmation');
await clickText(panel, '.confirm .secondary-button', 'Keep');
check((await count(panel, '.confirm')) === 0 && (await visible(panel, '#meeting-title-input')), 'Keep leaves the meeting alone');
await clickText(panel, '.mt-actions .text-button', 'Delete');
await until(() => visible(panel, '.confirm'), 'the delete question again');
await clickText(panel, '.confirm .primary-button', 'Delete');
await until(() => panel.eval(`!document.getElementById('meeting-title-input')`), 'the list after deleting');
await until(() => count(panel, '.mt-row').then((n) => n === 0), 'the list to be empty');
check((await count(panel, '.mt-row')) === 0, 'deleting removes the meeting');
const leftover = await frame.eval(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('meeting:')).length)`);
check(leftover === 0, 'and its stored record (no meeting: key is left in storage)');

step('a recording ends by itself when its tab ');
// ---- a recording ends by itself when its tab closes -----------------------------------------------------------------------------

// Another tab stays open (closing a window's last tab closes the window); the meeting tab goes in front of it.
await hub('newTab', plainUrl);
await wait(1500);
await hub('newTab', meetUrl);
await wait(2500);
await until(() => panel.eval(`!!document.getElementById('mt-primary') && !document.getElementById('mt-primary').disabled`), 'Start after the restart');
await click(panel, '#mt-primary');
await until(() => panel.eval(`document.getElementById('meetings').classList.contains('recording')`), 'the second recording', 60000);
await wait(4000);
// The tab being recorded is the one in front.
const chromeTabId = await frame.eval(`chrome.tabs.query({ active: true }).then((tabs) => tabs.find((t) => (t.url || '').startsWith(${JSON.stringify(meetUrl)}))?.id)`);
check(typeof chromeTabId === 'number', 'found the tab being recorded');
await frame.eval(`(chrome.tabs.remove(${chromeTabId}).catch(() => undefined), true)`);
await until(() => panel.eval(`!document.getElementById('meetings').classList.contains('recording')`), 'the recording to stop when its tab closed', 60000);
check(true, 'closing the meeting tab stops the recording');
await until(() => frame.eval(`chrome.storage.local.get('meetings:index').then((r) => (r['meetings:index'] ?? []).length)`).then((n) => n === 1), 'the saved meeting', 60000).catch(() => undefined);
const saved = await frame.eval(`chrome.storage.local.get('meetings:index').then((r) => (r['meetings:index'] ?? []).map((m) => m.endedBy))`);
check(saved[0] === 'tab-closed', 'and the meeting is kept, marked as ended by the tab closing');
await until(() => frame.eval(`chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false`).then((has) => !has), 'the capture page to close').catch(() => undefined);
check(!(await cdp.targets()).some((t) => t.url.includes('meetingsCapture.html')), 'the capture page is gone once the recording ends');

step('the helper going away');
// ---- the helper going away ends a recording too ------------------------------------------------------------------------------------

await hub('newTab', meetUrl);
await wait(2500);
await until(() => panel.eval(`!!document.getElementById('mt-primary') && !document.getElementById('mt-primary').disabled`), 'Start again');
// This one has no "tab" audio (the fixture is the microphone only), like a build where Chromium refuses tab capture.
await frame.eval(`chrome.storage.local.set({ 'meetings:testFixture': { me: ${JSON.stringify(speech.me.toString('base64'))} } })`);
await click(panel, '#mt-primary');
await until(() => panel.eval(`document.getElementById('meetings').classList.contains('recording')`), 'the third recording', 60000);
check(/Remote participants’ audio isn’t being captured yet/.test((await text(panel, '.mt-card .mt-notice')) ?? ''), 'a recording that never got the tab’s audio keeps saying so');
check((await count(panel, '.mt-meter')) === 1, 'and shows one level meter, not two');
await click(panel, '#meetings-close');
await until(() => visible(panel, '#rec-bar-hint'), 'the how-to in the recording bar');
check(/right-click inside the meeting page.*“UrAnus Browser: add this tab’s audio to the meeting notes”/.test((await text(panel, '#rec-bar-hint')) ?? ''), 'the recording bar carries the same how-to while there is no tab audio');
await shot(panel, 'meetings-4c-bar-hint-light-400');
await click(panel, '#rec-bar-open');
await until(() => sheetOpen(panel), 'the sheet again');
await wait(3000);
const hostPids = execFileSync('pgrep', ['-P', String(browser.pid)]).toString().split('\n').filter(Boolean);
const hostPid = hostPids.find((pid) => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', pid]).toString().includes('anus-host.cjs');
  } catch {
    return false;
  }
});
if (hostPid) {
  process.kill(Number(hostPid), 'SIGKILL');
  await until(() => panel.eval(`!document.getElementById('meetings').classList.contains('recording')`), 'the recording to stop when the helper went away', 60000);
  check(true, 'when the native helper goes away the recording stops');
  check(/helper stopped/.test((await text(panel, '.mt-notice')) ?? ''), 'and the panel says why');
} else {
  check(false, 'found the native helper process to stop');
}

step('Delete all');
// ---- Delete all ---------------------------------------------------------------------------------------------------------------------------

await until(() => count(panel, '.mt-row').then((n) => n >= 1), 'a saved meeting to delete', 30000).catch(() => undefined);
const before = await count(panel, '.mt-row');
if (before) {
  await clickText(panel, '.mt-past .text-button', 'Delete all');
  await until(() => visible(panel, '.confirm'), 'the Delete all question');
  check(/Delete all \d+ meetings/.test(await text(panel, '.confirm')), 'Delete all asks first, with the count');
  await clickText(panel, '.confirm .primary-button', 'Delete all');
  await until(() => count(panel, '.mt-row').then((n) => n === 0), 'the list to be empty');
  check(true, 'Delete all removes every meeting');
} else check(false, 'a meeting was saved when the helper went away (to delete)');

step('a start that fails');
// ---- a start that fails says why and offers the permission page ------------------------------------------------------------------------------

await frame.eval(`chrome.storage.local.set({ 'meetings:testMode': false })`);
await hub('newTab', meetUrl);
await wait(2500);
await until(() => panel.eval(`!!document.getElementById('mt-primary') && !document.getElementById('mt-primary').disabled`), 'Start for the failing case');
await click(panel, '#mt-primary');
await until(() => panel.eval(`!!document.querySelector('.sheet-error')`), 'the start error', 60000);
const err = await text(panel, '.sheet-error');
check(/microphone|permission/i.test(err), `a failed start says why (“${err}”)`);
check(!(await panel.eval(`document.getElementById('meetings').classList.contains('recording')`)), 'and nothing is recording');
if (/permission/i.test(err)) {
  await until(() => panel.eval(`[...document.querySelectorAll('.mt-card button')].some((b) => /Allow the microphone/.test(b.textContent))`), 'the permission button');
  await shot(panel, 'meetings-13-start-error-light-400');
  await clickText(panel, '.mt-card button', 'Allow the microphone…');
  const permTab = await cdp.waitTarget((t) => t.url.includes('meetingsCapture.html?permission=1'), 20000);
  const perm = await cdp.session(permTab.targetId);
  // The tab exists before its page has loaded: wait for the page's own elements.
  await until(() => perm.eval(`!!document.getElementById('permission') && !!document.getElementById('allow')`), 'the permission page', 20000);
  check(await perm.eval(`!document.getElementById('permission').hidden && document.getElementById('allow').textContent.includes('Allow microphone')`), 'the button opens the one-time microphone page in a tab');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
server.close();
process.exit(failed.length ? 1 : 0);
