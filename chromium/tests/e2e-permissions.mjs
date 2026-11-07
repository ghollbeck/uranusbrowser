// End-to-end test of the first-run tour's Permissions step, in a real UrAnus Browser on a fresh profile:
//   - the tour reaches a Permissions step with Microphone, Camera and App management rows;
//   - Allow on the microphone and camera opens their permission pages in a tab (where Chromium and macOS ask);
//   - once the microphone is granted the row reads "Allowed" by itself;
//   - the tour carries on to the end.
// It never presses "Open Settings" (that would open System Settings on the screen).
//
//   node chromium/tests/e2e-permissions.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir <dist>] [--shots <dir>]
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
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = path.resolve(arg('--shell-dir', path.join(here, '../shell/dist')));
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `permissions-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

fs.mkdirSync(profile, { recursive: true });
const browser = spawn(
  path.join(app, 'Contents/MacOS/UrAnus Browser'),
  [`--user-data-dir=${profile}`, `--anus-shell-dir=${shellDir}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', '--window-position=60,40'],
  { stdio: 'ignore' },
);
reap(browser);
const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);
const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const text = (selector) => frame.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const texts = (selector) => frame.eval(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim()))`).then(JSON.parse);
async function shot(name) {
  if (!shots) return;
  await wait(500);
  const { data } = await frame.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

try {
  await until(() => frame.eval(`!!document.querySelector('.tour-primary')`), 'the tour', 60000);
  // Walk to the Permissions step with the tour's own Continue button.
  for (let i = 0; i < 8 && (await text('.tour-kicker')) !== 'Permissions'; i++) {
    await frame.eval(`document.querySelector('.tour-primary').click(), true`);
    await wait(900);
  }
  check((await text('.tour-kicker')) === 'Permissions', 'the tour reaches a Permissions step');
  const rows = await texts('.tour-feature-text strong');
  check(JSON.stringify(rows) === JSON.stringify(['Microphone', 'Camera', 'App management']), `with three rows (${rows.join(', ')})`);
  const buttons = await texts('.tour-feature .tour-ghost');
  check(JSON.stringify(buttons) === JSON.stringify(['Allow…', 'Allow…', 'Open Settings']), `each asked with a button (${buttons.join(' | ')})`);
  check(/optional/i.test(await text('.tour-lead')), 'and it says each one is optional');
  await shot('permissions-step');

  // Microphone: the button opens the permission page in a tab.
  await frame.eval(`document.querySelectorAll('.tour-feature .tour-ghost')[0].click(), true`);
  const micTab = await cdp.waitTarget((t) => t.url.includes('meetingsCapture.html?permission=1') && !t.url.includes('kind=camera'), 20000);
  check(!!micTab, 'Allow on the microphone opens its permission page in a tab');
  await until(async () => (await cdp.targets()).find((x) => x.targetId === micTab.targetId)?.title === 'Allow microphone', 'the microphone tab title', 10000).catch(() => undefined);
  const micTitle = (await cdp.targets()).find((x) => x.targetId === micTab.targetId)?.title;
  check(micTitle === 'Allow microphone', `the tab is titled “${micTitle}”, not the recorder's name`);
  // Pressing again while it is open adds nothing: the button waits.
  check((await texts('.tour-feature .tour-ghost'))[0] === 'Waiting…' && (await frame.eval(`document.querySelectorAll('.tour-feature .tour-ghost')[0].disabled`)), 'the button now reads Waiting… and is disabled');
  await frame.eval(`document.querySelectorAll('.tour-feature .tour-ghost')[0].click(), true`);
  await wait(800);
  const micTabs = (await cdp.targets()).filter((t) => t.url.includes('meetingsCapture.html?permission=1') && !t.url.includes('kind=camera'));
  check(micTabs.length === 1, `and pressing it again opens no second tab (${micTabs.length} tab)`);
  const micPage = await cdp.session(micTab.targetId);
  await until(() => micPage.eval(`!!document.getElementById('permission') && !document.getElementById('permission').hidden`), 'the microphone page', 20000);
  check(/microphone/i.test(await micPage.eval(`document.querySelector('#permission h1').textContent`)) && (await micPage.eval(`document.getElementById('allow').textContent`)) === 'Allow microphone', 'it asks for the microphone');

  // Camera: the same page, for the camera.
  await frame.eval(`document.querySelectorAll('.tour-feature .tour-ghost')[1].click(), true`);
  const camTab = await cdp.waitTarget((t) => t.url.includes('kind=camera'), 20000);
  const titleOf = async (t) => (await cdp.targets()).find((x) => x.targetId === t.targetId)?.title;
  await until(async () => (await titleOf(camTab)) === 'Allow camera', 'the camera tab title', 10000).catch(() => undefined);
  check((await titleOf(camTab)) === 'Allow camera', `the camera tab is titled “${await titleOf(camTab)}”`);
  const camPage = await cdp.session(camTab.targetId);
  await until(() => camPage.eval(`!!document.getElementById('permission') && !document.getElementById('permission').hidden`), 'the camera page', 20000);
  check(/camera/i.test(await camPage.eval(`document.querySelector('#permission h1').textContent`)) && (await camPage.eval(`document.getElementById('allow').textContent`)) === 'Allow camera', 'Allow on the camera opens the camera page');

  // Once the microphone is granted the row says so by itself.
  await cdp.send('Browser.grantPermissions', { origin: `chrome-extension://${SHELL_ID}`, permissions: ['audioCapture'] });
  await until(async () => (await texts('.tour-feature-text small'))[0] === 'Allowed.', 'the microphone row to read Allowed', 15000).catch(() => undefined);
  const smalls = await texts('.tour-feature-text small');
  check(smalls[0] === 'Allowed.', 'once granted, the microphone row reads Allowed');
  check((await texts('.tour-feature .tour-ghost')).length === 2, 'and its button is replaced by a check (two buttons left)');
  check(smalls[1] !== 'Allowed.', 'the camera, not granted, still asks');
  await shot('permissions-step-after-mic');

  // The tour goes on to the end.
  await frame.eval(`document.querySelector('.tour-primary').click(), true`);
  await until(async () => (await text('.tour-kicker')) === 'Last thing', 'the last step', 10000);
  check((await text('.tour-primary')).includes('Start browsing'), 'Continue goes on to the last step');
} catch (err) {
  check(false, `no error (${err.message})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
