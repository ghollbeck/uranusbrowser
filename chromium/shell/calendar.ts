/**
 * Calendar reminders for meeting notes, from the background: read the user's calendar from its
 * private iCal address, and from a couple of minutes before a meeting that has a Google Meet, Zoom
 * or Teams link until it ends, say so: once as a macOS notification, and for the whole meeting as
 * a reminder card at the side of every Uranus Browser window (meetingReminder.ts) and a floating
 * panel on the display the pointer is on (the native host's reminderPopup.ts), each with Join,
 * Join & record, Record + AI assistant (when joinly is on) and Dismiss. The Agent panel's
 * Meetings sheet (ui/meetingsCalendar.ts) shows the address's settings, today's next meetings
 * and a strip for one about to start; every call here is a `calendar:` hub handler.
 *
 * What it promises:
 *  - Nothing records on its own. "Open & record" opens the meeting in a new tab, opens the
 *    Agent panel and shows the Meetings sheet's "ready to record" card; the user's click on
 *    Start recording there is what starts it. (Chromium only lets the shell capture a tab after a
 *    gesture on its own UI, and the recorder starts from a click in the panel anyway.)
 *  - The address is a secret. It is kept under its own key, fetched with no cookies, never
 *    logged, never sent to a page (the panel gets `host…`), and never reaches the model. Neither
 *    does any event text: titles are kept, cleaned and clipped, for the panel and notifications,
 *    which draw them as plain text; descriptions are only searched for a meeting link.
 *  - One notification per occurrence (UID + start); the card and the panel stay until the meeting
 *    ends or it is answered. A dismissal or a join, from any of them, is remembered for that
 *    occurrence (the notification never asks twice), but for the card and the panel only until
 *    Uranus Browser quits (chrome.storage.session): reopened, it shows a meeting still going on
 *    again, answered or not. A meeting already going on (Uranus Browser just started, or the
 *    calendar was just read) is shown at once.
 *  - The calendar is read when the background starts (if the last read is over a few minutes
 *    old), every 10 minutes by `chrome.alarms`, and when the user asks. A one-shot alarm wakes the
 *    background for the next prompt, since a service worker's timers don't survive it sleeping.
 */
import { broadcast, handle } from './hub';
import {
  MAX_ICS_CHARS,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  checkCalendarUrl,
  dueForPrompt,
  expandEvents,
  inPromptWindow,
  maskCalendarUrl,
  liveMeetingTab,
  meetingLinkOf,
  meetingsFrom,
  nextPromptAt,
  parseCalendar,
  reminderMeeting,
  startsIn,
  type CalendarMeeting,
  type ReminderAction as PopupAction,
  type ReminderSpec,
} from '../shared/calendar';
import * as store from './lib/calendarState';

export interface CalendarContext {
  /** Opens an address in a new Uranus Browser tab, in front, and brings its window forward. */
  openPage(url: string): void;
  /** Opens the Agent panel if it is closed. */
  openPanel(): Promise<void>;
  /** The meetings changed (read again, connected, removed): routines with a meeting trigger follow them. */
  onMeetings?(snapshot: CalendarSnapshot): void;
  /** Whether the user has switched on the AI assistant (joinly) joining meetings: the reminder then offers it. */
  assistantAvailable?(): Promise<boolean>;
  /** Starts meeting notes on the meeting's tab once it is in front (shell/meetings.ts). */
  startRecording?(host: string): Promise<{ error?: string }>;
  /** Stops the recording (the "Recording" notification's Stop). */
  stopRecording?(): void;
  /** Sends the AI assistant (joinly) into the meeting (shell/joinly.ts). */
  sendAssistant?(meetingUrl: string): Promise<{ error?: string }>;
  /** The floating panel on the pointer's display (nativeHost.ts): this meeting, or none. */
  showReminder?(spec: ReminderSpec | undefined): void;
}

/** The reminder card the windows show (meetingReminder.ts): the meeting going on or about to start. */
export interface ReminderView {
  meeting?: CalendarMeeting;
  /** Whether "Record + AI assistant" is offered. */
  assistant: boolean;
}

/** What a click on the reminder asks for: just the meeting, the meeting and its notes, or both plus the AI assistant. */
export type ReminderAction = 'body' | 0 | 1;

/** What routines see of the calendar: whether one is connected, and its meetings (titles are untrusted). */
export interface CalendarSnapshot {
  connected: boolean;
  meetings: Array<{ id: string; title: string; start: number; end: number; platform: string }>;
}

/** What the panel draws. Never the address itself. */
export interface CalendarView {
  connected: boolean;
  /** The saved address, masked: its host and an ellipsis. */
  shown?: string;
  offerTabs: boolean;
  checking: boolean;
  checkedAt?: number;
  events?: number;
  error?: string;
  /** Meetings with a link from an hour ago to a day and a half ahead. */
  meetings: CalendarMeeting[];
  /** Occurrence and meeting-tab ids the user dismissed. */
  dismissed: string[];
  /** A meeting just opened from a notification or the panel: the sheet shows its ready card. */
  focus?: ReadyFocus;
}

export interface ReadyFocus {
  /** Changes every time, so a panel handles each one once. */
  nonce: string;
  at: number;
  meeting: CalendarMeeting;
}

export interface CalendarApi {
  /** For routines (shell/routines.ts), once the saved calendar is loaded. */
  snapshot(): Promise<CalendarSnapshot>;
  onAlarm(name: string): Promise<void>;
  onNotification(notificationId: string, action: ReminderAction): Promise<void>;
  /** A click on the floating panel (nativeHost.ts relays it); the windows' card uses `calendar:reminderAction`. */
  onReminder(id: string, action: PopupAction): Promise<void>;
}

const REFRESH_ALARM = 'calendar-refresh';
const PROMPT_ALARM = 'calendar-prompt';
const REFRESH_MINUTES = 10;
/** On start, a read younger than this is used as it is. */
const FRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/** A ready card is offered to a panel that opens within this long of the click. */
const FOCUS_MS = 60_000;
const NOTE_PREFIX = 'anus-calendar:';
/** chrome.storage.session: the meetings answered on the reminder card or panel this run. */
const ANSWERED_KEY = 'calendar:answered';

const noteId = (id: string) => `${NOTE_PREFIX}${id}`;
/** A reminder whose second button sends the AI assistant (the ids say which buttons it has). */
const ASSISTANT_SUFFIX = '+assistant';
/** The "Recording …" notification (one at a time), with its Stop button. */
const RECORDING_NOTE = `${NOTE_PREFIX}recording`;
/** A meeting's reminder, whichever buttons it was made with. */
const isNoteFor = (noteName: string, meetingId: string) => noteName === noteId(meetingId) || noteName === noteId(meetingId) + ASSISTANT_SUFFIX;
function clearNotesFor(meetingId: string) {
  chrome.notifications?.clear(noteId(meetingId));
  chrome.notifications?.clear(noteId(meetingId) + ASSISTANT_SUFFIX);
}
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Reads a calendar file. The reason it failed is plain language and never names the address. */
async function fetchCalendar(url: string): Promise<{ text: string } | { error: string }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { error: (err as Error)?.name === 'TimeoutError' ? 'The calendar didn’t answer in time. It will be tried again in a few minutes.' : 'Couldn’t reach the calendar. Check your connection; it will be tried again in a few minutes.' };
  }
  if (res.url && !res.url.startsWith('https:')) return { error: 'The calendar address sent Uranus Browser to an address that isn’t https, so it wasn’t read.' };
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
    return { error: `The calendar address was refused (${res.status}). It may have been reset: copy the secret iCal address again.` };
  }
  if (!res.ok) return { error: `The calendar’s server had a problem (${res.status}). It will be tried again in a few minutes.` };
  if (Number(res.headers.get('content-length') ?? 0) > MAX_ICS_CHARS) return { error: 'That calendar is too large to read.' };
  const text = await res.text().catch(() => '');
  if (text.length > MAX_ICS_CHARS) return { error: 'That calendar is too large to read.' };
  if (!/^\s*BEGIN:VCALENDAR/i.test(text.slice(0, 1000))) return { error: 'That address didn’t return a calendar. Use the secret address in iCal format (it ends in .ics).' };
  return { text };
}

/** The meetings in a calendar file that matter now. */
function meetingsIn(text: string, now: number) {
  const parsed = parseCalendar(text);
  const meetings = meetingsFrom(expandEvents(parsed.events, now - WINDOW_BEFORE_MS, now + WINDOW_AFTER_MS));
  return { events: parsed.events.length, meetings };
}

export function registerCalendar(ctx: CalendarContext): CalendarApi {
  const storage = chrome.storage.local;
  let url: string | undefined;
  let settings = store.DEFAULT_SETTINGS;
  let cache: store.CalendarCache = store.EMPTY_CACHE;
  let marks: store.CalendarMarks = store.EMPTY_MARKS;
  let checking: Promise<{ error?: string }> | undefined;
  let focus: ReadyFocus | undefined;
  let reminder: ReminderView = { assistant: false };
  /** Meetings answered on the card or the panel since Uranus Browser started (they come back after a restart). */
  let answered = new Set<string>();

  const ready = (async () => {
    const got = await storage.get([store.URL_KEY, store.SETTINGS_KEY, store.CACHE_KEY, store.MARKS_KEY]);
    const saved = checkCalendarUrl(got[store.URL_KEY]);
    url = saved.ok ? saved.url : undefined;
    settings = store.restoreSettings(got[store.SETTINGS_KEY]);
    cache = url ? store.restoreCache(got[store.CACHE_KEY]) : store.EMPTY_CACHE;
    marks = store.restoreMarks(got[store.MARKS_KEY], Date.now());
    // Kept across the background's naps, cleared when the browser quits.
    const session = await chrome.storage.session?.get(ANSWERED_KEY).catch(() => ({}));
    const ids = (session as Record<string, unknown> | undefined)?.[ANSWERED_KEY];
    if (Array.isArray(ids)) answered = new Set(ids.filter((id): id is string => typeof id === 'string' && store.ID.test(id)));
  })();

  async function answer(id: string) {
    answered.add(id);
    await chrome.storage.session?.set({ [ANSWERED_KEY]: [...answered].slice(-200) }).catch(() => undefined);
  }

  void ready.then(async () => {
    // Routines with a meeting trigger learn the saved meetings now, before any read.
    sendView();
    await syncRefreshAlarm();
    if (url && Date.now() - (cache.checkedAt ?? 0) > FRESH_MS) await refresh();
    else await promptDue();
  });

  // ---- the view ---------------------------------------------------------------------------

  function view(): CalendarView {
    return {
      connected: !!url,
      shown: url ? maskCalendarUrl(url) : undefined,
      offerTabs: settings.offerTabs,
      checking: !!checking,
      checkedAt: cache.checkedAt,
      events: cache.events,
      error: cache.error,
      meetings: cache.meetings,
      dismissed: Object.keys(marks.dismissed),
      focus: focus && Date.now() - focus.at < FOCUS_MS ? focus : undefined,
    };
  }
  const snapshot = (): CalendarSnapshot => ({
    connected: !!url,
    meetings: url ? cache.meetings.map(({ id, title, start, end, platform }) => ({ id, title, start, end, platform })) : [],
  });
  // Only a real change reaches routines: the view is sent far more often than meetings change.
  let lastSnapshot = '';
  const sendView = () => {
    broadcast('calendar', view());
    const next = snapshot();
    const key = JSON.stringify(next);
    if (key !== lastSnapshot) {
      lastSnapshot = key;
      ctx.onMeetings?.(next);
    }
  };

  const handled = (id: string) => id in marks.dismissed || id in marks.prompted;

  async function saveMarks() {
    await storage.set({ [store.MARKS_KEY]: marks }).catch(() => undefined);
  }

  // ---- reading the calendar ---------------------------------------------------------------------

  function refresh(): Promise<{ error?: string }> {
    checking ??= (async () => {
      // After `checking` is set, so the panel sees "Checking…".
      await Promise.resolve();
      sendView();
      try {
        if (!url) return { error: 'No calendar is connected.' };
        const address = url;
        const got = await fetchCalendar(address);
        // Removed or replaced while it was being read: that result is for an address no longer saved.
        if (url !== address) return {};
        const now = Date.now();
        if ('error' in got) {
          // Keep the meetings already known: a flaky network shouldn't make reminders vanish.
          cache = { ...cache, error: got.error, checkedAt: cache.checkedAt };
          console.warn('Uranus Browser calendar: the calendar couldn’t be read');
        } else {
          const { events, meetings } = meetingsIn(got.text, now);
          cache = { checkedAt: now, events, meetings };
        }
        await storage.set({ [store.CACHE_KEY]: cache });
        return cache.error ? { error: cache.error } : {};
      } finally {
        checking = undefined;
        sendView();
        await promptDue();
      }
    })();
    return checking;
  }

  async function syncRefreshAlarm() {
    const alarm = await chrome.alarms.get(REFRESH_ALARM);
    if (url && !alarm) await chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
    if (!url && alarm) await chrome.alarms.clear(REFRESH_ALARM);
  }

  // ---- prompting ---------------------------------------------------------------------------------

  /** Shows what is due, clears notifications that are over, and sets the alarm for the next one. */
  async function promptDue() {
    const now = Date.now();
    marks = store.restoreMarks(marks, now);
    const due = dueForPrompt(cache.meetings, now, handled);
    for (const m of due) marks = store.mark(marks, 'prompted', m.id, m.start + store.MARK_AFTER_MS, now);
    await saveMarks();
    if (due.length) {
      const assistant = await (ctx.assistantAvailable?.() ?? Promise.resolve(false)).catch(() => false);
      for (const m of due) notify(m, now, assistant);
    }
    // A notification nobody answered goes once its meeting is over.
    const live = cache.meetings.filter((m) => inPromptWindow(m, now) && !(m.id in marks.dismissed));
    chrome.notifications?.getAll?.((all) => {
      for (const id of Object.keys(all ?? {})) {
        if (id.startsWith(NOTE_PREFIX) && id !== RECORDING_NOTE && !live.some((m) => isNoteFor(id, m.id))) chrome.notifications.clear(id);
      }
    });
    // Woken again when the next meeting's window opens or the one on screen ends.
    const next = url ? nextPromptAt(cache.meetings, now, handled, (id) => !answered.has(id)) : undefined;
    if (next === undefined) await chrome.alarms.clear(PROMPT_ALARM);
    else await chrome.alarms.create(PROMPT_ALARM, { when: Math.max(next, now + 1000) });
    await syncReminder(now);
  }

  /** The card in the windows and the panel on the pointer's display: the meeting due now, or none. */
  async function syncReminder(now = Date.now()) {
    const m = url ? reminderMeeting(cache.meetings, now, (id) => answered.has(id)) : undefined;
    const assistant = m ? await (ctx.assistantAvailable?.() ?? Promise.resolve(false)).catch(() => false) : false;
    const next: ReminderView = { meeting: m, assistant };
    if (JSON.stringify(next) !== JSON.stringify(reminder)) {
      reminder = next;
      broadcast('calendar:reminder', reminder);
    }
    ctx.showReminder?.(m && { id: m.id, title: m.title, platform: m.platform, start: m.start, end: m.end, assistant });
  }

  /** What a click on the card or the panel asks for. */
  async function answerReminder(id: string, action: PopupAction) {
    await ready;
    if (action === 'dismiss') await dismiss(id);
    else await openAndRecord(id, action !== 'join', action === 'assistant');
  }

  /**
   * The reminder, as a macOS notification. A click on it opens the meeting (you join yourself);
   * "Join & record" opens it and starts the notes; "Record + AI assistant" (only when the user
   * has switched joinly on) also sends the assistant in. The click is the go-ahead: nothing
   * happens until one.
   */
  function notify(m: CalendarMeeting, now: number, assistant: boolean) {
    if (!chrome.notifications?.create) return;
    const title = clip(m.title, 60);
    chrome.notifications.create(
      noteId(m.id) + (assistant ? ASSISTANT_SUFFIX : ''),
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon128.png'),
        title: `${title} ${startsIn(m.start, now)}`,
        message: `${m.platform} at ${time(m.start)}. Click to join. If you record, tell the others.`,
        buttons: assistant ? [{ title: 'Join & record' }, { title: 'Record + AI assistant' }] : [{ title: 'Join & record' }, { title: 'Dismiss' }],
        requireInteraction: true,
        priority: 2,
      },
      () => void chrome.runtime.lastError,
    );
  }

  /** A short notification of its own: "Recording …" (with Stop), or why something didn't happen. */
  function tell(title: string, message: string, stop = false) {
    if (!chrome.notifications?.create) return;
    chrome.notifications.create(
      stop ? RECORDING_NOTE : `${NOTE_PREFIX}info-${Date.now()}`,
      { type: 'basic', iconUrl: chrome.runtime.getURL('icon128.png'), title, message, ...(stop ? { buttons: [{ title: 'Stop recording' }] } : {}), priority: stop ? 1 : 0 },
      () => void chrome.runtime.lastError,
    );
  }

  async function dismiss(id: string) {
    const now = Date.now();
    const m = cache.meetings.find((x) => x.id === id);
    const until = m ? m.start + store.MARK_AFTER_MS : id.startsWith('tab-') ? now + store.TAB_MARK_MS : now + store.MARK_AFTER_MS;
    marks = store.mark(marks, 'dismissed', id, until, now);
    await saveMarks();
    if (id.startsWith('ev-')) {
      clearNotesFor(id);
      await answer(id);
    }
    sendView();
    await promptDue();
  }

  /** Opens the meeting in a new tab and the panel on the ready card. Never starts recording. */
  /**
   * Opens a meeting. `record`: and starts its notes as soon as its tab is in front (falling back
   * to the panel's ready card if it can't); `assistant`: and sends the AI assistant in too.
   */
  async function openAndRecord(id: string, record: boolean, assistant = false): Promise<{ ok: true } | { error: string }> {
    await ready;
    const m = cache.meetings.find((x) => x.id === id);
    if (!m) return { error: 'That meeting is no longer in your calendar.' };
    const link = meetingLinkOf(m.url);
    if (!link) return { error: 'That meeting’s link isn’t one Uranus Browser opens.' };
    ctx.openPage(link.url);
    // Opened: no more prompts or strips for it, nor (when it is to be recorded) "Record notes?" for its tab.
    const now = Date.now();
    marks = store.mark(marks, 'dismissed', m.id, m.start + store.MARK_AFTER_MS, now);
    await answer(m.id);
    const tab = record ? liveMeetingTab(link.url) : undefined;
    if (tab) marks = store.mark(marks, 'dismissed', store.tabId(tab.key), now + store.TAB_MARK_MS, now);
    await saveMarks();
    clearNotesFor(m.id);
    if (assistant && ctx.sendAssistant) {
      const sent = await ctx.sendAssistant(link.url).catch((err) => ({ error: err instanceof Error ? err.message : 'It couldn’t be sent.' }));
      if (sent.error) tell(`The AI assistant didn’t join ${clip(m.title, 40)}`, sent.error);
    }
    if (record) {
      await ctx.openPanel().catch(() => undefined);
      const started = ctx.startRecording ? await ctx.startRecording(new URL(link.url).hostname).catch((err) => ({ error: err instanceof Error ? err.message : 'It couldn’t start.' })) : { error: 'unavailable' };
      if (started.error) {
        // Couldn't start by itself (no microphone yet, say): the panel's ready card asks instead.
        focus = { nonce: crypto.randomUUID(), at: Date.now(), meeting: m };
        broadcast('calendar:focus', focus);
      } else {
        tell(`Recording ${clip(m.title, 50)}`, 'Tell the others you’re recording. To add their voices, click the meeting tab and press ⇧⌘Y.', true);
      }
    }
    sendView();
    await syncReminder();
    return { ok: true };
  }

  // ---- the panel's requests ------------------------------------------------------------------------

  handle({
    'calendar:get': async () => {
      await ready;
      return view();
    },
    /** Reads an address (the one typed, or the saved one) without saving it; says what it found. */
    'calendar:test': async (raw?: string) => {
      await ready;
      let address = url;
      if (typeof raw === 'string' && raw.trim()) {
        const checked = checkCalendarUrl(raw);
        if (!checked.ok) return { error: checked.reason };
        address = checked.url;
      }
      if (!address) return { error: 'Paste your calendar’s private iCal address first.' };
      const got = await fetchCalendar(address);
      if ('error' in got) return { error: got.error };
      const { events, meetings } = meetingsIn(got.text, Date.now());
      return { ok: true, events, meetings: meetings.length };
    },
    /** Saves an address once it has been read successfully, and reads it. */
    'calendar:save': async (raw: string) => {
      await ready;
      const checked = checkCalendarUrl(raw);
      if (!checked.ok) return { error: checked.reason };
      const got = await fetchCalendar(checked.url);
      if ('error' in got) return { error: got.error };
      url = checked.url;
      const now = Date.now();
      const { events, meetings } = meetingsIn(got.text, now);
      cache = { checkedAt: now, events, meetings };
      await storage.set({ [store.URL_KEY]: url, [store.CACHE_KEY]: cache });
      await syncRefreshAlarm();
      sendView();
      await promptDue();
      return { ok: true, events, meetings: meetings.length };
    },
    'calendar:remove': async () => {
      await ready;
      url = undefined;
      cache = store.EMPTY_CACHE;
      focus = undefined;
      await storage.remove([store.URL_KEY, store.CACHE_KEY]);
      await syncRefreshAlarm();
      await chrome.alarms.clear(PROMPT_ALARM);
      chrome.notifications?.getAll?.((all) => {
        for (const id of Object.keys(all ?? {})) if (id.startsWith(NOTE_PREFIX)) chrome.notifications.clear(id);
      });
      sendView();
      await syncReminder();
      return { ok: true };
    },
    'calendar:refresh': async () => {
      await ready;
      return refresh();
    },
    'calendar:setOfferTabs': async (on: boolean) => {
      await ready;
      settings = { ...settings, offerTabs: on === true };
      await storage.set({ [store.SETTINGS_KEY]: settings });
      sendView();
      return { ok: true };
    },
    /** "Dismiss" or "Not now", for a calendar occurrence (`ev-…`) or a meeting tab (`tab-…`). */
    'calendar:dismiss': async (id: string) => {
      await ready;
      if (typeof id !== 'string' || !store.ID.test(id)) return { error: 'Nothing to dismiss.' };
      await dismiss(id);
      return { ok: true };
    },
    /** "Open & record": the meeting in a new tab, the panel on the ready card. */
    'calendar:openRecord': (id: string) => openAndRecord(String(id), true),
    /** "Join": just the meeting, in a new tab. */
    'calendar:join': (id: string) => openAndRecord(String(id), false),
    /** The reminder card's state, for a window that just opened. */
    'calendar:reminder': async () => {
      await ready;
      return reminder;
    },
    /** A click on the reminder card: join, record, assistant or dismiss. */
    'calendar:reminderAction': async (id: string, action: string) => {
      if (typeof id !== 'string' || !store.ID.test(id) || !['join', 'record', 'assistant', 'dismiss'].includes(action)) return { error: 'Nothing to do.' };
      await answerReminder(id, action as PopupAction);
      return { ok: true };
    },
  });

  return {
    snapshot: async () => {
      await ready;
      return snapshot();
    },
    onAlarm: async (name) => {
      if (name !== REFRESH_ALARM && name !== PROMPT_ALARM) return;
      await ready;
      if (name === REFRESH_ALARM) await refresh();
      else await promptDue();
    },
    onReminder: (id, action) => answerReminder(id, action),
    onNotification: async (notificationId, action) => {
      if (!notificationId.startsWith(NOTE_PREFIX)) return;
      await ready;
      if (notificationId === RECORDING_NOTE) {
        if (action === 0) ctx.stopRecording?.();
        chrome.notifications?.clear(RECORDING_NOTE);
        return;
      }
      if (notificationId.startsWith(`${NOTE_PREFIX}info-`)) return void chrome.notifications?.clear(notificationId);
      const withAssistant = notificationId.endsWith(ASSISTANT_SUFFIX);
      const id = notificationId.slice(NOTE_PREFIX.length, withAssistant ? -ASSISTANT_SUFFIX.length : undefined);
      if (action === 'body') await openAndRecord(id, false);
      else if (action === 0) await openAndRecord(id, true);
      else if (withAssistant) await openAndRecord(id, true, true);
      else await dismiss(id);
    },
  };
}

/**
 * The listeners that can wake the background (the alarms and the notification's buttons). They
 * go on in the first turn, as Chromium requires, and wait for the calendar to be registered;
 * private windows have none (`calendar` resolves to undefined).
 */
export function listenCalendar(calendar: Promise<CalendarApi | undefined>) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith('calendar-')) void calendar.then((c) => c?.onAlarm(alarm.name));
  });
  if (!chrome.notifications) return;
  chrome.notifications.onClicked.addListener((id) => {
    if (id.startsWith(NOTE_PREFIX)) void calendar.then((c) => c?.onNotification(id, 'body'));
  });
  chrome.notifications.onButtonClicked.addListener((id, button) => {
    if (id.startsWith(NOTE_PREFIX)) void calendar.then((c) => c?.onNotification(id, button === 0 ? 0 : 1));
  });
}
