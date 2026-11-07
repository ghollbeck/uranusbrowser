/**
 * The meeting recorder's capture page. It runs as an OFFSCREEN DOCUMENT (the background creates
 * it when the user presses Start in the Agent panel and closes it when the recording ends), so
 * it survives the panel being closed and has no UI of its own.
 *
 * It turns two audio sources into chunks of 16 kHz mono WAV and hands them to the background:
 *   - "Me": the microphone (getUserMedia, with echo cancellation, so the meeting's sound coming
 *     out of the speakers is not also heard as the user);
 *   - "Others": the meeting tab's own sound, from a chrome.tabCapture stream id the background
 *     obtained (the tab keeps playing for the user: the stream is also routed to the speakers).
 * One AudioContext carries both, so their chunks share one clock. Audio is never written
 * anywhere: it lives in memory until a ~10-second chunk is full, is encoded, sent, and dropped.
 *
 * Opened in a tab as `?permission=1`, the same file is the one-time "Allow microphone" page:
 * Chromium can't show its permission prompt for an offscreen document, but it can for a tab.
 */
import type { CaptureCommand, CaptureEvent } from '../../shared/meetingProtocol';
import { encodeWav, fromBase64, inspectWav, toBase64 } from '../../shared/wav';
import { Chunker } from '../lib/meetingsChunker';

const send = (event: CaptureEvent) => void chrome.runtime.sendMessage(event).catch(() => undefined);
/** Below this level (RMS, 0 to 1) a chunk is silence and is not sent for transcription. */
const SILENT = 0.003;

type Channel = 'Me' | 'Others';

/** Plays recorded speech into a MediaStream, for tests that can't use a real microphone or tab. */
function fixtureStream(ctx: AudioContext, wavBase64: string): MediaStream {
  const wav = fromBase64(wavBase64);
  const { pcmBytes } = inspectWav(wav);
  const view = new DataView(wav.buffer, wav.byteOffset + 44, pcmBytes);
  const buffer = ctx.createBuffer(1, pcmBytes / 2, 16000);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = view.getInt16(i * 2, true) / 0x8000;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const destination = ctx.createMediaStreamDestination();
  source.connect(destination);
  source.start();
  return destination.stream;
}

/** One tapped source: its stream, the nodes carrying it, and its chunker. */
interface Tap {
  stream: MediaStream;
  nodes: AudioNode[];
  chunker: Chunker;
}

class Recording {
  private ctx = new AudioContext({ latencyHint: 'playback' });
  private taps = new Map<Channel, Tap>();
  private levels: Record<Channel, number> = { Me: 0, Others: 0 };
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private ended = false;

  /** Which microphone the user asked for; kept for reopening one that drops out. */
  private micChoice: 'builtin' | 'default' | 'device' = 'builtin';
  private micDevice?: { id: string; label: string };

  /**
   * Opens the microphone. For "built-in" it opens the default first (that is what unlocks the
   * device names), then reopens this Mac's own microphone if the default is something else (an
   * iPhone, AirPods, a display). With no built-in microphone it keeps the default.
   */
  private async openMic(): Promise<MediaStream> {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    // A microphone the user picked from the list: by id, then by name; if it is gone, the system default.
    if (this.micChoice === 'device' && this.micDevice) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: this.micDevice.id } } });
      } catch {
        try {
          const byName = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === this.micDevice!.label);
          if (byName) return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: byName.deviceId } } });
        } catch {
          /* fall through to the default */
        }
        return await navigator.mediaDevices.getUserMedia({ audio: base });
      }
    }
    const first = await navigator.mediaDevices.getUserMedia({ audio: base });
    if (this.micChoice !== 'builtin') return first;
    try {
      const inUse = first.getAudioTracks()[0]?.getSettings().deviceId;
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const own = inputs.find((d) => /macbook|imac|built-?in/i.test(d.label) && !/iphone|ipad|airpods|bluetooth|display|usb/i.test(d.label));
      if (!own || own.deviceId === inUse) return first;
      const mine = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: own.deviceId } } });
      for (const track of first.getTracks()) track.stop();
      return mine;
    } catch {
      return first; // the system's own choice is better than no microphone
    }
  }

  async start(cmd: Extract<CaptureCommand, { type: 'meeting:capture-start' }>) {
    this.micChoice = cmd.mic === 'default' || cmd.mic === 'device' ? cmd.mic : 'builtin';
    this.micDevice = cmd.micDevice;
    await this.ctx.audioWorklet.addModule('meetingsWorklet.js');

    // The microphone first: if it can't be had there is no recording at all.
    let mic: MediaStream;
    try {
      mic = cmd.fixture?.me
        ? fixtureStream(this.ctx, cmd.fixture.me)
        : await this.openMic();
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new CaptureFailure('mic-permission', 'Uranus Browser doesn’t have permission to use the microphone yet.');
      if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') throw new CaptureFailure('mic-unavailable', 'No usable microphone was found.');
      throw new CaptureFailure('failed', 'The microphone couldn’t be started.');
    }
    this.add('Me', mic, false);
    // The tab's sound is NOT asked for here: Chromium only allows it after a click on the extension's
    // context-menu item or its keyboard command, which arrives later as an attach command. (Test
    // mode can start with recorded speech standing in for it.)
    if (cmd.fixture?.others) this.add('Others', fixtureStream(this.ctx, cmd.fixture.others), false);

    // A page that is capturing the microphone may play sound without a click; if the audio engine
    // still doesn't run, say so instead of recording silence.
    await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
    if (this.ctx.state !== 'running') throw new CaptureFailure('failed', 'The audio engine couldn’t start.');

    const started = performance.now();
    this.timers.push(
      setInterval(() => send({ type: 'meeting:capture-level', me: this.levels.Me, others: this.levels.Others, elapsedMs: Math.round(performance.now() - started) }), 500),
      // A hard stop, here as well as in the background: a recording never outlives its limit.
      setTimeout(() => void this.stop('limit'), cmd.maxMs) as unknown as ReturnType<typeof setInterval>,
    );
    send({ type: 'meeting:capture-started', others: this.taps.has('Others'), micLabel: this.taps.get('Me')?.stream.getAudioTracks()[0]?.label || undefined });
  }

  /** Adds the tab's sound now ("Others" chunks begin from this moment), replacing an earlier one. */
  async attachTab(cmd: Extract<CaptureCommand, { type: 'meeting:capture-attach-tab' }>) {
    if (this.ended) return;
    try {
      let stream: MediaStream;
      if (cmd.fixture) stream = fixtureStream(this.ctx, cmd.fixture);
      else if (cmd.tabStreamId) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: cmd.tabStreamId } },
          video: false,
        } as unknown as MediaStreamConstraints);
      } else throw new Error('no stream');
      this.detach('Others', false);
      // Capturing a tab mutes it for the user; playing it here keeps the meeting audible.
      this.add('Others', stream, !cmd.fixture);
      send({ type: 'meeting:capture-tab', attached: true });
    } catch {
      send({ type: 'meeting:capture-tab', attached: false, message: 'The meeting tab’s sound couldn’t be captured. Try the menu item again.' });
    }
  }

  /** Taps a stream: its sound goes to a chunker, and (for the tab) on to the speakers. */
  private add(channel: Channel, stream: MediaStream, playThrough: boolean, again = false) {
    const source = this.ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(this.ctx, 'anus-meeting-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const silent = this.ctx.createGain();
    silent.gain.value = 0;
    source.connect(tap);
    tap.connect(silent);
    silent.connect(this.ctx.destination);
    if (playThrough) source.connect(this.ctx.destination);
    // A source added mid-recording starts its clock where the recording is now.
    const origin = channel === 'Me' && !again ? 0 : Math.round(this.ctx.currentTime * 1000) - this.originOffsetMs();
    const chunker = new Chunker(
      this.ctx.sampleRate,
      (chunk) => {
        if (chunk.level < SILENT) return;
        send({ type: 'meeting:capture-chunk', channel, startMs: chunk.startMs, endMs: chunk.endMs, level: chunk.level, wav: toBase64(encodeWav(chunk.samples)) });
      },
      undefined,
      Math.max(0, origin),
    );
    this.taps.set(channel, { stream, nodes: [source, tap, silent], chunker });
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const block = e.data;
      let sum = 0;
      for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
      this.levels[channel] = Math.sqrt(sum / block.length);
      chunker.push(block);
    };
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        // The microphone going away: reopen whatever input is the default now (AirPods after an iPhone
        // mic drops, say). The tab's sound going away just ends "Others".
        if (this.taps.get(channel)?.stream !== stream) return;
        if (channel === 'Me') void this.recoverMic();
        else {
          this.detach('Others', true);
          send({ type: 'meeting:capture-tab', attached: false, message: 'The meeting tab’s sound stopped (the tab may have closed).' });
        }
      });
    }
    if (channel === 'Me' && !again) this.meStartedAtMs = Math.round(this.ctx.currentTime * 1000);
  }

  /** Microphones reopened in this recording; a device that keeps vanishing ends it. */
  private micRecoveries = 0;

  /** The microphone went away mid-recording: reopen the default input and carry on from the same clock. */
  private async recoverMic() {
    if (this.ended) return;
    this.detach('Me', true);
    if (++this.micRecoveries > 3) return void this.stop('mic-lost');
    try {
      const mic = await this.openMic();
      if (this.ended) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      this.add('Me', mic, false, true);
      send({ type: 'meeting:capture-mic', label: mic.getAudioTracks()[0]?.label ?? '' });
    } catch {
      void this.stop('mic-lost');
    }
  }

  private meStartedAtMs = 0;
  /** The audio clock reading when the microphone began: chunk times are relative to it. */
  private originOffsetMs() {
    return this.meStartedAtMs;
  }

  private detach(channel: Channel, flush: boolean) {
    const t = this.taps.get(channel);
    if (!t) return;
    this.taps.delete(channel);
    if (flush) t.chunker.flush();
    for (const track of t.stream.getTracks()) track.stop();
    for (const node of t.nodes) node.disconnect();
    this.levels[channel] = 0;
  }

  async stop(reason: 'stopped' | 'limit' | 'tab-ended' | 'failed' | 'mic-lost') {
    if (this.ended) return;
    this.ended = true;
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    for (const channel of [...this.taps.keys()]) this.detach(channel, true);
    await this.ctx.close().catch(() => undefined);
    send({ type: 'meeting:capture-ended', reason });
  }
}

class CaptureFailure extends Error {
  constructor(
    readonly code: 'mic-permission' | 'mic-unavailable' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

// ---- the offscreen document ------------------------------------------------------------------

let recording: Recording | undefined;

function offscreen() {
  chrome.runtime.onMessage.addListener((message: CaptureCommand, sender, sendResponse) => {
    // Only the shell's own background may drive the recorder.
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message?.type === 'meeting:capture-start') {
      if (recording) return;
      const rec = (recording = new Recording());
      rec.start(message).catch(async (err) => {
        recording = undefined;
        const failure = err instanceof CaptureFailure ? err : new CaptureFailure('failed', 'Recording couldn’t be started.');
        send({ type: 'meeting:capture-error', code: failure.code, message: failure.message });
        await rec.stop('failed');
      });
    } else if (message?.type === 'meeting:capture-list-mics') {
      navigator.mediaDevices
        .enumerateDevices()
        .then((all) => sendResponse({ devices: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })) }))
        .catch(() => sendResponse({ devices: [] }));
      return true; // the answer comes asynchronously
    } else if (message?.type === 'meeting:capture-attach-tab') {
      void recording?.attachTab(message);
    } else if (message?.type === 'meeting:capture-stop') {
      void recording?.stop('stopped');
      recording = undefined;
    }
  });
}

// ---- the one-time microphone permission page (a tab) ------------------------------------------

function permissionPage() {
  const page = document.getElementById('permission')!;
  const query = new URLSearchParams(location.search);
  const camera = query.get('kind') === 'camera';
  // The same page asks for either; macOS shows its own prompt for Uranus Browser the first time.
  document.title = camera ? 'Allow camera' : 'Allow microphone';
  if (camera) {
    page.querySelector('h1')!.textContent = 'Allow Uranus Browser to use your camera';
    page.querySelector('p')!.textContent = 'Websites you open (a video call, say) ask for the camera themselves. Allowing it here lets macOS ask once, now, so it does not interrupt you later. Nothing is recorded.';
    document.getElementById('allow')!.textContent = 'Allow camera';
  }
  page.hidden = false;
  const result = document.getElementById('permission-result')!;
  let asking = false;
  const ask = async () => {
    if (asking) return;
    asking = true;
    result.textContent = `Choose “Allow while visiting the site” in the box above, then Allow when macOS asks.`;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(camera ? { video: true } : { audio: true });
      for (const track of stream.getTracks()) track.stop();
      result.textContent = 'Done. This tab closes itself.';
      if (!camera) void chrome.runtime.sendMessage({ type: 'meeting:mic-granted' }).catch(() => undefined);
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id !== undefined) setTimeout(() => void chrome.tabs.remove(tab.id!).catch(() => undefined), 800);
    } catch {
      result.textContent = `The ${camera ? 'camera' : 'microphone'} is still blocked. Allow it for Uranus Browser in System Settings › Privacy & Security, or in the site settings for this page.`;
      asking = false;
    }
  };
  document.getElementById('allow')!.addEventListener('click', () => void ask());
  // Opened from the first-run tour: the button there was the click, so ask now.
  if (query.has('auto')) void ask();
}

if (new URLSearchParams(location.search).has('permission')) permissionPage();
else offscreen();
