// End-to-end check of the agent's answers drawn as Markdown (shell/ui/markdownView.ts) in a real
// UrAnus Browser, through the real panel, with a stand-in native host that sends one rich answer
// (so it runs without a model, the same for every provider):
//   - headings, bold, lists, a task list, a quote, inline code and a code block with Copy;
//   - a table with right-aligned numbers that scrolls inside the answer;
//   - links and bare addresses as pills with the site's icon (from the local cache), the host,
//     and the full address as their tooltip; a click opens the page in a new tab;
//   - an image is a card, and nothing is fetched from its site until you click Show;
//   - raw HTML and a javascript: link in the answer stay text;
//   - light and dark screenshots.
//
//   node chromium/tests/e2e-markdown.mjs [--app /Applications/UrAnus Browser.app] [--shell-dir chromium/shell/dist] [--shots <dir>] [--keep]
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
const app = arg('--app', '/Applications/UrAnus Browser.app');
const shellDir = arg('--shell-dir', path.join(here, '../shell/dist'));
const shots = arg('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const profile = path.join(here, '.scratch', `markdown-profile-${Date.now()}`);
const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};


async function shot(target, name) {
  await wait(300);
  if (!shots) return;
  const { data } = await target.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  screenshot: ${name}.png`);
}

async function click(target, selector) {
  const at = await target.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!at) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await target.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}

// ---- the stand-in native host: relays between UrAnus Browser and this script --------------------------

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
const manifest = JSON.stringify({ name: 'dev.oprimo.anus.host', description: 'UrAnus Browser overlay test stand-in', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${SHELL_ID}/`] });

// ---- launch ----------------------------------------------------------------------------------

fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
const flags = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-mock-keychain', '--disable-features=MacAppCodeSignClone', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', `--anus-shell-dir=${path.resolve(shellDir)}`];
console.log(`UrAnus Browser: ${app}\nshell: ${shellDir}\nprofile: ${profile}`);
const browser = spawn(path.join(app, 'Contents/MacOS/UrAnus Browser'), flags, { stdio: 'ignore' });
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


// ---- the answer --------------------------------------------------------------------------------

// A local page stands in for the image's site, so "nothing was fetched" can be counted.
let imageRequests = 0;
const imageServer = http.createServer((req, res) => {
  imageRequests++;
  res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#7aa2d6"/><path d="M0 160 L110 50 L170 110 L230 70 L320 160Z" fill="#2b4d7e"/></svg>');
});
await new Promise((r) => imageServer.listen(0, '127.0.0.1', r));
// The panel only shows https images; this host maps to the local server through a rule below.
const IMAGE_URL = `https://images.example.test/mountain.svg?q=secret-from-the-page`;

const ANSWER = [
  '## Zurich coworking, compared',
  '',
  'I checked **three spaces** near ETH. The best value is **Impact Hub**, at [Impact Hub Zurich](https://impacthub.ch/en/zurich/), see also https://www.ethz.ch/en/campus/getting-there.html.',
  '',
  '| Space | Price / month | Distance | Link |',
  '|:---|---:|:--:|:---|',
  '| Impact Hub | 290 CHF | 8 min | [impacthub.ch](https://impacthub.ch) |',
  '| Kraftwerk | 350 CHF | 12 min | https://kraftwerk.host |',
  '| blueLion | 410 CHF | 15 min | — |',
  '',
  'Next steps:',
  '',
  '1. Book a **free trial day**',
  '2. Ask about the `student` rate',
  '   - bring your Legi',
  '   - weekdays only',
  '',
  '- [x] Compared prices',
  '- [ ] Visited in person',
  '',
  '> Prices change often; check before you sign.',
  '',
  '```js',
  "const cheapest = spaces.sort((a, b) => a.price - b.price)[0];",
  '```',
  '',
  `![A mountain near Zurich](${IMAGE_URL})`,
  '',
  'Raw <img src=x onerror="window.__xss=1"> stays text, and [this](javascript:window.__xss=2) is not a link.',
].join('\n');

toHost({
  type: 'chat',
  snapshot: {
    threadId: 'md-1',
    status: 'idle',
    entries: [
      { kind: 'user', id: 'u1', text: 'Compare coworking spaces near ETH' },
      { kind: 'assistant', id: 'a1', text: ANSWER },
    ],
  },
});
const panel = await cdp.session((await cdp.waitTarget((t) => t.url.startsWith(`chrome-extension://${SHELL_ID}/agent.html`))).targetId);
await until(() => panel.eval(`!!document.querySelector('.msg.assistant .md')`), 'the answer', 20000);
await wait(400);
const q = (js) => panel.eval(js);

check(await q(`document.querySelector('.md .md-h')?.textContent === 'Zurich coworking, compared'`), 'a heading');
check(await q(`[...document.querySelectorAll('.md strong')].some((s) => s.textContent === 'three spaces')`), 'bold text');
const pills = await q(`[...document.querySelectorAll('.md p .md-link')].map((a) => ({ label: a.querySelector('.md-link-label').textContent, host: a.querySelector('.md-link-host')?.textContent ?? '', title: a.title, fav: !!a.querySelector('.md-fav img, .md-fav') }))`);
check(pills.length === 2 && pills[0].label === 'Impact Hub Zurich' && pills[0].host === 'impacthub.ch' && pills[0].fav, `a titled link is a pill with the site's icon and host (${JSON.stringify(pills[0])})`);
check(pills[1]?.label === 'ethz.ch/en/…' && pills[1].title === 'https://www.ethz.ch/en/campus/getting-there.html', `a bare address is a pill naming the site, the full address as its tooltip (${pills[1]?.label})`);
check(await q(`[...document.querySelectorAll('.md .md-fav img')].every((i) => i.src.startsWith(location.origin + '/_favicon/'))`), 'site icons come from the local icon cache, not from the sites');
const table = await q(`(() => { const t = document.querySelector('.md-table'); return t && { cols: t.querySelectorAll('thead th').length, rows: t.querySelectorAll('tbody tr').length, right: getComputedStyle(t.querySelector('tbody td:nth-child(2)')).textAlign, links: t.querySelectorAll('.md-link').length, wrap: getComputedStyle(t.parentElement).overflowX }; })()`);
check(table && table.cols === 4 && table.rows === 3 && table.right === 'right' && table.links === 2 && table.wrap === 'auto', `a table: 4 columns, 3 rows, prices right-aligned, link pills inside, scrolls sideways (${JSON.stringify(table)})`);
check(await q(`document.querySelector('.md ol')?.children.length === 3 ? false : document.querySelector('.md ol')?.children.length === 2 && !!document.querySelector('.md ol li ul')`), 'a numbered list with a nested list');
check(await q(`document.querySelectorAll('.md .md-task').length === 2 && !!document.querySelector('.md .md-box.done')`), 'a task list with a ticked box');
check(await q(`!!document.querySelector('.md blockquote')`), 'a quote');
check(await q(`document.querySelector('.md .md-code-head span')?.textContent === 'js' && !!document.querySelector('.md .md-copy')`), 'a code block with its language and Copy');
check(await q(`!!document.querySelector('.md .md-inline-code')`), 'inline code');
check(await q(`!document.querySelector('.md img[src^="https://images"]') && window.__xss === undefined && document.querySelector('.msg.assistant').textContent.includes('<img src=x')`), 'raw HTML stays text and runs nothing');
check(await q(`![...document.querySelectorAll('.md a')].some((a) => a.href.startsWith('javascript'))`), 'a javascript: link is just its words');

// The image: a card until clicked.
check(await q(`!!document.querySelector('.md-image-show') && !document.querySelector('.md-image img')`), 'an image is a card naming its site');
check(imageRequests === 0, 'and nothing was fetched from the image’s site');
check(await q(`!document.querySelector('.msg.assistant .md p:last-child strong')`), 'underscores inside a word (window.__xss) are not bold');
await q(`document.getElementById('transcript').scrollTop = 0, true`);
await shot(panel, 'markdown-0-top');
await q(`document.getElementById('transcript').scrollTop = 1e6, true`);
await shot(panel, 'markdown-1-light');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await shot(panel, 'markdown-2-dark');
await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// Clicking Show loads it (the test maps the example host to the local server).
await panel.send('Fetch.enable', { patterns: [{ urlPattern: 'https://images.example.test/*' }] });
listeners.add(async (msg) => {
  if (msg.method !== 'Fetch.requestPaused') return;
  const r = await fetch(`http://127.0.0.1:${imageServer.address().port}/m.svg`);
  const body = Buffer.from(await r.arrayBuffer()).toString('base64');
  await panel.send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'image/svg+xml' }], body });
});
await click(panel, '.md-image-show');
await until(() => q(`(() => { const i = document.querySelector('.md-image img'); return !!i && i.complete && i.naturalWidth > 0; })()`), 'the image', 10000).catch(() => undefined);
check(await q(`(() => { const i = document.querySelector('.md-image img'); return !!i && i.naturalWidth > 0; })()`), 'Show loads the image, after the click');
await shot(panel, 'markdown-3-image');

// A pill opens its page in a new tab.
await click(panel, '.md p .md-link');
const opened = await until(async () => (await cdp.targets()).some((t) => t.type === 'page' && t.url.startsWith('https://impacthub.ch/')), 'the new tab', 20000).then(() => true, () => false);
check(opened, 'clicking a pill opens its page in a new tab');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
imageServer.close();
relay.close();
process.exit(failed.length ? 1 : 0);
