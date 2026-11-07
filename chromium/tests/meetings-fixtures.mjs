// What the meeting-notes end-to-end test plays and serves, made at test time (nothing large is committed):
//  - two speech tracks from the macOS `say` command, 16 kHz mono WAV: the user ("Me") and two other
//    people ("Others": Alice, then Bob, in separate ten-second windows so each chunk has one speaker);
//  - a local page that looks like a Google Meet participant grid, with a highlighted speaker tile
//    the test moves, for the on-demand name reader (shell/lib/meetingsDom.ts).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const RATE = 16000;

function pcmOf(file) {
  const wav = fs.readFileSync(file);
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') return new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function wavOf(samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(samples.length * 2 + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

function say(dir, name, voice, text) {
  const aiff = path.join(dir, `${name}.aiff`);
  const wav = path.join(dir, `${name}.wav`);
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  return pcmOf(wav);
}

/** Places speech clips at times (ms) on one silent track. */
function track(parts, totalMs) {
  const out = new Int16Array(Math.round((totalMs / 1000) * RATE));
  for (const [atMs, clip] of parts) out.set(clip, Math.round((atMs / 1000) * RATE));
  return out;
}

export const SCRIPT = {
  me: 'I will check the recording logs by Tuesday. We need both microphone and system audio.',
  alice: 'I am Alice. We decided to ship the audio fix on Thursday. I will write the regression tests by Wednesday.',
  bob: 'I am Bob. The release stays blocked until microphone and system audio both work. Which local summary model should we use?',
};

/** Speech tracks as WAV buffers: Me from 0.5 s; Alice from 0.5 s; Bob from 10.5 s. */
export function makeSpeech(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const me = say(dir, 'me', 'Samantha', SCRIPT.me);
  const alice = say(dir, 'alice', 'Daniel', SCRIPT.alice);
  const bob = say(dir, 'bob', 'Karen', SCRIPT.bob);
  const aliceMs = (alice.length / RATE) * 1000;
  if (aliceMs > 9300) throw new Error(`Alice's clip is too long (${aliceMs} ms); chunks would mix speakers`);
  const total = 10500 + (bob.length / RATE) * 1000 + 500;
  return {
    me: wavOf(track([[500, me]], total)),
    others: wavOf(track([[500, alice], [10500, bob]], total)),
    aliceWindow: [500, 500 + aliceMs],
    bobWindow: [10500, 10500 + (bob.length / RATE) * 1000],
    totalMs: total,
  };
}

/** A page shaped like a Meet participant grid (fixtures/meet-mock.html). `window.__speak(name|null)` moves the highlight. */
export const MEET_MOCK_PATH = '/__anus_meet_mock__/';
const MEET_MOCK_HTML = fs.readFileSync(new URL('./fixtures/meet-mock.html', import.meta.url), 'utf8');

/** One local server: the Meet-like page, and a plain page. Loopback only. */
export function startMockServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.url?.startsWith(MEET_MOCK_PATH) ? MEET_MOCK_HTML : '<!doctype html><title>Plain page</title><p>hello</p>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, meetUrl: `http://127.0.0.1:${server.address().port}${MEET_MOCK_PATH}`, plainUrl: `http://127.0.0.1:${server.address().port}/` })));
}
