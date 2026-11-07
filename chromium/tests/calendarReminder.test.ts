// The calendar reminder as a macOS notification (shell/calendar.ts), with a fake chrome and a fake
// calendar server: its buttons (Join & record; Record + AI assistant only when joinly is on), and
// what each click does. One calendar for all of it (the shell's hub takes each handler once); each
// step adds a fresh meeting through a calendar read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerCalendar } from '../shell/calendar';
import { call } from '../shell/hub';

const MEET = 'https://meet.google.com/abc-defg-hij';
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const ics = (uid: string, title: string, start: number) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(start + 1_800_000)}`, `LOCATION:${MEET}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

const stored = new Map<string, unknown>([['calendar:url', 'https://calendar.google.com/calendar/ical/x%40example.com/private-0000/basic.ics']]);
const notes = new Map<string, { title: string; message: string; buttons?: Array<{ title: string }> }>();
let calls: string[] = [];
let assistantOn = true;
let recordReply: { error?: string } = {};
let assistantReply: { error?: string } = {};
let feed = ics('first@x', 'Weekly sync', Date.now() + 90_000);

(globalThis as any).fetch = async () => new Response(feed, { status: 200, headers: { 'content-type': 'text/calendar' } });
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => stored.has(k)).map((k) => [k, structuredClone(stored.get(k))])),
      set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => stored.set(k, structuredClone(v))),
      remove: async (keys: string | string[]) => void (Array.isArray(keys) ? keys : [keys]).forEach((k) => stored.delete(k)),
    },
  },
  alarms: { create: async () => {}, clear: async () => true, get: async () => undefined, getAll: async () => [] },
  notifications: {
    create: (id: string, opts: any, cb?: () => void) => (notes.set(id, opts), cb?.()),
    clear: (id: string) => void notes.delete(id),
    getAll: (cb: (all: Record<string, boolean>) => void) => cb(Object.fromEntries([...notes.keys()].map((k) => [k, true]))),
  },
  runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, lastError: undefined },
};

const api = registerCalendar({
  openPage: (url) => void calls.push(`open ${url}`),
  openPanel: async () => void calls.push('panel'),
  assistantAvailable: async () => assistantOn,
  startRecording: async (host) => (calls.push(`record ${host}`), recordReply),
  stopRecording: () => void calls.push('stop'),
  sendAssistant: async (url) => (calls.push(`assistant ${url}`), assistantReply),
});
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
/** A new meeting starting in 90 seconds, read from the calendar: its reminder's id. */
async function remind(uid: string, title: string) {
  feed = ics(uid, title, Date.now() + 90_000);
  calls = [];
  await call('calendar:refresh');
  await settle();
  const id = [...notes.keys()].find((k) => k.startsWith('anus-calendar:ev-') && notes.get(k)!.title.startsWith(title));
  assert.ok(id, `a reminder for ${title}`);
  return id!;
}

test('with joinly switched on: Join & record and Record + AI assistant; the latter opens, sends the assistant, records, says so; Stop stops', async () => {
  const id = await remind('a@x', 'Weekly sync');
  const note = notes.get(id)!;
  assert.ok(id.endsWith('+assistant'));
  assert.deepEqual(note.buttons?.map((b) => b.title), ['Join & record', 'Record + AI assistant']);
  assert.match(note.title, /^Weekly sync starts in/);
  assert.match(note.message, /Click to join\. If you record, tell the others\./);
  await api.onNotification(id, 1);
  assert.deepEqual(calls, [`open ${MEET}`, `assistant ${MEET}`, 'panel', 'record meet.google.com']);
  assert.ok(!notes.has(id), 'the reminder goes');
  const recording = notes.get('anus-calendar:recording');
  assert.match(recording?.title ?? '', /^Recording Weekly sync/);
  assert.match(recording?.message ?? '', /Tell the others you’re recording/);
  assert.deepEqual(recording?.buttons?.map((b) => b.title), ['Stop recording']);
  await api.onNotification('anus-calendar:recording', 0);
  assert.equal(calls.at(-1), 'stop');
  assert.ok(!notes.has('anus-calendar:recording'));
});

test('without joinly the second button is Dismiss; a click on the reminder itself only opens the meeting', async () => {
  assistantOn = false;
  const id = await remind('b@x', 'Design review');
  assert.ok(!id.endsWith('+assistant'));
  assert.deepEqual(notes.get(id)!.buttons?.map((b) => b.title), ['Join & record', 'Dismiss']);
  await api.onNotification(id, 'body');
  assert.deepEqual(calls, [`open ${MEET}`], 'joining yourself: no recording, no assistant');
});

test('Join & record records without the assistant; Dismiss opens nothing', async () => {
  assistantOn = false;
  const id = await remind('c@x', 'Standup');
  await api.onNotification(id, 0);
  assert.deepEqual(calls, [`open ${MEET}`, 'panel', 'record meet.google.com']);
  const other = await remind('d@x', 'Retro');
  await api.onNotification(other, 1);
  assert.deepEqual(calls, [], 'Dismiss opens nothing');
  assert.ok(!notes.has(other));
});

test('notes that can’t start by themselves claim nothing (the panel’s ready card asks); a failed assistant says why', async () => {
  assistantOn = true;
  recordReply = { error: 'no microphone yet' };
  assistantReply = { error: 'joinly isn’t answering' };
  notes.delete('anus-calendar:recording');
  const id = await remind('e@x', 'Board call');
  await api.onNotification(id, 1);
  assert.ok(!notes.has('anus-calendar:recording'), 'nothing says it is recording');
  const info = [...notes.entries()].find(([k]) => k.startsWith('anus-calendar:info-'));
  assert.match(info?.[1].title ?? '', /The AI assistant didn’t join Board call/);
  assert.equal(info?.[1].message, 'joinly isn’t answering');
});
