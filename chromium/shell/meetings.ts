/**
 * Meeting notes, from the background: record the user's microphone ("Me") and the meeting
 * tab's sound ("Others"), transcribe it in ~10-second chunks while it happens, and on Stop
 * write grounded notes. The Agent panel's meetings sheet (ui/meetingsSheet.ts) draws this and
 * sends what the user does; every call here is a `meetings:` hub handler.
 *
 * Privacy, in the order it matters:
 *  - Nothing records until the user presses Start in the panel, on the tab that is active then.
 *    There is no auto-start, no schedule, no join. The panel shows a recording indicator for as
 *    long as it runs; Chromium's own tab-capture and microphone indicators are not hidden.
 *  - Audio exists only in the capture page's memory (ui/meetingsCapture.ts) until a chunk is
 *    sent to the native host, which sends it to the chosen engine and keeps nothing. Text is
 *    stored here, in this profile's chrome.storage.local, and goes nowhere except the user's own
 *    OpenAI transcription and summary requests (or stays on this Mac with the local engine).
 *  - Transcript text is never logged: diagnostics here are counts and names only.
 *  - Stop always works: it never waits on the host or the capture page. A recording also ends by
 *    itself when its tab closes, the helper goes away, the capture page dies, or after
 *    MAX_MEETING_MS.
 *  - The meeting page is read only through chrome.scripting.executeScript while a recording runs
 *    (lib/meetingsDom.ts), for speaker names; there are no content scripts.
 *
 * What works in this Chromium fork, found by trying it (see docs/meeting-notes.md): the capture
 * page is an offscreen document (the panel's own page has no media-permission delegate);
 * `chrome.tabCapture.getMediaStreamId` is tried first and, when Chromium says the extension
 * "has not been invoked for the current page" (it needs the activeTab grant that only a toolbar
 * click, a keyboard command or a context-menu click gives), the recording continues with the
 * microphone only and says so.
 */
import { handle, broadcast } from './hub';
import type { HostMethods } from '../native-host/protocol';
import type { CaptureCommand, CaptureEvent, EngineInfo, MeetingSummarizeReply, MeetingTranscribeReply } from '../shared/meetingProtocol';
import { languageForRequest } from '../shared/meetingLanguages';
import { renameSpeaker, suggestSpeakerNames, type NameSuggestions } from '../shared/meetingNames';
import {
  MAX_MEETING_MS,
  MAX_MEETINGS,
  meetingDigest,
  providerFor,
  routineNotes,
  shownTranscript,
  type MeetingMeta,
  type MeetingRecord,
  type MeetingSummary,
  type StoredSegment,
} from '../shared/meetings';
import { readMeetingPage } from './lib/meetingsDom';
import { MENU_ID, MENU_TITLE, createTabAudio } from './lib/meetingsTabAudio';
import * as store from './lib/meetingsState';

type MeetingHostMethod = 'meetingEngines' | 'meetingTranscribe' | 'meetingSummarize' | 'underdogInfo' | 'openPrivacyPane';

export interface MeetingsContext {
  /** Calls a method of the native host; rejects, saying why, if the helper isn't there. */
  host<K extends MeetingHostMethod>(method: K, ...params: Parameters<HostMethods[K]>): Promise<ReturnType<HostMethods[K]>>;
  /** Runs `fn` whenever the native host goes away. */
  onHostLost(fn: () => void): void;
  /** The tab the user is looking at (the one a recording would capture), if it's a page. */
  activeTab(): Promise<{ chromeId: number; url: string; title: string } | undefined>;
  /** Opens an address in a normal Uranus Browser tab in front. */
  openPage(url: string): void;
}

export type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the panel draws (everything but the transcript text and the list, which have their own events). */
export interface MeetingsView {
  phase: Phase;
  meetingId?: string;
  /** Epoch milliseconds when the recording began (the panel counts up from it). */
  startedAt?: number;
  maxMs: number;
  provider?: string;
  host?: string;
  engine?: Pick<EngineInfo, 'id' | 'label' | 'model' | 'where'>;
  /** Whether the meeting tab's sound has been added: it only is after the user's menu click or shortcut. */
  othersCaptured: boolean;
  /** The site whose sound is being added as "Others". */
  othersHost?: string;
  /** How to add the tab's sound: the menu item's title, and the keyboard shortcut Chromium assigned ('' if none). */
  tabAudioMenu: string;
  tabAudioShortcut: string;
  /** Whether names from the meeting page are being read (a known meeting site). */
  readingNames: boolean;
  pending: number;
  failed: number;
  segments: number;
  /** A line to show now: the last chunk that failed, or what ended the recording. */
  notice?: string;
  error?: { code: string; message: string };
  /** Meetings whose notes are being written. */
  summarizing: string[];
  setting: store.MeetingSettings['engine'];
  mic: store.MeetingSettings['mic'];
  micDevice?: store.MeetingSettings['micDevice'];
  language: store.MeetingSettings['language'];
  /** The microphone being recorded (its name), while recording. */
  micLabel?: string;
  engines: EngineInfo[];
  /** The on-device Underdog model: whether it could run (nothing is loaded to find out). */
  underdog?: import('../shared/meetingProtocol').UnderdogInfo;
  hostProblem?: string;
  testMode: boolean;
}

const newId = () => crypto.randomUUID().slice(0, 8);
/** The test page that imitates a Meet grid (tests/meetings-fixtures.mjs); only honoured in test mode. */
const MEET_MOCK = '/__anus_meet_mock__/';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFFSCREEN_URL = 'meetingsCapture.html';
const TEST_STREAM = 'anus-test-stream';
const NAMES_EVERY = 1200;
const SAVE_EVERY = 10_000;
const MAX_PARALLEL = 3;
/** How long Stop waits for chunks already sent to come back. */
const DRAIN_MS = 25_000;
const STARTUP_MS = 20_000;

interface Recording {
  live: store.LiveMeeting;
  chromeTab: number;
  /** The tab that was in front at Start (chromeTab changes to the one whose sound is added). */
  startTab: number;
  engine: EngineInfo;
  /** Date.now() when the capture page said it was recording; the recording clock's zero. */
  t0: number;
  queue: Array<{ channel: 'Me' | 'Others'; startMs: number; endMs: number; level: number; wav: string; tries: number }>;
  running: number;
  inflight: Set<Promise<void>>;
  stopping?: Promise<void>;
  timers: Array<ReturnType<typeof setTimeout>>;
  failed: number;
  levels: { me: number; others: number };
  lastSave: number;
  polling: boolean;
}

export function registerMeetings(ctx: MeetingsContext) {
  const storage = chrome.storage.local;
  let settings = store.DEFAULT_SETTINGS;
  let index: MeetingMeta[] = [];
  let engines: EngineInfo[] = [];
  let underdog: MeetingsView['underdog'];
  let enginesAt = 0;
  let hostProblem: string | undefined;
  let testMode = false;
  let phase: Phase = 'idle';
  let rec: Recording | undefined;
  let notice: string | undefined;
  let error: MeetingsView['error'];
  let othersCaptured = false;
  let micLabel: string | undefined;
  let listingMics: Promise<{ devices: Array<{ id: string; label: string }>; needsPermission?: boolean; busy?: boolean }> | undefined;
  let othersHost: string | undefined;
  let shortcut = '';
  /** The tab whose sound was just asked for; it becomes the meeting's page once the capture page confirms. */
  let pendingTab: { id: number; url: string } | undefined;
  /** Test mode: the next gesture is treated as granted, with recorded speech standing in for the tab. */
  let testGrant = false;
  const summarizing = new Set<string>();
  /** The meeting provider for a page; in test mode the local mock page counts as Google Meet. */
  function providerOf(url: string): string {
    try {
      const u = new URL(url);
      return providerFor(u.hostname) || (testMode && u.hostname === '127.0.0.1' && u.pathname.startsWith(MEET_MOCK) ? 'Google Meet' : '');
    } catch {
      return '';
    }
  }
  /** Resolves the Start call when the capture page reports it is recording, or fails. */
  let startWaiter: { ok(): void; fail(e: { code: string; message: string }): void } | undefined;

  const ready = (async () => {
    const got = await storage.get([store.INDEX_KEY, store.SETTINGS_KEY, store.LIVE_KEY, store.TEST_MODE_KEY]);
    settings = store.restoreSettings(got[store.SETTINGS_KEY]);
    index = store.restoreIndex(got[store.INDEX_KEY]);
    testMode = got[store.TEST_MODE_KEY] === true;
    await recoverLive(got[store.LIVE_KEY]);
    // A capture page left over from a background that restarted would record with nobody in charge.
    if (!rec) {
      await chrome.offscreen.closeDocument().catch(() => undefined);
      // A menu item left by a background that restarted mid-recording would offer to add audio to nothing.
      chrome.contextMenus.remove(MENU_ID, () => void chrome.runtime.lastError);
    }
  })();

  // ---- the view -------------------------------------------------------------------------

  const view = (): MeetingsView => ({
    phase,
    meetingId: rec?.live.id,
    startedAt: rec?.t0,
    maxMs: MAX_MEETING_MS,
    provider: rec?.live.provider || undefined,
    host: rec?.live.host || undefined,
    engine: rec && { id: rec.engine.id, label: rec.engine.label, model: rec.engine.model, where: rec.engine.where },
    othersCaptured,
    othersHost,
    tabAudioMenu: MENU_TITLE,
    tabAudioShortcut: shortcut,
    readingNames: !!rec && !!rec.live.provider,
    pending: rec ? rec.queue.length + rec.running : 0,
    failed: rec?.failed ?? 0,
    segments: rec?.live.segments.length ?? 0,
    notice,
    error,
    summarizing: [...summarizing],
    setting: settings.engine,
    mic: settings.mic,
    micDevice: settings.micDevice,
    language: settings.language,
    micLabel,
    engines,
    underdog,
    hostProblem,
    testMode,
  });
  const sendView = () => broadcast('meetings:state', view());
  const sendList = () => broadcast('meetings:list', index);

  async function refreshEngines(force = false) {
    if (!force && Date.now() - enginesAt < 15_000 && engines.length) return;
    try {
      engines = await ctx.host('meetingEngines');
      hostProblem = undefined;
      enginesAt = Date.now();
      underdog = await ctx.host('underdogInfo').then((info) => info as MeetingsView['underdog']).catch(() => undefined);
    } catch (err) {
      engines = [];
      const why = err instanceof Error ? err.message : '';
      // An older helper answers "No method meetingEngines": this Uranus Browser is newer than the helper it found.
      hostProblem = /No method/.test(why) ? 'Uranus Browser’s helper is older than meeting notes. Quit and reopen Uranus Browser so it registers the new one.' : why || 'Uranus Browser’s helper isn’t available.';
    }
  }

  // ---- saving -----------------------------------------------------------------------------

  async function saveRecord(record: MeetingRecord) {
    const meta = store.metaOf(record);
    index = store.upsertMeta(index, meta);
    await storage.set({ [store.recordKey(record.id)]: record, [store.INDEX_KEY]: index });
    sendList();
  }

  async function loadRecord(id: string): Promise<MeetingRecord | undefined> {
    const key = store.recordKey(String(id).slice(0, 64));
    return store.restoreRecord((await storage.get(key))[key]);
  }

  async function snapshotLive(force = false) {
    if (!rec || (!force && Date.now() - rec.lastSave < SAVE_EVERY)) return;
    rec.lastSave = Date.now();
    await storage.set({ [store.LIVE_KEY]: rec.live }).catch(() => undefined);
  }

  /** A recording the background lost (it restarted, or the browser quit): kept as the meeting it was. */
  async function recoverLive(raw: unknown) {
    const live = store.restoreLive(raw);
    await storage.remove(store.LIVE_KEY);
    if (!live) return;
    const record = store.toRecord(live, 'recovered', live.lastMs);
    if (record.segments.length) {
      await saveRecord(record);
      notice = 'A recording that was running when Uranus Browser stopped was saved as it was.';
    }
  }

  // ---- starting ---------------------------------------------------------------------------

  // ---- the meeting tab's sound: added on the user's gesture ------------------------------------

  const tabAudio = createTabAudio({
    contextMenus: {
      create: (props) => chrome.contextMenus.create(props as chrome.contextMenus.CreateProperties, () => void chrome.runtime.lastError),
      remove: (id) => void chrome.contextMenus.remove(id, () => void chrome.runtime.lastError),
      onClicked: chrome.contextMenus.onClicked,
    },
    commands: chrome.commands,
    tabCapture: {
      getMediaStreamId: (options) => (testMode && testGrant ? Promise.resolve(TEST_STREAM) : chrome.tabCapture.getMediaStreamId(options)),
    },
    accept: (tab) => /^https?:\/\//.test(tab.url ?? ''),
    attach: (streamId, tab) => void attachTab(streamId, tab),
    say: (message) => {
      notice = message;
      sendView();
    },
  });

  async function attachTab(streamId: string, tab: { id: number; url: string }) {
    pendingTab = tab;
    let fixture: string | undefined;
    if (streamId === TEST_STREAM) fixture = ((await storage.get(store.TEST_FIXTURE_KEY))[store.TEST_FIXTURE_KEY] as { others?: string } | undefined)?.others;
    send({ type: 'meeting:capture-attach-tab', ...(fixture ? { fixture } : { tabStreamId: streamId }) });
  }

  async function start(): Promise<{ ok: true } | { error: string; code?: string }> {
    await ready;
    testMode = (await storage.get(store.TEST_MODE_KEY))[store.TEST_MODE_KEY] === true;
    if (phase !== 'idle') return { error: 'A recording is already running.' };
    if (index.length >= MAX_MEETINGS) return { error: `You have ${MAX_MEETINGS} saved meetings. Delete some before recording another.` };
    const tab = await ctx.activeTab();
    if (!tab || !/^https?:\/\//.test(tab.url)) return { error: 'Open the meeting in a tab first: Uranus Browser records the tab you are looking at when you press Start.' };
    await refreshEngines(true);
    if (hostProblem) return { error: hostProblem };
    const picked = store.chooseEngine(settings.engine, engines);
    if ('error' in picked) return { error: picked.error };

    phase = 'starting';
    notice = undefined;
    error = undefined;
    othersCaptured = false;
    othersHost = undefined;
    sendView();

    let host = '';
    try {
      host = new URL(tab.url).hostname;
    } catch {
      /* not an address */
    }
    const live = store.newLive({ id: newId(), startedAt: Date.now(), host, provider: providerOf(tab.url), engine: picked.engine.id, model: picked.engine.model, othersCaptured: false });
    const recording: Recording = {
      live,
      chromeTab: tab.chromeId,
      startTab: tab.chromeId,
      engine: picked.engine,
      t0: Date.now(),
      queue: [],
      running: 0,
      inflight: new Set(),
      timers: [],
      failed: 0,
      levels: { me: 0, others: 0 },
      lastSave: 0,
      polling: false,
    };
    rec = recording;

    const fail = async (code: string, message: string) => {
      error = { code, message };
      tabAudio.setActive(false);
      await closeCapture();
      rec = undefined;
      phase = 'idle';
      sendView();
      return { error: message, code };
    };

    try {
      await chrome.offscreen.closeDocument().catch(() => undefined);
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Records the microphone, and the meeting tab’s sound once the user adds it, only after the user presses Start, to write meeting notes.',
      });
      const started = new Promise<void>((resolve, reject) => {
        startWaiter = { ok: resolve, fail: (e) => reject(Object.assign(new Error(e.message), { code: e.code })) };
        // Nothing for 20 seconds, and no error, is almost always a permission question the browser
        // could not show for a page without a window.
        setTimeout(() => reject(Object.assign(new Error('The microphone didn’t start. Uranus Browser may need your permission first.'), { code: 'mic-permission' })), STARTUP_MS);
      });
      // Test mode (a flag only the end-to-end tests set, in a throwaway profile) plays recorded
      // speech in place of the microphone and the tab, so the rest of the path runs for real.
      let fixture: Extract<CaptureCommand, { type: 'meeting:capture-start' }>['fixture'];
      if (testMode) {
        const stash = (await storage.get(store.TEST_FIXTURE_KEY))[store.TEST_FIXTURE_KEY];
        // Only the microphone's stand-in now; the tab's is played when the user's gesture adds it.
        if (stash && typeof stash === 'object') fixture = { me: (stash as { me?: string }).me };
      }
      send({ type: 'meeting:capture-start', maxMs: MAX_MEETING_MS, mic: settings.mic, micDevice: settings.micDevice, fixture });
      await started;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'failed';
      return fail(code, err instanceof Error ? err.message : 'Recording couldn’t be started.');
    } finally {
      startWaiter = undefined;
    }

    recording.t0 = Date.now();
    phase = 'recording';
    live.othersCaptured = othersCaptured;
    // From now on the page's context menu has the "add this tab's audio" item, and the shortcut works.
    tabAudio.setActive(true);
    shortcut = await tabAudio.shortcut();
    recording.timers.push(setTimeout(() => void stop('limit'), MAX_MEETING_MS + 5_000));
    recording.timers.push(setInterval(() => void pollNames(), NAMES_EVERY) as unknown as ReturnType<typeof setTimeout>);
    await snapshotLive(true);
    sendView();
    return { ok: true };
  }

  const send = (command: CaptureCommand) => void chrome.runtime.sendMessage(command).catch(() => undefined);

  async function closeCapture() {
    send({ type: 'meeting:capture-stop' });
    await wait(200);
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }

  // ---- while recording ------------------------------------------------------------------------

  function onCaptureEvent(event: CaptureEvent) {
    if (event.type === 'meeting:capture-started') {
      othersCaptured = event.others;
      micLabel = event.micLabel;
      startWaiter?.ok();
    } else if (event.type === 'meeting:capture-tab' && rec) {
      if (event.attached && pendingTab) {
        othersCaptured = true;
        rec.live.othersCaptured = true;
        rec.chromeTab = pendingTab.id;
        try {
          const host = new URL(pendingTab.url).hostname;
          othersHost = host;
          rec.live.host = host;
          rec.live.provider = providerOf(pendingTab.url);
        } catch {
          /* no address */
        }
        notice = undefined;
      } else {
        othersCaptured = false;
        othersHost = undefined;
        tabAudio.detached();
        notice = event.message ?? 'The meeting tab’s sound is no longer being added.';
      }
      pendingTab = undefined;
      sendView();
    } else if (event.type === 'meeting:capture-mic' && rec) {
      micLabel = event.label || micLabel;
      notice = `Your microphone changed${event.label ? ` to ${event.label}` : ''}. The recording carries on.`;
      sendView();
    } else if (event.type === 'meeting:capture-error') {
      if (startWaiter) startWaiter.fail({ code: event.code, message: event.message });
      else if (rec) void stop('error', event.message);
    } else if (event.type === 'meeting:capture-chunk' && rec && (phase === 'recording' || phase === 'stopping')) {
      // A chunk can still arrive just after Stop (the last seconds, flushed by the capture page): it counts.
      if (event.channel !== 'Me' && event.channel !== 'Others') return;
      rec.queue.push({ channel: event.channel, startMs: event.startMs, endMs: event.endMs, level: event.level, wav: event.wav, tries: 0 });
      pump();
    } else if (event.type === 'meeting:capture-level' && rec) {
      rec.levels = { me: event.me, others: event.others };
      broadcast('meetings:levels', rec.levels);
    } else if (event.type === 'meeting:capture-ended' && rec && phase === 'recording') {
      if (event.reason === 'mic-lost') void stop('error', 'Your microphone went away and couldn’t be reopened (an iPhone or Bluetooth mic dropping out, say). What was transcribed so far is saved. Choose your microphone in System Settings → Sound → Input, then press Start.');
      else void stop(event.reason === 'limit' ? 'limit' : event.reason === 'tab-ended' ? 'tab-closed' : event.reason === 'failed' ? 'error' : 'user');
    }
  }

  chrome.runtime.onMessage.addListener((message: CaptureEvent | { type: string }, sender) => {
    // Only the shell's own pages may report, never a content script or a web page (those have a tab
    // and the page's address): the offscreen capture page has no tab; the microphone permission
    // page is an extension page in a tab, and may only say that it was granted.
    if (sender.id !== chrome.runtime.id) return;
    const ownPageInTab = !!sender.tab && (sender.url ?? '').startsWith(chrome.runtime.getURL(OFFSCREEN_URL));
    if (message?.type === 'meeting:mic-granted' && (ownPageInTab || !sender.tab)) {
      error = undefined;
      notice = 'Microphone allowed. Press Start to record.';
      sendView();
    } else if (!sender.tab && typeof message?.type === 'string' && message.type.startsWith('meeting:capture-')) onCaptureEvent(message as CaptureEvent);
  });

  /** Sends queued chunks to the host, a few at a time. */
  function pump() {
    const r = rec;
    if (!r) return;
    while (r.running < MAX_PARALLEL && r.queue.length) {
      const chunk = r.queue.shift()!;
      r.running++;
      const task = transcribe(r, chunk).finally(() => {
        r.running--;
        r.inflight.delete(task);
        sendView();
        pump();
      });
      r.inflight.add(task);
    }
    sendView();
  }

  async function transcribe(r: Recording, chunk: Recording['queue'][number]): Promise<void> {
    try {
      const reply: MeetingTranscribeReply = await ctx.host('meetingTranscribe', { engine: r.engine.id, wav: chunk.wav, level: chunk.level, language: languageForRequest(settings.language) });
      // The recording clock is the capture page's; the chunk says where on it the words were spoken.
      const segment = store.addSegment(r.live, chunk.channel, chunk.startMs, chunk.endMs, reply.text);
      if (segment) {
        if (segment.channel === 'Others') segment.speaker = liveName(r, segment);
        broadcast('meetings:segment', segment);
        void snapshotLive();
      }
      notice = notice && /^Transcription/.test(notice) ? undefined : notice;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed.';
      // One more try for a hiccup; a chunk that fails twice is a gap in the transcript, and the audio is gone.
      if (chunk.tries < 1 && /problem on its side|Couldn’t reach|slowing down|didn’t answer/.test(message) && phase !== 'idle') {
        chunk.tries++;
        await wait(1500);
        r.queue.unshift(chunk);
        return;
      }
      r.failed++;
      store.addGap(r.live, chunk.startMs, chunk.endMs);
      notice = `Transcription: ${message}`;
    }
  }

  function liveName(r: Recording, segment: StoredSegment): string {
    const labeled = r.live.observations.length ? store.toRecord({ ...r.live, segments: [segment] }, 'user', segment.end_ms).segments[0] : undefined;
    return labeled?.speaker ?? 'Others';
  }

  /** One read of the meeting page for the highlighted speaker. Fails soft; never touches the page. */
  async function pollNames() {
    const r = rec;
    if (!r || phase !== 'recording' || !r.live.provider || r.polling) return;
    r.polling = true;
    try {
      const tab = await chrome.tabs.get(r.chromeTab);
      // Only while the tab is still on the meeting site that was recorded.
      if (providerOf(tab.url ?? '') !== r.live.provider) return;
      const [result] = await chrome.scripting.executeScript({ target: { tabId: r.chromeTab }, func: readMeetingPage, args: [r.live.provider] });
      const read = result?.result;
      if (read) store.addObservation(r.live, Date.now() - r.t0, read.speaker, read.names);
    } catch {
      /* the tab went away or can't be read: the lines stay "Others" */
    } finally {
      r.polling = false;
    }
  }

  // ---- stopping ---------------------------------------------------------------------------------

  function stop(reason: 'user' | 'limit' | 'tab-closed' | 'lost' | 'error', detail?: string): Promise<void> {
    const r = rec;
    if (!r) return Promise.resolve();
    if (r.stopping) return r.stopping;
    r.stopping = (async () => {
      phase = 'stopping';
      tabAudio.setActive(false);
      for (const t of r.timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      notice =
        reason === 'tab-closed'
          ? 'The meeting tab was closed, so the recording stopped.'
          : reason === 'limit'
            ? 'The recording reached its time limit and stopped.'
            : reason === 'lost'
              ? 'Uranus Browser’s helper stopped, so the recording ended. What was transcribed so far is saved.'
              : reason === 'error'
                ? (detail ?? 'The recorder stopped unexpectedly.')
                : undefined;
      sendView();
      // Never wait on the capture page: ask it to stop, then close it whatever it says.
      await closeCapture();
      await Promise.race([Promise.allSettled([...r.inflight]).then(() => undefined), wait(DRAIN_MS)]);
      // Chunks still waiting for a slot go now, once, bounded by the same time limit.
      const deadline = Date.now() + DRAIN_MS;
      while ((r.queue.length || r.running) && Date.now() < deadline && reason !== 'lost') {
        pump();
        await Promise.race([Promise.allSettled([...r.inflight]).then(() => undefined), wait(500)]);
      }
      const record = store.toRecord(r.live, reason, Math.max(Date.now() - r.t0, r.live.lastMs));
      rec = undefined;
      phase = 'idle';
      othersCaptured = false;
      othersHost = undefined;
      await storage.remove(store.LIVE_KEY).catch(() => undefined);
      if (record.segments.length) {
        await saveRecord(record);
        notice = notice ?? undefined;
        sendView();
        void summarize(record.id, r.engine.where === 'cloud' ? 'model' : 'digest');
      } else {
        notice = notice ?? 'No speech was picked up, so nothing was saved.';
        sendView();
      }
    })();
    return r.stopping;
  }

  // ---- notes ----------------------------------------------------------------------------------

  async function summarize(id: string, mode: 'model' | 'digest' | 'underdog'): Promise<{ ok: true } | { error: string }> {
    await ready;
    if (summarizing.has(id)) return { error: 'The notes are already being written.' };
    const record = await loadRecord(id);
    if (!record) return { error: 'That meeting no longer exists.' };
    const lines = shownTranscript(record.segments).map((s) => ({ speaker: s.speaker, start_ms: s.start_ms, text: s.text }));
    if (!lines.length) return { error: 'There is no transcript to summarise.' };
    summarizing.add(id);
    sendView();
    try {
      let reply: MeetingSummarizeReply;
      if (mode === 'digest') {
        const digest = meetingDigest(lines);
        reply = { items: digest.items, model: 'evidence-digest', method: 'extractive', warning: null, title: digest.title };
      } else {
        // OpenAI, unless the user chose the on-device model for this meeting.
        reply = await ctx.host('meetingSummarize', { segments: lines, provider: mode === 'underdog' ? 'underdog' : 'openai' });
      }
      const summary: MeetingSummary = { items: reply.items, model: reply.model, method: reply.method, warning: reply.warning, at: Date.now() };
      const fresh = (await loadRecord(id)) ?? record;
      fresh.summary = summary;
      fresh.hasSummary = true;
      fresh.summaryError = undefined;
      const proposed = store.checkTitle(reply.title);
      if (!fresh.titleEdited && proposed.ok) fresh.title = proposed.title;
      await saveRecord(fresh);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The notes couldn’t be written.';
      const fresh = (await loadRecord(id)) ?? record;
      fresh.summaryError = message;
      await saveRecord(fresh);
      return { error: message };
    } finally {
      summarizing.delete(id);
      sendView();
    }
  }

  // ---- the handlers the panel uses ----------------------------------------------------------------

  chrome.tabs.onRemoved.addListener((id) => {
    if (rec && (rec.chromeTab === id || rec.startTab === id) && phase === 'recording') void stop('tab-closed');
  });
  // If the tab's address leaves the meeting site the recording goes on (the user may have a reason),
  // but names are no longer asked of the page: pollNames() checks the site every time.

  ctx.onHostLost(() => {
    if (rec && (phase === 'recording' || phase === 'starting')) void stop('lost');
    enginesAt = 0;
  });

  handle({
    'meetings:get': async () => {
      await ready;
      await refreshEngines();
      return { view: view(), list: index, live: rec?.live.segments ?? [], levels: rec?.levels };
    },
    'meetings:start': () => start(),
    /** Always answers at once; the work of finishing runs after. */
    'meetings:stop': () => {
      void stop('user');
      return { ok: true };
    },
    'meetings:open': async (id: string) => {
      await ready;
      const record = await loadRecord(String(id));
      if (!record) return undefined;
      const suggestions: NameSuggestions = suggestSpeakerNames(record.segments);
      return { record, suggestions };
    },
    'meetings:rename': async (id: string, title: string) => {
      await ready;
      const checked = store.checkTitle(title);
      if (!checked.ok) return { error: checked.reason };
      const record = await loadRecord(String(id));
      if (!record) return { error: 'That meeting no longer exists.' };
      record.title = checked.title;
      record.titleEdited = true;
      await saveRecord(record);
      return { ok: true };
    },
    'meetings:speaker': async (id: string, from: string, to: string) => {
      await ready;
      const record = await loadRecord(String(id));
      if (!record) return { error: 'That meeting no longer exists.' };
      record.segments = renameSpeaker(record.segments, String(from), String(to));
      // The notes quote speakers by name; the quotes keep the name they were made with, so write them again.
      await saveRecord(record);
      return { ok: true };
    },
    'meetings:delete': async (id: string) => {
      await ready;
      if (rec?.live.id === id) return { error: 'Stop the recording first.' };
      index = store.removeMeta(index, String(id));
      await storage.remove(store.recordKey(String(id).slice(0, 64)));
      await storage.set({ [store.INDEX_KEY]: index });
      sendList();
      return { ok: true };
    },
    'meetings:deleteAll': async () => {
      await ready;
      if (rec) return { error: 'Stop the recording first.' };
      await storage.remove([...index.map((m) => store.recordKey(m.id)), store.LIVE_KEY]);
      index = [];
      await storage.set({ [store.INDEX_KEY]: index });
      sendList();
      return { ok: true };
    },
    'meetings:summarize': (id: string, mode: string) => summarize(String(id), mode === 'digest' ? 'digest' : mode === 'underdog' ? 'underdog' : 'model'),
    'meetings:setEngine': async (setting: string) => {
      await ready;
      settings = store.restoreSettings({ ...settings, engine: setting });
      await storage.set({ [store.SETTINGS_KEY]: settings });
      sendView();
      return { ok: true };
    },
    'meetings:setLanguage': async (code: string) => {
      await ready;
      settings = store.restoreSettings({ ...settings, language: code });
      await storage.set({ [store.SETTINGS_KEY]: settings });
      sendView();
      return { ok: true };
    },
    'meetings:setMic': async (choice: string, device?: { id: string; label: string }) => {
      await ready;
      settings = store.restoreSettings({ ...settings, mic: choice, micDevice: choice === 'device' ? device : settings.micDevice });
      await storage.set({ [store.SETTINGS_KEY]: settings });
      sendView();
      return { ok: true };
    },
    /**
     * The microphones by name, for the picker. The recorder's own hidden page can see names (it holds
     * the microphone permission); the panel page can't. While recording that page is already there;
     * otherwise one is opened just to list (it opens no microphone) and closed again.
     */
    'meetings:devices': () => {
      // One listing at a time (a second ask gets the first's answer): the hidden page is created and closed per listing.
      listingMics ??= (async () => {
        await ready;
        if (phase !== 'idle' && phase !== 'recording') return { devices: [], busy: true };
        const opened = phase === 'idle';
        try {
          if (opened) {
            await chrome.offscreen.closeDocument().catch(() => undefined);
            await chrome.offscreen.createDocument({
              url: OFFSCREEN_URL,
              reasons: [chrome.offscreen.Reason.USER_MEDIA],
              justification: 'Lists the microphones by name so the user can choose one for meeting notes. No microphone is opened.',
            });
          }
          // The page answers once it has loaded: ask until it does.
          for (let i = 0; i < 15; i++) {
            const reply = (await chrome.runtime.sendMessage({ type: 'meeting:capture-list-mics' } satisfies CaptureCommand).catch(() => undefined)) as { devices?: Array<{ id: string; label: string }> } | undefined;
            if (reply?.devices) {
              const devices = reply.devices.filter((d) => d.label).slice(0, 30);
              return { devices, needsPermission: !devices.length };
            }
            await wait(200);
          }
          return { devices: [], needsPermission: true };
        } catch {
          return { devices: [], needsPermission: true };
        } finally {
          if (opened && phase === 'idle') await chrome.offscreen.closeDocument().catch(() => undefined);
          listingMics = undefined;
        }
      })();
      return listingMics;
    },
    /** The one-time microphone permission page, opened in a tab because only a tab can show Chromium's prompt. */
    'meetings:permission': () => {
      ctx.openPage(chrome.runtime.getURL(`${OFFSCREEN_URL}?permission=1`));
      return { ok: true };
    },
    /**
     * Asks for a permission on purpose, with a button (the first-run tour): the microphone and camera pages open
     * in a tab (only a tab can show Chromium's prompt, and macOS then asks once); App Management has no prompt,
     * so its System Settings pane opens.
     */
    'permissions:open': async (kind: string) => {
      if (kind === 'microphone') ctx.openPage(chrome.runtime.getURL(`${OFFSCREEN_URL}?permission=1&auto=1`));
      else if (kind === 'camera') ctx.openPage(chrome.runtime.getURL(`${OFFSCREEN_URL}?permission=1&kind=camera&auto=1`));
      else if (kind === 'appManagement') return { ok: await ctx.host('openPrivacyPane', 'appManagement').then((r) => r === true).catch(() => false) };
      else return { ok: false };
      return { ok: true };
    },
    /** Test mode only: does what the menu click does, for the tab in front, with the grant faked or real. */
    'meetings:testGesture': async (grant: boolean) => {
      testMode = (await storage.get(store.TEST_MODE_KEY))[store.TEST_MODE_KEY] === true;
      if (!testMode) return { error: 'Not in test mode.' };
      testGrant = !!grant;
      const tab = await ctx.activeTab();
      await tabAudio.gesture(tab && { id: tab.chromeId, url: tab.url });
      return { ok: true };
    },
    'meetings:dismiss': () => {
      if (phase === 'idle') {
        notice = undefined;
        error = undefined;
        sendView();
      }
      return { ok: true };
    },
  });

  return {
    /** Whether a recording is running or starting. */
    recording: () => phase === 'recording' || phase === 'starting',
    /**
     * For the calendar reminder's "Join & record": starts the notes once the meeting's tab (on
     * `host`) is the one in front, as Start would, waiting a few seconds for it to open. The
     * user's click on the reminder is the go-ahead; the recording bar shows as for Start.
     */
    startFor: async (host: string): Promise<{ error?: string }> => {
      await ready;
      const wanted = host.replace(/^www\./, '');
      const deadline = Date.now() + 8000;
      for (;;) {
        const tab = await ctx.activeTab();
        let at = '';
        try {
          at = tab ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
        } catch {
          at = '';
        }
        if (at === wanted || at.endsWith(`.${wanted}`) || wanted.endsWith(`.${at}`)) break;
        if (Date.now() > deadline) return { error: 'The meeting’s tab didn’t open in time.' };
        await new Promise((r) => setTimeout(r, 250));
      }
      const started = await start();
      return 'error' in started ? { error: started.error } : {};
    },
    /** The "Recording" notification's Stop. */
    stopNow: () => void stop('user'),
    /**
     * For a routine that runs after a calendar meeting: the notes of the recording made during
     * it (started from 15 minutes before it to its end; the latest one), fenced. Undefined when
     * there is none.
     */
    notesFor: async (meeting: { start: number; end: number }): Promise<string | undefined> => {
      await ready;
      const during = index.filter((m) => m.startedAt >= meeting.start - 15 * 60_000 && m.startedAt <= meeting.end).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!during) return undefined;
      const record = await loadRecord(during.id);
      return record ? routineNotes(record) : undefined;
    },
  };
}
