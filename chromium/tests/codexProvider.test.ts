// The ChatGPT provider (native-host/ai/codex.ts) against a fake `codex app-server`
// (fakeCodexServer.mjs) replaying the real one's JSON-RPC: sign-in without UrAnus Browser touching a
// token, a locked-down thread, browser tools through the chat's own approval gate, streamed
// text, and clean errors (a usage limit, a server that goes quiet, one that dies).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ChatSession, type ChatHooks } from '../native-host/agentChat';
import { CodexProvider, cleanError, findCodex } from '../native-host/ai/codex';
import { AiRegistry } from '../native-host/ai/registry';
import { OpenAIApiProvider } from '../native-host/ai/openaiApi';
import type { AgentResult } from '../shared/agentTools';
import type { ChatSnapshot, TargetInfo } from '../shared/browserAgent';

const FAKE = fileURLToPath(new URL('../fakeCodexServer.mjs', import.meta.url));

function setup(scenario = 'tool', signedIn = true, extra: Partial<ConstructorParameters<typeof CodexProvider>[0]> = {}, fakeEnv: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anus-codex-'));
  const logFile = path.join(dir, 'server.log');
  const changes: Array<{ signedIn: boolean; error?: string }> = [];
  const codex = new CodexProvider({
    home: path.join(dir, 'home'),
    workspace: path.join(dir, 'workspace'),
    launch: { command: process.execPath, args: [FAKE] },
    // An API key in UrAnus Browser's environment must not reach Codex.
    env: { ...process.env, OPENAI_API_KEY: 'sk-should-not-reach-codex-1234567890' } as NodeJS.ProcessEnv,
    extraEnv: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_SIGNED_IN: signedIn ? '1' : '0', ...fakeEnv },
    onChange: (e) => changes.push(e),
    ...extra,
  });
  const seen = () =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { codex, seen, changes, dir };
}

function chatHarness(codex: CodexProvider, shell: (name: string, args: Record<string, unknown>) => AgentResult) {
  const published: ChatSnapshot[] = [];
  const shellCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const hooks: ChatHooks = {
    runInShell: async (name, args) => {
      shellCalls.push({ name, args });
      return shell(name, args);
    },
    publish: (s) => published.push(structuredClone(s)),
    log: () => {},
  };
  const chat = new ChatSession(codex.chat('gpt-6.1-sol'), hooks);
  return { chat, published, shellCalls, last: () => published.at(-1)! };
}

const text = (value: unknown): AgentResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const exampleTarget: TargetInfo = { url: 'https://example.org/', title: 'Start', fingerprint: 'https://example.org/|nav' };

test('findCodex prefers the native binary inside the npm package over its Node script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anus-codex-bin-'));
  const pkg = path.join(dir, 'lib/node_modules/@openai/codex');
  const arch = process.arch === 'arm64' ? ['arm64', 'aarch64-apple-darwin'] : ['x64', 'x86_64-apple-darwin'];
  const native = path.join(pkg, 'node_modules/@openai', `codex-darwin-${arch[0]}`, 'vendor', arch[1], 'bin/codex');
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(native, '\x7fELF', { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'bin/codex.js'), '#!/usr/bin/env node\nconsole.log(1)\n', { mode: 0o755 });
  fs.symlinkSync(path.join(pkg, 'bin/codex.js'), path.join(dir, 'bin/codex'));
  const found = findCodex({ PATH: path.join(dir, 'bin'), HOME: dir }, (f) => f.startsWith(dir) && fs.existsSync(f));
  assert.equal(found?.command, fs.realpathSync(native));
  assert.deepEqual(found?.args, []);
  assert.equal(findCodex({ PATH: '/nonexistent', HOME: dir }, () => false), undefined);
});

test('sign-in: Codex hands UrAnus Browser a page to open and says when it is done; no token ever comes back', async () => {
  const { codex, seen, changes } = setup('text', false);
  try {
    const before = await codex.status();
    assert.equal(before.ready, false);
    assert.equal(before.installed, true);
    const url = await codex.startLogin();
    assert.match(url, /^https:\/\/auth\.openai\.com\//);
    assert.equal((await codex.status()).loginPending, true);
    await waitFor(() => changes.length > 0);
    assert.deepEqual(changes[0], { signedIn: true, error: undefined });
    const after = await codex.status();
    assert.equal(after.ready, true);
    assert.deepEqual(after.account, { email: 'dude@example.com', plan: 'plus' });
    assert.equal(after.limits?.primary?.usedPercent, 12);
    assert.equal(after.limits?.secondary?.windowMins, 10080);
    assert.ok(!JSON.stringify(after).match(/token|eyJ/i));
    // Its own home, an empty folder, and no API key in its environment.
    const start = seen()[0];
    assert.match(start.env.CODEX_HOME, /anus-codex-.*\/home$/);
    assert.equal(start.env.OPENAI_API_KEY, null);
    assert.match(start.cwd, /workspace$/);
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation']) {
      assert.ok(start.argv.join(' ').includes(`--disable ${feature}`), `${feature} is off`);
    }
    assert.ok(start.argv.includes('web_search="disabled"'));
    // Codex's own skills (imagegen and the rest) would be offered without their tools.
    assert.ok(start.argv.includes('skills.bundled.enabled=false') && start.argv.includes('skills.include_instructions=false'), 'Codex’s bundled skills are off');
    await codex.logout();
    assert.equal((await codex.status()).ready, false);
  } finally {
    await codex.dispose();
  }
});

test('models come from model/list, hidden ones left out, the plan default first and as the default', async () => {
  const { codex } = setup();
  try {
    assert.deepEqual(
      (await codex.models('chat')).map((m) => m.id),
      ['gpt-6.1-sol', 'gpt-5.6-luna'],
    );
    assert.equal(codex.defaultModel(), 'gpt-6.1-sol');
  } finally {
    await codex.dispose();
  }
});

test('a browser tool from Codex runs through the chat loop: checked, logged, run by the shell, and answered', async () => {
  const { codex, seen } = setup('tool');
  try {
    const { chat, shellCalls, last, published } = chatHarness(codex, (name) =>
      name === 'agent_inspect' ? text(exampleTarget) : text('Opened https://example.com/\nTitle: Example Domain'),
    );
    await chat.handle({ action: 'send', text: 'Open example.com and tell me the title' });
    const entries = last().entries;
    // The model left out tabId and action; they were filled in as null and the call went through.
    assert.deepEqual(
      shellCalls.map((c) => c.name),
      ['agent_inspect', 'agent_navigate'],
    );
    assert.equal(shellCalls[1].args.url, 'https://example.com');
    const tool = entries.find((e) => e.kind === 'tool');
    assert.ok(tool && tool.kind === 'tool' && tool.state === 'done' && /example\.com/.test(tool.summary));
    const answers = entries.filter((e) => e.kind === 'assistant').map((e) => (e as { text: string }).text);
    assert.deepEqual(answers, ['I’ll open it.', 'The title is Example Domain.']);
    // It streamed: an earlier snapshot had part of an answer.
    assert.ok(published.some((s) => s.entries.some((e) => e.kind === 'assistant' && e.text !== 'I’ll open it.' && 'I’ll open it.'.startsWith(e.text))));
    // The thread was locked down and given UrAnus Browser's tools.
    const start = seen().find((e) => e.in?.method === 'thread/start').in.params;
    assert.equal(start.sandbox, 'read-only');
    assert.equal(start.approvalPolicy, 'never');
    assert.equal(start.ephemeral, true);
    assert.match(start.baseInstructions, /UrAnus Browser's browser agent/);
    assert.ok(start.dynamicTools.some((t: { name: string; inputSchema: object }) => t.name === 'navigate' && t.inputSchema));
    // The tool's output went back to Codex fenced as page data.
    const results = seen().find((e) => e.toolResults)?.toolResults;
    assert.match(results[0].contentItems[0].text, /untrusted data/);
    assert.equal(results[0].success, true);
    assert.equal(last().status, 'idle');
  } finally {
    await codex.dispose();
  }
});

test('a tool called from inside a code-mode exec cell (GPT-6 models) reaches the chat loop and its approval rules', async () => {
  const { codex, seen } = setup('codeMode');
  try {
    // The code-mode host must stay on, or code_mode_only models can't call any tool.
    assert.ok(!seen().length || !seen()[0].argv.includes('code_mode_host'));
    const { chat, shellCalls, last } = chatHarness(codex, (name) => (name === 'agent_inspect' ? text(exampleTarget) : text('Title: Example Domain')));
    await chat.handle({ action: 'send', text: 'Open example.com and tell me its title' });
    assert.ok(!seen()[0].argv.includes('code_mode_host'), 'code_mode_host is not disabled');
    assert.deepEqual(
      shellCalls.map((c) => c.name),
      ['agent_inspect', 'agent_navigate'],
    );
    const tool = last().entries.find((e) => e.kind === 'tool');
    assert.ok(tool && tool.kind === 'tool' && tool.state === 'done');
    assert.ok(last().entries.some((e) => e.kind === 'assistant' && /Example Domain/.test(e.text)));
    assert.equal(seen().find((e) => e.toolResults)?.toolResults[0].success, true);
  } finally {
    await codex.dispose();
  }
  // The same call to a sign-in page still waits for approval.
  const gated = setup('codeMode', true, {}, { FAKE_CODEX_URL: 'https://accounts.google.com/signin' });
  try {
    const { chat, published, shellCalls } = chatHarness(gated.codex, (name) => (name === 'agent_inspect' ? text(exampleTarget) : text('should not run')));
    const sent = chat.handle({ action: 'send', text: 'Open my sign-in' });
    await waitFor(() => published.some((s) => s.entries.some((e) => e.kind === 'approval' && e.state === 'pending')));
    const card = published.at(-1)!.entries.find((e) => e.kind === 'approval')!;
    await chat.handle({ action: 'decide', approvalId: card.id, approve: false });
    await sent;
    assert.ok(!shellCalls.some((c) => c.name === 'agent_navigate'));
    assert.equal(gated.seen().find((e) => e.toolResults)?.toolResults[0].success, false);
  } finally {
    await gated.codex.dispose();
  }
});

test('an action that needs approval still shows the card; declining it tells Codex nothing was done', async () => {
  // Opening a sign-in page asks first (shared/browserAgent.ts), whoever the model is.
  const { codex, seen } = setup('tool', true, {}, { FAKE_CODEX_URL: 'https://accounts.google.com/signin' });
  try {
    const { chat, shellCalls, published } = chatHarness(codex, (name) => (name === 'agent_inspect' ? text(exampleTarget) : text('should not run')));
    const sent = chat.handle({ action: 'send', text: 'Open my Google sign-in' });
    await waitFor(() => published.some((s) => s.entries.some((e) => e.kind === 'approval' && e.state === 'pending')));
    const card = published.at(-1)!.entries.find((e) => e.kind === 'approval')!;
    await chat.handle({ action: 'decide', approvalId: card.id, approve: false });
    await sent;
    assert.ok(!shellCalls.some((c) => c.name === 'agent_navigate'), 'nothing ran');
    const results = seen().find((e) => e.toolResults)?.toolResults;
    assert.match(results[0].contentItems[0].text, /declined/);
    assert.equal(results[0].success, false);
  } finally {
    await codex.dispose();
  }
});

test('a usage limit, a silent server and a dead server each end the run with a clear message, not a hang', async () => {
  for (const [scenario, expected] of [
    ['fail', /usage limit is reached/],
    ['hang', /stopped answering/],
    ['exit', /Codex stopped|ChatGPT said/],
  ] as const) {
    const { codex } = setup(scenario, true, { silenceMs: 300 });
    try {
      const { chat, last } = chatHarness(codex, () => text('ok'));
      const started = Date.now();
      await chat.handle({ action: 'send', text: 'hello' });
      const notice = last().entries.find((e) => e.kind === 'notice' && e.tone === 'error');
      assert.ok(notice && notice.kind === 'notice', `${scenario}: an error notice`);
      assert.match(notice.text, expected, scenario);
      assert.ok(!/eyJ|token/i.test(notice.text), 'no token in the message');
      assert.ok(Date.now() - started < 5000, `${scenario}: no hang`);
      assert.equal(last().status, 'idle');
    } finally {
      await codex.dispose();
    }
  }
});

test('Stop interrupts the Codex turn and the chat is free again at once', async () => {
  const { codex, seen } = setup('hang');
  try {
    const { chat, last, published } = chatHarness(codex, () => text('ok'));
    const sent = chat.handle({ action: 'send', text: 'hello' });
    await waitFor(() => seen().some((e) => e.in?.method === 'turn/start'));
    await chat.handle({ action: 'stop' });
    await sent;
    await waitFor(() => seen().some((e) => e.in?.method === 'turn/interrupt'));
    assert.equal(last().status, 'idle');
    assert.ok(!published.at(-1)!.entries.some((e) => e.kind === 'notice' && e.tone === 'error'));
  } finally {
    await codex.dispose();
  }
});

test('after the chat loop stops on a changed page, the next message ends the old turn and starts a new one', async () => {
  const { codex, seen } = setup('tool');
  try {
    let navigations = 0;
    const { chat, last } = chatHarness(codex, (name) => {
      if (name === 'agent_inspect') return text(exampleTarget);
      // The first time the page changes under the action: the loop halts and doesn't answer Codex again.
      return navigations++ === 0 ? { content: [{ type: 'text', text: '[stale] The page changed.' }], isError: true } : text('Title: Example Domain');
    });
    await chat.handle({ action: 'send', text: 'Open example.com' });
    assert.ok(last().entries.some((e) => e.kind === 'notice' && /page changed/.test(e.text)));
    await chat.handle({ action: 'send', text: 'Try again' });
    const methods = seen().map((e) => e.in?.method).filter(Boolean);
    assert.ok(methods.includes('turn/interrupt'), 'the old turn was interrupted');
    assert.equal(methods.filter((m: string) => m === 'turn/start').length, 2);
    assert.ok(last().entries.some((e) => e.kind === 'assistant' && e.text === 'The title is Example Domain.'));
    assert.equal(last().status, 'idle');
  } finally {
    await codex.dispose();
  }
});

test('meeting notes through ChatGPT: a tool-less thread, the answer held to the schema', async () => {
  const { codex, seen } = setup('schema');
  try {
    const registry = new AiRegistry({ providers: [codex, new OpenAIApiProvider({ openaiKey: async () => undefined })], env: {} });
    registry.set('meetingSummary', 'codex', 'gpt-6.1-sol');
    const out = await registry.complete('meetingSummary', { instructions: 'Pick lines', input: 'x', schema: { name: 't', schema: { type: 'object' } }, maxTokens: 100, signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(out), { title: 'Release planning' });
    const turn = seen().find((e) => e.in?.method === 'turn/start').in.params;
    assert.deepEqual(turn.outputSchema, { type: 'object' });
    assert.deepEqual(seen().find((e) => e.in?.method === 'thread/start').in.params.dynamicTools, []);
    // ChatGPT can't transcribe; the registry refuses rather than trying.
    assert.throws(() => registry.set('transcribe', 'codex', 'x'), /can’t transcribe/);
  } finally {
    await codex.dispose();
  }
});

test('Codex not installed: Settings says so instead of failing', async () => {
  const { codex } = setup('text', false, { launch: () => undefined });
  const status = await codex.status();
  assert.equal(status.installed, false);
  assert.equal(status.ready, false);
  assert.match(status.detail, /Codex/);
});

test('error text from Codex is cleaned of tokens and request ids', () => {
  const out = cleanError('401 Unauthorized: Bearer abc.def token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, cf-ray: a51f0d6 sk-proj-abcdefghijklmnop');
  assert.ok(!/eyJ|abc\.def|a51f0d6|sk-proj/.test(out), out);
});

async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
