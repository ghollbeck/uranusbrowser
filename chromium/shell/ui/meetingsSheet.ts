/**
 * The Agent panel's meeting notes: record a meeting you are in, read the live transcript, and
 * keep, search-read, copy or delete the notes afterwards. It only draws what the background
 * saved (shell/meetings.ts) and tells it what the user did. Everything from a transcript or a
 * model is shown as TEXT (DOM text nodes, never innerHTML), because other people's words and a
 * model's output are not markup.
 *
 * Recording starts only from the Start button here. While it runs, a bar under the header says
 * so and offers Stop, whether or not this sheet is open, and closing the panel asks first.
 *
 * Calendar reminders and the "this looks like a meeting" offer (ui/meetingsCalendar.ts) only
 * bring the user here: they open the sheet on a "ready to record" card, whose Start button is
 * the same one.
 */
import {
  MAX_TITLE,
  SUMMARY_HEADINGS,
  SUMMARY_SECTIONS,
  discussMessage,
  formatDuration,
  formatTimestamp,
  meetingMarkdown,
  shownTranscript,
  type MeetingMeta,
  type MeetingRecord,
  type StoredSegment,
} from '../../shared/meetings';
import type { NameSuggestions } from '../../shared/meetingNames';
import type { MeetingsView } from '../meetings';
import { AUTO_LANGUAGE, MEETING_LANGUAGES, restoreLanguage } from '../../shared/meetingLanguages';
import { invoke, on } from '../client';
import { ICONS, type IconName } from './icons';
import { customSelect } from './select';
import { tabAudioHint } from '../lib/meetingsTabAudio';
import { CONSENT_HINT, platformLabel, setupMeetingsCalendar, type ReadyInfo } from './meetingsCalendar';

type Child = Node | string | null | undefined | false;
type Reply = { error?: string; ok?: boolean; code?: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function icon(name: IconName) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  el.append(path);
  return el;
}

function h(tag: string, props: Record<string, string | boolean | undefined | ((e: Event) => void)> = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const clock = (ms: number) => formatTimestamp(Math.max(0, ms));
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface MeetingsHooks {
  /** Whether the agent is working: a message can't start meanwhile. */
  busy(): boolean;
  /** Sends text as the user's own message; false if it couldn't be sent. */
  discuss(text: string): boolean;
  /** The tab the user is looking at, as the composer shows it. */
  page(): { title: string; host: string } | undefined;
  /** Closes the whole panel. */
  closePanel(): void;
}

type Screen = { kind: 'home' } | { kind: 'calendar' } | { kind: 'meeting'; id: string; record?: MeetingRecord; suggestions?: NameSuggestions; confirm?: 'delete'; copied?: boolean; message?: string };

export function setupMeetings(hooks: MeetingsHooks) {
  const sheet = $('meetings-sheet');
  const toggle = $('meetings');
  const bar = $('rec-bar');
  let view: MeetingsView | undefined;
  let list: MeetingMeta[] = [];
  let live: StoredSegment[] = [];
  let levels = { me: 0, others: 0 };
  let screen: Screen = { kind: 'home' };
  let startError: { message: string; code?: string } | undefined;
  let starting = false;
  let confirmAll = false;
  let confirmClose = false;
  let follow = true;
  let tick: ReturnType<typeof setInterval> | undefined;
  /** Set when a calendar reminder or a meeting tab brought the user here: the card says what is about to be recorded. */
  let ready: ReadyInfo | undefined;

  // The live transcript list outlives repaints, so its scroll position and the reader's place in it do.
  const liveList = h('ol', { class: 'mt-live', id: 'mt-live', role: 'log', 'aria-live': 'polite', 'aria-label': 'Live transcript', tabindex: '0' });
  const toLatest = h('button', { class: 'mt-latest', type: 'button', 'aria-label': 'Scroll to the latest line', onclick: () => ((follow = true), (liveList.scrollTop = liveList.scrollHeight), (toLatest.hidden = true)) }, icon('arrowDown'));
  toLatest.hidden = true;
  const atBottom = () => liveList.scrollHeight - liveList.scrollTop - liveList.clientHeight < 40;
  liveList.addEventListener('scroll', () => {
    follow = atBottom();
    toLatest.hidden = follow;
  });

  const recording = () => view?.phase === 'recording' || view?.phase === 'starting' || view?.phase === 'stopping';
  const isOpen = () => !sheet.hidden;
  const calendar = setupMeetingsCalendar({
    recording,
    sheetOpen: isOpen,
    ready: openReady,
    openSettings: () => {
      if (!isOpen()) open();
      screen = { kind: 'calendar' };
      paint();
      $('meetings-back').focus();
    },
  });

  // ---- the header button, the bar, and the clock -----------------------------------------------

  function elapsed() {
    return view?.startedAt && view.phase === 'recording' ? Date.now() - view.startedAt : 0;
  }

  function paintChrome() {
    const active = recording();
    toggle.classList.toggle('recording', active);
    toggle.setAttribute('aria-label', active ? 'Meeting notes: recording in progress' : 'Meeting notes');
    // With the sheet open the recorder card shows the same thing, so the bar only appears to ask.
    bar.hidden = !active || (isOpen() && !confirmClose);
    if (active) {
      $('rec-bar-text').textContent = view!.phase === 'stopping' ? 'Finishing up…' : view!.phase === 'starting' ? 'Starting…' : 'Recording';
      $('rec-bar-time').textContent = clock(elapsed());
      const hint = $('rec-bar-hint');
      hint.hidden = !(view!.phase === 'recording' && !view!.othersCaptured);
      hint.textContent = hint.hidden ? '' : tabAudioHint(view!);
      $<HTMLButtonElement>('rec-bar-stop').disabled = view!.phase === 'stopping';
    }
    calendar.paintStrip();
    if (active && !tick) tick = setInterval(paintClock, 1000);
    if (!active && tick) {
      clearInterval(tick);
      tick = undefined;
    }
  }

  function paintClock() {
    const t = clock(elapsed());
    $('rec-bar-time').textContent = t;
    const el = document.getElementById('mt-elapsed');
    if (el) el.textContent = t;
  }

  // ---- opening and closing --------------------------------------------------------------------

  async function refresh() {
    const got = await invoke<{ view: MeetingsView; list: MeetingMeta[]; live: StoredSegment[]; levels?: typeof levels }>('meetings:get').catch(() => undefined);
    if (!got) return;
    view = got.view;
    list = got.list;
    live = got.live;
    levels = got.levels ?? levels;
    rebuildLive();
    paintChrome();
    paint();
  }

  function open() {
    // Only one sheet at a time: the companions sheet closes when this one opens.
    document.dispatchEvent(new CustomEvent('sheet:open', { detail: 'meetings' }));
    screen = { kind: 'home' };
    confirmAll = false;
    sheet.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    paintChrome();
    void refresh().then(() => ($('mt-primary') ?? $('meetings-close')).focus());
    paint();
  }

  function close(returnFocus = true) {
    if (sheet.hidden) return;
    if (screen.kind === 'calendar') calendar.leaveSettings();
    ready = undefined;
    sheet.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    paintChrome();
    if (returnFocus) toggle.focus();
  }

  /** Opens the sheet on the "ready to record" card. Recording still waits for the click on Start. */
  function openReady(info: ReadyInfo) {
    if (recording()) return;
    if (!isOpen()) open();
    else if (screen.kind === 'calendar') calendar.leaveSettings();
    ready = info;
    startError = undefined;
    screen = { kind: 'home' };
    paint();
    $('mt-primary')?.focus();
  }

  // ---- drawing --------------------------------------------------------------------------------

  function paint() {
    if (sheet.hidden) return;
    const body = $('meetings-body');
    const scroll = body.scrollTop;
    const current = screen;
    $('meetings-title').textContent = current.kind === 'meeting' ? 'Meeting' : current.kind === 'calendar' ? 'Calendar' : 'Meeting notes';
    $('meetings-back').hidden = current.kind === 'home';
    body.replaceChildren(current.kind === 'meeting' ? meetingScreen(current) : current.kind === 'calendar' ? calendar.settings() : homeScreen());
    if (current.kind === 'meeting') body.scrollTop = scroll;
    if (current.kind === 'home' && follow) liveList.scrollTop = liveList.scrollHeight;
  }

  function rebuildLive() {
    liveList.replaceChildren(...live.map(liveLine));
    if (follow) liveList.scrollTop = liveList.scrollHeight;
  }

  function liveLine(s: StoredSegment) {
    return h('li', { class: `mt-line ${s.channel === 'Me' ? 'me' : 'others'}` }, h('span', { class: 'mt-who' }, s.speaker), h('span', { class: 'mt-text' }, s.text), h('span', { class: 'mt-at' }, clock(s.start_ms)));
  }

  async function ask(name: string, ...args: unknown[]): Promise<Reply> {
    return (await invoke<Reply>(name, ...args).catch((err) => ({ error: err instanceof Error ? err.message : 'Something went wrong.' }))) ?? {};
  }

  // ---- home: the recorder, then the saved meetings ---------------------------------------------

  function homeScreen() {
    return h('div', { class: 'mt-home' }, recorderCard(), calendar.upcoming(), pastMeetings());
  }

  function engineText(): string {
    const v = view;
    if (!v) return '';
    const ready = v.engines.filter((e) => e.ready);
    const pick = v.setting === 'auto' ? (ready.find((e) => e.id === 'openai') ?? ready[0]) : ready.find((e) => e.id === v.setting);
    if (!pick) return v.hostProblem ?? v.engines.find((e) => e.id === (v.setting === 'local' ? 'local' : 'openai'))?.detail ?? 'No transcription engine is set up.';
    return pick.where === 'cloud'
      ? 'Your microphone, and the meeting tab’s sound once you add it, are turned into text by OpenAI, in 10-second pieces, with your API key. The audio is not saved anywhere. The text stays in this browser profile; the notes are written by OpenAI from the text.'
      : 'Your microphone, and the meeting tab’s sound once you add it, are turned into text on this Mac, in 10-second pieces. The audio is not saved and never leaves it. The text stays in this browser profile.';
  }

  function recorderCard() {
    const v = view;
    if (!v) return h('p', { class: 'sheet-hint' }, 'Loading…');
    if (v.phase === 'idle') return idleCard(v);
    return recordingCard(v);
  }

  function idleCard(v: MeetingsView) {
    const page = hooks.page();
    const engines = v.engines;
    const segmented = h(
      'div',
      { class: 'mt-engines', role: 'radiogroup', 'aria-label': 'Where audio is turned into text' },
      ...(
        [
          ['auto', 'Automatic'],
          ['openai', 'OpenAI'],
          ['local', 'On this Mac'],
        ] as const
      ).map(([id, label]) => {
        const info = engines.find((e) => e.id === id);
        const disabled = id !== 'auto' && info && !info.ready;
        return h(
          'button',
          {
            class: 'mt-engine',
            type: 'button',
            role: 'radio',
            'aria-checked': String(v.setting === id),
            disabled: !!disabled,
            title: info?.detail,
            onclick: async () => (await ask('meetings:setEngine', id), void refresh()),
          },
          label,
        );
      }),
    );
    // The microphone: this Mac's own (default), the system's, or any one by name. Names come from the
    // recorder's hidden page (the panel can't read them), so the list fills in a moment after the card shows.
    const micSelect = h('select', {
      id: 'mt-mic',
      class: 'mt-mic',
      'aria-label': 'Microphone',
      onchange: async (e) => {
        const select = e.target as HTMLSelectElement;
        const value = select.value;
        if (value.startsWith('dev:')) await ask('meetings:setMic', 'device', { id: value.slice(4), label: select.selectedOptions[0]?.textContent ?? '' });
        else await ask('meetings:setMic', value);
        void refresh();
      },
    }) as HTMLSelectElement;
    const fillMics = (devices: Array<{ id: string; label: string }>) => {
      const saved = v.mic === 'device' ? v.micDevice : undefined;
      const rows: Array<[string, string]> = [
        ['builtin', 'This Mac’s microphone (recommended)'],
        ['default', 'System default'],
        ...devices.map((d): [string, string] => [`dev:${d.id}`, d.label]),
      ];
      if (saved && !devices.some((d) => d.id === saved.id)) rows.push([`dev:${saved.id}`, `${saved.label} (not connected)`]);
      micSelect.replaceChildren(...rows.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
      micSelect.value = saved ? `dev:${saved.id}` : v.mic === 'default' ? 'default' : 'builtin';
    };
    fillMics([]);
    void ask('meetings:devices').then((r) => {
      const list = (r as { devices?: Array<{ id: string; label: string }> }).devices;
      if (list?.length && micSelect.isConnected) fillMics(list);
    });
    const micChoice = h('div', { class: 'mt-miclabel' }, h('label', { for: 'mt-mic' }, 'Microphone'), customSelect(micSelect));
    // The spoken language. Automatic lets the engine guess for every 10-second chunk, which can slip into
    // another script on a short or noisy chunk; naming the language removes the guess.
    const languageSelect = h(
      'select',
      {
        id: 'mt-language',
        class: 'mt-mic mt-language',
        'aria-label': 'Language',
        title: 'Automatic detects the language of every few seconds on its own. Pick the language you speak in this meeting for steadier text.',
        onchange: async (e) => {
          await ask('meetings:setLanguage', (e.target as HTMLSelectElement).value);
          void refresh();
        },
      },
      ...[{ code: AUTO_LANGUAGE, name: 'Automatic' }, ...MEETING_LANGUAGES].map((l) => Object.assign(document.createElement('option'), { value: l.code, textContent: l.name })),
    ) as HTMLSelectElement;
    languageSelect.value = restoreLanguage(v.language);
    const languageChoice = h('div', { class: 'mt-miclabel' }, h('label', { for: 'mt-language' }, 'Language'), customSelect(languageSelect));
    return h(
      'section',
      { class: 'mt-card', 'aria-labelledby': 'mt-card-title' },
      h('h3', { id: 'mt-card-title', class: 'mt-card-title' }, ready ? 'Ready to record this meeting' : 'Take notes on this meeting'),
      ready ? readyLine(ready) : null,
      page ? h('p', { class: 'mt-tab' }, h('span', { class: 'mt-tab-label' }, 'Records the tab you are on: '), h('strong', {}, page.title), page.host ? h('span', { class: 'mt-tab-host' }, ` ${page.host}`) : null) : h('p', { class: 'sheet-hint' }, 'Open the meeting in a tab first.'),
      h('p', { class: 'sheet-hint' }, engineText()),
      h('p', { class: 'sheet-hint mt-consent' }, CONSENT_HINT),
      segmented,
      micChoice,
      languageChoice,
      startError ? h('p', { class: 'sheet-error', role: 'alert' }, startError.message) : null,
      startError?.code === 'mic-permission' ? h('button', { class: 'secondary-button wide', type: 'button', onclick: () => void ask('meetings:permission') }, icon('mic'), 'Allow the microphone…') : null,
      v.notice ? h('p', { class: 'mt-notice', role: 'status' }, v.notice, h('button', { class: 'text-button', type: 'button', onclick: () => void ask('meetings:dismiss') }, 'Dismiss')) : null,
      v.hostProblem && !startError ? h('p', { class: 'sheet-error', role: 'alert' }, v.hostProblem) : null,
      h(
        'button',
        {
          id: 'mt-primary',
          class: 'primary-button wide mt-start',
          type: 'button',
          disabled: starting || !page,
          onclick: async () => {
            starting = true;
            startError = undefined;
            paint();
            const reply = await ask('meetings:start');
            starting = false;
            if (reply.error) startError = { message: reply.error, code: reply.code };
            else ready = undefined;
            await refresh();
          },
        },
        h('span', { class: 'mt-rec-dot', 'aria-hidden': 'true' }),
        starting ? 'Starting…' : 'Start recording',
      ),
      ready ? h('button', { class: 'text-button mt-not-now', type: 'button', onclick: () => ((ready = undefined), paint()) }, 'Not now') : null,
    );
  }

  /** What the ready card is about: the calendar meeting (its title is someone else's text, so text only) or the tab's platform. */
  function readyLine(info: ReadyInfo) {
    const when = info.start ? new Date(info.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    return h(
      'p',
      { class: 'mt-ready' },
      h('span', { class: 'mt-platform' }, platformLabel(info.platform)),
      info.title ? h('strong', {}, info.title) : h('span', {}, `The tab you are on looks like a ${info.platform} meeting.`),
      when ? h('span', { class: 'mt-tab-host' }, ` ${when}`) : null,
    );
  }

  function meter(label: string, level: number, id: string) {
    const bar = h('span', { class: 'mt-meter-fill' });
    bar.style.setProperty('--level', String(Math.min(1, Math.sqrt(level) * 2.2)));
    return h('div', { class: 'mt-meter', 'aria-hidden': 'true' }, h('span', { class: 'mt-meter-label' }, label), h('span', { class: 'mt-meter-track', id }, bar));
  }

  function recordingCard(v: MeetingsView) {
    const stopping = v.phase === 'stopping';
    const waitingForTab = v.phase === 'recording' && !v.othersCaptured;
    return h(
      'section',
      { class: 'mt-card recording', 'aria-labelledby': 'mt-card-title' },
      h(
        'div',
        { class: 'mt-live-head' },
        h('span', { class: 'mt-rec-dot pulse', 'aria-hidden': 'true' }),
        h('h3', { id: 'mt-card-title', class: 'mt-card-title' }, stopping ? 'Finishing up…' : v.phase === 'starting' ? 'Starting…' : 'Recording'),
        h('span', { class: 'mt-time', id: 'mt-elapsed', 'aria-hidden': 'true' }, clock(elapsed())),
        h('span', { class: 'spacer' }),
        h('button', { id: 'mt-primary', class: 'danger-button', type: 'button', disabled: stopping, onclick: () => void ask('meetings:stop').then(() => refresh()) }, 'Stop'),
      ),
      h('p', { class: 'sheet-hint' }, `${v.othersCaptured ? `${v.othersHost || v.provider || 'The meeting tab'}: the microphone and the tab’s sound are` : `Your microphone${v.micLabel ? ` (${v.micLabel})` : ''} is`} being turned into text${v.engine ? ` by ${v.engine.where === 'cloud' ? 'OpenAI' : 'this Mac'}` : ''}. Nothing is kept except the text.`),
      h('div', { class: 'mt-meters' }, meter('Me', levels.me, 'mt-meter-me'), v.othersCaptured ? meter('Others', levels.others, 'mt-meter-others') : null),
      waitingForTab ? h('p', { class: 'mt-notice', id: 'mt-tab-hint', role: 'status' }, tabAudioHint(v)) : null,
      v.notice ? h('p', { class: 'mt-notice', role: 'status' }, v.notice) : null,
      v.failed ? h('p', { class: 'mt-notice', role: 'status' }, `${v.failed} piece${v.failed === 1 ? '' : 's'} of audio couldn’t be turned into text and were skipped.`) : null,
      h('div', { class: 'mt-live-wrap' }, liveList, toLatest, live.length ? null : h('p', { class: 'mt-live-empty' }, v.phase === 'recording' ? 'Words appear here a few seconds after they are spoken.' : '')),
    );
  }

  function pastMeetings() {
    return h(
      'section',
      { class: 'mt-past', 'aria-labelledby': 'mt-past-title' },
      h('h3', { id: 'mt-past-title', class: 'memory-title' }, 'Your meetings', h('span', { class: 'memory-count' }, String(list.length))),
      list.length
        ? h(
            'ul',
            { class: 'mt-list' },
            ...list.map((m) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { class: 'mt-row', type: 'button', onclick: () => void openMeeting(m.id) },
                  h('span', { class: 'mt-row-text' }, h('span', { class: 'mt-row-title' }, m.title), h('span', { class: 'mt-row-meta' }, [when(m.startedAt), formatDuration(m.durationMs), m.provider || m.host].filter(Boolean).join(' · '))),
                  m.hasSummary ? h('span', { class: 'mt-badge', title: 'Has notes' }, 'Notes') : null,
                  icon('chevron'),
                ),
              ),
            ),
          )
        : h('p', { class: 'memory-empty' }, 'No meetings yet. Press Start in a meeting to take notes: the transcript and a summary of decisions, action items and open questions are saved here.'),
      list.length
        ? confirmAll
          ? h(
              'div',
              { class: 'confirm', role: 'alertdialog', 'aria-label': 'Delete all meetings' },
              h('span', {}, `Delete all ${list.length} meetings and their notes?`),
              h('span', { class: 'spacer' }),
              h('button', { class: 'secondary-button', type: 'button', onclick: () => ((confirmAll = false), paint()) }, 'Keep'),
              h('button', { class: 'primary-button', type: 'button', onclick: async () => ((confirmAll = false), await ask('meetings:deleteAll'), void refresh()) }, 'Delete all'),
            )
          : h('button', { class: 'text-button danger', type: 'button', disabled: recording(), onclick: () => ((confirmAll = true), paint()) }, 'Delete all')
        : null,
      h('p', { class: 'sheet-hint' }, 'Transcripts are sensitive. They are stored only in this browser profile, are never logged, and go nowhere except your own OpenAI requests (or stay on this Mac). Deleting a meeting removes it for good.'),
    );
  }

  // ---- one meeting ------------------------------------------------------------------------------

  async function openMeeting(id: string) {
    screen = { kind: 'meeting', id };
    paint();
    const got = await invoke<{ record: MeetingRecord; suggestions: NameSuggestions } | undefined>('meetings:open', id).catch(() => undefined);
    if (screen.kind !== 'meeting' || screen.id !== id) return;
    if (!got) {
      screen = { kind: 'home' };
      void refresh();
      return;
    }
    screen = { kind: 'meeting', id, record: got.record, suggestions: got.suggestions };
    paint();
    $('meetings-back').focus();
  }

  async function reload(extra: Partial<Extract<Screen, { kind: 'meeting' }>> = {}) {
    if (screen.kind !== 'meeting') return;
    const id = screen.id;
    const got = await invoke<{ record: MeetingRecord; suggestions: NameSuggestions } | undefined>('meetings:open', id).catch(() => undefined);
    if (got && screen.kind === 'meeting' && screen.id === id) screen = { kind: 'meeting', id, record: got.record, suggestions: got.suggestions, ...extra };
    paint();
  }

  function meetingScreen(s: Extract<Screen, { kind: 'meeting' }>) {
    const r = s.record;
    if (!r) return h('p', { class: 'sheet-hint' }, 'Loading…');
    const summarizing = !!view?.summarizing.includes(r.id);
    const title = h('input', { id: 'meeting-title-input', class: 'field mt-title', type: 'text', value: r.title, maxlength: String(MAX_TITLE), 'aria-label': 'Meeting title', autocomplete: 'off' }) as HTMLInputElement;
    const saveTitle = async () => {
      const text = title.value.trim();
      if (!text || text === r.title) return void (title.value = r.title);
      const reply = await ask('meetings:rename', r.id, text);
      if (reply.error) return void (title.value = r.title);
      void reload();
      void refresh();
    };
    title.addEventListener('blur', () => void saveTitle());
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        title.blur();
      }
    });
    const meta = [when(r.startedAt), formatDuration(r.durationMs), r.provider || r.host, r.engine.startsWith('local') ? 'transcribed on this Mac' : 'transcribed by OpenAI'].filter(Boolean).join(' · ');

    const suggestions = s.suggestions ?? {};
    const suggestionRows = (['Others', 'Me'] as const).flatMap((label) => {
      const name = suggestions[label];
      const channel = label === 'Me' ? 'Me' : 'Others';
      // Only while every line of that channel still has its plain label: names read from the meeting page win.
      if (!name || !r.segments.filter((x) => x.channel === channel).every((x) => x.speaker === channel)) return [];
      return [
        h(
          'p',
          { class: 'mt-suggest' },
          h('span', {}, label === 'Me' ? `You introduced yourself as ${name}.` : `Someone on the call said they are ${name}.`),
          h('button', { class: 'text-button', type: 'button', onclick: async () => (await ask('meetings:speaker', r.id, label, name), void reload()) }, label === 'Me' ? `Label my lines “${name}”` : `Label “Others” lines “${name}”`),
        ),
      ];
    });

    const gapNote = r.gaps?.length ? h('p', { class: 'mt-notice' }, `${r.gaps.length} stretch${r.gaps.length === 1 ? '' : 'es'} of audio couldn’t be turned into text, and the audio isn’t kept (${r.gaps.map((g) => clock(g.start_ms)).slice(0, 4).join(', ')}${r.gaps.length > 4 ? '…' : ''}).`) : null;

    return h(
      'div',
      { class: 'mt-meeting' },
      title,
      h('p', { class: 'mt-meta' }, meta),
      r.endedBy && r.endedBy !== 'user' ? h('p', { class: 'mt-notice' }, { 'tab-closed': 'Recording ended because the meeting tab was closed.', limit: 'Recording ended at the time limit.', lost: 'Recording ended because Uranus Browser’s helper stopped.', error: 'Recording ended unexpectedly.', recovered: 'Uranus Browser closed while this was recording; what was captured is kept.' }[r.endedBy]) : null,
      r.othersCaptured === false ? h('p', { class: 'mt-notice' }, 'The meeting tab’s sound was not added, so only your microphone was recorded. Other people appear only if your speakers carried them to the microphone, and then as “Me”.') : null,
      h(
        'div',
        { class: 'mt-actions' },
        h('button', { class: 'secondary-button', type: 'button', onclick: async () => {
          await navigator.clipboard.writeText(meetingMarkdown(r)).catch(() => undefined);
          screen = { ...s, copied: true };
          paint();
          setTimeout(() => {
            if (screen.kind === 'meeting' && screen.id === r.id && screen.copied) {
              screen = { ...screen, copied: false };
              paint();
            }
          }, 2000);
        } }, icon('copy'), s.copied ? 'Copied' : 'Copy as Markdown'),
        h('button', { class: 'secondary-button', type: 'button', onclick: () => {
          if (hooks.busy()) return void (screen = { ...s, message: 'The agent is working. Wait for it to finish, or stop it, first.' }, paint());
          if (hooks.discuss(discussMessage(r))) close(false);
        } }, icon('agent'), 'Discuss in chat'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'text-button danger', type: 'button', onclick: () => ((screen = { ...s, confirm: 'delete' }), paint()) }, icon('trash'), 'Delete'),
      ),
      s.message ? h('p', { class: 'sheet-error', role: 'alert' }, s.message) : null,
      ...suggestionRows,
      summarySection(r, summarizing),
      gapNote,
      h(
        'section',
        { class: 'mt-transcript', 'aria-labelledby': 'mt-transcript-title' },
        h('h3', { id: 'mt-transcript-title', class: 'memory-title' }, 'Transcript'),
        r.segments.length
          ? h('ol', { class: 'mt-lines' }, ...shownTranscript(r.segments).map(liveLine))
          : h('p', { class: 'memory-empty' }, 'Nothing was transcribed.'),
      ),
      s.confirm === 'delete'
        ? h(
            'div',
            { class: 'confirm', role: 'alertdialog', 'aria-label': 'Delete this meeting' },
            h('span', {}, 'Delete this meeting, its notes and transcript?'),
            h('span', { class: 'spacer' }),
            h('button', { class: 'secondary-button', type: 'button', onclick: () => ((screen = { ...s, confirm: undefined }), paint()) }, 'Keep'),
            h('button', { class: 'primary-button', type: 'button', onclick: async () => {
              await ask('meetings:delete', r.id);
              screen = { kind: 'home' };
              await refresh();
            } }, 'Delete'),
          )
        : null,
    );
  }

  function summarySection(r: MeetingRecord, summarizing: boolean) {
    const busy = summarizing;
    const again = (mode: 'model' | 'digest' | 'underdog', label: string, primary = false) =>
      h('button', { class: primary ? 'secondary-button' : 'text-button', type: 'button', disabled: busy || !r.segments.length, onclick: async () => {
        const reply = await ask('meetings:summarize', r.id, mode);
        await reload(reply.error ? { message: reply.error } : {});
      } }, label);
    // The on-device model is only offered, never the default: OpenAI writes the notes unless this is clicked.
    const onDevice = view?.underdog?.ready ? again('underdog', 'Write on this Mac (Underdog, nothing leaves it)') : null;
    if (busy) return h('section', { class: 'mt-summary' }, h('p', { class: 'mt-working' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Writing the notes…'));
    if (!r.summary) {
      return h(
        'section',
        { class: 'mt-summary' },
        r.summaryError ? h('p', { class: 'sheet-error', role: 'alert' }, `The notes couldn’t be written: ${r.summaryError}`) : h('p', { class: 'sheet-hint' }, 'No notes yet.'),
        h('div', { class: 'mt-actions' }, again('model', 'Write notes with OpenAI', true), again('digest', 'Quick digest (nothing leaves this Mac)'), onDevice),
      );
    }
    const summary = r.summary;
    return h(
      'section',
      { class: 'mt-summary' },
      ...SUMMARY_SECTIONS.map((section) =>
        h(
          'div',
          { class: 'mt-section' },
          h('h3', { class: 'mt-section-title' }, SUMMARY_HEADINGS[section]),
          summary.items[section].length
            ? h('ul', { class: 'mt-items' }, ...summary.items[section].map((i) => h('li', { class: 'mt-item' }, h('span', { class: 'mt-at' }, clock(i.t)), h('span', { class: 'mt-item-body' }, h('span', { class: 'mt-who' }, i.speaker), h('span', { class: 'mt-quote' }, i.text)))))
            : h('p', { class: 'mt-none' }, summary.method === 'extractive' ? 'None identified' : 'None stated'),
        ),
      ),
      h('p', { class: 'sheet-hint' }, summary.method === 'extractive' ? 'A quick digest: only lines that say it outright (“we decided…”, “I will…”, a question nobody answered). Nothing was sent anywhere.' : 'Each line above is quoted from the transcript; the model only chose which lines to show.'),
      summary.warning ? h('p', { class: 'mt-notice' }, summary.warning) : null,
      h('div', { class: 'mt-actions' }, summary.method === 'extractive' ? again('model', 'Write notes with OpenAI', true) : again('digest', 'Quick digest instead'), summary.method === 'model' ? again('model', 'Write again') : null, onDevice),
    );
  }

  // ---- closing the panel while recording ---------------------------------------------------------

  /** The panel is about to close. While a recording runs, ask first. Returns whether it asked (so the caller waits). */
  function beforeClose(): boolean {
    if (!recording() || confirmClose) return false;
    confirmClose = true;
    paintChrome();
    bar.classList.add('asking');
    $('rec-bar-ask').hidden = false;
    $<HTMLButtonElement>('rec-bar-keep').focus();
    return true;
  }

  function cancelAsk() {
    confirmClose = false;
    bar.classList.remove('asking');
    $('rec-bar-ask').hidden = true;
    paintChrome();
  }

  // ---- wiring ----------------------------------------------------------------------------------

  // The sheets open below the recording bar, not over it, so Stop and the close question stay in reach.
  new ResizeObserver(() => $('panel').style.setProperty('--bar-h', bar.hidden ? '0px' : `${bar.offsetHeight + 8}px`)).observe(bar);
  new MutationObserver(() => $('panel').style.setProperty('--bar-h', bar.hidden ? '0px' : `${bar.offsetHeight + 8}px`)).observe(bar, { attributes: true, attributeFilter: ['hidden'] });

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  $('meetings-close').addEventListener('click', () => close());
  $('meetings-back').addEventListener('click', () => {
    if (screen.kind === 'calendar') calendar.leaveSettings();
    screen = { kind: 'home' };
    paint();
    void refresh();
  });
  $('rec-bar-stop').addEventListener('click', () => void ask('meetings:stop').then(() => refresh()));
  $('rec-bar-open').addEventListener('click', () => (isOpen() ? ($('mt-primary') ?? $('meetings-close')).focus() : open()));
  $('rec-bar-keep').addEventListener('click', () => {
    cancelAsk();
    hooks.closePanel();
  });
  $('rec-bar-stop-close').addEventListener('click', () => {
    cancelAsk();
    void ask('meetings:stop').then(() => hooks.closePanel());
  });
  $('rec-bar-cancel').addEventListener('click', () => {
    cancelAsk();
    toggle.focus();
  });
  document.addEventListener('sheet:open', (e) => {
    if ((e as CustomEvent).detail !== 'meetings') close(false);
  });

  on('meetings:state', (next: MeetingsView) => {
    const was = view?.phase;
    view = next;
    if (next.phase !== 'idle') {
      starting = false;
      ready = undefined;
    }
    if (was !== 'recording' && next.phase === 'recording') {
      live = [];
      rebuildLive();
      follow = true;
    }
    if (next.phase === 'idle' && recording() === false && confirmClose) cancelAsk();
    paintChrome();
    paint();
  });
  on('meetings:list', (next: MeetingMeta[]) => {
    list = next;
    paint();
  });
  on('meetings:segment', (segment: StoredSegment) => {
    live.push(segment);
    liveList.append(liveLine(segment));
    if (follow) liveList.scrollTop = liveList.scrollHeight;
    else toLatest.hidden = false;
    // The first line replaces the “words appear here” hint.
    if (live.length === 1) paint();
  });
  on('meetings:levels', (next: typeof levels) => {
    levels = next;
    for (const [id, level] of [['mt-meter-me', next.me], ['mt-meter-others', next.others]] as const) {
      (document.getElementById(id)?.firstElementChild as HTMLElement | null)?.style.setProperty('--level', String(Math.min(1, Math.sqrt(level) * 2.2)));
    }
  });
  void refresh();

  return {
    isOpen,
    recording,
    beforeClose,
    /** Opens the sheet on its Calendar screen (the routines form's "Connect a calendar"). */
    openCalendar: () => {
      if (!isOpen()) open();
      screen = { kind: 'calendar' };
      paint();
      $('meetings-back').focus();
    },
    /** Escape closes a confirmation, then the sheet, before the panel. Returns whether it did. */
    escape() {
      if (confirmClose) {
        cancelAsk();
        return true;
      }
      if (!isOpen()) return false;
      if (screen.kind !== 'home') {
        if (screen.kind === 'calendar') calendar.leaveSettings();
        screen = { kind: 'home' };
        paint();
        void refresh();
      } else close();
      return true;
    },
    /** The current tab changed: the Start card names it. */
    repaint: () => {
      if (isOpen() && screen.kind === 'home' && view?.phase === 'idle') paint();
    },
  };
}
