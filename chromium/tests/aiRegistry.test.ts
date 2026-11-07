// The central AI provider (native-host/ai/registry.ts): one provider and model per feature,
// saved without secrets, env overrides on top, "can't work" options explained, and a model
// picked for the chat reaching the very next request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatSession, type ChatHooks } from '../native-host/agentChat';
import { OpenAIApiProvider, chatModelsFrom } from '../native-host/ai/openaiApi';
import { AiRegistry } from '../native-host/ai/registry';
import type { AiProvider } from '../native-host/ai/types';
import { ProviderError } from '../native-host/agentProvider';
import type { SecretStore } from '../native-host/secrets';
import type { ChatSnapshot } from '../shared/browserAgent';
import type { AiProviderView } from '../shared/aiProtocol';

const KEY = `sk-test-${'R4z'.repeat(14)}`;
const secrets: SecretStore = { openaiKey: async () => ({ key: KEY, source: 'keychain' }) };
const noKey: SecretStore = { openaiKey: async () => undefined };

/** A fake OpenAI: records every request, answers chat with a short message and models with a list. */
function fakeOpenAi() {
  const seen: Array<{ url: string; body?: any; auth?: string }> = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, auth: headers.authorization });
    if (url.endsWith('/models')) {
      const data = ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4o-transcribe', 'text-embedding-3-small', 'gpt-5.4-2026-03-01', 'o4-mini', 'dall-e-3', 'gpt-realtime'].map((id) => ({ id }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

/** A stand-in provider with a chosen readiness and capabilities. */
function fakeProvider(id: 'codex' | 'underdog', ready: { value: boolean }, capabilities = { chat: true, text: true, transcribe: false }): AiProvider {
  return {
    id,
    label: id,
    capabilities,
    status: async (): Promise<AiProviderView> => ({ id, label: id, ready: ready.value, detail: ready.value ? 'ready' : 'Sign in first.', capabilities }),
    models: async () => [{ id: `${id}-model`, label: `${id} model` }],
    defaultModel: () => `${id}-model`,
    complete: async () => `${id} says hi`,
  };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anus-ai-')), 'prefs.json');

test('with nothing saved, every feature uses the OpenAI API key and its defaults', () => {
  const registry = new AiRegistry({ providers: [new OpenAIApiProvider(secrets)], env: {} });
  assert.equal(registry.choice('chat').provider.id, 'openai');
  assert.equal(registry.choice('chat').model, 'gpt-5.4-mini');
  assert.equal(registry.choice('transcribe').model, 'gpt-4o-mini-transcribe');
  assert.equal(registry.choice('routines').followsChat, true);
});

test('a model picked for the chat is the model of the very next request, and survives a restart', async () => {
  const file = tmpFile();
  const { fetcher, seen } = fakeOpenAi();
  const make = () => new AiRegistry({ providers: [new OpenAIApiProvider(secrets, fetcher)], file, env: {} });
  const registry = make();
  const published: ChatSnapshot[] = [];
  const hooks: ChatHooks = { runInShell: async () => ({ content: [] }), publish: (s) => published.push(structuredClone(s)), log: () => {} };
  const chat = new ChatSession((feature) => registry.chat(feature), hooks);
  registry.onChange(() => void chat.providerChanged());

  await chat.handle({ action: 'send', text: 'hello' });
  assert.equal(seen.at(-1)!.body.model, 'gpt-5.4-mini');
  registry.set('chat', 'openai', 'gpt-5.4');
  await chat.providerChanged();
  await chat.handle({ action: 'send', text: 'again' });
  assert.equal(seen.at(-1)!.body.model, 'gpt-5.4');
  // A fresh conversation: the new model doesn't get the old turns; the panel says so.
  assert.equal(seen.at(-1)!.body.input.length, 1);
  assert.ok(published.at(-1)!.entries.some((e) => e.kind === 'notice' && /Now using gpt-5\.4/.test(e.text)));

  // Saved as plain choices, no key in the file.
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes(KEY));
  assert.deepEqual(JSON.parse(saved).features.chat, { provider: 'openai', model: 'gpt-5.4' });
  assert.equal(make().choice('chat').model, 'gpt-5.4');
});

test('a development override fixes the OpenAI model above anything saved, and says which variable', () => {
  const registry = new AiRegistry({ providers: [new OpenAIApiProvider(secrets)], env: { ANUS_AGENT_MODEL: 'gpt-dev', ANUS_MEETING_TRANSCRIBE_MODEL: 'whisper-1' } });
  registry.set('chat', 'openai', 'gpt-5.4');
  assert.equal(registry.choice('chat').model, 'gpt-dev');
  assert.equal(registry.choice('chat').lockedBy, 'ANUS_AGENT_MODEL');
  assert.equal(registry.choice('meetingSummary').model, 'gpt-dev');
  assert.equal(registry.choice('transcribe').model, 'whisper-1');
});

test('a provider that cannot do a feature is refused, and the view says why', async () => {
  const ready = { value: true };
  const registry = new AiRegistry({
    providers: [new OpenAIApiProvider(noKey), fakeProvider('codex', ready), fakeProvider('underdog', ready, { chat: false, text: true, transcribe: false })],
    env: {},
  });
  assert.throws(() => registry.set('transcribe', 'codex', 'x'), (e: Error) => e instanceof ProviderError && /can’t transcribe audio/.test(e.message));
  assert.throws(() => registry.set('chat', 'underdog', 'x'), /browser tools/);
  assert.throws(() => registry.set('chat', 'codex', 'bad model name; rm -rf'), /isn’t a model name/);
  const view = await registry.view();
  const transcribe = view.features.transcribe.options;
  assert.equal(transcribe.find((o) => o.provider === 'codex')!.available, false);
  assert.match(transcribe.find((o) => o.provider === 'codex')!.reason!, /ChatGPT plan can’t transcribe/);
  assert.match(transcribe.find((o) => o.provider === 'underdog')!.reason!, /text only/);
  // No key: the option is there, not available, with what to do.
  const openai = view.features.chat.options.find((o) => o.provider === 'openai')!;
  assert.equal(openai.available, false);
  assert.match(openai.reason!, /Settings › AI/);
  assert.deepEqual(view.features.chat.options.find((o) => o.provider === 'codex')!.models, [{ id: 'codex-model', label: 'codex model' }]);
  assert.ok(!JSON.stringify(view).includes('sk-'));
});

test('a provider that becomes ready takes over only the features that did not work', async () => {
  const codexReady = { value: false };
  const registry = new AiRegistry({ providers: [new OpenAIApiProvider(noKey), fakeProvider('codex', codexReady)], env: {} });
  let changes = 0;
  registry.onChange(() => changes++);
  codexReady.value = true;
  await registry.adopt('codex');
  assert.equal(registry.choice('chat').provider.id, 'codex');
  assert.equal(registry.choice('meetingSummary').provider.id, 'codex');
  // Transcription can't move to ChatGPT; routines keep following the chat.
  assert.equal(registry.choice('transcribe').provider.id, 'openai');
  assert.equal(registry.choice('routines').followsChat, true);
  assert.ok(changes > 0);

  // With a working key nothing moves.
  const withKey = new AiRegistry({ providers: [new OpenAIApiProvider(secrets), fakeProvider('codex', { value: true })], env: {} });
  await withKey.adopt('codex');
  assert.equal(withKey.choice('chat').provider.id, 'openai');
});

test('text answers go to the feature\'s provider', async () => {
  const registry = new AiRegistry({ providers: [new OpenAIApiProvider(secrets), fakeProvider('codex', { value: true })], env: {} });
  registry.set('meetingSummary', 'codex', 'codex-model');
  const text = await registry.complete('meetingSummary', { instructions: 'x', input: 'y', maxTokens: 10, signal: new AbortController().signal });
  assert.equal(text, 'codex says hi');
});

test('the API key\'s model list keeps chat models only, the default first, and falls back without a key', async () => {
  const { fetcher, seen } = fakeOpenAi();
  const provider = new OpenAIApiProvider(secrets, fetcher);
  const models = (await provider.models('chat')).map((m) => m.id);
  assert.deepEqual(models, ['gpt-5.4-mini', 'gpt-5.4', 'o4-mini']);
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  await provider.models('chat');
  assert.equal(seen.length, 1, 'cached');
  assert.ok((await new OpenAIApiProvider(noKey, fetcher).models('chat')).length >= 1);
  assert.deepEqual(chatModelsFrom(['gpt-4o-mini-tts', 'gpt-4.1', 'gpt-image-1']).map((m) => m.id), ['gpt-4.1']);
  assert.ok((await provider.models('transcribe')).some((m) => m.id === 'whisper-1'));
});
