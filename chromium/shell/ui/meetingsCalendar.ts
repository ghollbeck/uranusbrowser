/**
 * Calendar reminders in the Agent panel, for meeting notes: the Meetings sheet's "Upcoming"
 * card (today's next three meetings with a link), its Calendar screen (the private iCal address,
 * Test / Save / Remove, and "Offer to record meetings"), and the compact strip above the
 * conversation that says a meeting is about to start, or that the tab you are on looks like one.
 * The background (shell/calendar.ts) reads the calendar and sends the notifications; the sheet
 * (ui/meetingsSheet.ts) owns this module and shows its "ready to record" card.
 *
 * Nothing here records. Every path ends on the sheet's card, where the user's own click on Start
 * recording does it, on the tab in front.
 *
 * The address is typed here and handed straight to the background, which keeps it; the panel
 * only ever gets it back masked (host + "…"), and the field is emptied once it is saved. Event
 * titles come from other people's invitations, so they are drawn as DOM text only, already
 * clipped, and never go into the conversation. Nothing is added to web pages: whether a tab is
 * a meeting is read from its address alone.
 */
import { liveMeetingTab, meetingsToday, startingSoon, startsIn, type CalendarMeeting } from '../../shared/calendar';
import type { MeetingPlatform } from '../../shared/joinly';
import type { UiState } from '../../shared/types';
import type { CalendarView, ReadyFocus } from '../calendar';
import { tabId } from '../lib/calendarState';
import { invoke, on } from '../client';
import { ICONS, type IconName } from './icons';

type Child = Node | string | null | undefined | false;
type Reply = { error?: string; ok?: boolean; events?: number; meetings?: number };

/** What the sheet's "ready to record" card says. A calendar meeting has a title and time; a tab, its platform. */
export interface ReadyInfo {
  source: 'calendar' | 'tab';
  platform: MeetingPlatform;
  title?: string;
  start?: number;
}

export interface CalendarHooks {
  /** Whether a recording is starting, running or finishing. */
  recording(): boolean;
  /** Whether the Meetings sheet is open. */
  sheetOpen(): boolean;
  /** Opens the Meetings sheet on its "ready to record" card. */
  ready(info: ReadyInfo): void;
  /** Opens the Meetings sheet on the Calendar screen. */
  openSettings(): void;
}

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

/** Replaces an element's children, skipping the empty ones. */
const fill = (el: HTMLElement, ...children: Child[]) => el.replaceChildren(...children.filter((c): c is Node | string => !!c));

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
/** The platform's short name, for the label beside a meeting. */
export const platformLabel = (p: MeetingPlatform) => (p === 'Google Meet' ? 'Meet' : p === 'Microsoft Teams' ? 'Teams' : 'Zoom');
/** The reminder every way into recording carries. */
export const CONSENT_HINT = 'Tell the other people in the meeting that you’re recording. In many places you need their consent.';

const WHERE_TO_FIND =
  'Google Calendar: Settings › your calendar › Integrate calendar › “Secret address in iCal format”. Outlook and iCloud: a published calendar’s ICS (webcal://) link works too.';
const SECRET_HINT =
  'This address works like a password: anyone who has it can read your calendar. Uranus Browser keeps it only in this browser profile, shows it shortened, never logs it, and never gives it, or your events, to the AI model. It is read every 10 minutes, without your cookies.';
const OFFER_HINT = 'When the tab you are on is a Google Meet, Zoom or Teams meeting, the panel asks whether to take notes. It only reads the tab’s address; nothing is added to the page.';

export function setupMeetingsCalendar(hooks: CalendarHooks) {
  let view: CalendarView | undefined;
  let active: { url: string; title: string } | undefined;
  let editing = false;
  let busy: 'test' | 'save' | 'refresh' | 'remove' | undefined;
  let result: { ok: boolean; text: string } | undefined;
  let confirmRemove = false;
  const seen = new Set<string>();

  // Both outlive repaints of the sheet, so what is typed into the field stays put.
  const upcomingEl = h('section', { class: 'mt-upcoming', 'aria-labelledby': 'mt-up-title' });
  const settingsEl = h('div', { class: 'mt-cal' });
  const input = h('input', {
    id: 'mt-cal-url',
    class: 'field',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
    'aria-describedby': 'mt-cal-where',
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    if (result) {
      result = undefined;
      paintSettings();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void save();
    }
  });

  async function ask(name: string, ...args: unknown[]): Promise<Reply> {
    return (await invoke<Reply>(name, ...args).catch((err) => ({ error: err instanceof Error ? err.message : 'Something went wrong.' }))) ?? {};
  }

  const dismissed = (id: string) => !!view?.dismissed.includes(id);

  // ---- the strip above the conversation ------------------------------------------------------------

  function paintStrip() {
    const strip = $('meeting-strip');
    if (!strip) return;
    const content = stripContent();
    strip.hidden = !content;
    strip.replaceChildren(...(content ?? []));
  }

  function stripContent(): Node[] | undefined {
    if (!view || hooks.recording() || hooks.sheetOpen()) return undefined;
    const tab = active ? liveMeetingTab(active.url) : undefined;
    if (tab) {
      const id = tabId(tab.key);
      if (!view.offerTabs || dismissed(id)) return undefined;
      return [
        h('span', { class: 'meeting-strip-icon', 'aria-hidden': 'true' }, icon('mic')),
        // Short, so it stays one line beside its buttons; the consent reminder is the second line.
        h('div', { class: 'meeting-strip-text', title: `This looks like a meeting. ${CONSENT_HINT}` }, h('strong', {}, 'Record this meeting?'), h('span', {}, `${tab.platform} · tell the others you’re recording`)),
        h(
          'div',
          { class: 'meeting-strip-actions' },
          h('button', { class: 'primary-button small', type: 'button', onclick: () => {
            // Asked once per meeting: after this recording, it doesn't ask again.
            void ask('calendar:dismiss', id);
            hooks.ready({ source: 'tab', platform: tab.platform });
          } }, 'Record'),
          h('button', { class: 'text-button small', type: 'button', onclick: () => void ask('calendar:dismiss', id) }, 'Not now'),
        ),
      ];
    }
    const soon = startingSoon(view.meetings, Date.now(), dismissed);
    if (!soon) return undefined;
    return [
      h('span', { class: 'meeting-strip-icon', 'aria-hidden': 'true' }, icon('calendar')),
      h('div', { class: 'meeting-strip-text' }, h('strong', {}, soon.title), h('span', {}, `${platformLabel(soon.platform)} · ${time(soon.start)} · ${startsIn(soon.start, Date.now())}`)),
      h(
        'div',
        { class: 'meeting-strip-actions' },
        h('button', { class: 'primary-button small', type: 'button', onclick: () => void ask('calendar:openRecord', soon.id) }, 'Open & record'),
        h('button', { class: 'icon-button small meeting-strip-close', type: 'button', 'aria-label': `Dismiss ${soon.title}`, onclick: () => void ask('calendar:dismiss', soon.id) }, icon('close')),
      ),
    ];
  }

  // ---- the Upcoming card on the sheet's home screen ---------------------------------------------------

  function upcomingRow(m: CalendarMeeting) {
    return h(
      'li',
      { class: 'mt-up-row' },
      h('span', { class: 'mt-up-time' }, time(m.start)),
      h('span', { class: 'mt-up-text' }, h('span', { class: 'mt-up-title' }, m.title), h('span', { class: 'mt-up-meta' }, h('span', { class: 'mt-platform' }, platformLabel(m.platform)), ` ${m.shown}`)),
      h(
        'span',
        { class: 'mt-up-actions' },
        // Two words of buttons leave the title room at the panel's usual width: Join is an icon.
        h('button', { class: 'icon-button small', type: 'button', 'aria-label': `Join ${m.title} without recording`, 'data-tip': 'Join without notes', onclick: () => void ask('calendar:join', m.id) }, icon('external')),
        h('button', { class: 'secondary-button small', type: 'button', disabled: hooks.recording(), 'aria-label': `Open ${m.title} and record notes`, onclick: () => void ask('calendar:openRecord', m.id) }, 'Record'),
      ),
    );
  }

  function paintUpcoming() {
    const v = view;
    const head = h(
      'h3',
      { id: 'mt-up-title', class: 'memory-title' },
      'Upcoming today',
      h('button', { class: 'icon-button small', type: 'button', 'aria-label': 'Calendar settings', 'data-tip': 'Calendar', onclick: () => hooks.openSettings() }, icon('calendar')),
    );
    if (!v) return fill(upcomingEl, head, h('p', { class: 'sheet-hint' }, 'Loading…'));
    if (!v.connected) {
      return fill(upcomingEl, 
        head,
        h(
          'div',
          { class: 'memory-empty mt-up-empty' },
          icon('calendar'),
          h('span', {}, 'Connect your calendar and Uranus Browser reminds you two minutes before a meeting with a Google Meet, Zoom or Teams link, and opens it ready to take notes.'),
        ),
        h('button', { class: 'secondary-button', type: 'button', onclick: () => hooks.openSettings() }, 'Connect a calendar…'),
      );
    }
    const today = meetingsToday(v.meetings, Date.now(), 3);
    fill(upcomingEl, 
      head,
      today.length ? h('ul', { class: 'mt-up-list' }, ...today.map(upcomingRow)) : h('p', { class: 'mt-none' }, v.checkedAt ? 'No more meetings with a link today.' : 'Reading your calendar…'),
      v.error ? h('p', { class: 'sheet-error', role: 'alert' }, v.error) : null,
    );
  }

  // ---- the Calendar screen ----------------------------------------------------------------------------

  function statusLine(v: CalendarView) {
    if (busy === 'refresh' || v.checking) return 'Checking…';
    if (!v.checkedAt) return 'Not read yet.';
    const n = v.meetings.length;
    return `Checked at ${time(v.checkedAt)}: ${v.events ?? 0} event${v.events === 1 ? '' : 's'}, ${n} with a meeting link in the next day and a half.`;
  }

  async function test() {
    busy = 'test';
    result = undefined;
    paintSettings();
    const reply = await ask('calendar:test', input.value);
    busy = undefined;
    result = reply.error ? { ok: false, text: reply.error } : { ok: true, text: `It works: ${reply.events ?? 0} events, ${reply.meetings ?? 0} with a meeting link in the next day and a half.` };
    paintSettings();
  }

  async function save() {
    if (busy) return;
    busy = 'save';
    result = undefined;
    paintSettings();
    const reply = await ask('calendar:save', input.value);
    busy = undefined;
    if (reply.error) result = { ok: false, text: reply.error };
    else {
      // The address leaves the page: from now on it is only shown masked.
      input.value = '';
      editing = false;
      result = { ok: true, text: `Saved. ${reply.meetings ?? 0} meeting${reply.meetings === 1 ? '' : 's'} with a link in the next day and a half.` };
    }
    paintSettings();
  }

  /** Redraws the Calendar screen; the address field keeps its focus and caret while it is moved. */
  function paintSettings() {
    const typing = document.activeElement === input;
    const [from, to] = [input.selectionStart, input.selectionEnd];
    drawSettings();
    if (typing && input.isConnected) {
      input.focus();
      if (from !== null && to !== null) input.setSelectionRange(from, to);
    }
  }

  function drawSettings() {
    const v = view;
    if (!v) return fill(settingsEl, h('p', { class: 'sheet-hint' }, 'Loading…'));
    const form = !v.connected || editing;
    const offer = h(
      'button',
      {
        class: 'switch',
        type: 'button',
        role: 'switch',
        id: 'mt-offer',
        'aria-checked': String(v.offerTabs),
        'aria-labelledby': 'mt-offer-label',
        onclick: async () => {
          await ask('calendar:setOfferTabs', !v.offerTabs);
        },
      },
      h('span', { class: 'switch-thumb' }),
    );
    fill(settingsEl, 
      h('p', { class: 'sheet-hint' }, 'A couple of minutes before a meeting with a Google Meet, Zoom or Teams link, Uranus Browser can remind you and open it ready to take notes. It reads your calendar from its private iCal address; it never signs in to your account. Recording still starts only when you press Start recording.'),
      v.connected
        ? h(
            'section',
            { class: 'mt-card mt-cal-status', 'aria-labelledby': 'mt-cal-connected' },
            h('div', { class: 'mt-cal-head' }, icon('calendar'), h('h3', { id: 'mt-cal-connected', class: 'mt-card-title' }, 'Calendar connected'), h('span', { class: 'mt-cal-host' }, v.shown ?? '')),
            h('p', { class: 'sheet-hint', role: 'status' }, statusLine(v)),
            v.error ? h('p', { class: 'sheet-error', role: 'alert' }, v.error) : null,
            confirmRemove
              ? h(
                  'div',
                  { class: 'confirm', role: 'alertdialog', 'aria-label': 'Remove the calendar' },
                  h('span', {}, 'Remove the calendar address? Reminders stop.'),
                  h('span', { class: 'spacer' }),
                  h('button', { class: 'secondary-button', type: 'button', onclick: () => ((confirmRemove = false), paintSettings()) }, 'Keep'),
                  h('button', { class: 'primary-button', type: 'button', onclick: async () => {
                    confirmRemove = false;
                    busy = 'remove';
                    paintSettings();
                    await ask('calendar:remove');
                    busy = undefined;
                    editing = false;
                    result = { ok: true, text: 'Removed. The address and the meetings read from it are gone from this profile.' };
                    paintSettings();
                  } }, 'Remove'),
                )
              : h(
                  'div',
                  { class: 'mt-actions' },
                  h('button', { class: 'secondary-button small', type: 'button', disabled: !!busy || v.checking, onclick: async () => {
                    busy = 'refresh';
                    result = undefined;
                    paintSettings();
                    await ask('calendar:refresh');
                    busy = undefined;
                    paintSettings();
                  } }, icon('reload'), 'Check now'),
                  editing ? null : h('button', { class: 'text-button small', type: 'button', onclick: () => ((editing = true), (result = undefined), paintSettings(), input.focus()) }, 'Use another address'),
                  h('span', { class: 'spacer' }),
                  h('button', { class: 'text-button small danger', type: 'button', disabled: !!busy, onclick: () => ((confirmRemove = true), paintSettings()) }, icon('trash'), 'Remove'),
                ),
          )
        : null,
      form
        ? h(
            'section',
            { class: 'mt-cal-form', 'aria-label': 'Calendar address' },
            h('label', { class: 'label', for: 'mt-cal-url' }, v.connected ? 'Another private iCal address' : 'Private iCal address'),
            input,
            h('p', { id: 'mt-cal-where', class: 'sheet-hint' }, WHERE_TO_FIND),
            h(
              'div',
              { class: 'mt-actions' },
              h('button', { class: 'secondary-button', type: 'button', disabled: !!busy, onclick: () => void test() }, busy === 'test' ? 'Testing…' : 'Test'),
              h('button', { class: 'primary-button', type: 'button', disabled: !!busy, onclick: () => void save() }, busy === 'save' ? 'Saving…' : 'Save'),
              editing ? h('button', { class: 'text-button', type: 'button', onclick: () => ((editing = false), (input.value = ''), (result = undefined), paintSettings()) }, 'Cancel') : null,
            ),
          )
        : null,
      result ? h('p', { class: result.ok ? 'mt-cal-ok' : 'sheet-error', role: result.ok ? 'status' : 'alert' }, result.text) : null,
      h('p', { class: 'sheet-hint' }, SECRET_HINT),
      h(
        'div',
        { class: 'mt-cal-offer' },
        h('span', { class: 'mt-cal-offer-text' }, h('strong', { id: 'mt-offer-label' }, 'Offer to record meetings'), h('span', {}, OFFER_HINT)),
        offer,
      ),
      h('p', { class: 'sheet-hint' }, CONSENT_HINT),
    );
  }

  // ---- wiring -------------------------------------------------------------------------------------------

  function take(next: CalendarView) {
    view = next;
    if (next.focus) handleFocus(next.focus);
    paintStrip();
    paintUpcoming();
    if (settingsEl.isConnected) paintSettings();
  }

  /** A meeting was opened to be recorded (from the notification, the strip or the list): show its card, once. */
  function handleFocus(focus: ReadyFocus) {
    if (seen.has(focus.nonce)) return;
    seen.add(focus.nonce);
    hooks.ready({ source: 'calendar', platform: focus.meeting.platform, title: focus.meeting.title, start: focus.meeting.start });
  }

  on('calendar', (next: CalendarView) => take(next));
  on('calendar:focus', (focus: ReadyFocus) => handleFocus(focus));
  on('state', (s: UiState) => {
    const space = s.spaces.find((sp) => sp.id === s.activeSpaceId) ?? s.spaces[0];
    const tab = space?.activeTabId ? s.tabs[space.activeTabId] : undefined;
    const next = tab ? { url: tab.url, title: tab.customTitle || tab.title || '' } : undefined;
    if (next?.url === active?.url) return;
    active = next;
    paintStrip();
  });
  // Time passes: "starts in" counts down and the strip comes and goes on its own.
  setInterval(paintStrip, 30_000);
  void invoke<CalendarView>('calendar:get')
    .then((v) => v && take(v))
    .catch(() => undefined);

  return {
    /** The Upcoming card for the sheet's home screen (one element, kept up to date in place). */
    upcoming() {
      paintUpcoming();
      return upcomingEl;
    },
    /** The Calendar screen. */
    settings() {
      paintSettings();
      return settingsEl;
    },
    /** Leaving the Calendar screen: an unsaved address doesn't linger in the page. */
    leaveSettings() {
      confirmRemove = false;
      if (!busy) {
        input.value = '';
        editing = false;
        result = undefined;
      }
    },
    /** The sheet opened or closed, or a recording began or ended. */
    paintStrip,
  };
}
