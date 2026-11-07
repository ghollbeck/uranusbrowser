// The on-device Underdog model: found by looking at files only, started by the first prompt (not
// before), one child reused, released when idle, stopped on a timeout or an abort, given no
// secrets, and used by the meeting summary only when that is asked for.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { MeetingError } from '../native-host/meetingTranscribe';
import { summarizeMeeting } from '../native-host/meetingSummary';
import { UnderdogError, UnderdogLlm, resolveUnderdog } from '../native-host/underdogLlm';
import type { SecretStore } from '../native-host/secrets';

// Tests are bundled into tests/.cache, so the fixture is found from the repository root (where npm test runs).
const FAKE = path.resolve(process.cwd(), 'chromium/tests/fixtures/fake-woof.mjs');

/** An UnderdogLlm that launches the fake server instead of Python, counting how often it starts. */
function harness(options: { idleMs?: number; requestMs?: number; startupMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const starts: string[][] = [];
  const llm = new UnderdogLlm(
    () => ({ ok: true, launch: { command: process.execPath, args: [FAKE], label: 'Underdog Woof 2B 1.1 (on this Mac)' } }),
    {
      ...options,
      env: { PATH: process.env.PATH, HOME: '/tmp/home', OPENAI_API_KEY: 'sk-test-must-not-reach-the-child', FAKE_WOOF_JSON: '{"overview":[1],"decisions":[],"action_items":[],"open_questions":[]}', ...options.env },
      spawnImpl: ((command: string, args: string[], opts: object) => {
        starts.push(args);
        return spawn(command, args, opts as never);
      }) as typeof spawn,
    },
  );
  return { llm, starts };
}
const ask = (text: string, extra: object = {}) => ({ messages: [{ role: 'user' as const, content: text }], ...extra });
const gone = async (llm: UnderdogLlm, ms = 3000) => {
  const end = Date.now() + ms;
  while (llm.loaded() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return !llm.loaded();
};

test('availability is decided from files; each missing piece is named, and only the pinned snapshot counts', () => {
  const home = '/Users/test';
  const snap = `${home}/.cache/huggingface/hub/models--ConwayResearch--Underdog-Woof-2B-1.1/snapshots/73c8b5ca3abffb2358270f4bc86bff697131612a/model.safetensors`;
  const python = `${home}/.local/share/voxtral-transcribe/.venv/bin/python`;
  const script = '/Applications/OpenWhisper.app/Contents/Resources/python/llm_mlx_server.py';
  const have = (...files: string[]) => ({ home, env: {}, exists: (f: string) => files.includes(f) });
  assert.match((resolveUnderdog(have(python, snap)) as { detail: string }).detail, /script wasn’t found/);
  assert.match((resolveUnderdog(have(script, snap)) as { detail: string }).detail, /Python environment/);
  assert.match((resolveUnderdog(have(script, python)) as { detail: string }).detail, /isn’t downloaded/);
  // another snapshot revision is not used
  const other = snap.replace('73c8b5ca3abffb2358270f4bc86bff697131612a', 'ffffffffffffffffffffffffffffffffffffffff');
  assert.equal(resolveUnderdog(have(script, python, other)).ok, false);
  const ok = resolveUnderdog(have(script, python, snap));
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.launch.command, python);
    assert.deepEqual(ok.launch.args.slice(0, 5), ['-u', script, '--server', '--model', 'woof-2b-1.1']);
    assert.match(ok.launch.label, /Underdog Woof 2B 1\.1 \(on this Mac\)/);
  }
  assert.match((resolveUnderdog({ ...have(), env: { ANUS_UNDERDOG_MODEL: 'nope' } }) as { detail: string }).detail, /Unknown/);
});

test('nothing starts until the first prompt; then one child serves every prompt', async () => {
  const { llm, starts } = harness({ idleMs: 0 });
  assert.equal(llm.info().ready, true);
  assert.equal(llm.info().loaded, false);
  assert.equal(starts.length, 0, 'asking whether it is available starts nothing');
  const first = await llm.chat(ask('hello'));
  assert.equal(first.text, 'plain answer');
  assert.equal(starts.length, 1);
  assert.equal(llm.info().loaded, true);
  await llm.chat(ask('again'));
  assert.equal(starts.length, 1, 'the same child is reused');
  await llm.dispose();
  assert.equal(llm.loaded(), false);
  await llm.chat(ask('after a release'));
  assert.equal(starts.length, 2, 'asked again, it starts again');
  await llm.dispose();
});

test('after the idle time the model is released by itself', async () => {
  const { llm } = harness({ idleMs: 150 });
  await llm.chat(ask('hi'));
  assert.equal(llm.loaded(), true);
  assert.ok(await gone(llm), 'unloaded after idling');
  await llm.dispose();
});

test('the child gets no secrets; what it prints to stderr is never kept; errors say nothing about the content', async () => {
  const { llm } = harness({ idleMs: 0 });
  const env = JSON.parse((await llm.chat(ask('ENV'))).text) as string[];
  assert.ok(!env.includes('OPENAI_API_KEY'), 'the key is not passed on');
  assert.ok(env.includes('HF_HUB_OFFLINE'));
  await assert.rejects(llm.chat(ask('FAIL private words')), (err: Error) => err instanceof UnderdogError && !/private|transcript|boom|sk-/.test(err.message));
  // still usable after an error
  assert.equal((await llm.chat(ask('fine'))).text, 'plain answer');
  await llm.dispose();
});

test('a prompt that never gets an answer is stopped (and the weights released); so is an abort', async () => {
  const { llm } = harness({ idleMs: 0, requestMs: 200 });
  await assert.rejects(llm.chat(ask('HANG')), /took too long/);
  assert.equal(llm.loaded(), false);
  const aborter = new AbortController();
  const pending = llm.chat(ask('HANG again', { signal: aborter.signal }));
  setTimeout(() => aborter.abort(), 100);
  await assert.rejects(pending, /Cancelled/);
  assert.equal(llm.loaded(), false);
  // it starts again for the next prompt
  assert.equal((await llm.chat(ask('ok'))).text, 'plain answer');
  await llm.dispose();
});

test('prompts run one at a time, in order', async () => {
  const { llm } = harness({ idleMs: 0 });
  const answers = await Promise.all([llm.chat(ask('one')), llm.chat(ask('two')), llm.chat(ask('three'))]);
  assert.deepEqual(answers.map((a) => a.text), ['plain answer', 'plain answer', 'plain answer']);
  await llm.dispose();
});

// ---- the meeting summary -------------------------------------------------------------------------------

const transcript = [
  { speaker: 'Others', start_ms: 12000, text: 'We decided to release on Monday.' },
  { speaker: 'Me', start_ms: 18000, text: 'I will send the report tomorrow.' },
];
const noKey: SecretStore = { openaiKey: async () => undefined };
const neverFetch = (async () => {
  throw new Error('the on-device summary must not reach OpenAI');
}) as unknown as typeof fetch;

test('asked for the on-device model, the summary needs no OpenAI key, sends nothing, and stays grounded', async () => {
  const { llm } = harness({ idleMs: 0 });
  try {
    const out = await summarizeMeeting({ segments: transcript, provider: 'underdog' }, { secrets: noKey, fetcher: neverFetch, underdog: llm });
    assert.match(out.model, /Underdog Woof 2B 1\.1/);
    assert.equal(out.method, 'model');
    // the notes quote the original line the model picked (id 1), nothing the model wrote
    assert.ok(JSON.stringify(out.items).includes('We decided to release on Monday.'));
  } finally {
    await llm.dispose(); // the fake server never outlives the test, pass or fail
  }
});

test('the on-device model is never used unless asked for; and asking when it is absent is a clear error', async () => {
  const { llm, starts } = harness({ idleMs: 0 });
  // default: OpenAI path, so with no key it stops there and the model is never started
  await assert.rejects(summarizeMeeting({ segments: transcript }, { secrets: noKey, fetcher: neverFetch, underdog: llm }), (e: Error) => e instanceof MeetingError && /OpenAI API key/.test(e.message));
  assert.equal(starts.length, 0);
  await assert.rejects(summarizeMeeting({ segments: transcript, provider: 'underdog' }, { secrets: noKey, fetcher: neverFetch }), /isn’t available/);
  await llm.dispose();
});
