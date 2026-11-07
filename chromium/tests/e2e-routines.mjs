// End-to-end test of Routines in a real Uranus Browser, driving the panel with real mouse events:
//   - the header button and the empty state; creating a routine (with the form's validation
//     messages), editing it and its trigger, switching it on and off;
//   - the routines survive quitting and reopening with the same profile;
//   - after a restart, what came due while Uranus Browser was closed is OVERDUE: shown with a badge
//     and a card, and not run; Skip drops one, Run now runs another for real (the local test
//     page and one cheap OpenAI call through the native host);
//   - the run leaves a record you can open, read and delete; deleting a routine asks first
//     and clears its alarm; screenshots in light and dark, at 360 and 720 px.
//
//   node chromium/tests/e2e-routines.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist]
//        [--shots <dir>] [--dev-host] [--no-openai]
//
// --dev-host points the profile at this checkout's native host (the app's bundled one predates
// routines: it runs the conversation fine but does not show the "Routine: <name>" notice).
// --no-openai skips the one real model call. The profile is a fresh one under tests/.scratch.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixture-server.mjs';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../..');
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const app = arg('--app', '/Applications/Uranus Browser.app');
const shellDir = arg('--shell-dir');
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `routines-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

const fixture = await startFixtureServer(0);
let browserLog = '';

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', '--window-position=60,40'];
  if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
  const browser = spawn(path.join(app, 'Contents/MacOS/Uranus Browser'), flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  reap(browser);
  browser.stdout.on('data', (d) => (browserLog += d));
  browser.stderr.on('data', (d) => (browserLog += d));
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
  if (has('--dev-host')) {
    const manifest = path.join(profile, 'NativeMessagingHosts/dev.oprimo.anus.host.json');
    await until(async () => fs.existsSync(manifest), "the app's native host registration", 60000).catch(() => undefined);
    execFileSync(path.join(repo, 'chromium/scripts/install-native-host.sh'), ['--only', profile], {
      stdio: 'ignore',
      env: { ...process.env, ANUS_HOST_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'anus-e2e-host-')) },
    });
  }
  return { browser, cdp, frame, hub };
}

async function openPanel(cdp, hub) {
  await hub('agentPanel:toggle');
  const t = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
  const panel = await cdp.session(t.targetId);
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.body.dataset.side && !document.getElementById('routines-open').hidden`), 'the panel page with its Routines button');
  return panel;
}

async function shot(panel, name) {
  await wait(450); // the sheet's entrance fade
  if (!shots) return;
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

/** Real mouse events at an element's centre (clicks, as a person would). */
async function click(panel, selector) {
  const at = await panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await panel.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}
/** Clicks the first element matching `selector` whose text is `label`. */
async function clickText(panel, selector, label) {
  const tag = `data-e2e-${Date.now()}`;
  const found = await panel.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!el) return false; el.setAttribute('${tag}', ''); return true; })()`);
  if (!found) throw new Error(`no ${selector} says “${label}”`);
  await click(panel, `[${tag}]`);
  await panel.eval(`document.querySelector('[${tag}]')?.removeAttribute('${tag}')`);
}

async function type(panel, selector, text) {
  await panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); el.value = ''; })()`);
  await panel.send('Input.insertText', { text });
}
/** Native pickers (time, date) take their value programmatically; the form reads it on Save. */
const setValue = (panel, selector, value) => panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);

const key = async (panel, name, code) => {
  await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
};

const text = (panel, selector) => panel.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const texts = (panel, selector) => panel.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
const count = (panel, selector) => panel.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const sheetOpen = (panel) => panel.eval(`!document.getElementById('routines-sheet').hidden`);
const rowText = (panel, name) => panel.eval(`[...document.querySelectorAll('.routine')].find((r) => r.querySelector('.routine-name').textContent === ${JSON.stringify(name)})?.innerText.replace(/\\s+/g, ' ') ?? null`);
/** Click a button inside the row of the named routine. */
async function clickInRow(panel, name, buttonSelector, label) {
  const tag = `data-e2e-${Math.random().toString(36).slice(2)}`;
  const found = await panel.eval(`(() => {
    const row = [...document.querySelectorAll('.routine')].find((r) => r.querySelector('.routine-name').textContent === ${JSON.stringify(name)});
    const el = row && [...row.querySelectorAll(${JSON.stringify(buttonSelector)})].find((b) => ${label === undefined ? 'true' : `b.textContent.trim().startsWith(${JSON.stringify(label)})`});
    if (!el) return false; el.setAttribute('${tag}', ''); return true; })()`);
  if (!found) throw new Error(`no ${buttonSelector} ${label ?? ''} in the row “${name}”`);
  await click(panel, `[${tag}]`);
}
const localInput = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** The same picture in light and dark, at 360 and 720 px wide. */
async function matrix(panel, hub, name) {
  for (const width of [360, 720]) {
    await hub('agentPanel:resize', width);
    await wait(500);
    for (const scheme of ['light', 'dark']) {
      await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await shot(panel, `${name}-${width}-${scheme}`);
    }
  }
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await hub('agentPanel:resize', 400);
  await wait(400);
}

const routinesView = (hub) => hub('routines:get');

// ---- first launch: the empty state, the form and its messages ------------------------------

let { browser, cdp, frame, hub } = await launch();
process.on('exit', () => browser.kill());
await hub('finishOnboarding');
let panel = await openPanel(cdp, hub);

check(await panel.eval(`!document.getElementById('routines-open').hidden`), 'the header has a Routines button (clock)');
check((await panel.eval(`document.getElementById('routines-open').getAttribute('aria-expanded')`)) === 'false', 'it says the sheet is closed');
check(await panel.eval(`document.getElementById('routines-badge').hidden`), 'no overdue badge yet');
check(!(await sheetOpen(panel)), 'the sheet starts closed');

await click(panel, '#routines-open');
await until(() => sheetOpen(panel), 'the Routines sheet');
check((await panel.eval(`document.getElementById('routines-open').getAttribute('aria-expanded')`)) === 'true', 'opening it sets aria-expanded');
await until(() => panel.eval(`!!document.querySelector('.routines-empty')`), 'the empty state');
const empty = await text(panel, '.routines-empty');
check(/only while Uranus Browser is open/i.test(empty), `the empty state says routines run only while Uranus Browser is open: “${empty.replace(/\s+/g, ' ').slice(0, 120)}…”`);
check(/waits for you/i.test(empty), 'and that a missed one waits for you');
check(await panel.eval(`document.activeElement?.id === 'routines-new'`), 'focus moves to “New routine”');
await shot(panel, '1-empty');

await click(panel, '#routines-new');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
check((await text(panel, '#routines-title')) === 'New routine', 'the form is titled New routine');
check((await panel.eval(`document.activeElement?.id`)) === 'rf-name', 'focus is in the name field');
check((await count(panel, '.day[aria-pressed="true"]')) === 5, 'daily is the default, on weekdays');
check((await panel.eval(`document.getElementById('rf-time').value`)) === '09:00', 'at 09:00');
await shot(panel, '2-form-empty');

// Validation: each message names the field and the field is marked.
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!!document.querySelector('.sheet-error')`), 'the empty-name message');
check(/name/i.test(await text(panel, '.sheet-error')), 'saving without a name is refused with a reason');
check((await panel.eval(`document.getElementById('rf-name').getAttribute('aria-invalid')`)) === 'true' && (await panel.eval(`document.activeElement?.id`)) === 'rf-name', 'the name field is marked invalid and focused');
await type(panel, '#rf-name', 'Page title');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`/what the agent should do/i.test(document.querySelector('.sheet-error')?.textContent ?? '')`), 'the instructions message');
check((await panel.eval(`document.activeElement?.id`)) === 'rf-instructions', 'a missing instruction puts the cursor in the instructions');
await type(panel, '#rf-instructions', 'Read this page with read_page and tell me its title in one short sentence. Do not click anything.');
check((await text(panel, '.rf-counter')).startsWith('99/') || /^\d+\/2000$/.test(await text(panel, '.rf-counter')), 'the instructions show a character count');
// Too short an interval.
await click(panel, '.segment[data-kind="interval"]');
check(await panel.eval(`document.getElementById('when-interval').hidden === false && document.getElementById('when-daily').hidden`), 'the trigger picker switches to “every few minutes”');
await type(panel, '#rf-minutes', '10');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`/15 minutes/.test(document.querySelector('.sheet-error')?.textContent ?? '')`), 'the 15-minute message');
check(true, 'an interval under 15 minutes is refused: “' + (await text(panel, '.sheet-error')) + '”');
// No days.
await click(panel, '.segment[data-kind="daily"]');
for (let i = 0; i < 5; i++) await click(panel, '.day[aria-pressed="true"]');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`/at least one day/i.test(document.querySelector('.sheet-error')?.textContent ?? '')`), 'the days message');
check(true, 'no days is refused: “' + (await text(panel, '.sheet-error')) + '”');
await shot(panel, '3-form-error');
await click(panel, '.day-presets .text-button');
check((await count(panel, '.day[aria-pressed="true"]')) === 5, '“Weekdays” picks Monday to Friday again');
await setValue(panel, '#rf-time', '09:30');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!document.getElementById('rf-name')`), 'the form to close after saving');

let rows = await count(panel, '.routine');
check(rows === 1, 'the routine is listed');
let row = await rowText(panel, 'Page title');
check(/General · Weekdays at 09:30/.test(row), `its companion and trigger are shown: “${row}”`);
check(/Next: (Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2} \w{3}) 09:30/.test(row), `and when it next runs: “${row.match(/Next: [^R]*/)?.[0]?.trim()}”`);
check((await panel.eval(`document.querySelector('.routine .switch').getAttribute('aria-checked')`)) === 'true', 'it is on');
let view = await routinesView(hub);
const pageTitleId = view.routines[0].id;
const alarmsNow = async () => frame.eval(`chrome.alarms.getAll().then((a) => a.filter((x) => x.name.startsWith('routine:')).map((x) => ({ name: x.name, when: x.scheduledTime })))`);
check((await alarmsNow()).some((a) => a.name === `routine:${pageTitleId}`), 'an alarm is set for it (chrome.alarms)');
await shot(panel, '4-list-one');

// Edit: rename, and change the trigger to every 30 minutes.
await clickInRow(panel, 'Page title', '.icon-button');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the edit form');
check((await text(panel, '#routines-title')) === 'Edit routine', 'editing opens the form titled Edit routine');
check((await panel.eval(`document.getElementById('rf-name').value`)) === 'Page title' && (await panel.eval(`document.getElementById('rf-time').value`)) === '09:30', 'with the routine’s own values');
check((await panel.eval(`document.querySelector('.segment[aria-checked="true"]').dataset.kind`)) === 'daily', 'and the trigger picker on Daily');
await type(panel, '#rf-name', 'Page title check');
await click(panel, '.segment[data-kind="interval"]');
await type(panel, '#rf-minutes', '30');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!document.getElementById('rf-name')`), 'the form to close');
row = await rowText(panel, 'Page title check');
check(!!row && /Every 30 minutes/.test(row), `the edit shows in the list: “${row}”`);
const pa = (await alarmsNow()).find((a) => a.name === `routine:${pageTitleId}`);
check(!!pa && Math.abs(pa.when - (Date.now() + 30 * 60_000)) < 3 * 60_000, 'its alarm moved to about 30 minutes from now');

// A second routine: once, as the Researcher.
await click(panel, '#routines-new');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
await type(panel, '#rf-name', 'One-off summary');
await panel.eval(`(() => { const s = document.getElementById('rf-companion'); s.value = 'researcher'; s.dispatchEvent(new Event('change')); })()`);
await type(panel, '#rf-instructions', 'Summarise this page in two sentences.');
await click(panel, '.segment[data-kind="once"]');
await setValue(panel, '#rf-at', localInput(Date.now() - 3600_000));
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`/future/i.test(document.querySelector('.sheet-error')?.textContent ?? '')`), 'the past-time message');
check(true, 'a once-only time in the past is refused: “' + (await text(panel, '.sheet-error')) + '”');
check((await panel.eval(`document.activeElement?.id`)) === 'rf-at', 'and the date field is focused');
await setValue(panel, '#rf-at', localInput(Date.now() + 2 * 3600_000));
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!document.getElementById('rf-name')`), 'the form to close');
row = await rowText(panel, 'One-off summary');
check(/Researcher · Once, Today/.test(row ?? '') || /Researcher · Once, Tomorrow/.test(row ?? ''), `the once-only routine: “${row}”`);

// A third, switched off with a real click.
await click(panel, '#routines-new');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
await type(panel, '#rf-name', 'Weekly check');
await type(panel, '#rf-instructions', 'Look at this page.');
await click(panel, '#rf-enabled');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!document.getElementById('rf-name')`), 'the form to close');
row = await rowText(panel, 'Weekly check');
check(/Off/.test(row ?? ''), `a routine saved switched off says Off: “${row}”`);
const weeklyId = (await routinesView(hub)).routines.find((r) => r.name === 'Weekly check').id;
check(!(await alarmsNow()).some((a) => a.name === `routine:${weeklyId}`), 'and has no alarm');
await clickInRow(panel, 'Weekly check', '.switch');
await until(async () => (await panel.eval(`[...document.querySelectorAll('.routine')].find((r) => r.querySelector('.routine-name').textContent === 'Weekly check').querySelector('.switch').getAttribute('aria-checked')`)) === 'true', 'the switch to turn on');
check((await alarmsNow()).some((a) => a.name === `routine:${weeklyId}`), 'switching it on sets its alarm');
await clickInRow(panel, 'Weekly check', '.switch');
await until(async () => (await panel.eval(`[...document.querySelectorAll('.routine')].find((r) => r.querySelector('.routine-name').textContent === 'Weekly check').querySelector('.switch').getAttribute('aria-checked')`)) === 'false', 'the switch to turn off');
check(!(await alarmsNow()).some((a) => a.name === `routine:${weeklyId}`), 'switching it off clears its alarm');
check((await rowText(panel, 'Weekly check')).includes('Off'), 'and the row says Off');
await shot(panel, '5-list-three');

// Escape: closes the form first, then the sheet; the panel stays.
await clickInRow(panel, 'Weekly check', '.icon-button');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
await key(panel, 'Escape', 27);
await until(() => panel.eval(`!document.getElementById('rf-name')`), 'Escape to leave the form').catch(() => undefined);
check((await sheetOpen(panel)) && (await count(panel, '.routine')) === 3, 'Escape leaves the form and keeps the sheet');
await key(panel, 'Escape', 27);
await until(async () => !(await sheetOpen(panel)), 'Escape to close the sheet').catch(() => undefined);
check(!(await sheetOpen(panel)) && !!(await cdp.targets()).find((t) => t.url.includes('/agent.html')), 'a second Escape closes the sheet and leaves the panel open');
check((await panel.eval(`document.activeElement?.id`)) === 'routines-open', 'focus returns to the Routines button');

// ---- restart: everything is still there -----------------------------------------------------

// Make two of them overdue the way a closed Uranus Browser would: their time passes while it is quit.
await frame.eval(`(async () => {
  const { routines } = await chrome.storage.local.get('routines');
  const past = Date.now() - 3 * 3600_000;
  for (const r of routines) {
    if (r.name === 'Page title check') r.nextAt = past;
    if (r.name === 'One-off summary') { r.trigger.at = past; r.nextAt = past; }
  }
  await chrome.storage.local.set({ routines });
  return true;
})()`);
await wait(300);
browser.kill();
await new Promise((r) => browser.once('exit', r));
await wait(1500);
({ browser, cdp, frame, hub } = await launch());
panel = await openPanel(cdp, hub);

// Nothing ran by itself, whatever was due.
await wait(3000);
check((await count(panel, '#transcript > li')) === 0, 'after the restart nothing has run: the conversation is empty');
check(await panel.eval(`document.getElementById('empty').hidden === false`), 'and the panel shows its usual empty state');
const badge = await text(panel, '#routines-badge');
check(!(await panel.eval(`document.getElementById('routines-badge').hidden`)) && badge === '2', `the header button shows 2 overdue (badge “${badge}”)`);
check(/2 overdue/.test(await panel.eval(`document.getElementById('routines-open').getAttribute('aria-label')`)), 'its accessible name says so');
const cardText = await panel.eval(`document.getElementById('routines-card').hidden ? null : document.getElementById('routines-card').innerText.replace(/\\s+/g, ' ')`);
check(/Routine overdue: .+Was due/.test(cardText ?? '') && /1 more/.test(cardText ?? ''), `a card above the conversation offers Run now / Skip: “${cardText}”`);
view = await routinesView(hub);
check(view.routines.length === 3, 'all three routines survived the restart');
check(view.routines.find((r) => r.name === 'One-off summary').companionId === 'researcher', 'with their companion');
check(view.routines.find((r) => r.name === 'Weekly check').enabled === false, 'and their on/off state');
check(view.routines.filter((r) => r.status === 'overdue').length === 2, 'two are overdue; the one switched off is not');
check((await alarmsNow()).some((a) => a.name === `routine:${view.routines.find((r) => r.name === 'Page title check').id}` && a.when > Date.now()), 'the repeating one has its next alarm in the future');
await shot(panel, '6-overdue-card');

await click(panel, '#routines-open');
await until(() => sheetOpen(panel), 'the sheet');
await until(() => panel.eval(`document.querySelectorAll('.routine.overdue').length === 2`), 'two overdue rows');
const overdueRow = await rowText(panel, 'Page title check');
check(/Overdue: was due/.test(overdueRow) && /Run now/.test(overdueRow) && /Skip/.test(overdueRow), `an overdue row says so and offers Run now and Skip: “${overdueRow}”`);
await matrix(panel, hub, '7-overdue-list');

// Skip the once-only one.
await clickInRow(panel, 'One-off summary', '.secondary-button', 'Skip');
await until(async () => !/Overdue/.test((await rowText(panel, 'One-off summary')) ?? ''), 'the skip');
check(/Ran once/.test(await rowText(panel, 'One-off summary')), `skipping a once-only routine finishes it: “${await rowText(panel, 'One-off summary')}”`);
check((await text(panel, '#routines-badge')) === '1', 'the badge counts one now');
check((await count(panel, '#transcript > li')) === 0, 'and still nothing has run');
await clickInRow(panel, 'One-off summary', '.text-button', 'History');
await until(() => panel.eval(`!!document.querySelector('.record')`), 'the history');
check((await texts(panel, '.status-chip')).includes('Skipped'), 'its history has a Skipped record');
await key(panel, 'Escape', 27);
await until(() => panel.eval(`!document.querySelector('.record')`), 'back to the list');

// Run now, for real.
if (has('--no-openai')) {
  console.log('  (skipping the real run: --no-openai)');
} else {
  await hub('newTab', fixture.url);
  const pageTarget = await cdp.waitTarget((t) => t.type === 'page' && t.url.startsWith(fixture.url));
  const page = await cdp.session(pageTarget.targetId);
  await until(() => page.eval(`document.readyState === 'complete'`), 'the test page');
  await wait(800);
  await clickInRow(panel, 'Page title check', '.primary-button', 'Run now');
  await until(async () => !(await sheetOpen(panel)), 'the sheet to close as the run starts');
  check(true, 'Run now closes the sheet and the conversation takes over');
  await until(() => panel.eval(`!!document.querySelector('#transcript .msg.user')`), 'the instructions as the user’s message', 60000);
  const asked = await text(panel, '#transcript .msg.user .bubble');
  check(/tell me its title/.test(asked), `the routine’s instructions were sent as the user’s message: “${asked.slice(0, 70)}…”`);
  const first = await panel.eval(`document.querySelector('#transcript > li')?.innerText ?? ''`);
  const hasNotice = /^Routine: Page title check/.test(first);
  console.log(`  ("Routine: <name>" notice ${hasNotice ? 'shown' : 'not shown: this host predates routines; use --dev-host to see it'})`);
  if (has('--dev-host')) check(hasNotice, 'the conversation opens with the notice “Routine: Page title check”');
  check((await text(panel, '#companion-name')) === 'General', 'it ran as the routine’s companion (General)');
  await until(() => panel.eval(`document.getElementById('status').dataset.status === 'idle' && !!document.querySelector('#transcript .msg.assistant')`), 'the agent to answer', 150000);
  const answer = (await texts(panel, '#transcript .msg.assistant .text')).join(' ');
  check(/agent test page/i.test(answer), `the agent read the page and answered: “${answer.slice(0, 120)}”`);
  check(!(await count(panel, '.approval')), 'a read-only routine needed no approval card');
  await shot(panel, '8-run-conversation');
  await wait(600);

  // The record.
  await click(panel, '#routines-open');
  await until(() => sheetOpen(panel), 'the sheet');
  await until(async () => /Last run: Done/.test((await rowText(panel, 'Page title check')) ?? ''), 'the row to show the last run');
  check(true, `the row shows the last run: “${(await rowText(panel, 'Page title check')).match(/Last run:[^E]*/)?.[0]?.trim()}”`);
  check(await panel.eval(`document.getElementById('routines-badge').hidden`), 'nothing is overdue now: the badge is gone');
  check(await panel.eval(`document.getElementById('routines-card').hidden`), 'and so is the card');
  await clickInRow(panel, 'Page title check', '.text-button', 'History');
  await until(() => panel.eval(`!!document.querySelector('.record')`), 'the history');
  check((await count(panel, '.record')) === 1 && (await texts(panel, '.status-chip'))[0] === 'Done', 'one record, with status Done');
  await click(panel, '.record-main');
  await until(() => panel.eval(`!!document.querySelector('.run-lines')`), 'the viewer');
  const lines = await texts(panel, '.run-line');
  check(lines.some((l) => /Instructions/.test(l) && /tell me its title/.test(l)) && lines.some((l) => /Agent/.test(l) && /agent test page/i.test(l)), 'the viewer shows the instructions and the agent’s answer as plain text');
  // Which tool the model picks to find a title (reading the page, or asking for the active tab) is its choice.
  check(lines.some((l) => /^Step · done/.test(l)), 'and a step it took');
  check((await text(panel, '#routines-title')) === 'Run', 'the viewer is titled Run');
  await matrix(panel, hub, '9-run-viewer');
  await click(panel, '#routines-back');
  await until(() => panel.eval(`!!document.querySelector('.record')`), 'back to the history');
  await click(panel, '.record .icon-button');
  await until(() => panel.eval(`!document.querySelector('.record')`), 'the record to go');
  check((await count(panel, '.record')) === 0 && /No runs yet/.test(await text(panel, '.memory-empty')), 'Delete record removes it');
  await click(panel, '#routines-back');
  await until(() => panel.eval(`!!document.querySelector('.routine')`), 'the list');
}

// ---- delete with confirmation, and the alarm goes ---------------------------------------------

await clickInRow(panel, 'Weekly check', '.icon-button');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
await click(panel, '.edit-actions .text-button.danger');
await until(() => panel.eval(`!!document.querySelector('.confirm')`), 'the confirmation');
check(/Delete “Weekly check”/.test(await text(panel, '.confirm')), 'deleting asks first, by name');
await clickText(panel, '.confirm button', 'Keep');
await until(() => panel.eval(`!document.querySelector('.confirm')`), 'the confirmation to go');
check((await text(panel, '#routines-title')) === 'Edit routine', 'Keep leaves the form as it was');
await click(panel, '.edit-actions .text-button.danger');
await until(() => panel.eval(`!!document.querySelector('.confirm')`), 'the confirmation');
await clickText(panel, '.confirm button', 'Delete');
await until(async () => (await rowText(panel, 'Weekly check')) === null && (await count(panel, '.routine')) === 2, 'the routine to go');
check(true, 'confirming removes the routine');

const pageTitle = (await routinesView(hub)).routines.find((r) => r.name === 'Page title check');
await clickInRow(panel, 'Page title check', '.icon-button');
await until(() => panel.eval(`!!document.getElementById('rf-name')`), 'the form');
check((await alarmsNow()).some((a) => a.name === `routine:${pageTitle.id}`), 'before deleting it has an alarm');
await shot(panel, '10-edit-form');
await click(panel, '.edit-actions .text-button.danger');
await until(() => panel.eval(`!!document.querySelector('.confirm')`), 'the confirmation');
await shot(panel, '11-delete-confirm');
await clickText(panel, '.confirm button', 'Delete');
await until(async () => (await rowText(panel, 'Page title check')) === null, 'the routine to go');
check(!(await alarmsNow()).some((a) => a.name === `routine:${pageTitle.id}`), 'deleting a routine clears its alarm');
check((await routinesView(hub)).routines.length === 1, 'one routine is left (the finished once-only one)');
await matrix(panel, hub, '12-list-final');

// ---- a routine that comes due by itself, with the panel closed ------------------------------------

if (!has('--no-openai')) {
  // The sheet is left open on purpose: a run that begins by itself should close it, to show the conversation.
  if (!(await sheetOpen(panel))) await click(panel, '#routines-open');
  await until(() => sheetOpen(panel), 'the sheet');
  await hub('agentPanel:close');
  await until(async () => (await hub('agentPanel:get')).open === false, 'the panel to close');
  check(true, 'the Agent panel is closed while the routine is waiting for its time');
  const minute = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
  const made = await hub('routines:save', {
    name: 'Auto title',
    companionId: 'general',
    instructions: 'Read this page with read_page and tell me its title in one short sentence. Do not click anything.',
    trigger: { kind: 'once', at: minute },
  });
  check(!!made.id && !made.error, `a once-only routine is saved for the next minute (${made.error ?? 'ok'})`);
  console.log(`  (waiting ${Math.round((minute - Date.now()) / 1000)} s for it to come due…)`);
  await until(async () => (await hub('agentPanel:get')).open === true, 'the panel to open by itself', minute - Date.now() + 90_000);
  check(true, 'when it came due, the panel opened by itself (approval cards would show there)');
  const target = (await cdp.targets()).filter((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`)).at(-1);
  panel = await cdp.session(target.targetId);
  await until(() => panel.eval(`document.readyState === 'complete' && !!document.querySelector('#transcript .msg.user')`), 'the conversation', 60000);
  check(!(await sheetOpen(panel)), 'the Routines sheet closed itself, so the conversation (and any approval card) is what you see');
  check(/tell me its title/.test(await text(panel, '#transcript .msg.user .bubble')), 'it started a new conversation with the routine’s instructions as the user’s message');
  if (has('--dev-host')) check(/^Routine: Auto title/.test(await panel.eval(`document.querySelector('#transcript > li')?.innerText ?? ''`)), 'under the notice “Routine: Auto title”');
  await until(() => panel.eval(`document.getElementById('status').dataset.status === 'idle' && !!document.querySelector('#transcript .msg.assistant')`), 'the agent to answer', 150000);
  check(/agent test page/i.test((await texts(panel, '#transcript .msg.assistant .text')).join(' ')), 'the agent read the page and answered');
  await until(async () => (await hub('routines:history', made.id)).records?.[0]?.status === 'done', 'the record', 20000);
  const record = (await hub('routines:history', made.id)).records[0];
  check(record.status === 'done' && record.transcript.length >= 3, `its record says Done with ${record.transcript.length} transcript lines`);
  check((await routinesView(hub)).routines.find((r) => r.id === made.id).status === 'finished', 'and the once-only routine is finished');
  check(!(await alarmsNow()).some((a) => a.name === `routine:${made.id}`), 'its alarm is gone');
  await shot(panel, '13-auto-run');
}

// ---- the key never reaches the panel -------------------------------------------------------------

if (!has('--no-openai')) {
  const keyHint = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'dev.oprimo.anus.agent.openai', '-a', 'api-key', '-w']).toString().trim();
  const panelHtml = await panel.eval('document.documentElement.outerHTML');
  const stored = await panel.eval(`(async () => JSON.stringify(await chrome.storage.local.get(null)))()`);
  for (const [where, body] of Object.entries({ 'the panel page': panelHtml, 'the profile’s routine storage': stored, 'browser output': browserLog })) {
    check(!body.includes(keyHint) && !body.includes(keyHint.slice(-12)), `the API key is not in ${where}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
fixture.server.close();
cdp.ws.close();
process.exit(failed.length ? 1 : 0);
