// The MCP client for the user's joinly server, end to end against a fake one on 127.0.0.1 (a
// random port): probing without opening a meeting session, joining, the talk with speaker
// names, speaking and posting only with approval, tool errors, leaving, the server vanishing
// mid-meeting, and addresses that are not this computer.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JoinlyClient, JoinlyError } from '../native-host/joinlyClient';
import { formatTranscript, type JoinlyView } from '../shared/joinly';
import { FakeJoinly } from './fakeJoinly';

const MEET = 'https://meet.google.com/abc-defg-hij';
const FAST = { poll: 40, idle: 60_000, probe: 600, connect: 4_000, join: 4_000, call: 4_000, speak: 4_000, leave: 3_000, people: 40, emptyLeave: 150, emptyRecheck: 20, name: 2_000, settle: 60, slowFailure: 150 };
const yes = { approved: true };

const open: Array<{ stop(): Promise<unknown> | void }> = [];
afterEach(async () => {
  for (const thing of open.splice(0)) await thing.stop();
});

async function setup(options: { enabled?: boolean } = {}) {
  const fake = await FakeJoinly.start();
  const logs: string[] = [];
  const client = new JoinlyClient({ timeouts: FAST, log: (...a) => logs.push(a.map(String).join(' ')) });
  const views: JoinlyView[] = [];
  client.onChange((v) => views.push(v));
  open.push(fake, { stop: () => client.shutdown() });
  if (options.enabled !== false) await client.configure({ enabled: true, endpoint: fake.endpoint });
  return { fake, client, logs, views };
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const segments = [
  { text: 'Hi everyone, let us start.', start: 2, end: 5, speaker: 'Anna Keller', role: 'participant' as const },
  { text: 'Quick update on the launch.', start: 6, end: 9, speaker: 'Anna Keller', role: 'participant' as const },
  { text: 'Is the demo ready?', start: 11, end: 13, speaker: 'Ben Ortiz', role: 'participant' as const },
];

test('probing: a GET of /health only; no meeting session is opened on joinly', async () => {
  const { fake, client } = await setup();
  const view = await client.probe();
  assert.equal(view.status, 'ready');
  assert.ok(fake.healthHits >= 1);
  assert.equal(fake.opened, 0, 'looking is not connecting: joinly makes a whole meeting session per connection');
  assert.equal(fake.calls.length, 0);
});

test('probing: unavailable when nothing listens, with words for the person', async () => {
  const fake = await FakeJoinly.start();
  const endpoint = fake.endpoint;
  await fake.stop();
  const client = new JoinlyClient({ timeouts: FAST });
  open.push({ stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint });
  const view = await client.probe();
  assert.equal(view.status, 'unavailable');
  assert.equal(view.reason, 'unreachable');
  assert.match(view.detail ?? '', /isn’t answering on 127\.0\.0\.1:\d+/);
});

test('probing: something else on the port is not joinly', async () => {
  const { fake, client } = await setup();
  fake.health = { status: 200, body: '<html>hello</html>' };
  assert.equal((await client.probe()).reason, 'not-joinly');
  fake.health = { status: 500, body: '{"status":"healthy"}' };
  assert.equal((await client.probe()).reason, 'not-joinly');
  fake.health = undefined;
  assert.equal((await client.probe()).status, 'ready');
});

test('while the opt-in is off, refresh() does not look; an explicit probe() does', async () => {
  const { fake, client } = await setup({ enabled: false });
  await client.configure({ enabled: false, endpoint: fake.endpoint });
  assert.equal(client.view().enabled, false);
  await client.refresh();
  assert.equal(fake.healthHits, 0);
  await client.configure({ enabled: false, endpoint: fake.endpoint });
  const view = await client.probe();
  assert.equal(view.status, 'ready');
  assert.equal(view.enabled, false, 'reachable, but not switched on');
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes), /switched off/);
  assert.equal(fake.opened, 0);
});

test('an address that is not this computer is never used', async () => {
  const requested: string[] = [];
  const client = new JoinlyClient({ timeouts: FAST, fetch: (async (input: unknown) => (requested.push(String(input)), new Response('{}'))) as unknown as typeof fetch });
  open.push({ stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: 'http://example.com/mcp/' });
  const view = client.view();
  assert.equal(view.enabled, false, 'refused: the settings fall back to off');
  await client.probe();
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes), /switched off/);
  assert.ok(requested.every((u) => /^http:\/\/127\.0\.0\.1[:/]/.test(u)), `only loopback: ${requested.join(', ')}`);
  assert.ok(!requested.some((u) => u.includes('example.com')));
});

test('a redirect is never followed, not even to another loopback address', async () => {
  const other = await FakeJoinly.start();
  const { fake, client } = await setup();
  open.push(other);
  fake.redirectTo = `${other.url}/health`;
  const view = await client.probe();
  assert.equal(view.status, 'unavailable');
  assert.equal(other.healthHits, 0, 'the redirect target was not asked');
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes), (err: Error) => err instanceof JoinlyError && /redirect/.test(err.message));
  assert.equal(other.opened, 0);
  fake.redirectTo = 'http://example.com/elsewhere';
  assert.equal((await client.probe()).status, 'unavailable');
});

test('joining needs approval, a good link and a good name, and connects to nothing otherwise', async () => {
  const { fake, client } = await setup();
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, { approved: false }), /approval/);
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, undefined as never), /approval/);
  await assert.rejects(client.join({ meetingUrl: 'https://meet.google.com.evil.example/abc', botName: 'Bot Bot' }, yes), /Google Meet/);
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'x' }, yes), /name/);
  assert.equal(fake.opened, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(client.view().status, 'ready');
});

test('join: connects once, asks joinly to join as the bot, reports the meeting, and allows only one at a time', async () => {
  const { fake, client, logs } = await setup();
  const said = await client.join({ meetingUrl: `${MEET}#x`, botName: 'Alex’s AI assistant' }, yes);
  assert.match(said, /meet\.google\.com.*Alex’s AI assistant/);
  const view = client.view();
  assert.equal(view.status, 'joined');
  assert.equal(view.phase, undefined);
  assert.equal(view.meeting?.host, 'meet.google.com');
  assert.equal(view.meeting?.botName, 'Alex’s AI assistant');
  assert.equal(client.joined, true);
  assert.equal(fake.opened, 1);
  assert.deepEqual(fake.tools('join_meeting').map((c) => c.args), [{ meeting_url: MEET, participant_name: 'Alex’s AI assistant' }]);
  await assert.rejects(client.join({ meetingUrl: 'https://zoom.us/j/1', botName: 'Bot Bot' }, yes), /Already in a meeting/);
  assert.equal(fake.opened, 1, 'no second connection');
  assert.ok(logs.some((l) => /joinly: joined in \d+ms/.test(l)));
  assert.ok(!logs.join('\n').includes('abc-defg-hij'), 'the log never carries the link');
});

test('the talk: speaker names, merged turns, last N, and the live view follows the meeting', async () => {
  const { fake, client } = await setup();
  fake.segments = [...segments];
  fake.participants = [{ name: 'Anna Keller', email: 'anna@example.com' }, { name: 'Ben Ortiz' }];
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const shaped = await client.transcript(10);
  assert.deepEqual(shaped.turns.map((t) => [t.speaker, t.text]), [['Anna Keller', 'Hi everyone, let us start. Quick update on the launch.'], ['Ben Ortiz', 'Is the demo ready?']]);
  assert.match(formatTranscript(shaped), /\[00:11\] Ben Ortiz: Is the demo ready\?/);
  assert.equal((await client.transcript(1)).turns.length, 1);
  assert.deepEqual(await client.participants(), ['Anna Keller', 'Ben Ortiz']);
  assert.deepEqual(fake.tools('get_transcript')[0].args, { mode: 'latest', minutes: 30 });
  // The panel's view updates by itself as people talk.
  fake.segments.push({ text: 'Yes, shipping today.', start: 15, end: 17, speaker: 'Caro Lind', role: 'participant' });
  fake.participants.push({ name: 'Caro Lind' });
  await until(() => client.view().lines.at(-1)?.speaker === 'Caro Lind', 'the live view to follow the talk');
  await until(() => client.view().participants.includes('Caro Lind'), 'the participant list to follow');
  assert.deepEqual(client.view().participants, ['Anna Keller', 'Ben Ortiz', 'Caro Lind']);
  assert.ok(!JSON.stringify(client.view()).includes('anna@example.com'));
});

test('the talk can only be read while in a meeting', async () => {
  const { client } = await setup();
  await assert.rejects(client.transcript(5), /Not in a meeting/);
  await assert.rejects(client.participants(), /Not in a meeting/);
  await assert.rejects(client.say('Hello', yes), /Not in a meeting/);
});

test('speaking and posting: only with approval, and then exactly the approved text', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await assert.rejects(client.say('Hello', { approved: false }), /approval/);
  await assert.rejects(client.chat('Hello', { approved: false }), /approval/);
  await assert.rejects(client.say('Hello', undefined as never), /approval/);
  assert.equal(fake.tools('speak_text').length + fake.tools('send_chat_message').length, 0);
  assert.equal(await client.say('Hello, I am an AI assistant for Alex.', yes), 'Finished speaking.');
  assert.match(await client.chat('Notes are in the doc.', yes), /Posted/);
  assert.deepEqual(fake.tools('speak_text').map((c) => c.args), [{ text: 'Hello, I am an AI assistant for Alex.' }]);
  assert.deepEqual(fake.tools('send_chat_message').map((c) => c.args), [{ message: 'Notes are in the doc.' }]);
});

test('a tool error from joinly is reported without links, and the meeting goes on', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  fake.fail.set('speak_text', 'TTS failed while reading https://meet.google.com/abc-defg-hij?authuser=1 at /app/joinly/x.py');
  const err = await client.say('Hello', yes).catch((e: Error) => e);
  assert.ok(err instanceof JoinlyError);
  assert.doesNotMatch(err.message, /https?:|\/app\//);
  assert.match(err.message, /TTS failed/);
  assert.equal(client.view().status, 'joined', 'one failed call is not a lost meeting');
  assert.equal(await client.say('Again', yes), 'Finished speaking.');
});

test('a failed join leaves nothing behind: the connection is closed and joinly is looked for again', async () => {
  const { fake, client } = await setup();
  fake.failJoin = true;
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes), /Google Meet refused the bot at once/);
  const view = client.view();
  assert.equal(view.phase, undefined);
  assert.equal(view.meeting, undefined);
  assert.match(view.error ?? '', /refused the bot at once/);
  await until(() => fake.closed === 1, 'the connection to be closed');
  await until(() => client.view().status === 'ready', 'status to return to ready');
  // And it can be tried again.
  fake.failJoin = false;
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.equal(client.view().status, 'joined');
  assert.equal(client.view().error, undefined);
});

test('something that is not joinly is not joined', async () => {
  const { fake, client } = await setup();
  fake.withoutTools = ['speak_text', 'send_chat_message'];
  await assert.rejects(client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes), /isn’t joinly/);
  assert.equal(fake.tools('join_meeting').length, 0, 'it was not asked to join anything');
  await until(() => fake.closed === 1, 'the connection to be closed');
});

test('leaving: asks joinly to leave, ends the connection, and is safe to repeat', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.equal(await client.leave(), 'Left the meeting.');
  assert.equal(fake.tools('leave_meeting').length, 1);
  await until(() => fake.closed === 1, 'the session to be ended on joinly’s side');
  const view = client.view();
  assert.equal(view.status, 'ready');
  assert.equal(view.meeting, undefined);
  assert.deepEqual(view.lines, []);
  assert.equal(await client.leave(), 'Not in a meeting.');
  assert.equal(fake.tools('leave_meeting').length, 1);
});

test('leaving while still waiting to be let in cancels the join', async () => {
  const { fake, client } = await setup();
  fake.holdJoin = true;
  const joining = client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const outcome = joining.then(() => 'joined', (e: Error) => e.message);
  await until(() => fake.tools('join_meeting').length === 0 && client.view().phase === 'joining' && fake.opened === 1, 'the join to be waiting');
  assert.match(client.view().detail ?? '', /Waiting to be let in/);
  assert.match(await client.leave(), /Cancelled/);
  assert.match(await outcome, /Cancelled/);
  await until(() => fake.closed === 1, 'the connection to be closed');
  assert.equal(client.view().meeting, undefined);
  assert.equal(client.joined, false);
  fake.admit();
});

test('switching the opt-in off, or moving the address, leaves the meeting first', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await client.configure({ enabled: false, endpoint: fake.endpoint });
  assert.equal(fake.tools('leave_meeting').length, 1);
  assert.equal(client.joined, false);
  assert.equal(client.view().status, 'unavailable');
  assert.equal(client.view().reason, 'disabled');
});

test('the host shutting down leaves the meeting', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await client.shutdown();
  assert.equal(fake.tools('leave_meeting').length, 1);
  await until(() => fake.closed === 1, 'the session to end');
  assert.equal(client.active, false);
});

test('the server vanishing mid-meeting is noticed, said plainly, and nothing is left running', async () => {
  const { fake, client, views } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.equal(client.view().status, 'joined');
  await fake.vanish();
  await until(() => client.view().reason === 'lost', 'the loss to be noticed');
  const view = client.view();
  assert.equal(view.status, 'unavailable');
  assert.equal(view.meeting, undefined);
  assert.match(view.error ?? '', /Lost the connection to joinly.*may still be in it/);
  assert.equal(client.active, false);
  assert.ok(views.some((v) => v.reason === 'lost'), 'the panel was told');
  await assert.rejects(client.say('Hello', yes), /Not in a meeting/);
  assert.equal(await client.leave(), 'Not in a meeting.');
});

test('calls that fail because the server is gone count as lost too', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await fake.vanish();
  const errors: string[] = [];
  for (let i = 0; i < 3; i++) errors.push(await client.say('Hello', yes).then(() => 'spoke', (e: Error) => e.message));
  assert.ok(errors[0].startsWith('joinly didn’t answer'), errors[0]);
  await until(() => client.view().reason === 'lost', 'the loss to be noticed');
});

test('what changes is published to listeners, and an unchanged view is not', async () => {
  const { client, views } = await setup();
  const before = views.length;
  await client.probe();
  await client.probe();
  assert.equal(views.length, before, 'no change, no message');
  await client.configure({ enabled: false, endpoint: client.view().endpoint });
  assert.ok(views.length > before);
});

// ---- what the REAL joinly does differently from a naive stand-in (fakeJoinly mirrors it) -----------

test('joinly hides why a join failed: a quick failure reads as a refusal at the door (Meet’s 403), with the next step', async () => {
  const { fake, client } = await setup();
  fake.failJoin = true;
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.ok(err instanceof JoinlyError);
  assert.match(err.message, /refused the bot at once/);
  assert.match(err.message, /403/);
  assert.match(err.message, /signed in to a Google account/);
  assert.doesNotMatch(err.message, /Error calling tool|Failed to perform/, 'joinly’s own wrapper text is not shown');
  assert.equal(client.view().error, err.message);
  const zoom = await client.join({ meetingUrl: 'https://zoom.us/j/123456789', botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((zoom as Error).message, /Zoom refused the bot at once/);
});

test('a join that took minutes before failing was waiting in the lobby: nobody let the bot in', async () => {
  const { fake, client } = await setup();
  fake.failJoin = true;
  fake.joinDelay = 200; // the client under test treats 150 ms as "slow"
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((err as Error).message, /Nobody let the bot in/);
  assert.match((err as Error).message, /3 minutes/);
  assert.doesNotMatch((err as Error).message, /403/);
});

test('Uranus Browser giving up on a join nobody admitted says so, and the connection is closed', async () => {
  const fake = await FakeJoinly.start();
  const client = new JoinlyClient({ timeouts: { ...FAST, join: 250 } });
  open.push(fake, { stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: fake.endpoint });
  fake.holdJoin = true;
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((err as Error).message, /Nobody let the bot in: Uranus Browser waited/);
  await until(() => fake.closed === 1, 'the connection to be closed');
  fake.admit();
});

test('a second client is turned away at once (joinly has one bot browser), with who to look for', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const other = new JoinlyClient({ timeouts: FAST });
  open.push({ stop: () => other.shutdown() });
  await other.configure({ enabled: true, endpoint: fake.endpoint });
  const started = Date.now();
  const err = await other.join({ meetingUrl: MEET, botName: 'Other Bot' }, yes).catch((e: Error) => e);
  assert.ok(Date.now() - started < 2_000, 'no waiting for a timeout: the dropped stream is noticed');
  assert.match((err as Error).message, /joinly’s bot is busy/);
  assert.match((err as Error).message, /another client already controls it/);
  assert.match((err as Error).message, /restart joinly/);
  assert.equal(fake.tools('join_meeting').length, 1, 'only the first client ever reached join_meeting');
  assert.equal(client.view().status, 'joined', 'the first client’s meeting is untouched');
});

test('joining right after leaving waits for joinly to finish closing the old bot browser, then goes through', async () => {
  const { fake, client, logs } = await setup();
  fake.lingerMs = 150;
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await client.leave();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.equal(client.view().status, 'joined');
  assert.ok(logs.some((l) => /connection refused while the last meeting closes/.test(l)), 'it had to wait at least once');
  assert.equal(fake.tools('join_meeting').length, 2);
});

test('a bot browser taken by someone else is not retried forever', async () => {
  const { fake, client } = await setup();
  // Taken by a session that Uranus Browser never opened (a `playground.sh live` run, say).
  fake.lingerMs = 60_000;
  const other = new JoinlyClient({ timeouts: FAST });
  open.push({ stop: () => other.shutdown() });
  await other.configure({ enabled: true, endpoint: fake.endpoint });
  await other.join({ meetingUrl: MEET, botName: 'Other Bot' }, yes);
  await other.leave();
  const started = Date.now();
  // Uranus Browser's own client released it just now, so it waits a few times, then gives up: three tries, not more.
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((err as Error).message, /busy/);
  assert.equal(fake.tools('join_meeting').length, 1, 'never got as far as joining');
  assert.ok(Date.now() - started < 3_000);
});

test('joinly not running when joining: the words are about Docker, not a stack trace', async () => {
  const { fake, client } = await setup();
  await fake.vanish();
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((err as Error).message, /Docker Desktop/);
  assert.match((err as Error).message, /playground\.sh start/);
  assert.doesNotMatch((err as Error).message, /fetch failed|ECONNREFUSED/);
  await until(() => /Docker Desktop/.test(client.view().detail ?? ''), 'the panel’s sentence to mention Docker');
});

test('probing says Docker may be stopped when nothing answers', async () => {
  const fake = await FakeJoinly.start();
  const endpoint = fake.endpoint;
  await fake.stop();
  const client = new JoinlyClient({ timeouts: FAST });
  open.push({ stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint });
  assert.match(client.view().detail ?? '', /Docker Desktop running/);
});

test('joinly slow to build its meeting session: a timeout says it may still be loading models, and cleans up', async () => {
  const fake = await FakeJoinly.start();
  const client = new JoinlyClient({ timeouts: { ...FAST, connect: 200 } });
  open.push(fake, { stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: fake.endpoint });
  fake.initDelay = 1_500;
  const err = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes).catch((e: Error) => e);
  assert.match((err as Error).message, /didn’t finish starting a meeting session within/);
  assert.match((err as Error).message, /speech models and a browser/);
  assert.equal(client.joined, false);
});

test('the real defaults give joinly time: a minute to start a session, more than its own 180 s for the host', async () => {
  const { DEFAULT_TIMEOUTS } = await import('../native-host/joinlyClient');
  assert.ok(DEFAULT_TIMEOUTS.connect >= 60_000);
  assert.ok(DEFAULT_TIMEOUTS.join >= 240_000, 'joinly waits up to 180 s after loading Meet’s page (30 s) and finding the join button (30 s)');
  assert.ok(DEFAULT_TIMEOUTS.slowFailure < 180_000 && DEFAULT_TIMEOUTS.slowFailure > 60_000);
});

test('results arrive the way FastMCP wraps them: {result} for strings, {segments}, {result:[…]}; errors carry its prefix', async () => {
  const { fake, client } = await setup();
  fake.segments = [
    { text: 'Hello', start: 1.25, end: 2, speaker: null },
    { text: 'I am the assistant', start: 3, end: 4, speaker: 'Bot Bot', role: 'assistant' },
  ];
  fake.participants = [{ name: 'Anna Keller', email: null, infos: ['Meeting host', 'Unmuted'] }];
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const shaped = await client.transcript(5);
  assert.deepEqual(shaped.turns.map((t) => [t.speaker, t.self]), [['Unknown speaker', false], ['you', true]], 'speaker is often null; the bot’s own turns have role assistant');
  assert.deepEqual(await client.participants(), ['Anna Keller']);
  fake.fail.set('speak_text', 'Error while speaking text');
  const err = await client.say('Hello', yes).catch((e: Error) => e);
  assert.doesNotMatch((err as Error).message, /Error calling tool/);
  assert.match((err as Error).message, /couldn’t speak/);
});

test('speech someone talked over is reported as interrupted, not as spoken', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  fake.interruptSpeech = true;
  const said = await client.say('Hello everyone, this is a long sentence', yes);
  assert.match(said, /^Interrupted: someone started talking/);
  assert.match(said, /Spoken until now/);
  assert.match(said, /Do not say it again unless the user asks/);
});

test('chat: joinly refuses over 500 characters and says so; its hidden failures get a plain reason', async () => {
  const { fake, client } = await setup();
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const long = await client.chat('x'.repeat(501), yes).catch((e: Error) => e);
  assert.match((long as Error).message, /Message exceeds the maximum length of 500 characters/);
  fake.fail.set('send_chat_message', "Failed to perform 'send_chat_message'.");
  const hidden = await client.chat('Hello', yes).catch((e: Error) => e);
  assert.match((hidden as Error).message, /couldn’t post in the meeting chat/);
  assert.match((hidden as Error).message, /host turned chat off/);
  assert.equal(client.view().status, 'joined');
});

test('the participant list is read off Meet’s People panel, so it is read now and then, not on every look at the talk', async () => {
  const fake = await FakeJoinly.start();
  const client = new JoinlyClient({ timeouts: { ...FAST, people: 60_000 } });
  open.push(fake, { stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: fake.endpoint });
  fake.participants = [{ name: 'Anna Keller' }];
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  await until(() => fake.tools('get_transcript').length >= 5, 'several looks at the talk');
  assert.equal(fake.tools('get_participants').length, 1, 'once, to learn the bot’s own name');
  assert.deepEqual(client.view().participants, ['Anna Keller']);
});

test('joinly’s browser signed in to Google: the meeting shows that name, and Uranus Browser says so', async () => {
  const { fake, client } = await setup();
  fake.participants = [
    { name: 'Anna Keller', email: null, infos: ['Meeting host', 'Unmuted'] },
    { name: 'Jordan Example (You)', email: null, infos: ['You', 'Muted'] },
  ];
  const said = await client.join({ meetingUrl: MEET, botName: 'Uranus Browser AI assistant' }, yes);
  assert.match(said, /as “Jordan Example”/);
  assert.match(said, /signed in to a Google account/);
  assert.match(said, /instead of “Uranus Browser AI assistant”/);
  assert.match(said, /does not announce itself/);
  const view = client.view();
  assert.equal(view.meeting?.botName, 'Jordan Example', 'the cards and the panel say what other people really see');
  assert.deepEqual(view.participants, ['Anna Keller', 'Jordan Example (the bot)']);
  assert.deepEqual(await client.participants(), ['Anna Keller', 'Jordan Example (the bot)']);
});

test('joining as a guest under the asked name leaves the name alone', async () => {
  const { fake, client } = await setup();
  fake.participants = [{ name: 'Anna Keller', infos: [] }, { name: 'Uranus Browser AI assistant', infos: ['You'] }];
  const said = await client.join({ meetingUrl: MEET, botName: 'Uranus Browser AI assistant' }, yes);
  assert.match(said, /^Joined the meeting on meet\.google\.com as “Uranus Browser AI assistant”\./);
  assert.doesNotMatch(said, /Google account/);
  assert.equal(client.view().meeting?.botName, 'Uranus Browser AI assistant');
});

test('not being able to read the participant list after joining does not fail the join', async () => {
  const { fake, client } = await setup();
  fake.fail.set('get_participants', "Failed to perform 'get_participants'.");
  const said = await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.match(said, /as “Bot Bot”/);
  assert.equal(client.view().status, 'joined');
});

// ---- speed and language ---------------------------------------------------------------------------------

test('the spoken language goes to joinly in its per-connection settings header, and only a listed one', async () => {
  const { fake, client } = await setup();
  await client.configure({ enabled: true, endpoint: fake.endpoint, language: 'de' });
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.deepEqual(fake.settingsHeaders, ['{"language":"de"}'], 'its speech recognition assumes English otherwise');
  assert.equal(client.joined, true, 'changing the language never takes the bot out of a meeting');
  await client.configure({ enabled: true, endpoint: fake.endpoint, language: 'de' });
  await client.leave();
  await client.configure({ enabled: true, endpoint: fake.endpoint, language: 'klingon' });
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  assert.deepEqual(fake.settingsHeaders, ['{"language":"de"}', undefined], 'an unknown code sends nothing');
});

test('joinly pushes a notice when someone finishes speaking: the latest talk follows at once, without polling', async () => {
  const fake = await FakeJoinly.start();
  const client = new JoinlyClient({ timeouts: { ...FAST, poll: 60_000, talkSafety: 60_000, talkFast: 60_000 } });
  open.push(fake, { stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: fake.endpoint });
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  const before = fake.tools('get_transcript').length;
  const heardAt = Date.now();
  fake.hear('Pushed, not polled.', 'Caro Lind');
  await until(() => client.view().lines.some((l) => l.speaker === 'Caro Lind'), 'the line to appear', 500);
  assert.ok(Date.now() - heardAt < 250);
  assert.equal(fake.tools('get_transcript').length, before + 1, 'one look per notice');
});

test('a server that refuses the subscription is polled instead, quickly', async () => {
  const fake = await FakeJoinly.start();
  fake.pushes = false;
  const client = new JoinlyClient({ timeouts: { ...FAST, poll: 60_000, talkFast: 20, talkSafety: 60_000 } });
  open.push(fake, { stop: () => client.shutdown() });
  await client.configure({ enabled: true, endpoint: fake.endpoint });
  await client.join({ meetingUrl: MEET, botName: 'Bot Bot' }, yes);
  fake.hear('Polled.', 'Caro Lind', { notify: false });
  await until(() => client.view().lines.some((l) => l.speaker === 'Caro Lind'), 'the line to appear by polling', 1500);
});

test('when everyone else has left the call, the bot leaves by itself, after two looks', async () => {
  const { fake, client, logs } = await setup();
  fake.participants = [{ name: 'Anna Keller' }, { name: 'Jordan Example (You)', infos: ['You'] }];
  await client.join({ meetingUrl: MEET, botName: 'Uranus Browser AI assistant' }, yes);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.tools('leave_meeting').length, 0, 'someone is still there: it stays');
  // Anna closes the call: only the bot is left.
  fake.participants = [{ name: 'Jordan Example (You)', infos: ['You'] }];
  await until(
    () => client.view().status === 'ready'
      && fake.tools('leave_meeting').length === 1
      && /the bot left on its own/.test(client.view().detail ?? ''),
    'the bot to leave on its own',
  );
  assert.ok(logs.some((l) => /the meeting is empty, leaving/.test(l)));
  assert.match(client.view().detail ?? '', /the bot left on its own/);
  assert.equal(client.view().participants.length, 0);
});

test('one odd reading never sends the bot away: an empty list, or people coming back, resets the wait', async () => {
  const { fake, client } = await setup();
  fake.participants = [{ name: 'Anna Keller' }, { name: 'Jordan Example (You)', infos: ['You'] }];
  await client.join({ meetingUrl: MEET, botName: 'Uranus Browser AI assistant' }, yes);
  // A list that could not be read at all (nothing, not even the bot) is not "the room is empty".
  fake.participants = [];
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fake.tools('leave_meeting').length, 0, 'nothing read is not an empty room');
  // Only the bot for a moment, then someone is back: the wait starts over.
  fake.participants = [{ name: 'Jordan Example (You)', infos: ['You'] }];
  await new Promise((r) => setTimeout(r, 90));
  fake.participants = [{ name: 'Ben Ortiz' }, { name: 'Jordan Example (You)', infos: ['You'] }];
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fake.tools('leave_meeting').length, 0, 'someone came back');
  assert.equal(client.view().status, 'joined');
});
