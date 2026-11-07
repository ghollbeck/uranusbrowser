// Meeting notes in the shell: the chunker that cuts audio into 16 kHz WAV chunks, and the
// per-profile state (live transcript, saved meetings, caps, restoring odd stored data).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EngineInfo } from '../shared/meetingProtocol';
import { MAX_MEETINGS, MAX_SEGMENTS, type MeetingMeta } from '../shared/meetings';
import { WAV_RATE } from '../shared/wav';
import { Chunker, type Chunk } from '../shell/lib/meetingsChunker';
import * as store from '../shell/lib/meetingsState';
import { AUTO_LANGUAGE, MEETING_LANGUAGES, languageForRequest, restoreLanguage } from '../shared/meetingLanguages';

// ---- the chunker -------------------------------------------------------------------------------

const tone = (seconds: number, rate: number, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / rate));
const feed = (chunker: Chunker, audio: Float32Array, block = 4096) => {
  for (let i = 0; i < audio.length; i += block) chunker.push(audio.subarray(i, Math.min(audio.length, i + block)));
};

test('audio is cut into 10-second chunks of 16 kHz samples on one clock', () => {
  const chunks: Chunk[] = [];
  const chunker = new Chunker(48000, (c) => chunks.push(c));
  feed(chunker, tone(25, 48000));
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => [c.startMs, c.endMs]), [[0, 10_000], [10_000, 20_000]]);
  assert.ok(chunks.every((c) => c.samples.length === 10 * WAV_RATE));
  assert.ok(Math.abs(chunks[0].level - 0.5 / Math.SQRT2) < 0.03);
  chunker.flush();
  assert.equal(chunks.length, 3);
  assert.deepEqual([chunks[2].startMs, chunks[2].endMs], [20_000, 25_000]);
  assert.equal(chunker.elapsedMs, 25_000);
});

test('a short tail is dropped but still moves the clock; silence has level zero', () => {
  const chunks: Chunk[] = [];
  const chunker = new Chunker(16000, (c) => chunks.push(c), 2000);
  feed(chunker, new Float32Array(16000 * 2.5));
  chunker.flush(1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].level, 0);
  feed(chunker, tone(2, 16000));
  assert.equal(chunks.length, 2);
  assert.deepEqual([chunks[1].startMs, chunks[1].endMs], [2500, 4500], 'the dropped half second still counted');
});

test('blocks of any size give the same chunks', () => {
  const audio = tone(12, 44100);
  const a: Chunk[] = [];
  const b: Chunk[] = [];
  feed(new Chunker(44100, (c) => a.push(c)), audio, 128);
  feed(new Chunker(44100, (c) => b.push(c)), audio, 5000);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].samples, b[0].samples);
});

// ---- engine choice -----------------------------------------------------------------------------

const info = (id: 'openai' | 'local', ready: boolean): EngineInfo => ({ id, label: id, model: 'm', where: id === 'openai' ? 'cloud' : 'local', ready, detail: `${id} detail` });

test('auto prefers OpenAI, falls back to a local engine that is installed, and says what is missing', () => {
  assert.deepEqual(store.chooseEngine('auto', [info('openai', true), info('local', true)]), { engine: info('openai', true) });
  assert.deepEqual(store.chooseEngine('auto', [info('openai', false), info('local', true)]), { engine: info('local', true) });
  assert.deepEqual(store.chooseEngine('auto', [info('openai', false), info('local', false)]), { error: 'openai detail' });
  assert.deepEqual(store.chooseEngine('local', [info('openai', true), info('local', false)]), { error: 'local detail' });
  assert.deepEqual(store.chooseEngine('openai', []), { error: 'That transcription engine isn’t available.' });
  assert.deepEqual(store.restoreSettings({ engine: 'weird' }), { engine: 'auto', mic: 'builtin', language: 'auto' });
  assert.deepEqual(store.restoreSettings({ engine: 'local' }), { engine: 'local', mic: 'builtin', language: 'auto' });
});

test('the microphone setting: this Mac’s built-in one by default, and each setting survives changing the other', () => {
  assert.equal(store.DEFAULT_SETTINGS.mic, 'builtin');
  assert.equal(store.restoreSettings(undefined).mic, 'builtin');
  assert.equal(store.restoreSettings({ mic: 'nonsense' }).mic, 'builtin');
  assert.equal(store.restoreSettings({ mic: 'default' }).mic, 'default');
  const withMic = store.restoreSettings({ engine: 'auto', mic: 'default' });
  assert.deepEqual(store.restoreSettings({ ...withMic, engine: 'openai' }), { engine: 'openai', mic: 'default', language: 'auto' });
  assert.deepEqual(store.restoreSettings({ ...withMic, mic: 'builtin' }), { engine: 'auto', mic: 'builtin', language: 'auto' });
});

// ---- the live transcript -----------------------------------------------------------------------

const live = () => store.newLive({ id: 'abc', startedAt: Date.UTC(2026, 9, 28, 14, 0), host: 'meet.google.com', provider: 'Google Meet', engine: 'openai', model: 'gpt-4o-mini-transcribe', othersCaptured: true });

test('segments are added in order with tidy text; empty text is not a segment; the cap holds', () => {
  const l = live();
  assert.equal(store.addSegment(l, 'Me', 0, 10_000, '   '), undefined);
  const s = store.addSegment(l, 'Others', 10_000, 20_000, '  Hello   there. ')!;
  assert.deepEqual([s.id, s.speaker, s.channel, s.text], [1, 'Others', 'Others', 'Hello there.']);
  assert.equal(l.lastMs, 20_000);
  l.segments.length = MAX_SEGMENTS;
  assert.equal(store.addSegment(l, 'Me', 0, 1000, 'one more'), undefined);
});

test('failed chunks become gaps, and neighbouring gaps merge', () => {
  const l = live();
  store.addGap(l, 0, 10_000);
  store.addGap(l, 10_000, 20_000);
  store.addGap(l, 40_000, 50_000);
  assert.deepEqual(l.gaps, [{ start_ms: 0, end_ms: 20_000 }, { start_ms: 40_000, end_ms: 50_000 }]);
});

test('names from the page name the "Others" lines in the finished record, and "Me" stays "Me"', () => {
  const l = live();
  for (let t = 0; t < 20_000; t += 1000) store.addObservation(l, t, t < 10_000 ? 'Alice' : 'Bob', ['Alice', 'Bob', 'You']);
  store.addSegment(l, 'Others', 0, 9500, 'Alice talks first.');
  store.addSegment(l, 'Me', 2000, 6000, 'I say something.');
  store.addSegment(l, 'Others', 10_000, 19_500, 'Then Bob.');
  const record = store.toRecord(l, 'user', 30_000);
  assert.deepEqual(record.segments.map((s) => s.speaker), ['Alice', 'Me', 'Bob']);
  assert.deepEqual([...record.participants!].sort(), ['Alice', 'Bob']);
  assert.equal(record.durationMs, 30_000);
  assert.equal(record.segmentCount, 3);
  assert.equal(record.endedBy, 'user');
  assert.match(record.title, /^Meeting, /);
  assert.equal(store.addObservation(l, 5, null, 'not a list'), undefined);
  // Every poll is kept, because a name only holds for a few seconds after it was seen.
  const l2 = live();
  for (let t = 0; t < 5000; t += 1000) store.addObservation(l2, t, 'Alice', []);
  assert.equal(l2.observations.length, 5);
});

test('with no page names every "Others" line stays "Others"', () => {
  const l = live();
  store.addSegment(l, 'Others', 0, 5000, 'Hi.');
  assert.equal(store.toRecord(l, 'tab-closed', 5000).segments[0].speaker, 'Others');
});

// ---- saved meetings -----------------------------------------------------------------------------

test('the index is newest first, deduplicated, capped, and junk rows are dropped', () => {
  const rows: unknown[] = [{ id: 'a', title: 'A', startedAt: 1, durationMs: 5, host: 'x', provider: '', engine: '', hasSummary: true, segmentCount: 3 }, { id: 'b', title: 'B', startedAt: 9 }, { id: 'a', title: 'dup', startedAt: 5 }, null, { title: 'no id' }, 'junk'];
  const out = store.restoreIndex(rows);
  assert.deepEqual(out.map((m) => m.id), ['b', 'a']);
  assert.equal(out[1].hasSummary, true);
  assert.equal(out[1].segmentCount, 3);
  assert.deepEqual(store.restoreIndex('nope'), []);
  const many = Array.from({ length: MAX_MEETINGS + 20 }, (_, i) => ({ id: `m${i}`, title: 't', startedAt: i }));
  assert.equal(store.restoreIndex(many).length, MAX_MEETINGS);
  assert.equal(store.atCapacity(store.restoreIndex(many)), true);
});

test('upserting and removing keep the list ordered', () => {
  const meta = (id: string, startedAt: number): MeetingMeta => ({ id, title: id, startedAt, durationMs: 0, host: '', provider: '', engine: '', hasSummary: false, segmentCount: 0 });
  let list = [meta('a', 5), meta('b', 3)];
  list = store.upsertMeta(list, meta('c', 9));
  list = store.upsertMeta(list, { ...meta('b', 3), title: 'renamed' });
  assert.deepEqual(list.map((m) => m.id), ['c', 'a', 'b']);
  assert.equal(list[2].title, 'renamed');
  assert.deepEqual(store.removeMeta(list, 'a').map((m) => m.id), ['c', 'b']);
});

test('a stored record is checked on the way back: bad fields are dropped, text is clipped, markup stays text', () => {
  const r = store.restoreRecord({
    id: 'r1',
    title: '  <b>Hi</b>\nthere  ',
    startedAt: 5,
    durationMs: 'x',
    segments: [{ channel: 'Me', start_ms: 0, end_ms: 5, text: 'ok' }, { bad: true }],
    summary: { items: { overview: [{ t: 1, speaker: 'Me', text: 'quoted' }, { nope: 1 }], decisions: 'x' }, model: 'm', method: 'weird', at: 1 },
    endedBy: 'aliens',
    participants: ['Alice', 'You', 7],
    gaps: [{ start_ms: 1, end_ms: 2 }, { start_ms: 'a' }],
  })!;
  assert.equal(r.title, '<b>Hi</b> there', 'stored as text; it is only ever rendered as a text node');
  assert.equal(r.durationMs, 0);
  assert.equal(r.segments.length, 1);
  assert.deepEqual(r.summary!.items.overview, [{ t: 1, speaker: 'Me', text: 'quoted' }]);
  assert.deepEqual(r.summary!.items.decisions, []);
  assert.equal(r.summary!.method, 'model');
  assert.equal(r.endedBy, undefined);
  assert.deepEqual(r.participants, ['Alice']);
  assert.deepEqual(r.gaps, [{ start_ms: 1, end_ms: 2 }]);
  assert.equal(r.hasSummary, true);
  assert.equal(store.restoreRecord({ title: 'no id' }), undefined);
  assert.equal(store.restoreRecord(null), undefined);
});

test('a snapshot of a recording that was running is restored as a recovered meeting', () => {
  const l = live();
  store.addSegment(l, 'Me', 0, 10_000, 'Captured before the browser quit.');
  const restored = store.restoreLive(JSON.parse(JSON.stringify(l)))!;
  const record = store.toRecord(restored, 'recovered', restored.lastMs);
  assert.equal(record.endedBy, 'recovered');
  assert.equal(record.segments[0].text, 'Captured before the browser quit.');
  assert.equal(store.restoreLive({ id: '' }), undefined);
  assert.equal(store.restoreLive('x'), undefined);
});

test('titles typed by the user: one line, clipped, never empty', () => {
  assert.deepEqual(store.checkTitle('  Weekly\nsync  '), { ok: true, title: 'Weekly sync' });
  assert.equal(store.checkTitle('   ').ok, false);
  assert.equal(store.checkTitle(42).ok, false);
  const long = store.checkTitle('x'.repeat(200));
  assert.ok(long.ok && long.title.length === 72);
});

test('a microphone picked from the list is kept with its name, and cleaned; without both it is ignored', () => {
  const picked = store.restoreSettings({ engine: 'auto', mic: 'device', micDevice: { id: 'abc123', label: 'Studio Display Microphone' }, language: 'auto' });
  assert.deepEqual(picked, { engine: 'auto', mic: 'device', micDevice: { id: 'abc123', label: 'Studio Display Microphone' }, language: 'auto' });
  // no device, or no name: back to the built-in one
  assert.equal(store.restoreSettings({ mic: 'device' }).mic, 'builtin');
  assert.equal(store.restoreSettings({ mic: 'device', micDevice: { id: 'x', label: '' } }).mic, 'builtin');
  assert.equal(store.restoreSettings({ mic: 'device', micDevice: { id: 5, label: 'x' } }).mic, 'builtin');
  // the other choices drop a stale device, and odd characters and long names are cleaned
  assert.equal(store.restoreSettings({ mic: 'default', micDevice: { id: 'abc', label: 'Old' } }).micDevice, undefined);
  const odd = store.restoreSettings({ mic: 'device', micDevice: { id: 'i'.repeat(500), label: 'A\u0000B\n' + 'x'.repeat(500) } });
  assert.ok(odd.micDevice && odd.micDevice.id.length === 200 && odd.micDevice.label.length === 120 && !/[\u0000\n]/.test(odd.micDevice.label));
});

test('the language setting: Automatic by default, only listed codes are kept, other settings are untouched', () => {
  assert.equal(store.DEFAULT_SETTINGS.language, 'auto');
  assert.equal(store.restoreSettings(undefined).language, 'auto');
  // Settings saved before the language existed still load, as Automatic.
  assert.deepEqual(store.restoreSettings({ engine: 'openai', mic: 'default' }), { engine: 'openai', mic: 'default', language: 'auto' });
  assert.equal(store.restoreSettings({ language: 'de' }).language, 'de');
  assert.equal(store.restoreSettings({ language: 'ko' }).language, 'ko');
  for (const bad of ['xx', 'EN', 'english', 'en-US', '', 'en; drop', 5, null, {}, ['en']]) {
    assert.equal(store.restoreSettings({ language: bad }).language, 'auto', String(bad));
  }
  // Changing the language keeps engine, microphone and the picked device.
  const picked = store.restoreSettings({ engine: 'local', mic: 'device', micDevice: { id: 'a', label: 'Mic' }, language: 'fr' });
  assert.deepEqual(store.restoreSettings({ ...picked, language: 'hu' }), { engine: 'local', mic: 'device', micDevice: { id: 'a', label: 'Mic' }, language: 'hu' });
  assert.deepEqual(store.restoreSettings({ ...picked, language: 'auto' }), { engine: 'local', mic: 'device', micDevice: { id: 'a', label: 'Mic' }, language: 'auto' });
  assert.deepEqual(store.restoreSettings({ ...picked, mic: 'builtin' }), { engine: 'local', mic: 'builtin', language: 'fr' });
});

test('the language list has unique, valid ISO 639-1 codes with names, and the requested languages', () => {
  const codes = MEETING_LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(new Set(MEETING_LANGUAGES.map((l) => l.name)).size, codes.length);
  for (const l of MEETING_LANGUAGES) {
    assert.match(l.code, /^[a-z]{2}$/);
    assert.ok(l.code !== AUTO_LANGUAGE && l.name.trim());
    assert.equal(restoreLanguage(l.code), l.code);
  }
  for (const wanted of ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'tr', 'ru', 'ja', 'ko', 'zh', 'hu', 'ar', 'hi', 'sv', 'uk']) assert.ok(codes.includes(wanted), wanted);
});

test('Automatic sends no language on the transcription request; a chosen language sends its code', () => {
  assert.equal(languageForRequest('auto'), undefined);
  assert.equal(languageForRequest(undefined), undefined);
  assert.equal(languageForRequest('garbage'), undefined);
  assert.equal(languageForRequest('de'), 'de');
  const request = { engine: 'openai' as const, wav: 'x', language: languageForRequest(store.restoreSettings({ language: 'auto' }).language) };
  assert.equal('language' in JSON.parse(JSON.stringify(request)), false, 'undefined drops out of the message');
});
