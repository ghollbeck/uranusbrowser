// End-to-end check of the central AI provider's UI in a real UrAnus Browser (docs/ai-providers.md):
//   - Settings › AI shows the ChatGPT, API key and on-device rows and a picker per feature;
//     the settings search finds it; ChatGPT is greyed out for transcription, with the reason;
//   - the Agent panel's model button names the chat's model, and its menu lists the models and
//     a way to Settings › AI; Escape closes it;
//   - nothing in either page carries an API key.
// Changes nothing: no key is saved, no sign-in started, no model picked.
//
//   node chromium/tests/e2e-ai.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist] [--dev-host] [--shots <dir>]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../..');
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = arg('--shell-dir');
const shots = arg('--shots');
const profile = path.join(here, '.scratch', `ai-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};
if (shots) fs.mkdirSync(shots, { recursive: true });

fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
const browser = spawn(path.join(app, 'Contents/MacOS/UrAnus Browser'), flags, { stdio: 'ignore' });
reap(browser);
process.on('exit', () => browser.kill());

const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);

if (process.argv.includes('--dev-host')) {
  const manifest = path.join(profile, 'NativeMessagingHosts/dev.oprimo.anus.host.json');
  await until(async () => fs.existsSync(manifest), "the app's native host registration", 60000).catch(() => undefined);
  execFileSync(path.join(repo, 'chromium/scripts/install-native-host.sh'), ['--only', profile], {
    stdio: 'ignore',
    env: { ...process.env, ANUS_HOST_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'anus-e2e-host-')) },
  });
}

const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
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
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
}

// ---- Settings › AI ------------------------------------------------------------------------------

await hub('openSettings', 'ai').catch(() => undefined);
let settingsTarget = await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/settings.html`), 15000).catch(() => undefined);
if (!settingsTarget) {
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${SHELL_ID}/settings.html#ai` });
  settingsTarget = { targetId };
}
const settings = await cdp.session(settingsTarget.targetId);
await until(() => settings.eval(`document.readyState === 'complete' && !!document.querySelector('.nav-item[data-pane="ai"]')`), 'the Settings page');
await settings.eval(`document.querySelector('.nav-item[data-pane="ai"]').click()`);
await until(() => settings.eval(`!document.querySelector('.pane[data-pane="ai"]').hidden`), 'the AI pane');
check((await settings.eval(`document.getElementById('pane-title').textContent`)) === 'AI', 'Settings has an AI pane');
const rows = await settings.eval(`[...document.querySelectorAll('.pane[data-pane="ai"] .card:first-of-type .row strong')].map((s) => s.textContent)`);
check(JSON.stringify(rows) === JSON.stringify(['ChatGPT account', 'OpenAI API key', 'On this Mac (Underdog)']), `three provider rows (${rows.join(', ')})`);
await until(() => settings.eval(`document.querySelectorAll('#ai-features .ai-feature').length === 4`), 'the feature pickers', 60000);
const features = await settings.eval(`[...document.querySelectorAll('#ai-features .ai-feature strong')].map((s) => s.textContent)`);
check(features.join() === 'Agent chat,Routines,Meeting notes,Transcription', `a picker per feature (${features.join(', ')})`);
const chatgptTranscribe = await settings.eval(`(() => { const o = [...document.querySelectorAll('#ai-features [data-feature="transcribe"] .ai-provider option')].find((o) => o.value === 'codex'); return o && { disabled: o.disabled, text: o.textContent, title: o.title }; })()`);
check(!!chatgptTranscribe?.disabled && /transcribe audio/.test(chatgptTranscribe.text), `ChatGPT is greyed out for transcription, with the reason (“${chatgptTranscribe?.text}”)`);
const underdogChat = await settings.eval(`(() => { const o = [...document.querySelectorAll('#ai-features [data-feature="chat"] .ai-provider option')].find((o) => o.value === 'underdog'); return o && { disabled: o.disabled, text: o.textContent }; })()`);
check(!!underdogChat?.disabled && /browser tools/.test(underdogChat.text), 'the on-device model is greyed out for the chat');
const chatStatus = await until(() => settings.eval(`(() => { const t = document.getElementById('ai-chatgpt-status').textContent; return t && t !== 'Checking…' ? t : false; })()`), 'the ChatGPT row', 60000);
check(!!chatStatus, `the ChatGPT row says where it stands (“${chatStatus}”)`);
check(await settings.eval(`document.getElementById('ai-key-input').type === 'password'`), 'the key field hides what is typed');
await shot(settings, 'ai-settings-light');
await settings.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await shot(settings, 'ai-settings-dark');
await settings.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// The settings search finds it.
await settings.eval(`(() => { const s = document.getElementById('search'); s.value = 'chatgpt'; s.dispatchEvent(new Event('input')); })()`);
const hits = await settings.eval(`[...document.querySelectorAll('#search-results .result strong')].map((s) => s.textContent)`);
check(hits.includes('ChatGPT account'), `searching “chatgpt” finds the ChatGPT account row (${hits.slice(0, 4).join(', ')})`);
await settings.eval(`(() => { const s = document.getElementById('search'); s.value = 'transcription'; s.dispatchEvent(new Event('input')); })()`);
const hits2 = await settings.eval(`[...document.querySelectorAll('#search-results .result strong')].map((s) => s.textContent)`);
check(hits2.includes('Transcription'), 'searching “transcription” finds its model picker');
const settingsHtml = await settings.eval('document.documentElement.outerHTML');
check(!/sk-[A-Za-z0-9_-]{20,}/.test(settingsHtml), 'no API key in the Settings page');

// ---- the panel's one model picker: the composer's selector ---------------------------------------

await hub('agentPanel:toggle');
const panel = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`))).targetId);
await until(() => panel.eval(`document.readyState === 'complete' && !!document.getElementById('chooser')`), 'the panel');
check(!(await panel.eval(`!!document.getElementById('model-button')`)), 'there is no second model button beside the composer');
const buttonText = await until(() => panel.eval(`(() => { const t = document.getElementById('chooser-label').textContent; return t && t !== 'Model' ? t : false; })()`), 'the model on the pill', 30000);
check(!!buttonText, `the selector's pill names the model (“${buttonText}”)`);
await click(panel, '#chooser');
await until(() => panel.eval(`!!document.getElementById('chooser-model')`), 'the selector');
check(!(await panel.eval(`[...document.querySelectorAll('#chooser-pop .chooser-name')].some((n) => /^(Efficient|Default|Expert)$/.test(n.textContent))`)), 'no Efficient / Default / Expert modes any more');
await click(panel, '#chooser-model');
await until(() => panel.eval(`!document.getElementById('chooser-fly').hidden`), 'the Model list');
await until(() => panel.eval(`!document.querySelector('#chooser-fly .mm-item')?.textContent.includes('Loading')`), 'the models', 60000);
const menu = await panel.eval(`({ heads: [...document.querySelectorAll('#chooser-fly .mm-head')].map((e) => e.textContent), items: [...document.querySelectorAll('#chooser-fly .mm-item')].map((e) => e.textContent), checked: document.querySelector('#chooser-fly [aria-checked="true"]')?.textContent ?? null })`);
check(menu.heads.some((h) => h.startsWith('ChatGPT')) && menu.heads.some((h) => h.startsWith('OpenAI API key')), `the Model list has ChatGPT and API key groups (${menu.heads.join(' | ')})`);
check(menu.items.includes('AI settings…'), 'and a way to Settings › AI');
check(!menu.heads.some((h) => /Underdog/.test(h)), 'the on-device model is not offered for the chat');
await shot(panel, 'ai-panel-menu-light');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await shot(panel, 'ai-panel-menu-dark');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await click(panel, '#chooser-thinking');
await until(() => panel.eval(`(document.getElementById('chooser-fly').textContent ?? '').includes('How hard it thinks')`), 'the Thinking list');
await panel.eval(`[...document.querySelectorAll('#chooser-fly .mm-item')].find((b) => b.textContent.startsWith('High')).click(), true`);
await until(() => panel.eval(`document.getElementById('chooser').dataset.tip?.includes('High thinking')`), 'High to be picked', 10000).catch(() => undefined);
check(await panel.eval(`document.getElementById('chooser').dataset.tip?.includes('High thinking')`), 'Thinking › High is picked and shown on the pill’s tip');
await shot(panel, 'ai-panel-thinking');
for (let i = 0; i < 2; i++) {
  await panel.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(200);
}
check(await panel.eval(`document.getElementById('chooser-pop').hidden && document.getElementById('chooser-fly').hidden`), 'Escape closes the list, then the selector (and leaves the panel open)');
const panelHtml = await panel.eval('document.documentElement.outerHTML');
check(!/sk-[A-Za-z0-9_-]{20,}/.test(panelHtml), 'no API key in the panel');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
browser.kill();
process.exit(failed ? 1 : 0);
