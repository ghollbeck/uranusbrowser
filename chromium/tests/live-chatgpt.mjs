// A supervised live check of Sign in with ChatGPT (docs/ai-providers.md), against the real
// Codex app-server and a real ChatGPT plan. Not part of the automated suite: someone has to
// finish the ChatGPT sign-in in the tab Uranus Browser opens (unless Uranus Browser is signed in already).
//   1. Settings › AI › Sign In opens the ChatGPT sign-in page in a Uranus Browser tab; waits up to
//      10 minutes for Codex to report the sign-in, then checks the row and the tab closing;
//   2. picks a ChatGPT model in the panel's model menu;
//   3. asks "Open example.com and tell me its title", and checks the navigate step in the
//      panel's tool log and "Example Domain" in the answer;
//   4. puts the chat back on the model it had before.
// Uses the signed-in state in ~/Library/Application Support/Anus Browser/ai (the real one), and a
// throwaway browser profile.
//
//   node chromium/tests/live-chatgpt.mjs [--app /Applications/Uranus Browser.app] [--shots <dir>] [--keep-model]
//        [--model <label text, e.g. GPT-6-Luna>] [--prompt "<a task of your own>"]
// With --prompt, the checks are: at least one browser step, an answer, and no error.
import { spawn } from 'node:child_process';
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
const wantModel = arg('--model');
const prompt = arg('--prompt');
const profile = path.join(here, '.scratch', `live-chatgpt-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};
if (shots) fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
const browser = spawn(
  path.join(app, 'Contents/MacOS/Uranus Browser'),
  [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900'],
  { stdio: 'ignore' },
);
reap(browser);
process.on('exit', () => browser.kill());
const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const cdp = await Cdp.connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ? { error: m.error } : m.value ?? true); } });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);
await hub('finishOnboarding');
await wait(800);
async function shot(session, name) {
  if (!shots) return;
  await wait(450);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}
async function click(session, selector) {
  const at = await session.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await session.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}

// ---- 1. sign in ---------------------------------------------------------------------------------

await hub('openSettings', 'ai');
const settings = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/settings.html`), 20000)).targetId);
await until(() => settings.eval(`document.readyState === 'complete' && !document.querySelector('.pane[data-pane="ai"]').hidden`), 'Settings › AI');
const status = () => settings.eval(`document.getElementById('ai-chatgpt-status').textContent`);
await until(async () => (await status()) !== 'Checking…', 'the ChatGPT row', 60000);
const before = await hub('ai:request', { op: 'view' });
const chatBefore = before.features?.chat;
if (!before.providers?.find((p) => p.id === 'codex')?.ready) {
  await click(settings, '#ai-chatgpt-action');
  const authTab = await cdp.waitTarget((t) => t.type === 'page' && /^https:\/\/auth\.openai\.com\//.test(t.url), 30000).catch(() => undefined);
  check(!!authTab, 'Sign In opens the ChatGPT sign-in page in a Uranus Browser tab');
  await shot(settings, 'live-1-waiting');
  console.log('\n>>> Finish signing in to ChatGPT in the Uranus Browser window that just opened (10 minutes).\n');
  // Asked of the host, so closing the Settings window meanwhile doesn't matter.
  await until(async () => (await hub('ai:request', { op: 'view' }))?.providers?.find((p) => p.id === 'codex')?.ready, 'the ChatGPT sign-in', 600000);
  await wait(1500);
  const left = (await cdp.targets()).some((t) => t.type === 'page' && /auth\.openai\.com|localhost:1455/.test(t.url));
  check(!left, 'the sign-in tab closes once Codex reports success');
}
const codexView = (await hub('ai:request', { op: 'view' })).providers.find((p) => p.id === 'codex');
check(!!codexView?.ready, `signed in to ChatGPT (plan: ${codexView?.account?.plan ?? 'not reported'})`);
const signedIn = await status().catch(() => '(Settings window closed)');
check(/^Signed in|closed/.test(signedIn), `Settings › AI shows the account (“${signedIn}”)`);
const limits = await settings.eval(`document.getElementById('ai-chatgpt-limits').hidden ? '' : document.getElementById('ai-chatgpt-limits').textContent`).catch(() => '');
console.log(`  limits: ${limits || '(none reported)'}`);
await shot(settings, 'live-2-signed-in').catch(() => undefined);

// ---- 2. pick a ChatGPT model in the panel ------------------------------------------------------------

await hub('agentPanel:toggle');
const panel = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`))).targetId);
await until(() => panel.eval(`document.readyState === 'complete' && !!document.getElementById('chooser')`), 'the panel');
// The composer's selector is the one model picker: its Model row opens the list.
await click(panel, '#chooser');
await until(() => panel.eval(`!!document.getElementById('chooser-model')`), 'the selector');
await click(panel, '#chooser-model');
await until(() => panel.eval(`[...document.querySelectorAll('#chooser-fly .mm-group')].some((g) => g.querySelector('.mm-head')?.textContent.startsWith('ChatGPT') && g.querySelector('[role="menuitemradio"]'))`), 'ChatGPT models in the menu', 60000);
const picked = await panel.eval(`(() => { const g = [...document.querySelectorAll('#chooser-fly .mm-group')].find((g) => g.querySelector('.mm-head')?.textContent.startsWith('ChatGPT')); const items = [...g.querySelectorAll('[role="menuitemradio"]')]; const item = items.find((i) => i.textContent.includes(${JSON.stringify(wantModel ?? '')})) ?? items[0]; item.click(); return item.textContent; })()`);
await until(() => panel.eval(`document.getElementById('provider-badge').textContent === 'ChatGPT'`), 'the ChatGPT badge', 20000);
check(true, `picked ${picked} in the panel; the badge says ChatGPT`);
await shot(panel, 'live-3-picked');

// ---- 3. a browser task ------------------------------------------------------------------------------

const task = prompt ?? 'Open example.com and tell me its title.';
await panel.eval(`(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(task)}; i.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
const started = Date.now();
await until(() => panel.eval(`!!document.querySelector('.msg.user')`), 'the message', 20000);
// An approval card is approved for example.com (harmless); with a task of your own it is
// declined and listed, since nobody here decided it.
const cards = new Set();
const done = await until(async () => {
  const card = await panel.eval(`document.querySelector('.approval.pending .approval-summary')?.textContent ?? ''`);
  if (card && !cards.has(card)) {
    cards.add(card);
    console.log(`  approval card: ${card}${prompt ? ' (declined)' : ' (approved)'}`);
  }
  await panel.eval(`document.querySelector('.approval.pending ${prompt ? '.secondary-button' : '.primary-button'}')?.click()`);
  return panel.eval(`(() => { const busy = !document.getElementById('working').hidden; const answers = [...document.querySelectorAll('.msg.assistant .text')].map((e) => e.textContent); const notices = [...document.querySelectorAll('#transcript .notice')].map((e) => e.textContent); return !busy && (answers.length || notices.length) ? { answers, notices } : false; })()`);
}, 'the answer', prompt ? 600000 : 240000);
const tools = await panel.eval(`[...document.querySelectorAll('.step')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);
console.log(`  tools: ${JSON.stringify(tools)}\n  answer: ${JSON.stringify(done.answers.at(-1))}\n  notices: ${JSON.stringify(done.notices)}  (${Math.round((Date.now() - started) / 1000)} s)`);
if (prompt) {
  check(tools.length > 0, `the agent drove the browser (${tools.length} steps)`);
  check(done.answers.length > 0 && !done.notices.some((n) => /couldn’t|failed|stopped|limit/i.test(n)), 'it answered without an error');
} else {
  check(tools.some((t) => /example\.com/i.test(t)), 'the navigate step to example.com shows in the panel');
  check(done.answers.some((a) => /Example Domain/.test(a)), 'the answer reports the title “Example Domain”');
}
await shot(panel, 'live-4-answer');

// ---- 4. put the chat back ---------------------------------------------------------------------------

if (!process.argv.includes('--keep-model') && chatBefore) {
  const back = await hub('ai:request', { op: 'setModel', feature: 'chat', provider: chatBefore.provider, model: chatBefore.model });
  check(!back?.error, `the chat is back on ${chatBefore.provider} · ${chatBefore.model}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
browser.kill();
process.exit(failed ? 1 : 0);
