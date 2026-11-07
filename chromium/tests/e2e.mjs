// End-to-end test of the Agent panel in a real Uranus Browser, against the local test page and the
// real model provider (the OpenAI key from the Keychain; set-openai-key.sh). Drives Uranus Browser
// over the DevTools protocol, like a user would through the panel:
//   1. opens the panel from the shell (as the toolbar button does);
//   2. asks the agent to summarise the test page, scroll to the bottom, click "Add one",
//      and type a name, then checks the page itself;
//   3. asks it to submit the feedback form, checks an approval card appears, declines it and
//      checks nothing was submitted;
//   4. checks the API key appears nowhere the panel, page or logs can see.
//
//   node chromium/tests/e2e.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist]
//        [--dev-host] [--keep] [--shots <dir>] [--ai-dir <dir>]
//
// The AI choices (Settings › AI, ~/Library/Application Support/Anus Browser/ai) belong to the Mac, not
// to a profile, so the test gives its host a fresh AI folder (ANUS_AI_DIR): the chat uses the
// Keychain OpenAI key, whatever the user picked, and the user's choices are never changed.
// --ai-dir uses another folder instead (your own one runs the test on your ChatGPT sign-in).
//
// --dev-host points the test profile at this checkout's native host (an app whose own host
// predates the Agent panel). Without the panel patch (an older app) the panel page opens in a
// tab instead. The profile is a fresh one under tests/.scratch, so your own is never touched.
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
const profile = path.join(here, '.scratch', `e2e-profile-${Date.now()}`);
const aiDir = path.resolve(arg('--ai-dir', path.join(profile, 'ai')));
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// ---- launch ----------------------------------------------------------------------

const fixture = await startFixtureServer(0);
fs.mkdirSync(profile, { recursive: true });
const binary = path.join(app, 'Contents/MacOS/Uranus Browser');
// --use-mock-keychain: a fresh profile would otherwise ask the macOS Keychain for its storage
// key, and hold every request until someone answers.
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
console.log(`Uranus Browser: ${app}\nprofile: ${profile}\nAI folder: ${aiDir}\ntest page: ${fixture.url}`);
const browser = spawn(binary, flags, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANUS_AI_DIR: aiDir } });
  reap(browser);
process.on('exit', () => has('--keep') || browser.kill());
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(err);
  process.exit(1);
});
let browserLog = '';
browser.stdout.on('data', (d) => (browserLog += d));
browser.stderr.on('data', (d) => (browserLog += d));

const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);

if (has('--dev-host')) {
  // The app registers its own host on launch; once it has, point this profile at the
  // checkout's instead.
  const manifest = path.join(profile, 'NativeMessagingHosts/dev.oprimo.anus.host.json');
  await until(async () => fs.existsSync(manifest), "the app's native host registration", 60000).catch(() => undefined);
  // Its copy goes in a temporary folder: not your own Uranus Browser folder, and not under ~/Desktop
  // or ~/Documents, which macOS keeps from a host Chromium starts.
  execFileSync(path.join(repo, 'chromium/scripts/install-native-host.sh'), ['--only', profile], {
    stdio: 'ignore',
    env: { ...process.env, ANUS_HOST_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'anus-e2e-host-')) },
  });
}

// The frame page is the shell's window.html; through it, talk to the background as pages do.
const frameTarget = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`));
const frame = await cdp.session(frameTarget.targetId);
// The target can exist a moment before the page has its extension APIs (the first launch races).
await until(async () => frame.eval("typeof chrome !== 'undefined' && typeof chrome.runtime?.connect === 'function'").catch(() => false), 'the frame page to get chrome.runtime', 30000);
// An invoke, so it resolves once the background has run the command.
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => {
      if (m.type !== 'result' || m.id !== 1) return;
      p.disconnect();
      resolve(m.error ?? true);
    });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);
await hub('finishOnboarding');
await wait(800);
await hub('newTab', fixture.url);
const pageTarget = await cdp.waitTarget((t) => t.type === 'page' && t.url.startsWith(fixture.url));
const page = await cdp.session(pageTarget.targetId);
await until(async () => {
  const state = await page.eval(`[document.readyState, location.href, !!document.getElementById('add')].join(' ')`);
  if (!state.endsWith('true')) {
    const history = await page.send('Page.getNavigationHistory').catch((e) => ({ error: e.message }));
    console.log('  test page:', state, JSON.stringify(history).slice(0, 300));
  }
  return state.startsWith('complete') && state.endsWith('true');
}, 'the test page');

// ---- the panel -------------------------------------------------------------------

const native = await frame.eval(`typeof chrome.anusPrivate.setAgentPanel === 'function'`);
check(native, 'the browser has the Agent panel (anusPrivate.setAgentPanel)');
let panelTarget;
if (native) {
  await hub('agentPanel:toggle');
  panelTarget = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`));
} else {
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${SHELL_ID}/agent.html`, newWindow: true });
  panelTarget = { targetId };
}
const panel = await cdp.session(panelTarget.targetId);
await until(() => panel.eval(`!!document.getElementById('input') && document.readyState === 'complete'`), 'the panel page');

if (native) {
  // Opening it from the toolbar leaves the keyboard with the page.
  const focusedPanel = await panel.eval('document.hasFocus()');
  check(!focusedPanel, 'opening the panel does not take keyboard focus from the page');
  const layout = await frame.eval(`(async () => { const w = await chrome.windows.getCurrent(); return { width: w.width }; })()`);
  const box = await panel.eval(`({ w: innerWidth, side: document.body.dataset.side })`);
  check(box.side === 'right' && Math.abs(box.w - 400) <= 2, `docked right, about 400 px wide (got ${box.side}, ${box.w} px of a ${layout.width} px window)`);
  const pageBox = await page.eval(`innerWidth`);
  check(pageBox < layout.width - 400 - 200, `the page area makes room for the panel (page ${pageBox} px)`);
}

if (shots) {
  fs.mkdirSync(shots, { recursive: true });
}

/** The whole window, with macOS screencapture (Screen Recording permission), when --shots is given. */
async function windowShot(name) {
  if (!shots) return;
  const w = await frame.eval(`(async () => { const w = await chrome.windows.getCurrent(); return { left: w.left, top: w.top, width: w.width, height: w.height }; })()`);
  try {
    execFileSync('/usr/sbin/screencapture', ['-x', '-o', `-R${w.left},${w.top},${w.width},${w.height}`, path.join(shots, `${name}.png`)]);
  } catch (err) {
    console.log(`  (no window screenshot: ${err.message})`);
  }
}

async function ask(text, done = (s) => s.status === 'idle') {
  const before = await panel.eval(`document.querySelectorAll('#transcript > li').length`);
  await panel.eval(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(text)}; document.getElementById('composer').requestSubmit(); return true; })()`);
  return until(
    () =>
      panel.eval(`(() => {
        const items = [...document.querySelectorAll('#transcript > li')];
        if (items.length <= ${before} + 1) return undefined;
        const status = document.getElementById('status').dataset.status;
        const pending = !!document.querySelector('.approval.pending');
        const s = { status, pending, items: items.slice(${before}).map((li) => ({ cls: li.className, text: li.innerText })) };
        return (${done.toString()})(s) ? s : undefined;
      })()`),
    `the agent to answer “${text}”`,
    150000,
  ).catch(async (err) => {
    console.error('panel at timeout:', await panel.eval(`document.getElementById('panel').innerText`).catch(() => '?'));
    throw err;
  });
}
const toolLines = (s) => s.items.filter((i) => i.cls.startsWith('step')).map((i) => i.text.replace(/\s+/g, ' '));

// 1. A summary of the page.
let turn = await ask('Summarize this page in two sentences. Do not click anything.');
const summary = turn.items.filter((i) => i.cls.includes('assistant')).map((i) => i.text).join(' ');
check(/agent test page|counter|feedback/i.test(summary), `page summary: “${summary.slice(0, 140)}”`);
check(toolLines(turn).some((l) => /Read the page/.test(l)), `tool log shows the read (${toolLines(turn).join(' | ')})`);

// 2. Scroll.
turn = await ask('Scroll to the very bottom of the page and tell me the secret word written there.');
const scrolled = await page.eval(`Math.round(scrollY + innerHeight) >= document.documentElement.scrollHeight - 4`);
check(scrolled, 'the page scrolled to the bottom');
check(/papaya/i.test(turn.items.map((i) => i.text).join(' ')), 'the agent read the word at the bottom');

// 3. A safe click on the test page runs without a card.
turn = await ask('Click the "Add one" button exactly twice.');
const counter = await page.eval(`document.getElementById('counter').textContent`);
check(counter === '2', `the counter went to 2 (it says ${counter})`);
check(!turn.items.some((i) => i.cls.includes('approval')), 'no approval card for a click on the test page');

// 4. Typing.
turn = await ask('Type "Ada Lovelace" into the "Your name" field.');
const typed = await page.eval(`document.getElementById('name').value`);
check(typed === 'Ada Lovelace', `the name field says “${typed}”`);
const preview = await page.eval(`document.getElementById('preview').textContent`);
check(preview === 'Ada Lovelace', 'the page saw the typing as input events');

if (shots) {
  const png = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, 'panel-transcript.png'), Buffer.from(png.data, 'base64'));
  await windowShot('window-transcript');
}

// 5. Submitting asks first; declining does nothing.
const urlBefore = await page.eval('location.href');
turn = await ask('Fill the feedback form with email test@example.com and message "Hello", then submit it.', (s) => s.pending || s.status === 'idle');
check(turn.pending, 'submitting the form shows an approval card');
if (!turn.pending) console.log('  transcript:', JSON.stringify(turn.items.map((i) => i.text.replace(/\s+/g, ' '))));
const card = await panel.eval(`document.querySelector('.approval.pending')?.innerText ?? ''`);
check(/Send feedback/.test(card) && /127\.0\.0\.1/.test(card), `the card names the action and the site: “${card.replace(/\s+/g, ' ').slice(0, 160)}”`);
if (shots) {
  const png = await panel.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, 'panel-approval.png'), Buffer.from(png.data, 'base64'));
  await windowShot('window-approval');
}
await panel.eval(`[...document.querySelectorAll('.approval.pending button')].find((b) => b.textContent === 'Decline')?.click()`);
await until(() => panel.eval(`document.getElementById('status').dataset.status === 'idle' && !document.querySelector('.approval.pending')`), 'the agent to stop after Decline');
await wait(1500);
check(fixture.submissions() === 0, `nothing was submitted (${fixture.submissions()} submissions)`);
check((await page.eval('location.href')) === urlBefore, 'the page did not navigate');
const declined = await panel.eval(`[...document.querySelectorAll('.approval')].at(-1)?.className`);
check(/declined/.test(declined), 'the card shows it was declined');

// 6. The key stays in the host.
const keyHint = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'dev.oprimo.anus.agent.openai', '-a', 'api-key', '-w']).toString().trim();
const panelHtml = await panel.eval('document.documentElement.outerHTML');
const panelStorage = await panel.eval(`(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]))()`);
const pageHtml = await page.eval('document.documentElement.outerHTML');
const logs = [browserLog, ...fs.readdirSync(profile, { recursive: true }).filter((f) => /\.log$|LOG$/.test(f)).map((f) => fs.readFileSync(path.join(profile, f), 'latin1'))].join('\n');
for (const [where, text] of Object.entries({ 'the panel page': panelHtml, "the shell's storage": panelStorage, 'the web page': pageHtml, 'browser output and profile logs': logs })) {
  check(!text.includes(keyHint) && !text.includes(keyHint.slice(-12)), `the API key is not in ${where}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (!has('--keep')) {
  browser.kill();
  fixture.server.close();
} else {
  console.log('(left running: --keep)');
}
cdp.ws.close();
process.exit(failed.length ? 1 : 0);
