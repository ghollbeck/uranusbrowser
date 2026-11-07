#!/usr/bin/env node
// A stand-in for `codex app-server` (JSON-RPC lines over stdio), replaying the messages the real
// one (0.164) sends, for native-host/ai/codex.ts's tests. What it receives, and its argv and
// environment, go to FAKE_CODEX_LOG (one JSON object per line). FAKE_CODEX_SCENARIO picks how a
// turn goes: tool (default), fail, hang, exit, schema, text, twoTools, codeMode (the call comes
// from inside an `exec` cell, as GPT-6 models' code_mode_only tool mode does it).
import fs from 'node:fs';
import readline from 'node:readline';

const logFile = process.env.FAKE_CODEX_LOG;
const scenario = process.env.FAKE_CODEX_SCENARIO || 'tool';
let signedIn = process.env.FAKE_CODEX_SIGNED_IN === '1';
const log = (entry) => logFile && fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
log({ argv: process.argv.slice(2), env: { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null }, cwd: process.cwd() });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let nextServerId = 1000;
const waiting = new Map();
/** Asks the client something (as Codex asks for a dynamic tool) and waits for its answer. */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let threads = 0;
let turns = 0;
let current;

async function say(threadId, turnId, itemId, text) {
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } });
  for (const word of text.split(/(?<= )/)) {
    notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: word });
    await pause(2);
  }
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text }, completedAtMs: Date.now() });
}

async function runTurn(threadId, turnId, input) {
  current = { threadId, turnId, interrupted: false };
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  const finish = (status, error = null) => notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error } });
  if (scenario === 'hang') return;
  if (scenario === 'exit') {
    await pause(10);
    process.exit(3);
  }
  if (scenario === 'fail') {
    notify('error', { threadId, turnId, willRetry: false, error: { message: 'usage limit, token eyJabcdefghij.klmnop.qrs', codexErrorInfo: 'usageLimitExceeded' } });
    return finish('failed', { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null });
  }
  if (scenario === 'schema') {
    await say(threadId, turnId, 'm1', JSON.stringify({ title: 'Release planning' }));
    return finish('completed');
  }
  if (scenario === 'text') {
    await say(threadId, turnId, 'm1', `You said: ${input}`);
    return finish('completed');
  }
  if (scenario === 'codeMode') {
    if (process.argv.includes('code_mode_host')) {
      // The host is off: the model's exec cell fails, as Codex 0.164 says it.
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'm1', text: 'Browser access isn’t available right now.' }, completedAtMs: Date.now() });
      return finish('completed');
    }
    const callId = 'exec-0b1c2d3e';
    const args = { url: process.env.FAKE_CODEX_URL || 'https://example.com' };
    notify('item/started', { threadId, turnId, item: { type: 'dynamicToolCall', id: callId, namespace: null, tool: 'navigate', arguments: args, status: 'inProgress' } });
    const result = await ask('item/tool/call', { threadId, turnId, callId, namespace: null, tool: 'navigate', arguments: args });
    log({ toolResults: [result] });
    notify('item/completed', { threadId, turnId, item: { type: 'dynamicToolCall', id: callId, namespace: null, tool: 'navigate', arguments: args, status: 'completed', contentItems: result.contentItems, success: result.success } });
    await say(threadId, turnId, 'm2', 'The page title is **Example Domain**.');
    return finish('completed');
  }
  await say(threadId, turnId, 'm1', 'I’ll open it.');
  const url = process.env.FAKE_CODEX_URL || 'https://example.com';
  const calls = scenario === 'twoTools' ? [['c1', 'navigate', { url }], ['c2', 'read_page', { tabId: null }]] : [['c1', 'navigate', { url }]];
  const results = await Promise.all(calls.map(([callId, tool, args]) => ask('item/tool/call', { threadId, turnId, callId, namespace: null, tool, arguments: args })));
  log({ toolResults: results });
  if (current.interrupted) return;
  await say(threadId, turnId, 'm2', 'The title is Example Domain.');
  finish('completed');
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  log({ in: message });
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? message.error);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params = {} } = message;
  const reply = (result) => send({ id, result });
  switch (method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex/0.164.0', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'macos' });
    case 'initialized':
      return;
    case 'account/read':
      return reply({ account: signedIn ? { type: 'chatgpt', email: 'dude@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true, workspaceRouting: null });
    case 'account/login/start':
      reply({ type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize?client=codex&state=abc' });
      await pause(30);
      signedIn = true;
      return notify('account/login/completed', { loginId: 'login-1', success: true, error: null });
    case 'account/login/cancel':
      return reply({ status: 'canceled' });
    case 'account/logout':
      signedIn = false;
      return reply({});
    case 'account/rateLimits/read':
      return reply({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793300000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793800000 } } });
    case 'model/list':
      return reply({
        data: [
          { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: true },
          { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false, isDefault: false },
          { id: 'secret-preview', displayName: 'Hidden', hidden: true, isDefault: false },
        ],
        nextCursor: null,
      });
    case 'thread/start': {
      if (!signedIn) return send({ id, error: { code: -32000, message: 'not signed in' } });
      const threadId = `thread-${++threads}`;
      reply({ thread: { id: threadId }, model: params.model, cwd: params.cwd });
      return notify('thread/started', { thread: { id: threadId } });
    }
    case 'turn/start': {
      const turnId = `turn-${++turns}`;
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      return runTurn(params.threadId, turnId, params.input?.[0]?.text ?? '');
    }
    case 'turn/interrupt':
      if (current) current.interrupted = true;
      reply({});
      return notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, items: [], status: 'interrupted', error: null } });
    case 'thread/unsubscribe':
      return reply({});
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
