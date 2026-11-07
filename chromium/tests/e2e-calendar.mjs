// End-to-end test of calendar reminders for meeting notes, in a real UrAnus Browser with a
// throwaway profile (no network: the calendar's last reading is put in the profile's storage,
// as the background keeps it, so no iCal address is fetched):
//   - after a restart the background reads it, notifies about a meeting starting in under two
//     minutes (chrome.notifications), and the panel's strip shows it with Open & record;
//   - the Meetings sheet's Upcoming card lists it;
//   - Open & record opens the meeting link in a new tab and the sheet on the ready card,
//     without starting a recording; a dismissed meeting doesn't come back;
//   - a Meet tab in front gets "Record this meeting?", and Not now hides it.
//
//   node chromium/tests/e2e-calendar.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>] [--live]
// --live also reads a real Google calendar over the network (Google's public holiday calendar,
// no secret): the fetch from the extension, the redirect, Google's ICS and the parser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';
import { makeSpeech } from './meetings-fixtures.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shots = arg('--shots');
const shellDir = arg('--shell-dir');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `calendar-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/UrAnus Browser'),
    [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40', ...(shellDir ? [`--anus-shell-dir=${path.resolve(shellDir)}`] : [])],
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
  return { browser, cdp, frame, hub };
}

async function openPanel(cdp, hub) {
  await hub('agentPanel:toggle');
  const t = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
  const panel = await cdp.session(t.targetId);
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.body.dataset.side`), 'the panel page');
  return panel;
}

async function shot(panel, name) {
  await wait(450);
  if (!shots) return;
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

async function click(panel, selector) {
  const at = await panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
const text = (panel, selector) => panel.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const visible = (panel, selector) => panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.hidden && el.getClientRects().length > 0; })()`);

// ---- seed the calendar's last reading, then start again so the background reads it ----------

let { browser, cdp, frame, hub } = await launch();
await hub('finishOnboarding');
const start = Date.now() + 90_000;
const MEET = 'https://meet.google.com/abc-defg-hij';
const seeded = await frame.eval(`chrome.storage.local.set({
  'calendar:url': 'https://calendar.google.com/calendar/ical/test%40example.com/private-0000/basic.ics',
  'calendar:cache': { checkedAt: Date.now(), events: 2, meetings: [
    { id: 'ev-0123456789abcdef', title: 'Weekly sync <b>bold</b>', start: ${start}, end: ${start + 1_800_000}, url: '${MEET}' },
    { id: 'ev-fedcba9876543210', title: 'Design review', start: ${start + 3 * 3_600_000}, end: ${start + 4 * 3_600_000}, url: 'https://acme.zoom.us/j/123456789' },
    { id: 'ev-1111111111111111', title: 'Not a meeting link', start: ${start + 3_600_000}, end: ${start + 7_200_000}, url: 'https://evil.example/j/1' },
  ] },
}).then(() => true)`);
check(seeded === true, 'the calendar’s last reading is in the profile');
browser.kill();
await new Promise((r) => browser.once('exit', r));
await wait(1500);
({ browser, cdp, frame, hub } = await launch());

// ---- the notification, the strip, the Upcoming card ---------------------------------------------

const level = await frame.eval(`new Promise((r) => chrome.notifications.getPermissionLevel(r))`);
check(level === 'granted', `notifications are allowed for the shell (${level})`);
const notes = await until(async () => {
  const all = await frame.eval(`new Promise((r) => chrome.notifications.getAll(r))`);
  return Object.keys(all ?? {}).length ? all : false;
}, 'the reminder notification', 20000).catch(() => ({}));
check(Object.keys(notes).length === 1, 'one reminder notification, for the meeting about to start (not the later ones)');

const panel = await openPanel(cdp, hub);
await until(() => visible(panel, '#meeting-strip'), 'the strip', 15000).catch(() => undefined);
check(await visible(panel, '#meeting-strip'), 'the panel shows a strip for the meeting about to start');
const strip = (await text(panel, '#meeting-strip')) ?? '';
check(/Weekly sync <b>bold<\/b>/.test(strip) && /Meet/.test(strip) && /Open & record/.test(strip), 'the strip names it as plain text, with its platform and Open & record');
await shot(panel, 'calendar-1-strip');

await click(panel, '#meetings');
await until(() => panel.eval(`!document.getElementById('meetings-sheet').hidden`), 'the meetings sheet');
await wait(400);
const sheet = (await text(panel, '#meetings-body')) ?? '';
check(/Weekly sync/.test(sheet) && /Design review/.test(sheet), 'the Upcoming card lists today’s meetings');
check((await panel.eval(`[...document.querySelectorAll('.mt-up-title')].every((el) => el.scrollWidth <= el.clientWidth + 1 || el.clientWidth > 150)`)), 'each title gets room beside its buttons');
check(!/Not a meeting link/.test(sheet), 'an event whose link isn’t a real meeting host is left out');
check(/tell|recording/i.test(sheet), 'the sheet reminds you to tell people you’re recording');
await shot(panel, 'calendar-2-upcoming');
await click(panel, '#meetings-close');
await wait(300);

// ---- Open & record --------------------------------------------------------------------------------

const before = (await cdp.targets()).filter((t) => t.type === 'page' && t.url.startsWith(MEET)).length;
await click(panel, '#meeting-strip .primary-button');
const opened = await until(async () => (await cdp.targets()).filter((t) => t.type === 'page' && t.url.startsWith('https://meet.google.com/')).length > before, 'the meeting tab', 20000).then(() => true, () => false);
check(opened, 'Open & record opens the meeting link in a tab');
await until(() => panel.eval(`!document.getElementById('meetings-sheet').hidden`), 'the ready card', 15000).catch(() => undefined);
const ready = (await text(panel, '#meetings-body')) ?? '';
// Open & record starts the notes by itself when it can; this test profile has no microphone
// permission, so it can't, and the ready card asks instead (nothing records).
check(/Ready to record/i.test(ready), 'notes that can’t start by themselves fall back to the ready card');
check(!(await panel.eval(`document.getElementById('meetings').classList.contains('recording')`)), 'and nothing records meanwhile');
await shot(panel, 'calendar-3-ready');
await click(panel, '#meetings-close');
await wait(500);

// ---- a meeting tab in front: "Record notes?" -------------------------------------------------------
// (Open & record already answered for that meeting, so it isn't asked again there: another one is.)
check(!/Record this meeting/.test((await text(panel, '#meeting-strip')) ?? ''), 'the meeting you chose to record isn’t offered again');
const meetTab = (await cdp.targets()).find((t) => t.type === 'page' && t.url.startsWith('https://meet.google.com/'));
const meetPage = await cdp.session(meetTab.targetId);
await meetPage.send('Page.navigate', { url: 'https://meet.google.com/xyz-wxyz-xyz' });
await wait(3000);

console.log('  meeting tab is at', (await cdp.targets()).filter((t) => t.type === 'page' && /meet\.google/.test(t.url)).map((t) => t.url));
await until(() => visible(panel, '#meeting-strip'), 'the tab offer', 15000).catch(() => undefined);
const offer = (await text(panel, '#meeting-strip')) ?? '';
check(/Record this meeting/.test(offer), 'with the Meet tab in front, the strip offers to record notes');
await shot(panel, 'calendar-4-tab-offer');
const notNow = await panel.eval(`[...document.querySelectorAll('#meeting-strip button')].findIndex((b) => /Not now/.test(b.textContent))`);
if (notNow >= 0) await click(panel, `#meeting-strip .meeting-strip-actions button:nth-child(${notNow + 1})`);
await wait(800);
const after = (await text(panel, '#meeting-strip')) ?? '';
check(!/Record this meeting/.test(after) || !(await visible(panel, '#meeting-strip')), '“Not now” takes the offer away for that meeting');

// ---- a routine around meetings -------------------------------------------------------------------

const saved = await hub('routines:save', { name: 'Prep', companionId: 'general', instructions: 'Brief me for this meeting.', trigger: { kind: 'meeting', when: 'before', minutes: 1, match: 'weekly' } });
check(typeof saved?.id === 'string', 'a routine “1 min before meetings with weekly in the title” is saved');
const rv = await hub('routines:get');
const prep = rv.routines.find((r) => r.id === saved.id);
check(rv.calendar?.connected === true && rv.calendar.upcoming >= 1, 'routines see the connected calendar and its meetings');
check(prep?.nextAt === start - 60_000, 'it is scheduled one minute before the Weekly sync, not before the Design review');
await click(panel, '#routines-open');
await until(() => panel.eval(`!document.getElementById('routines-sheet').hidden`), 'the routines sheet');
await until(() => panel.eval(`!!document.querySelector('.routine')`), 'the routine row', 10000).catch(() => undefined);
check(/1 min before meetings with “weekly” in the title/.test((await text(panel, '.routine-meta')) ?? ''), 'its row says when, in words');
await shot(panel, 'calendar-5-routine-row');
await click(panel, '#routines-new');
await until(() => panel.eval(`!!document.querySelector('.rf-template')`), 'the form');
await click(panel, '.rf-template:nth-child(2)');
await until(() => panel.eval(`document.getElementById('rf-name').value === 'Follow up after meetings'`), 'the template to fill the form', 5000).catch(() => undefined);
check((await panel.eval(`document.getElementById('rf-name').value`)) === 'Follow up after meetings' && (await panel.eval(`document.querySelector('[data-kind="meeting"]').getAttribute('aria-checked')`)) === 'true' && (await panel.eval(`document.getElementById('rf-when').value`)) === 'after', 'a template fills the form: a meeting trigger, after');
await shot(panel, 'calendar-6-routine-form');
await click(panel, '#routines-close');
await wait(300);
await hub('routines:runNow', saved.id);
await until(async () => /<<<MEETING/.test((await text(panel, '.msg.user .bubble')) ?? ''), 'the routine’s message', 20000).catch(() => undefined);
const sent = (await text(panel, '.msg.user .bubble')) ?? '';
check(sent.startsWith('Brief me for this meeting.') && /Title: Weekly sync <b>bold<\/b>/.test(sent) && /MEETING>>>/.test(sent), 'Run now sends the instructions and the meeting, fenced');
await shot(panel, 'calendar-7-routine-run');

// ---- Agent in a meeting: no pasting ---------------------------------------------------------------------
// With the assistant switched on, the join form fills the link in from the meeting tab in front, and
// offers this tab and today's calendar meetings as one-click picks.
await hub('joinly:save', { enabled: true, consent: true });
await click(panel, '#joinly-open');
await until(() => panel.eval(`!!document.getElementById('jn-link')`), 'the join form', 15000).catch(() => undefined);
const form = await panel.eval(`({ link: document.getElementById('jn-link')?.value ?? '', picks: [...document.querySelectorAll('.jn-pick strong')].map((s) => s.textContent), note: document.getElementById('jn-link-note')?.textContent ?? '' })`);
check(form.link === 'https://meet.google.com/xyz-wxyz-xyz' && /From the tab you’re on/.test(form.note), `the link is filled in from the meeting tab in front, as the meeting's own address (${form.link})`);
check(form.picks[0] === 'This tab' && form.picks.includes('Weekly sync <b>bold</b>') && form.picks.includes('Design review'), `picks: this tab and today's meetings (${form.picks.join(' | ')})`);
await shot(panel, 'calendar-9-join-picks');
await panel.eval(`[...document.querySelectorAll('.jn-pick')].find((b) => b.textContent.includes('Design review')).click(), true`);
await wait(200);
check((await panel.eval(`document.getElementById('jn-link').value`)) === 'https://acme.zoom.us/j/123456789' && /From your calendar: Design review/.test(await panel.eval(`document.getElementById('jn-link-note').textContent`)), 'a calendar pick fills in its link, and says where it came from');
await click(panel, '#joinly-close');
await hub('joinly:save', { enabled: false });
await wait(300);

// ---- Open & record starts the notes by itself ---------------------------------------------------------
// With the meetings test audio in place of a microphone (the test mode e2e-meetings uses), the
// recording starts without a click on Start, and a "Recording …" notification says so, with Stop.
const engines = (await hub('meetings:get'))?.view?.engines ?? [];
if (engines.some((e) => e.ready)) {
  const speech = makeSpeech(path.join(profile, 'speech'));
  await frame.eval(`chrome.storage.local.set({ 'meetings:testMode': true, 'meetings:testFixture': { me: ${JSON.stringify(speech.me.toString('base64'))} } })`);
  await hub('calendar:openRecord', 'ev-fedcba9876543210');
  const recording = await until(() => panel.eval(`document.getElementById('meetings').classList.contains('recording')`), 'the recording', 30000).then(() => true, () => false);
  check(recording, 'Open & record on the Zoom meeting starts recording by itself, no Start click');
  const said = await until(async () => Object.keys((await frame.eval(`new Promise((r) => chrome.notifications.getAll(r))`)) ?? {}).includes('anus-calendar:recording'), 'the Recording notification', 15000).then(() => true, () => false);
  check(said, 'and a “Recording …” notification says so');
  await shot(panel, 'calendar-8-auto-recording');
  await hub('meetings:stop');
  await until(() => panel.eval(`!document.getElementById('meetings').classList.contains('recording')`), 'the recording to stop', 60000).catch(() => undefined);
  await frame.eval(`chrome.storage.local.set({ 'meetings:testMode': false })`);
} else {
  console.log('  (skipped the automatic start: no transcription engine is ready in this profile)');
}

if (process.argv.includes('--live')) {
  const tested = await hub('calendar:test', 'webcal://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics');
  check(!tested?.error && tested?.events > 10, `a real Google calendar is fetched and parsed (${tested?.error ?? `${tested?.events} events, ${tested?.meetings} with a meeting link`})`);
  const bad = await hub('calendar:test', 'https://calendar.google.com/calendar/ical/nobody-here-1234%40example.com/private-0000/basic.ics');
  check(!!bad?.error && !/private-0000/.test(bad.error), `a wrong address is refused without echoing it (${bad?.error})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
process.exit(failed.length ? 1 : 0);
