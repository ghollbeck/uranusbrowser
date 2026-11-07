// Meetings in the shell's background, through the real hub: what is saved per profile, what
// the opt-in needs, what the Join button may ask of the host, and what the host's answers
// (or its silence) turn into for the panel.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ChatAction } from '../shared/browserAgent';
import { JOINLY_DEFAULT_BOT_NAME, JOINLY_DEFAULT_ENDPOINT, emptyView, type JoinlyView } from '../shared/joinly';
import type { ToHost } from '../native-host/protocol';

const storage = new Map<string, unknown>();
const chromeApi = {
  storage: {
    local: {
      get: async (key: string) => (storage.has(key) ? { [key]: storage.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) storage.set(k, structuredClone(v));
      },
    },
  },
  windows: { getLastFocused: async () => ({ id: 7 }) },
  runtime: { onConnect: { addListener() {} } },
};
(globalThis as any).chrome = chromeApi;

type Sent = Extract<ToHost, { type: 'joinly' }>;

/** The shell's meetings module can be registered once per process: every test here shares it (and its log of what the host was asked). */
let once: Promise<{ toHost: Sent[]; joinly: ReturnType<typeof import('../shell/joinly').registerJoinly> }> | undefined;
function shellOnce() {
  once ??= (async () => {
    const { registerJoinly } = await import('../shell/joinly');
    const toHost: Sent[] = [];
    return { toHost, joinly: registerJoinly({ send: (m) => void toHost.push(m) }) };
  })();
  return once;
}

test('the Meetings settings, the opt-in, and what the host is asked', async () => {
  const { call } = await import('../shell/hub');
  const { registerAgentPanel } = await import('../shell/agentPanel');

  const { toHost, joinly } = await shellOnce();
  const chatActions: ChatAction[] = [];
  registerAgentPanel({ chat: (a) => chatActions.push(a), joinlyConfig: joinly.config });
  const get = async () => (await call('joinly:get')) as { settings: any; view: JoinlyView };

  // Off until the user turns it on, pointing at the playground's address.
  const first = await get();
  assert.deepEqual(first.settings, { enabled: false, endpoint: JOINLY_DEFAULT_ENDPOINT, botName: JOINLY_DEFAULT_BOT_NAME, voiceModel: '', voiceConsent: false });
  assert.equal(first.view.status, 'unavailable');
  assert.equal(toHost.length, 0, 'the host is not woken just to hear "off"');

  // Turning on needs the consent the sheet collects.
  assert.match(((await call('joinly:save', { enabled: true })) as any).error, /consent/);
  assert.match(((await call('joinly:save', { enabled: true, consent: 'yes' })) as any).error, /consent/);
  assert.equal((await get()).settings.enabled, false);
  assert.deepEqual(storage.get('joinly'), undefined);

  // The address can only be this computer; a refused change changes nothing.
  assert.match(((await call('joinly:save', { endpoint: 'http://192.168.1.5:18765/mcp/' })) as any).error, /this computer|Only this computer/i);
  assert.match(((await call('joinly:save', { enabled: true, consent: true, endpoint: 'http://example.com/mcp/' })) as any).error, /computer/i);
  assert.equal((await get()).settings.enabled, false, 'not half-applied');

  // Consent given: saved, and the host hears of it with the config.
  assert.deepEqual(await call('joinly:save', { enabled: true, consent: true, botName: 'Alex’s AI assistant' }), {});
  assert.deepEqual(storage.get('joinly'), { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT, botName: 'Alex’s AI assistant', voiceModel: '', voiceConsent: false });
  assert.deepEqual(toHost.at(-1), { type: 'joinly', config: { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT }, op: 'sync' });

  // Every chat message carries the saved setting, whatever the panel page said.
  await call('agent:action', { action: 'send', text: 'hi', joinly: { enabled: true, endpoint: 'http://example.com/mcp/' } } as ChatAction);
  assert.deepEqual((chatActions.at(-1) as any).joinly, { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT });
  assert.deepEqual(await joinly.config(), { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT });

  // Check again → a probe.
  await call('joinly:refresh');
  assert.equal(toHost.at(-1)!.op, 'probe');

  // Join: only after the sheet's confirmation, with a good link and name.
  const before = toHost.length;
  assert.match(((await call('joinly:join', 'https://meet.google.com/abc-defg-hij', 'Bot Bot')) as any).error, /confirmation/);
  assert.match(((await call('joinly:join', 'https://meet.google.com/abc-defg-hij', 'Bot Bot', 'yes')) as any).error, /confirmation/);
  assert.match(((await call('joinly:join', 'https://meet.google.com.evil.example/x', 'Bot Bot', true)) as any).error, /Google Meet/);
  assert.match(((await call('joinly:join', 'https://meet.google.com/abc-defg-hij', 'x', true)) as any).error, /name/);
  assert.equal(toHost.length, before, 'nothing reached the host');
  assert.deepEqual(await call('joinly:join', 'https://meet.google.com/abc-defg-hij', 'Sam’s AI assistant', true), {});
  assert.deepEqual(toHost.at(-1), {
    type: 'joinly',
    config: { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT },
    op: 'join',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    botName: 'Sam’s AI assistant',
  });
  assert.equal((storage.get('joinly') as any).botName, 'Sam’s AI assistant', 'the name is remembered');

  // The host's word becomes the panel's view; while joined, a second join is refused here too.
  joinly.onView({ ...emptyView({ enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT }), status: 'joined', meeting: { id: 1, host: 'meet.google.com', botName: 'Sam’s AI assistant', since: 1 }, checkedAt: 5 });
  assert.equal((await get()).view.status, 'joined');
  assert.equal(joinly.active(), true);
  assert.match(((await call('joinly:join', 'https://zoom.us/j/1', 'Bot Bot', true)) as any).error, /Already/);
  await call('joinly:leave');
  assert.equal(toHost.at(-1)!.op, 'leave');

  // Turning it off tells the host (which leaves a meeting).
  assert.deepEqual(await call('joinly:save', { enabled: false }), {});
  assert.deepEqual(toHost.at(-1), { type: 'joinly', config: { enabled: false, endpoint: JOINLY_DEFAULT_ENDPOINT }, op: 'sync' });
  assert.equal((storage.get('joinly') as any).enabled, false);

  // The host going away ends the meeting; the panel is told so.
  joinly.onView(undefined, 'Uranus Browser’s helper stopped: exit 1');
  const gone = (await get()).view;
  assert.equal(gone.reason, 'helper');
  assert.match(gone.error ?? '', /the bot leaves/);
  assert.equal(joinly.active(), false);

  // A host that never answers (a helper from before meetings) is said to be silent, not "joinly is down".
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await call('joinly:refresh');
    mock.timers.tick(6_100);
  } finally {
    mock.timers.reset();
  }
  const silent = (await get()).view;
  assert.equal(silent.reason, 'helper');
  assert.match(silent.detail ?? '', /helper didn’t answer/);
});

test('saved settings are restored per profile, and odd data falls back to the safe defaults', async () => {
  const { restoreSettings } = await import('../shared/joinly');
  assert.deepEqual(restoreSettings(storage.get('joinly')), { enabled: false, endpoint: JOINLY_DEFAULT_ENDPOINT, botName: 'Sam’s AI assistant', voiceModel: '', voiceConsent: false });
  const { loadSettings, saveSettings } = await import('../shell/lib/joinlyState');
  const other = new Map<string, unknown>([['joinly', { enabled: true, endpoint: 'http://example.com/', botName: 7 }]]);
  const fake = { get: async (k: string) => (other.has(k) ? { [k]: other.get(k) } : {}), set: async (i: Record<string, unknown>) => void Object.entries(i).forEach(([k, v]) => other.set(k, v)) };
  assert.deepEqual(await loadSettings(fake), { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT, botName: JOINLY_DEFAULT_BOT_NAME, voiceModel: '', voiceConsent: false });
  await saveSettings(fake, { enabled: false, endpoint: JOINLY_DEFAULT_ENDPOINT, botName: 'Bot Bot', voiceModel: '', voiceConsent: false });
  assert.equal((other.get('joinly') as any).enabled, false);
});

test('voice mode: only a confirmed click, only in a meeting, remembered consent and model; Stop and the model list need nothing', async () => {
  storage.clear();
  const { call } = await import('../shell/hub');
  const { toHost, joinly } = await shellOnce();
  await call('joinly:get');
  const voiceOps = () => toHost.filter((m) => m.op === 'voice');

  assert.match(((await call('joinly:voice', true, 'qwen3:4b', true)) as any).error, /Turn on “Let the agent join meetings/, 'not while meetings are off');
  await call('joinly:save', { enabled: true, consent: true });
  assert.match(((await call('joinly:voice', true, 'qwen3:4b', true)) as any).error, /Join a meeting first/);
  joinly.onView({ ...emptyView({ enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT }), status: 'joined', meeting: { id: 1, host: 'meet.google.com', botName: 'Bot Bot', since: 1 }, checkedAt: 5 });
  assert.match(((await call('joinly:voice', true, 'qwen3:4b')) as any).error, /needs your confirmation/);
  assert.match(((await call('joinly:voice', true, 'qwen3:4b', 'yes')) as any).error, /needs your confirmation/);
  assert.equal(voiceOps().length, 0, 'nothing reached the host');

  assert.deepEqual(await call('joinly:voice', true, 'qwen3:4b', true), {});
  assert.deepEqual(voiceOps().at(-1), { type: 'joinly', config: { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT }, op: 'voice', on: true, model: 'qwen3:4b', confirmed: true });
  assert.equal((storage.get('joinly') as any).voiceConsent, true, 'the confirmation text is shown once');
  assert.equal((storage.get('joinly') as any).voiceModel, 'qwen3:4b');
  assert.deepEqual(await call('joinly:voice', true, 'not a model!', true), {});
  assert.equal((voiceOps().at(-1) as any).model, undefined, 'a junk model name is dropped; the host picks the best installed one');

  assert.deepEqual(await call('joinly:voice', false), {});
  assert.deepEqual(voiceOps().at(-1), { type: 'joinly', config: { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT }, op: 'voice', on: false });
  await call('joinly:voice-models');
  assert.equal(toHost.at(-1)!.op, 'voice-models');
});

test('the meeting language is saved, sent with the config, and only a listed one is kept', async () => {
  storage.clear();
  const { call } = await import('../shell/hub');
  const { joinly } = await shellOnce();
  await call('joinly:get');
  await call('joinly:save', { language: 'de' });
  assert.deepEqual(await joinly.config(), { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT, language: 'de' });
  await call('joinly:save', { language: 'klingon' });
  assert.deepEqual(await joinly.config(), { enabled: true, endpoint: JOINLY_DEFAULT_ENDPOINT });
  await call('joinly:save', { language: 'fr' });
  await call('joinly:save', { language: null });
  assert.equal((storage.get('joinly') as any).language, undefined);
});
