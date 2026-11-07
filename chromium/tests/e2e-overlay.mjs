// End-to-end check of the agent's page overlay (shell/agentOverlay.ts) in a real Uranus Browser: the
// glow, the "Controlled by" card and the agent's pointer, driven through the shell's real tool
// runner (shell/browserAgentTools.ts) by a stand-in native host, so it runs without a model and
// the same for every provider (the API key and ChatGPT both reach the page through that runner).
//   1. the pointer appears, glides to a button (eased, a few hundred ms) and ripples, and only
//      then does the click land, on the point the pointer shows; it does the same for typing;
//      it stays put when the page scrolls; with reduced motion it jumps instead of gliding;
//   2. the glow fades in once and stays (breathing, ~5 s a breath) across several tool calls,
//      a short "idle" blip between steps and a navigation in the tab: the new page gets it
//      before it has finished loading, already on, with no entrance;
//   3. its four corners follow the page area's rounded corners (12 px, patch 0024) and match
//      each other and the straight edges, on a light and a dark page (screenshots compared);
//   4. it fades away when the run ends.
//
//   node chromium/tests/e2e-overlay.mjs [--app /Applications/Uranus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>] [--keep]
//
// The profile is a fresh one under tests/.scratch; the stand-in host is registered for that
// profile alone (in a temporary folder, as macOS keeps a host Chromium starts out of ~/Desktop).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Cdp, until, wait, reap } from './anus-cdp.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const SHELL_ID = 'abdiaepfgbbhdjaecjipmaailijaaide';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const app = arg('--app', '/Applications/Uranus Browser.app');
const shellDir = arg('--shell-dir', path.join(here, '../shell/dist'));
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `overlay-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

// ---- the test pages --------------------------------------------------------------------------

const page = (title, bg, fg, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
  html, body { margin: 0; background: ${bg}; color: ${fg}; font: 16px -apple-system, system-ui, sans-serif; }
  body { height: 2400px; }
  button, input, a { position: absolute; font: inherit; }
  button { padding: 10px 18px; }
</style></head><body>${body}<script>
  window.__clicks = [];
  document.addEventListener('click', (e) => __clicks.push({ t: performance.now(), x: e.clientX, y: e.clientY, id: e.target.id }), true);
</script></body></html>`;
const pages = {
  '/light': page('Light', '#ffffff', '#111', `<button id="go" style="left: 560px; top: 300px">Go</button>
    <input id="name" aria-label="Name" style="left: 180px; top: 470px; width: 280px; padding: 8px">
    <a id="next" href="/dark" style="left: 760px; top: 560px">Next page</a>`),
  '/dark': page('Dark', '#0f1115', '#eee', `<button id="ok" style="left: 300px; top: 220px">OK</button>`),
};
const server = http.createServer((req, res) => {
  const html = pages[new URL(req.url, 'http://x').pathname];
  if (!html) return res.writeHead(404).end();
  // Slow, like a real page: the start at once, the rest a moment later, so "before it has
  // finished loading" means something.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const cut = html.indexOf('<body>') + 6;
  res.write(html.slice(0, cut));
  setTimeout(() => res.end(html.slice(cut)), 900);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- the stand-in native host: relays between Uranus Browser and this script --------------------------

let hostSocket;
const toolWaits = new Map();
let nextTool = 1;
let hostMessages = 0;
const relay = net.createServer((socket) => {
  hostSocket = socket;
  let buffer = '';
  socket.on('data', (d) => {
    buffer += d;
    for (let i; (i = buffer.indexOf('\n')) >= 0; ) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      hostMessages++;
      // Whatever the shell asks the host itself (AI settings, meetings…) isn't this test's.
      if (message.type === 'call') toHost({ type: 'reply', id: message.id, error: 'stand-in host' });
      else if (message.type === 'toolResult') toolWaits.get(message.id)?.(message.result);
    }
  });
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const toHost = (message) => hostSocket.write(`${JSON.stringify(message)}\n`);
const chat = (status, activity) => toHost({ type: 'chat', snapshot: { status, activity, entries: [] } });
const tool = (name, args = {}) =>
  new Promise((resolve) => {
    const id = nextTool++;
    toolWaits.set(id, (result) => {
      toolWaits.delete(id);
      resolve({ ...result, text: result.content?.map((c) => c.text ?? '').join('') ?? '' });
    });
    toHost({ type: 'tool', id, name, args });
  });

const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anus-overlay-host-'));
fs.writeFileSync(
  path.join(hostDir, 'host.mjs'),
  `import net from 'node:net';
const socket = net.connect(${relay.address().port}, '127.0.0.1');
let input = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  input = Buffer.concat([input, d]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    const n = input.readUInt32LE(0);
    socket.write(input.subarray(4, 4 + n).toString() + '\\n');
    input = input.subarray(4 + n);
  }
});
let lines = '';
socket.on('data', (d) => {
  lines += d;
  for (let i; (i = lines.indexOf('\\n')) >= 0; ) {
    const body = Buffer.from(lines.slice(0, i));
    lines = lines.slice(i + 1);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
`,
);
const launcher = path.join(hostDir, 'host');
fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(hostDir, 'host.mjs')}"\n`, { mode: 0o755 });
const manifestFile = path.join(profile, 'NativeMessagingHosts/dev.oprimo.anus.host.json');
const manifest = JSON.stringify({ name: 'dev.oprimo.anus.host', description: 'Uranus Browser overlay test stand-in', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${SHELL_ID}/`] });

// ---- launch ----------------------------------------------------------------------------------

fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', `--anus-shell-dir=${path.resolve(shellDir)}`];
console.log(`Uranus Browser: ${app}\nshell: ${shellDir}\nprofile: ${profile}`);
const browser = spawn(path.join(app, 'Contents/MacOS/Uranus Browser'), flags, { stdio: 'ignore' });
reap(browser);
const quit = () => has('--keep') || browser.kill();
process.on('exit', quit);
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.error(err);
    process.exit(1);
  });
}

const portFile = path.join(profile, 'DevToolsActivePort');
const port = await until(async () => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0], 'DevTools port', 180000);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = await Cdp.connect(webSocketDebuggerUrl);
// Events too (anus-cdp.mjs only answers calls).
const listeners = new Set();
const answer = cdp.ws.onmessage;
cdp.ws.onmessage = (e) => {
  answer(e);
  const msg = JSON.parse(e.data);
  if (msg.method) for (const fn of listeners) fn(msg);
};

// The app registers its own host on launch; then this profile gets the stand-in instead.
await until(async () => fs.existsSync(manifestFile), "the app's host registration", 60000).catch(() => undefined);
await wait(300);
fs.writeFileSync(manifestFile, manifest);

const frame = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/window.html`))).targetId);
const hub = (name, ...args) =>
  frame.eval(`new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'anus' });
    p.onMessage.addListener((m) => { if (m.type === 'result' && m.id === 1) { p.disconnect(); resolve(m.error ?? m.value ?? true); } });
    p.postMessage({ type: 'invoke', id: 1, name: ${JSON.stringify(name)}, args: ${JSON.stringify(args)} });
  })`);
await hub('finishOnboarding');
await wait(800);

// A real host may have started before the swap: end it, and the shell's next message starts ours.
try {
  for (const line of execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-A'], { encoding: 'utf8' }).split('\n')) {
    const [pid, ppid, ...command] = line.trim().split(/\s+/);
    if (Number(ppid) === browser.pid && /native-host|anus-host/.test(command.join(' ')) && !command.join(' ').includes(hostDir)) process.kill(Number(pid));
  }
} catch {}
await hub('agentPanel:toggle');
await until(async () => !!hostSocket, 'the stand-in host to be started', 30000);
check(true, 'the shell talks to the stand-in host');

// ---- the page and the extension's world in it -------------------------------------------------

await hub('newTab', `${origin}/light`);
const pageTarget = await cdp.waitTarget((t) => t.type === 'page' && t.url.startsWith(`${origin}/light`));
const tab = await cdp.session(pageTarget.targetId);
await cdp.send('Target.activateTarget', { targetId: pageTarget.targetId });
// The page's own record of the overlay arriving, from the very start of every document.
await tab.send('Page.enable');
await tab.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__overlayLog = [];
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeName === 'ANUS-AGENT-OVERLAY') __overlayLog.push({ t: performance.now(), enter: n.dataset.enter, on: n.dataset.on, readyState: document.readyState });
  }).observe(document, { childList: true, subtree: true });`,
});
await tab.send('Page.reload');
await until(() => tab.eval(`document.readyState === 'complete' && !!document.getElementById('go') && Array.isArray(window.__overlayLog)`), 'the light page');

// Contexts in the tab's main frame, to find the shell's isolated world (where the overlay lives).
const contexts = new Map();
listeners.add((msg) => {
  if (msg.method === 'Runtime.executionContextCreated') contexts.set(msg.params.context.id, msg.params.context);
  else if (msg.method === 'Runtime.executionContextDestroyed') contexts.delete(msg.params.executionContextId);
  else if (msg.method === 'Runtime.executionContextsCleared') contexts.clear();
});
await tab.send('Runtime.enable');
const shellWorld = () => [...contexts.values()].reverse().find((c) => c.origin === `chrome-extension://${SHELL_ID}` && c.auxData?.isDefault === false && c.auxData?.frameId === pageTarget.targetId);
async function inShellWorld(expression) {
  const context = await until(async () => shellWorld(), "the shell's world in the page", 20000);
  const r = await tab.send('Runtime.evaluate', { expression, contextId: context.id, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
/**
 * Brings the test window to the front: a window behind others counts as hidden, and a hidden
 * page runs no animations and slows its timers, which is not what's being measured.
 */
async function front() {
  await frame.eval(`(async () => { const w = await chrome.windows.getCurrent(); await chrome.windows.update(w.id, { focused: true }); })()`);
  await until(() => tab.eval(`document.visibilityState === 'visible'`), 'the test page on screen', 10000);
}
await front();
check(await tab.eval(`document.visibilityState === 'visible'`), 'the test page is on screen');

// Samples the glow and the pointer every few ms, notes ripples, and what's under the click.
const MONITOR = `(() => {
  const o = globalThis.__anusAgentOverlay;
  if (!o) return false;
  clearInterval(globalThis.__mon?.timer);
  const m = (globalThis.__mon = { samples: [], clicks: [], ripples: [] });
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.className === 'ripple') m.ripples.push({ t: performance.now(), x: parseFloat(n.style.left), y: parseFloat(n.style.top) });
  }).observe(o.pointer.parentNode, { childList: true });
  const tick = () => {
    const cur = globalThis.__anusAgentOverlay;
    if (!cur) return m.samples.push({ t: performance.now(), missing: true });
    const style = getComputedStyle(cur.pointer);
    const at = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    m.samples.push({ t: performance.now(), glow: +getComputedStyle(cur.glow).opacity, x: at.m41, y: at.m42, shown: +style.opacity });
  };
  m.timer = setInterval(tick, 8);
  document.addEventListener('click', (e) => { tick(); m.clicks.push({ t: performance.now(), x: e.clientX, y: e.clientY, at: m.samples.at(-1) }); }, true);
  return true;
})()`;
const monitor = () => inShellWorld('globalThis.__mon && { samples: __mon.samples, clicks: __mon.clicks, ripples: __mon.ripples }');

/** Checks the pointer glided to the click and was there when it landed. */
function judgeGlide(mon, label, { glide = true } = {}) {
  const click = mon.clicks.at(-1);
  if (!click) return check(false, `${label}: a click landed`);
  // From when it shows: before that it hasn't been anywhere yet.
  const before = mon.samples.filter((s) => !s.missing && s.shown > 0.05 && s.t <= click.t && s.t >= click.t - 1500);
  const at = click.at;
  const offBy = Math.hypot(at.x - click.x, at.y - click.y);
  check(at.shown > 0.9 && offBy <= 1.5, `${label}: the pointer is on the click's point when it lands (off by ${offBy.toFixed(1)} px, opacity ${at.shown})`);
  const moving = before.filter((s, i) => i && (s.x !== before[i - 1].x || s.y !== before[i - 1].y));
  const start = moving[0];
  const arrived = before.find((s) => Math.hypot(s.x - click.x, s.y - click.y) <= 0.5 && (!start || s.t >= start.t));
  const ripple = mon.ripples.find((r) => r.t <= click.t + 5 && Math.hypot(r.x - click.x, r.y - click.y) <= 1.5);
  if (glide) {
    const from = before[0];
    const travelled = from ? Math.hypot(from.x - click.x, from.y - click.y) : 0;
    const took = start && arrived ? arrived.t - start.t : 0;
    check(moving.length >= 8 && travelled > 40 && took >= 250 && took <= 700, `${label}: it glides there first (${Math.round(travelled)} px in ${Math.round(took)} ms, ${moving.length} steps)`);
    // Eased: slow at both ends, fastest in the middle.
    const speeds = moving.slice(1).map((s, i) => Math.hypot(s.x - moving[i].x, s.y - moving[i].y) / Math.max(1, s.t - moving[i].t));
    const third = Math.floor(speeds.length / 3);
    const mid = speeds.slice(third, 2 * third);
    const ends = [...speeds.slice(0, 2), ...speeds.slice(-2)];
    check(speeds.length >= 6 && Math.max(...mid) > Math.max(...ends), `${label}: the glide eases in and out`);
    // A hand's arc, not a ruler's line: the path bows away from the straight line.
    const line = { x: click.x - from.x, y: click.y - from.y };
    const bow = Math.max(...moving.map((s) => Math.abs((s.x - from.x) * line.y - (s.y - from.y) * line.x) / Math.max(1, travelled)));
    check(bow >= travelled * 0.05, `${label}: it moves along a curve (bows ${Math.round(bow)} px off the straight line)`);
  } else {
    check(moving.length <= 1, `${label}: with reduced motion it jumps (${moving.length} intermediate positions)`);
  }
  check(!!ripple && click.t - ripple.t < 400, `${label}: it ripples on the point${ripple ? ` ${Math.round(click.t - ripple.t)} ms before the click` : ''}`);
  if (has('--verbose')) console.log(JSON.stringify({ click, ripples: mon.ripples, samples: before.filter((s, i) => i % 3 === 0).map((s) => [Math.round(s.t), Math.round(s.x), Math.round(s.y), s.shown]) }));
  return click;
}

// ---- 1. a run starts: the glow fades in, once ----------------------------------------------------

chat('thinking', 'Thinking…');
await until(() => inShellWorld('!!globalThis.__anusAgentOverlay'), 'the overlay');
await inShellWorld(MONITOR);
await wait(900);
const entered = await monitor();
const firstGlow = entered.samples.filter((s) => !s.missing).map((s) => s.glow);
check(firstGlow.length > 10 && firstGlow.at(-1) > 0.99, `the glow is on once the run starts (opacity ${firstGlow.at(-1)})`);
const log1 = await tab.eval('__overlayLog');
check(log1.length === 1 && log1[0].enter === 'fade', `it came in with its entrance, once (${JSON.stringify(log1.map((l) => l.enter))})`);
const breath = await inShellWorld(`globalThis.__anusAgentOverlay.glow.getAnimations({ subtree: true }).filter((a) => a.animationName === 'breathe').map((a) => a.effect.getTiming().duration)`);
check(breath.length === 1 && breath[0] >= 4000 && breath[0] <= 6000, `it breathes slowly (${breath[0]} ms a breath)`);
const radius = await inShellWorld(`getComputedStyle(globalThis.__anusAgentOverlay.glow).borderTopLeftRadius`);
check(radius === '12px', `the glow's corners are the page area's (${radius})`);

// ---- 2. tool calls: the pointer, and the glow staying put -----------------------------------------

chat('acting', 'Reading the page');
const read = await tool('agent_read_page', { tabId: null });
const refOf = (text, label) => text.match(new RegExp(`\\[(e\\d+)\\][^\\n]*"${label}"`))?.[1];
const go = refOf(read.text, 'Go');
const name = refOf(read.text, 'Name');
const next = refOf(read.text, 'Next page');
check(!!go && !!name && !!next, `read_page lists the page's controls (${go}, ${name}, ${next})`);

async function act(toolName, ref, extra = {}) {
  await front();
  const inspected = await tool('agent_inspect', { tabId: null, ref });
  const fingerprint = JSON.parse(inspected.text).fingerprint;
  chat('acting', `${toolName} ${ref}`);
  return tool(toolName, { tabId: null, ref, fingerprint, ...extra });
}

const clicked = await act('agent_click', go);
check(!clicked.isError, `the click went through (${clicked.text.slice(0, 80)})`);
const goClick = judgeGlide(await monitor(), 'click');
const pageClicks = await tab.eval('__clicks');
check(pageClicks.length === 1 && pageClicks[0].id === 'go', `the page got exactly that click, on the button (${JSON.stringify(pageClicks.map((c) => c.id))})`);

// A blip of "idle" between steps doesn't end the run.
chat('idle');
await wait(350);
chat('thinking', 'Thinking…');

const typed = await act('agent_type', name, { text: 'Ada Lovelace', clear: true });
check(!typed.isError && (await tab.eval(`document.getElementById('name').value`)) === 'Ada Lovelace', 'typing went through');
await wait(150);
const afterType = await monitor();
const field = await tab.eval(`(() => { const r = document.getElementById('name').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`);
const pointerNow = afterType.samples.at(-1);
check(pointerNow.x >= field.left && pointerNow.x <= field.right && pointerNow.y >= field.top && pointerNow.y <= field.bottom, `before typing, the pointer went to the field (${Math.round(pointerNow.x)}, ${Math.round(pointerNow.y)})`);
check(afterType.ripples.length >= 2, `and rippled there (${afterType.ripples.length} ripples so far)`);

// It survives the page scrolling: still there, still where it was on screen.
await tab.eval('window.scrollBy(0, 300)');
await wait(120);
const scrolled = (await monitor()).samples.at(-1);
check(!scrolled.missing && scrolled.shown > 0.9 && Math.hypot(scrolled.x - pointerNow.x, scrolled.y - pointerNow.y) < 0.5, `scrolling the page leaves the pointer where it is (${JSON.stringify(pointerNow)} → ${JSON.stringify(scrolled)})`);
await tab.eval('window.scrollTo(0, 0)');
await shotOf('pointer-on-field');

// Several steps in, the glow never dipped.
const steady = (await monitor()).samples.filter((s) => !s.missing && s.t > entered.samples.at(-1).t);
const lowest = Math.min(...steady.map((s) => s.glow));
check(steady.length > 50 && lowest > 0.99 && steady.every((s) => !s.missing), `across ${steady.length} samples and 5 tool calls the glow stayed fully on (lowest ${lowest})`);
check((await tab.eval('__overlayLog')).length === 1, 'and was never put in again');

// It rests out of sight after a while.
const leftAt = Date.now();
await front();
const rested = await until(async () => {
  const last = (await monitor()).samples.at(-1);
  return last.shown < 0.05 && last;
}, 'the pointer to rest', 9000).catch(() => undefined);
check(!!rested, `the pointer fades when the agent leaves it alone (after ${Math.round((Date.now() - leftAt) / 100) / 10} s here, 3 s after its last move)`);

// Reduced motion: no glide, a jump.
await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await inShellWorld(MONITOR);
await act('agent_click', go);
judgeGlide(await monitor(), 'reduced motion', { glide: false });
await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

// ---- 3. the corners ------------------------------------------------------------------------------

/** Four corner crops and an edge strip of the page, as RGB rows, decoded in the page. */
async function corners(label, bg) {
  await front();
  await wait(300);
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  if (shots) fs.writeFileSync(path.join(shots, `overlay-${label}.png`), Buffer.from(data, 'base64'));
  const SIZE = 28; // css px
  const measured = await tab.eval(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${data}';
    await img.decode();
    const dpr = img.width / innerWidth;
    const n = Math.round(${SIZE} * dpr);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    // Each corner turned to the top left, so they can be compared pixel for pixel.
    const crop = (cx, cy, fx, fy) => {
      const px = g.getImageData(cx, cy, n, n).data;
      const out = [];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const sx = fx ? n - 1 - x : x, sy = fy ? n - 1 - y : y;
        const i = (sy * n + sx) * 4;
        out.push(px[i], px[i + 1], px[i + 2]);
      }
      return out;
    };
    const W = img.width, H = img.height;
    // The left edge at mid height, as a corner would be read along its diagonal.
    const edge = [...g.getImageData(0, Math.round(H / 2), n, 1).data].filter((_, i) => i % 4 !== 3);
    // A blown-up picture of the four corners for people.
    const zoom = 6, pic = new OffscreenCanvas(n * zoom * 2 + 8, n * zoom * 2 + 8), p = pic.getContext('2d');
    p.imageSmoothingEnabled = false;
    p.fillStyle = '#888'; p.fillRect(0, 0, pic.width, pic.height);
    [[0, 0], [W - n, 0], [0, H - n], [W - n, H - n]].forEach(([x, y], k) => p.drawImage(c, x, y, n, n, (k % 2) * (n * zoom + 8), Math.floor(k / 2) * (n * zoom + 8), n * zoom, n * zoom));
    const blob = await pic.convertToBlob({ type: 'image/png' });
    const picture = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    return { dpr, n, tl: crop(0, 0, false, false), tr: crop(W - n, 0, true, false), bl: crop(0, H - n, false, true), br: crop(W - n, H - n, true, true), edge, picture };
  })()`);
  if (shots) fs.writeFileSync(path.join(shots, `overlay-corners-${label}.png`), Buffer.from(measured.picture, 'base64'));
  const { n, dpr } = measured;
  const drawn = await inShellWorld(`getComputedStyle(globalThis.__anusAgentOverlay.glow).borderTopLeftRadius`);
  const win = await frame.eval(`(async () => { const w = await chrome.windows.getCurrent(); return w.state + ' ' + w.width + 'x' + w.height; })()`);
  console.log(`  ${label}: dpr ${dpr}, glow radius ${drawn}, window ${win}`);
  const px = (crop, x, y) => crop.slice((y * n + x) * 3, (y * n + x) * 3 + 3);
  const off = (rgb) => Math.max(...rgb.map((v, i) => Math.abs(v - bg[i])));
  const diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
  // 1) All four corners look alike.
  const worst = Math.max(diff(measured.tl, measured.tr), diff(measured.tl, measured.bl), diff(measured.tl, measured.br));
  check(worst < 2, `${label}: the four corners match (mean difference ${worst.toFixed(2)} of 255)`);
  // 2) The corner's very tip, which the window's rounding cuts away, has no glow: the glow
  //    bends with the corner instead of being cut.
  const tip = off(px(measured.tl, 0, 0));
  check(tip < 16, `${label}: nothing is drawn in the clipped-off tip of the corner (${tip} off the background)`);
  // 3) Along the corner's diagonal, the glow fades in like it does from a straight edge.
  const arc = Math.round(12 * (1 - Math.SQRT1_2) * dpr); // where the rounded corner crosses the diagonal
  const diag = (k) => off(px(measured.tl, Math.min(n - 1, arc + Math.round(k * Math.SQRT1_2)), Math.min(n - 1, arc + Math.round(k * Math.SQRT1_2))));
  const straight = (k) => off(measured.edge.slice(k * 3, k * 3 + 3));
  const ring = [Math.max(diag(0), diag(1), diag(2)), Math.max(straight(0), straight(1), straight(2))];
  const deeper = [diag(Math.round(10 * dpr)), straight(Math.round(10 * dpr))];
  check(ring[0] > 20 && ring[0] >= ring[1] * 0.6 && ring[0] <= ring[1] * 1.6, `${label}: the rim follows the curve as strongly as the edge (${ring[0]} vs ${ring[1]})`);
  check(deeper[0] >= deeper[1] * 0.8 && deeper[0] <= deeper[1] * 2.2, `${label}: and fades inward like the edge (${deeper[0]} vs ${deeper[1]} at 10 px)`);
}
await corners('light', [255, 255, 255]);

// ---- 4. a navigation in the tab: the new page has the glow already on ----------------------------

chat('acting', 'Opening the next page');
await act('agent_click', next);
await until(() => tab.eval(`location.pathname === '/dark' && document.readyState === 'complete'`), 'the dark page');
const log2 = await tab.eval('__overlayLog');
check(log2.length >= 1 && log2[0].enter === 'steady' && log2[0].on === 'true', `the next page gets the glow already on, no entrance (${JSON.stringify(log2)})`);
check(log2[0]?.readyState === 'loading', `before the page has finished loading (${log2[0]?.readyState} at ${Math.round(log2[0]?.t ?? 0)} ms)`);
const fresh = await inShellWorld(`(() => { const o = globalThis.__anusAgentOverlay; return { glow: +getComputedStyle(o.glow).opacity, transitions: o.glow.getAnimations().filter((a) => a instanceof CSSTransition).length, phase: o.glow.style.getPropertyValue('--phase') }; })()`);
check(fresh.glow > 0.99 && fresh.transitions === 0, `its glow is fully on with nothing fading in (opacity ${fresh.glow}, ${fresh.transitions} transitions)`);
check(/^-\d+ms$/.test(fresh.phase) && fresh.phase !== '-0ms', `and picks up the breath where the last page was (${fresh.phase})`);
await corners('dark', [0x0f, 0x11, 0x15]);

// The pointer starts from where it last was, on the new page too.
await inShellWorld(MONITOR);
const read2 = await tool('agent_read_page', { tabId: null });
await act('agent_click', refOf(read2.text, 'OK'));
const darkMon = await monitor();
const firstAt = darkMon.samples.find((s) => !s.missing && s.shown > 0.5);
check(!!firstAt && Math.hypot(firstAt.x - goClick.x, firstAt.y - goClick.y) < 400, `on the new page the pointer comes from where it was (${firstAt && `${Math.round(firstAt.x)}, ${Math.round(firstAt.y)}`})`);
judgeGlide(darkMon, 'click on the new page');
const lowest2 = Math.min(...darkMon.samples.filter((s) => !s.missing).map((s) => s.glow));
check(lowest2 > 0.99, `the glow stayed on there too (lowest ${lowest2})`);
await shotOf('pointer-dark');

// ---- 5. the run ends: it fades away ----------------------------------------------------------------

await front();
chat('idle');
await wait(500);
check(await tab.eval(`!!document.querySelector('anus-agent-overlay')`), 'a short idle keeps it (the next step may come)');
const ended = Date.now();
const gone = await until(() => tab.eval(`!document.querySelector('anus-agent-overlay')`), 'the overlay to go', 6000).catch(() => false);
check(gone && Date.now() - ended < 2000, `when the run has ended it is gone (${Date.now() - ended + 500} ms after the last step; ${await tab.eval(`document.querySelector('anus-agent-overlay')?.dataset.on ?? 'removed'`)})`);

async function shotOf(name) {
  if (!shots) return;
  const { data } = await tab.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `overlay-${name}.png`), Buffer.from(data, 'base64'));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (${hostMessages} messages from the shell)`);
server.close();
relay.close();
quit();
process.exit(failed ? 1 : 0);
