// End-to-end test of companions, their knowledge, skills and memory, in a real Uranus Browser
// (no OpenAI calls):
//   - the composer's selector shows who the agent works as and opens the companions sheet
//     ("Companions, skills and files…"); the sheet lists the built-in companions;
//   - choosing one, making one of your own (it opens on its profile), and adding and removing
//     notes in its Memory tab work with real clicks; a secret is refused as a note;
//   - Knowledge: project context is kept when you leave the field, a text file is attached
//     through the file picker and previewed;
//   - Skills: one is written in the form, "Use" puts it on the composer as a chip, and "/" in
//     the composer lists it;
//   - Escape steps back a screen, then closes the sheet, before the panel;
//   - after quitting and reopening with the same profile, all of it is still there.
//
//   node chromium/tests/e2e-companions.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>]
// With --shots, the panel's own pictures (through DevTools, so no Screen Recording permission) are saved there.
import { spawn, spawnSync } from 'node:child_process';
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
const shots = arg('--shots');
const shellDir = arg('--shell-dir');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `companions-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

async function launch() {
  fs.mkdirSync(profile, { recursive: true });
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  const browser = spawn(
    path.join(app, 'Contents/MacOS/Uranus Browser'),
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
  await until(() => panel.eval(`!!document.getElementById('chooser')?.getAttribute('aria-label')`), 'the composer’s selector');
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

async function type(panel, selector, text) {
  await panel.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ''; })()`);
  await panel.send('Input.insertText', { text });
}

const key = async (panel, name, code) => {
  await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
};

const text = (panel, selector) => panel.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (panel, selector) => panel.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const sheetOpen = (panel) => panel.eval(`!document.getElementById('sheet').hidden`);
/** Who the agent works as, as the composer's selector says it (its label is the mode). */
const companionName = (panel) => panel.eval(`document.getElementById('chooser').getAttribute('aria-label').split(',')[0]`);
/** Whether the selector comes to name `name` (it repaints when the shell's update arrives). */
const namesCompanion = (panel, name) =>
  until(async () => (await companionName(panel)) === name, `the selector to name ${name}`, 10000).then(() => true, () => false);
/** As a person does: the composer's selector, then "Companions and memory…". */
async function openSheet(panel) {
  await click(panel, '#chooser');
  await until(() => panel.eval(`!document.getElementById('chooser-pop').hidden`), 'the selector');
  await click(panel, '#chooser-manage');
  await until(() => sheetOpen(panel), 'the sheet to open');
}
const panelOpen = async (cdp) => !!(await cdp.targets()).find((t) => t.url.includes('/agent.html'));

// ---- first launch ------------------------------------------------------------------------

let { browser, cdp, frame, hub } = await launch();
await hub('finishOnboarding');
let panel = await openPanel(cdp, hub);

check(await namesCompanion(panel, 'General'), 'the composer shows the companion: General');
check(!(await sheetOpen(panel)), 'the sheet starts closed');

await openSheet(panel);
check(await panel.eval(`document.getElementById('chooser-pop').hidden`), 'opening the sheet closes the selector');
check((await count(panel, '#sheet [role="radio"].person-main')) === 6, 'six built-in companions are listed');
check((await panel.eval(`document.querySelector('.person-main[aria-checked="true"] .person-name').textContent`)) === 'General', 'General is the one in use');
check((await panel.eval(`document.activeElement?.getAttribute('role') === 'radio'`)), 'focus moves into the sheet');
await shot(panel, '1-companions-list');

// Choose another companion.
await click(panel, '.person:nth-child(2) .person-main');
await until(async () => !(await sheetOpen(panel)), 'the sheet to close after choosing');
check(await namesCompanion(panel, 'Researcher'), 'choosing Researcher changes the composer’s selector');
check(/Researcher:/.test(await text(panel, '#empty-title')), 'the empty state says who is ready');

// Make one of your own, with real typing.
await openSheet(panel);
await click(panel, '.sheet-body > div > button.secondary-button.wide');
await until(() => panel.eval(`!!document.getElementById('f-name')`), 'the form');
check((await text(panel, '#sheet-title')) === 'New companion', 'the form is titled New companion');
await shot(panel, '2-new-companion');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!!document.querySelector('.sheet-error')`), 'the empty-name error');
check(/name/i.test(await text(panel, '.sheet-error')), 'saving without a name is refused, with a reason');
await type(panel, '#f-name', 'Support desk');
await type(panel, '#f-role', 'Answers tickets');
await type(panel, '#f-instructions', 'Keep every reply under three sentences.');
await click(panel, '.swatch:nth-child(3)');
await click(panel, '.edit-actions .primary-button');
await until(() => panel.eval(`!document.getElementById('f-name')`), 'the form to close');
check((await text(panel, '.profile-name')) === 'Support desk' && !!(await text(panel, '.profile-active')), 'a new companion opens on its profile, in use');
check(await namesCompanion(panel, 'Support desk'), 'the composer’s selector follows');
check((await count(panel, '.profile-tab')) === 4 && (await panel.eval(`document.getElementById('ptab-about').getAttribute('aria-selected')`)) === 'true', 'the profile has four tabs, About first');
check((await text(panel, '.about-text')) === 'Keep every reply under three sentences.', 'About shows its instructions');
await shot(panel, '3a-profile-about');

// Knowledge: project context, then a file through the picker.
await click(panel, '#ptab-knowledge');
await until(() => panel.eval(`!!document.getElementById('k-context')`), 'the Knowledge tab');
await type(panel, '#k-context', 'We sell the Acme Router to small offices in Austria.');
await panel.eval(`document.getElementById('k-context').blur(), true`);
await until(() => panel.eval(`document.querySelector('.profile-tab-count') !== null && document.getElementById('ptab-knowledge').textContent.includes('1')`), 'the context to be saved', 10000).catch(() => undefined);
check(/Knowledge1/.test(await text(panel, '#ptab-knowledge')), 'leaving the context field saves it (the tab counts it)');
const sample = path.join(path.dirname(profile), `pricing-${Date.now()}.md`);
fs.writeFileSync(sample, '# Acme Router pricing\n\nSmall office: 49 EUR a month.\nEnterprise: ask sales.\n');
const { result } = await panel.send('Runtime.evaluate', { expression: `document.querySelector('.knowledge input[type=file]')` });
await panel.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [sample] });
await until(async () => (await count(panel, '.file:not(.reading)')) === 1, 'the file to be added', 20000);
check((await text(panel, '.file-name')) === path.basename(sample) && /Text · \d+ characters/.test(await text(panel, '.file-meta')), 'a picked file is listed with its kind and size');
await click(panel, '.file-main');
await until(async () => /49 EUR/.test((await text(panel, '.file-preview')) ?? ''), 'the preview', 10000).catch(() => undefined);
check(/49 EUR a month/.test((await text(panel, '.file-preview')) ?? ''), 'clicking a file shows the start of its text');
// A PDF goes to the helper, which reads it on this Mac (PDFKit). Needs a helper with extractText:
// the app's own (a packaged build), or skipped with a note when the app's helper is older.
const pdf = path.join(path.dirname(profile), `price-list-${Date.now()}.pdf`);
// (cupsfilter reads a file, not standard input.)
fs.writeFileSync(`${pdf}.txt`, 'Acme Router price list\n\nSmall office plan: 49 EUR per month.\n');
const made = spawnSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', `${pdf}.txt`]);
if (made.status === 0 && made.stdout.length) {
  fs.writeFileSync(pdf, made.stdout);
  const { result: input } = await panel.send('Runtime.evaluate', { expression: `document.querySelector('.knowledge input[type=file]')` });
  await panel.send('DOM.setFileInputFiles', { objectId: input.objectId, files: [pdf] });
  await until(async () => (await count(panel, '.file:not(.reading)')) === 2 || !!(await text(panel, '.sheet-error')), 'the PDF to be read', 30000).catch(() => undefined);
  const error = await text(panel, '.sheet-error');
  if (error && /helper|older|unknown/i.test(error) && !shellDir) check(false, `a PDF is read into text by the helper (${error})`);
  else if (error) console.log(`  (PDF skipped: this app’s helper predates extractText: ${error})`);
  else check(/PDF · \d+ characters/.test(await panel.eval(`[...document.querySelectorAll('.file-meta')].map((m) => m.textContent).join(' ')`)), 'a PDF is read into text on this Mac by the helper and listed as PDF');
  // Back to one file, as the checks below expect.
  if (!error) {
    await click(panel, '.file:nth-child(2) .icon-button');
    await until(async () => (await count(panel, '.file')) === 1, 'the PDF to be removed');
  }
}
await shot(panel, '3b-profile-knowledge');

// Skills: write one, use it from the composer.
await click(panel, '#ptab-skills');
await until(() => panel.eval(`!!document.querySelector('.profile-panel .memory-empty, .profile-panel .skills')`), 'the Skills tab');
check(/No skills yet/.test(await text(panel, '.profile-panel')), 'Skills starts empty, saying how to get one');
await click(panel, '.profile-panel button.secondary-button.wide');
await until(() => panel.eval(`!!document.getElementById('k-steps')`), 'the skill form');
await type(panel, '#k-name', 'Pricing answer');
await type(panel, '#k-when', 'When a customer asks what it costs');
await type(panel, '#k-steps', '1. Read the pricing file\n2. Answer in two sentences');
await shot(panel, '3c-skill-form');
await click(panel, '.edit-actions .primary-button');
await until(async () => (await count(panel, '.skill')) === 1, 'the skill to be saved');
check((await text(panel, '.skill-name')) === 'Pricing answer' && /Written by you/.test(await text(panel, '.skill-source')), 'the skill is listed, written by you');
await shot(panel, '3d-skills');
await click(panel, '.skill .secondary-button');
await until(async () => !(await sheetOpen(panel)), 'the sheet to close on Use');
check((await text(panel, '.skill-chip-name')) === 'Pricing answer', '“Use” puts the skill on the composer as a chip');
check(/\/ for a skill/.test(await panel.eval(`document.getElementById('input').placeholder`)), 'the composer says / picks a skill');
await click(panel, '.skill-chip-remove');
check(await panel.eval(`document.getElementById('skill-chip').hidden`), 'the chip’s × takes it off');
await panel.eval(`document.getElementById('input').focus(), true`);
await panel.send('Input.insertText', { text: '/pri' });
await until(() => panel.eval(`!document.getElementById('skill-pop').hidden`), 'the / menu', 10000).catch(() => undefined);
check((await text(panel, '.skill-opt-name')) === 'Pricing answer', 'typing /pri in the composer lists the skill');
await shot(panel, '3e-slash-menu');
await key(panel, 'Enter', 13);
check((await text(panel, '.skill-chip-name')) === 'Pricing answer' && (await panel.eval(`document.getElementById('input').value`)) === '', 'Enter picks it: the chip, and the /pri is gone');
await click(panel, '.skill-chip-remove');

// Memory: add, refuse a secret, remove.
await openSheet(panel);
await click(panel, '.person.on .person-open');
await until(() => panel.eval(`!!document.getElementById('ptab-memory')`), 'the profile');
await click(panel, '#ptab-memory');
await until(() => panel.eval(`!!document.getElementById('note-input')`), 'the Memory tab');
await type(panel, '#note-input', 'I work in Berlin time');
await click(panel, '.note-add .secondary-button');
await until(async () => (await count(panel, '.note')) === 1, 'the note to appear');
check((await text(panel, '.note-text')) === 'I work in Berlin time', 'a note you add is saved and listed');
check((await text(panel, '.memory-count')) === '1/40', 'the count follows (1/40)');
await type(panel, '#note-input', 'my api key is sk-' + 'Ab1x'.repeat(8));
await click(panel, '.note-add .secondary-button');
await until(() => panel.eval(`!!document.querySelector('.sheet-error')`), 'the refusal');
check(/Memory isn’t for/.test(await text(panel, '.sheet-error')), 'a note that looks like a secret is refused');
check((await count(panel, '.note')) === 1, 'and nothing was added');
await type(panel, '#note-input', 'Reply in English');
await click(panel, '.note-add .secondary-button');
await until(async () => (await count(panel, '.note')) === 2, 'the second note');
await shot(panel, '3-memory');
await click(panel, '.note:first-child .icon-button');
await until(async () => (await count(panel, '.note')) === 1, 'the note to go');
check((await text(panel, '.note-text')) === 'Reply in English', 'removing a note removes that one');

// Escape steps back to the list, then closes the sheet, before the panel.
await panel.eval(`document.getElementById('note-input').focus(), true`);
await key(panel, 'Escape', 27);
await until(() => panel.eval(`!!document.querySelector('#sheet .people')`), 'the list on Escape', 10000).catch(() => undefined);
check((await sheetOpen(panel)) && (await text(panel, '#sheet-title')) === 'Companions', 'Escape on a profile goes back to the list');
await key(panel, 'Escape', 27);
await until(async () => !(await sheetOpen(panel)), 'the sheet to close on Escape', 10000).catch(() => undefined);
check(!(await sheetOpen(panel)) && (await panelOpen(cdp)), 'Escape again closes the sheet and leaves the panel open');
check((await panel.eval(`document.activeElement?.id`)) === 'chooser', 'focus returns to the composer’s selector');

// ---- quit and reopen with the same profile ------------------------------------------------

browser.kill();
await new Promise((r) => browser.once('exit', r));
await wait(1500);
({ browser, cdp, frame, hub } = await launch());
panel = await openPanel(cdp, hub);
check(await namesCompanion(panel, 'Support desk'), 'after a restart the same companion is in use');
await openSheet(panel);
check((await count(panel, '.person')) === 7, 'and so is the companion you made (7 listed)');
check(/1 skill · 1 file · 1 note/.test(await text(panel, '.person.on .person-meta')), 'its row says what it has: 1 skill · 1 file · 1 note');
await click(panel, '.person.on .person-open');
await until(() => panel.eval(`!!document.getElementById('ptab-memory')`), 'the profile');
await click(panel, '#ptab-memory');
await until(() => panel.eval(`!!document.getElementById('note-input')`), 'the Memory tab');
check((await count(panel, '.note')) === 1 && (await text(panel, '.note-text')) === 'Reply in English', 'and its note is still there');
await click(panel, '#ptab-knowledge');
await until(() => panel.eval(`!!document.getElementById('k-context')`), 'the Knowledge tab');
check((await panel.eval(`document.getElementById('k-context').value`)) === 'We sell the Acme Router to small offices in Austria.' && (await count(panel, '.file')) === 1, 'its context and file too');
await click(panel, '#ptab-skills');
await until(async () => (await count(panel, '.skill')) === 1, 'the skill after a restart', 10000).catch(() => undefined);
check((await count(panel, '.skill')) === 1, 'and its skill');

// Remove it: back to General, with its notes, files and skills gone.
await click(panel, '#ptab-about');
await until(() => panel.eval(`!!document.querySelector('.profile .edit-actions .secondary-button')`), 'About');
await click(panel, '.profile .edit-actions .secondary-button');
await until(() => panel.eval(`!!document.getElementById('f-name')`), 'the edit form');
check((await text(panel, '#sheet-title')) === 'Edit companion', 'editing your own companion opens its form');
await click(panel, '.edit-actions .text-button.danger');
await until(async () => (await count(panel, '.person')) === 6, 'the companion to go');
check((await panel.eval(`document.querySelector('.person-main[aria-checked="true"] .person-name').textContent`)) === 'General', 'removing it falls back to General');
check(await namesCompanion(panel, 'General'), 'and the composer’s selector says so');

const leftovers = await frame.eval(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('companionFile:')).length)`);
check(leftovers === 0, 'removing a companion deletes its files’ text from storage');

// A built-in one offers a copy, not an edit, and still has its own knowledge and skills.
await click(panel, '.person:nth-child(2) .person-open');
await until(() => panel.eval(`!!document.querySelector('.profile')`), 'Researcher’s profile');
check(/Make an editable copy/.test(await text(panel, '.profile .edit-actions')), 'built-in companions offer “make a copy”, not edit');
check(!(await panel.eval(`document.getElementById('ptab-skills').disabled`)), 'and their Skills tab is open to you');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
browser.kill();
process.exit(failed.length ? 1 : 0);
