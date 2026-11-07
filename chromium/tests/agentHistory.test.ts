// The Agent panel's history list and model selector (shell/agentPanel.ts), through the real hub:
// conversations are filed by thread id and titled by their first message, a finished one is
// unread until you look, going back sends the saved entries to the host, and the selector's
// modes resolve to a model and effort that go with each message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatAction, ChatEntry, ChatSnapshot } from '../shared/browserAgent';

type Sent = { type: string; name?: string; args?: unknown[] };

test('history files conversations, marks unread ones and goes back to them; the selector picks the model', async () => {
  const storage = new Map<string, unknown>();
  let connect: ((port: unknown) => void) | undefined;
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, structuredClone(v));
        },
      },
    },
    windows: { getLastFocused: async () => ({ id: 7 }) },
    anusPrivate: { focus: async () => undefined },
    runtime: { onConnect: { addListener: (fn: (port: unknown) => void) => (connect = fn) } },
  };
  const { call, listen } = await import('../shell/hub');
  const { registerAgentPanel } = await import('../shell/agentPanel');

  const actions: ChatAction[] = [];
  let snapshot: ChatSnapshot | undefined;
  const panel = registerAgentPanel({
    chat: (a) => actions.push(a),
    chatSnapshot: () => snapshot,
    models: async () => ({ models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano'], default: 'gpt-5.4-mini' }),
  });
  const sent: Sent[] = [];
  listen(Promise.resolve());
  connect!({ name: 'anus', postMessage: (m: Sent) => sent.push(m), onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {} } });
  await new Promise((r) => setTimeout(r, 0));

  // ---- the selector ----
  const view = (await call('agentChoice:get')) as { mode: string; modes: Record<string, { model: string; effort: string; changed: boolean }>; models: string[] };
  assert.equal(view.mode, 'default');
  assert.deepEqual(view.modes.default, { model: 'gpt-5.4-mini', effort: 'low', changed: false });
  assert.deepEqual(view.modes.efficient, { model: 'gpt-5.4-nano', effort: 'low', changed: false }, 'the smallest model the account has');
  assert.deepEqual(view.modes.expert, { model: 'gpt-5.4', effort: 'high', changed: false }, 'the full model, thinking hard');
  // The composer's Thinking sets how hard it thinks; the model is the chat's own (its Model list).
  await call('agentChoice:set', { mode: 'default', effort: 'xhigh' });
  await call('agent:action', { action: 'send', text: 'plan my trip' });
  assert.deepEqual((actions.at(-1) as Extract<ChatAction, { action: 'send' }>).choice, { effort: 'xhigh' });
  assert.deepEqual(storage.get('agentChoice'), { mode: 'default', own: { default: { effort: 'xhigh' } } });
  // A profile that saved the old Expert mode (with a model of its own) no longer sends that model.
  await call('agentChoice:set', { mode: 'expert', effort: 'high' });
  await call('agentChoice:set', { mode: 'expert', model: 'not a model!' });
  await call('agent:action', { action: 'send', text: 'and the hotel' });
  assert.deepEqual((actions.at(-1) as Extract<ChatAction, { action: 'send' }>).choice, { effort: 'xhigh' }, 'Default’s effort, no mode model');
  await call('agentChoice:set', { mode: 'default', reset: true });
  assert.equal(((await call('agentChoice:get')) as typeof view).modes.default.effort, 'low', 'back to the default');

  // ---- history ----
  const user = (id: string, text: string): ChatEntry => ({ kind: 'user', id, text });
  const answer = (id: string, text: string): ChatEntry => ({ kind: 'assistant', id, text });
  const threads = () => sent.filter((m) => m.name === 'agentThreads').map((m) => m.args![0] as Array<{ id: string; title: string; unread: boolean; current: boolean }>).at(-1)!;

  // An empty new conversation isn't filed.
  panel.onChat({ threadId: 't1', status: 'idle', entries: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await call('agentThreads:list'), []);

  // Panel closed while it finishes: unread.
  snapshot = { threadId: 't1', status: 'thinking', entries: [user('c1', 'Check   flights from Zurich')] };
  panel.onChat(snapshot);
  snapshot = { threadId: 't1', status: 'idle', entries: [user('c1', 'Check   flights from Zurich'), answer('c2', 'Found three.')] };
  panel.onChat(snapshot);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(threads().map((t) => [t.id, t.title, t.unread, t.current]), [['t1', 'Check flights from Zurich', true, true]]);

  // Opening the panel shows it: read.
  await call('agentPanel:toggle');
  assert.equal(threads()[0].unread, false);
  // A routine finishes while the panel is closed: unread again until you look.
  await call('agentPanel:toggle');
  snapshot = { threadId: 't1', status: 'idle', entries: [...snapshot.entries, user('c3', 'And trains?'), answer('c4', 'Two.')] };
  panel.onChat(snapshot);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(threads()[0].unread, true);
  // A second conversation, with the panel open: not unread, and newest first.
  await call('agentPanel:toggle');
  snapshot = { threadId: 't2', status: 'idle', entries: [user('c1', 'Summarise this page'), answer('c2', 'It is about…')] };
  panel.onChat(snapshot);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(threads().map((t) => [t.id, t.unread, t.current]), [['t2', false, true], ['t1', false, false]]);

  // Going back: the host gets the saved entries, and the dot goes.
  assert.deepEqual(await call('agentThreads:open', 't1'), {});
  const opened = actions.at(-1) as Extract<ChatAction, { action: 'open' }>;
  assert.equal(opened.action, 'open');
  assert.equal(opened.thread.id, 't1');
  assert.deepEqual(opened.thread.entries.map((e) => e.id), ['c1', 'c2', 'c3', 'c4']);

  // Not while the agent works, and not one that doesn't exist.
  snapshot = { threadId: 't1', status: 'acting', entries: opened.thread.entries };
  assert.match(((await call('agentThreads:open', 't2')) as { error: string }).error, /Wait for the agent/);
  snapshot = { ...snapshot, status: 'idle' };
  assert.match(((await call('agentThreads:open', 'nope')) as { error: string }).error, /gone/);

  // Deleting the open one starts a fresh conversation.
  panel.onChat(snapshot);
  await call('agentThreads:remove', 't1');
  assert.deepEqual(actions.at(-1), { action: 'reset' });
  assert.deepEqual(((await call('agentThreads:list')) as Array<{ id: string }>).map((t) => t.id), ['t2']);

  // Saved for the next session (debounced).
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual((storage.get('agentThreads') as Array<{ id: string }>).map((t) => t.id), ['t2']);
});
