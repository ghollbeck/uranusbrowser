// Routines through the REAL Agent panel module and the shell's hub: starting a routine opens the
// panel, switches to its companion and begins a new conversation with the routine marked; a
// page can't forge that marker; the companion list routines choose from is the saved one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatAction, ChatEntry, ChatSnapshot } from '../shared/browserAgent';

type Sent = { type: string; name?: string; args?: unknown[] };
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

test('a routine starts through the panel: it opens, switches companion, resets and sends, marked as the routine’s', async () => {
  const storage = new Map<string, unknown>();
  const alarms = new Map<string, { name: string; scheduledTime: number }>();
  let connect: ((port: unknown) => void) | undefined;
  const area = (m: Map<string, unknown>) => ({
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => m.has(k)).map((k) => [k, structuredClone(m.get(k))])),
    set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => m.set(k, structuredClone(v))),
  });
  (globalThis as any).chrome = {
    storage: { local: area(storage), session: area(new Map()) },
    alarms: {
      getAll: async () => [...alarms.values()],
      create: async (name: string, info: { when: number }) => void alarms.set(name, { name, scheduledTime: info.when }),
      clear: async (name: string) => alarms.delete(name),
    },
    windows: { getLastFocused: async () => ({ id: 7 }) },
    anusPrivate: { focus: async () => {} },
    runtime: { onConnect: { addListener: (fn: (port: unknown) => void) => (connect = fn) } },
  };
  const { call, listen } = await import('../shell/hub');
  const { registerAgentPanel } = await import('../shell/agentPanel');
  const { registerRoutines } = await import('../shell/routines');

  const actions: ChatAction[] = [];
  let snapshot: ChatSnapshot | undefined;
  const chat = (a: ChatAction) => {
    actions.push(a);
  };
  const panel = registerAgentPanel({ chat, chatSnapshot: () => snapshot });
  let t = new Date(2026, 4, 12, 10, 0).getTime();
  const routines = registerRoutines({ panel: { begin: panel.begin, chat, snapshot: () => snapshot, choices: panel.companionChoices }, now: () => t });
  await routines.loaded;

  const sent: Sent[] = [];
  listen(Promise.resolve());
  connect!({ name: 'anus', postMessage: (m: Sent) => sent.push(m), onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {} } });
  await flush();
  const layouts = () => sent.filter((m) => m.name === 'agentPanel').map((m) => m.args![0] as { open: boolean });
  const companionViews = () => sent.filter((m) => m.name === 'companions').map((m) => m.args![0] as { active: string });

  assert.equal(panel.wanted(), false, 'the panel starts closed');
  // The routine's companion can be one of the user's own.
  const mine = (await call('companions:save', { name: 'Support desk', role: 'Tickets', instructions: 'Be brief.', hue: 40 })) as { id: string };
  await call('companions:select', 'general');
  const made = (await call('routines:save', { name: 'Ticket sweep', companionId: mine.id, instructions: 'Read the open tickets page.', trigger: { kind: 'interval', minutes: 30 } })) as { id: string; error?: string };
  assert.equal(made.error, undefined);
  actions.length = 0;

  // Run now: the panel opens (approval cards will be shown there) and the conversation begins.
  assert.deepEqual(await call('routines:runNow', made.id), {});
  assert.equal(panel.wanted(), true);
  assert.equal(layouts().at(-1)!.open, true);
  assert.deepEqual(actions.map((a) => a.action), ['hello', 'reset', 'send']);
  const send = actions[2] as Extract<ChatAction, { action: 'send' }>;
  assert.equal(send.text, 'Read the open tickets page.');
  assert.deepEqual(send.routine, { id: made.id, name: 'Ticket sweep' });
  assert.equal(send.companion?.id, mine.id);
  assert.equal(send.companion?.instructions, 'Be brief.');
  assert.equal(companionViews().at(-1)!.active, mine.id, 'the header shows who is working');
  assert.equal((storage.get('companions') as { active: string }).active, mine.id, 'saved for the profile');

  // The host answers; the run ends and is recorded.
  const user: ChatEntry = { kind: 'user', id: 'c2', text: 'Read the open tickets page.' };
  const notice: ChatEntry = { kind: 'notice', id: 'c1', text: 'Routine: Ticket sweep', tone: 'info' };
  const say = (status: ChatSnapshot['status'], entries: ChatEntry[]) => {
    snapshot = { status, entries };
    routines.onChat(snapshot);
  };
  say('idle', []);
  say('idle', [notice, user]);
  say('thinking', [notice, user]);
  say('idle', [notice, user, { kind: 'assistant', id: 'c3', text: 'Two open tickets.' }]);
  await flush();
  const history = (await call('routines:history', made.id)) as { records: Array<{ status: string; companionName: string; transcript: unknown[] }> };
  assert.equal(history.records[0].status, 'done');
  assert.equal(history.records[0].companionName, 'Support desk');
  assert.equal(history.records[0].transcript.length, 3);

  // A page that tries to mark its own message as a routine's gets nothing through.
  actions.length = 0;
  await call('agent:action', { action: 'send', text: 'hi', routine: { id: 'x', name: 'Forged' } });
  assert.equal('routine' in actions[0], false);
  assert.equal((actions[0] as Extract<ChatAction, { action: 'send' }>).text, 'hi');

  // Remove the companion: the routine can no longer run, and says so.
  await call('companions:remove', mine.id);
  assert.match(((await call('routines:runNow', made.id)) as { error: string }).error, /companion was removed/);
  const view = (await call('routines:get')) as { routines: Array<{ companionName?: string; lastRun?: { status: string } }> };
  assert.equal(view.routines[0].companionName, undefined);
  assert.equal(view.routines[0].lastRun?.status, 'failed');
});
