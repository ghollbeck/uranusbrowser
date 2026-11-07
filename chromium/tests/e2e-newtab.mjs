// End-to-end test of a blank tab's own page (newtab.html), in a real UrAnus Browser:
//   - clicking its "Search or enter a URL" box with a real mouse opens the window's command bar,
//     empty and focused;
//   - typing an address and pressing Enter loads it in that same tab, not in another new one.
//
//   node chromium/tests/e2e-newtab.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist] [--keep]
import { spawn } from 'node:child_process';
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
const shellDir = arg('--shell-dir');
const profile = path.join(here, '.scratch', `newtab-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};
const fixture = await startFixtureServer(0);

fs.mkdirSync(profile, { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900'];
if (shellDir) flags.push(`--anus-shell-dir=${path.resolve(shellDir)}`);
const browser = spawn(path.join(app, 'Contents/MacOS/UrAnus Browser'), flags, { stdio: 'ignore' });
reap(browser);
process.on('exit', () => process.argv.includes('--keep') || browser.kill());

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

try {
  await hub('finishOnboarding');
  await hub('newTab', '');
  // chrome://newtab shows the shell's newtab.html (it keeps its address); attach once it has loaded.
  const ntp = await until(async () => {
    const t = (await cdp.targets()).find((t) => t.type === 'page' && (t.url.startsWith('chrome://newtab') || t.url.startsWith(`chrome-extension://${SHELL_ID}/newtab.html`)));
    if (!t) return undefined;
    const s = await cdp.session(t.targetId);
    // Attached while the tab was still switching to newtab.html, an evaluation never answers: try again.
    const ready = await Promise.race([s.eval(`document.readyState === 'complete' && !document.getElementById('empty-state').hidden`), wait(3000).then(() => false)]);
    return ready ? s : undefined;
  }, 'the new tab page', 30000);
  await wait(600);
  const tabCount = () => frame.eval(`chrome.tabs.query({}).then((t) => t.length)`);
  const tabsBefore = await tabCount();

  // A real click, as the user's: through the page's input pipeline, not element.click().
  const box = await ntp.eval(`(() => { const r = document.getElementById('empty-new-tab').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await ntp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });

  const opened = await until(() => frame.eval(`!document.getElementById('palette').hidden || undefined`), 'the command bar', 5000).catch(() => false);
  check(!!opened, 'clicking the search box opens the command bar');
  const bar = await frame.eval(`({ value: document.getElementById('palette-input').value, focused: document.activeElement?.id === 'palette-input', mode: document.getElementById('palette-mode').textContent })`);
  check(bar.value === '', `the command bar starts empty (got ${JSON.stringify(bar.value)})`);
  check(bar.focused, 'the command bar has the keyboard focus');
  check(bar.mode === '', `no "Current Tab" chip on a blank tab (got ${JSON.stringify(bar.mode)})`);

  await frame.eval(`(() => { const i = document.getElementById('palette-input'); i.value = ${JSON.stringify(fixture.url)}; i.dispatchEvent(new Event('input')); return true; })()`);
  await wait(200);
  await frame.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await frame.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const loaded = await until(async () => (await cdp.targets()).some((t) => t.type === 'page' && t.url.startsWith(fixture.url.split('#')[0])), 'the typed address', 15000).catch(() => false);
  check(!!loaded, 'Enter loads the typed address');
  const tabsAfter = await tabCount();
  check(tabsAfter === tabsBefore, `it loads in the blank tab, not a new one (${tabsBefore} → ${tabsAfter} tabs)`);
} catch (err) {
  check(false, `test crashed: ${err.message}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
fixture.close?.();
process.exit(failed ? 1 : 0);
