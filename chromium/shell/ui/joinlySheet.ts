/**
 * The Agent panel's Meetings sheet: whether the user's joinly server is running (with how to
 * start it), the opt-in "Let the agent join meetings for me" with the consent it needs, a form
 * to send the bot into a meeting (after an explicit confirmation), and, while it is in one,
 * who is there and the latest talk with speaker names. Plus the banner that stays in the
 * panel the whole time the agent is in a meeting, with its Leave button.
 *
 * It only draws what the shell has (shell/joinly.ts) and asks the shell to change things.
 * Everything that came from a meeting (names, words) is drawn as text nodes, never as markup.
 */
import { JOINLY_DEFAULT_ENDPOINT, JOINLY_START_COMMAND, MAX_BOT_NAME, checkBotName, checkEndpoint, checkMeetingUrl, type JoinlyView, type VoiceView } from '../../shared/joinly';
import { meetingsToOffer, type CalendarMeeting } from '../../shared/calendar';
import type { CalendarView } from '../calendar';
import { MEETING_LANGUAGES } from '../../shared/meetingLanguages';
import type { JoinlyState } from '../joinly';
import { invoke, on } from '../client';
import { ICONS, type IconName } from './icons';
import { customSelect } from './select';

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | undefined | ((e: Event) => void)>;

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

function h(tag: string, props: Props = {}, ...children: Child[]) {
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

/** What the person is told before the opt-in is on, and can read again afterwards. */
export const CONSENT_POINTS = [
  'The bot joins as a visible participant. It does not announce itself: the agent can say or post that it is an AI assistant, if you ask and approve it. Tell the other attendees before it joins.',
  'It listens to the meeting. Many countries and workplaces require everyone’s consent to record or transcribe a call. Getting it is on you.',
  'Some platforms and organisations forbid bots: check the rules of Google Meet, Zoom or Teams and of your employer. The host can remove the bot.',
  'What the agent reads from the meeting (words and names) is sent to OpenAI with your messages.',
  'The agent never joins, speaks or posts without an approval card that you accept. Stop in this panel, or Leave here, ends its part in the meeting.',
  'What people say in a meeting is treated as information, never as instructions.',
] as const;

const LANGUAGE_HINT = 'Tell joinly what language the meeting is in, so it listens for it. It speaks with a voice for English, Spanish, French or Italian; other languages are understood but answered in an English voice. Applies from the next meeting.';
const NAME_HINT = 'Pick a name that makes clear this is an AI assistant. If joinly’s browser is signed in to a Google account, Meet may show that account’s name instead.';
const HOST_HINT = 'Only this computer is allowed: 127.0.0.1, localhost or [::1].';

/** The one line the status block shows for the way things are. */
export function statusLine(state: JoinlyState, checking: boolean): { tone: 'ok' | 'warn' | 'busy' | 'idle'; title: string; detail: string } {
  const { view } = state;
  const where = (() => {
    try {
      const u = new URL(state.settings.endpoint);
      return `${u.hostname}:${u.port || '80'}`;
    } catch {
      return 'this computer';
    }
  })();
  if (view.phase === 'joining') return { tone: 'busy', title: 'Joining the meeting…', detail: view.detail ?? 'Waiting to be let in.' };
  if (view.phase === 'leaving') return { tone: 'busy', title: 'Leaving the meeting…', detail: '' };
  if (view.status === 'joined' && view.meeting) return { tone: 'ok', title: 'In a meeting', detail: `${view.meeting.host} as “${view.meeting.botName}”` };
  if (checking) return { tone: 'busy', title: 'Checking…', detail: `Looking for joinly at ${where}.` };
  if (view.status === 'ready') return { tone: 'ok', title: 'joinly is running', detail: `Reachable at ${where}. Nothing is joined until you ask.` };
  switch (view.reason) {
    case 'helper':
      return { tone: 'warn', title: 'Uranus Browser’s helper isn’t answering', detail: view.detail ?? '' };
    case 'not-joinly':
      return { tone: 'warn', title: 'That isn’t joinly', detail: view.detail ?? '' };
    case 'lost':
      return { tone: 'warn', title: 'Lost the connection to joinly', detail: view.detail ?? '' };
    case 'bad-endpoint':
      return { tone: 'warn', title: 'That address can’t be used', detail: view.detail ?? '' };
    default:
      if (!view.checkedAt) return { tone: 'idle', title: 'Not checked yet', detail: 'Press Check again to look for joinly on this computer.' };
      return { tone: 'warn', title: 'joinly isn’t running', detail: view.detail ?? `Nothing answers at ${where}.` };
  }
}

export interface MeetingsHooks {
  /** The other sheet (companions) closes when this one opens. */
  closeOthers(): void;
  /** The current tab's address: offered as the link when it is a meeting. */
  currentUrl?(): string | undefined;
}

const clockTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });


export function setupMeetings(hooks: MeetingsHooks) {
  let state: JoinlyState | undefined;
  /** What the person typed but hasn't used yet; kept across repaints. */
  const draft = { link: '', name: undefined as string | undefined, endpoint: undefined as string | undefined };
  /** Where the link in the field came from, when the sheet filled it in ("the tab you're on", a calendar meeting). */
  let linkSource: string | undefined;
  /** The connected calendar's meetings (shell/calendar.ts): the sheet offers today's. */
  let calendarMeetings: CalendarMeeting[] = [];
  const tabMeeting = () => {
    // Meet shows a visitor who isn't signed in /meet/<code>: the bot gets the meeting's own address.
    const url = hooks.currentUrl?.()?.replace(/^(https:\/\/meet\.google\.com)\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i, '$1/$2');
    const checked = url ? checkMeetingUrl(url) : undefined;
    return checked?.ok ? checked : undefined;
  };
  /** Fills the link in, if it is empty: the meeting tab you're on, else the next meeting in the calendar. */
  function suggestLink() {
    if (draft.link.trim()) return;
    const tab = tabMeeting();
    if (tab) {
      draft.link = tab.url;
      linkSource = 'From the tab you’re on';
      return;
    }
    const next = meetingsToOffer(calendarMeetings, Date.now())[0];
    if (next) {
      draft.link = next.url;
      linkSource = `From your calendar: ${next.title} at ${clockTime(next.start)}`;
    }
  }
  let consenting = false;
  let confirmingJoin = false;
  let confirmingVoice = false;
  /** The model picked in the voice mode picker but not used yet. */
  let pickedModel: string | undefined;
  let message: string | undefined;
  let checking = false;
  let checkingTimer: ReturnType<typeof setTimeout> | undefined;
  let copied = false;
  const sheet = $('joinly-sheet');
  const toggle = $('joinly-open');
  const banner = $('meeting-banner');
  let built = false;

  const isOpen = () => !sheet.hidden;
  const busy = () => !!state && (state.view.status === 'joined' || !!state.view.phase);

  // ---- asking the shell ---------------------------------------------------------------------

  async function ask<T extends { error?: string }>(name: string, ...args: unknown[]): Promise<T> {
    const reply = await invoke<T>(name, ...args).catch((err) => ({ error: err instanceof Error ? err.message : 'Something went wrong.' }) as T);
    message = reply?.error;
    return reply ?? ({} as T);
  }

  function recheck() {
    checking = true;
    clearTimeout(checkingTimer);
    checkingTimer = setTimeout(() => {
      checking = false;
      paint();
    }, 5_000);
    paint();
    void ask('joinly:refresh');
  }

  // ---- regions: each repainted only when what it shows changed, so typing isn't interrupted ------

  interface Region {
    el: HTMLElement;
    key: string;
    inputs(): unknown;
    build(): Child[];
  }
  const regions: Region[] = [];

  function region(cls: string, inputs: () => unknown, build: () => Child[]) {
    const r: Region = { el: h('section', { class: `jn-region ${cls}` }), key: '', inputs, build };
    regions.push(r);
    return r;
  }

  function repaint(r: Region) {
    const key = JSON.stringify(r.inputs());
    if (key === r.key) return;
    r.key = key;
    const active = document.activeElement as HTMLInputElement | null;
    const keep = active && r.el.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : undefined;
    r.el.replaceChildren(...(r.build().filter(Boolean) as Node[]));
    if (keep) {
      const again = document.getElementById(keep.id) as HTMLInputElement | null;
      again?.focus();
      if (again && keep.start !== null && keep.end !== null && typeof again.setSelectionRange === 'function') again.setSelectionRange(keep.start, keep.end);
    }
  }

  // 1. How things are.
  const statusRegion = region(
    'jn-status-region',
    () => (state ? { s: statusLine(state, checking), error: state.view.error, message, busy: busy() } : null),
    () => {
      if (!state) return [h('p', { class: 'sheet-hint' }, 'Loading…')];
      const line = statusLine(state, checking);
      return [
        h(
          'div',
          { class: `jn-status ${line.tone}`, role: 'status' },
          h('span', { class: 'jn-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'jn-status-text' }, h('strong', {}, line.title), line.detail ? h('span', { class: 'jn-detail' }, line.detail) : null),
          busy() ? null : h('button', { id: 'jn-check', class: 'secondary-button jn-check', type: 'button', disabled: checking, onclick: recheck }, 'Check again'),
        ),
        state.view.error ? h('p', { class: 'sheet-error', role: 'alert' }, state.view.error) : null,
        message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
      ];
    },
  );

  // 2. How to start joinly, when it isn't running.
  const setupRegion = region(
    'jn-setup-region',
    () => (state ? { show: state.view.status === 'unavailable' && state.view.reason !== 'helper' && !busy(), copied } : null),
    () => {
      if (!state || !(state.view.status === 'unavailable' && state.view.reason !== 'helper' && !busy())) return [];
      return [
        h('h3', { class: 'jn-title' }, 'Start joinly on this Mac'),
        h('p', { class: 'sheet-hint' }, 'Uranus Browser is only a client: joinly (the meeting bot) runs on your computer, in Docker, and you start it yourself. Nothing is started for you. In Terminal, run:'),
        h(
          'div',
          { class: 'jn-code-row' },
          h('pre', { class: 'jn-code', tabindex: '0', 'aria-label': 'Command to start joinly' }, JOINLY_START_COMMAND),
          h('button', { id: 'jn-copy', class: 'secondary-button', type: 'button', onclick: copyCommand }, icon('copy'), copied ? 'Copied' : 'Copy'),
        ),
        h('p', { class: 'sheet-hint' }, 'Docker Desktop has to be running. When joinly is up, press Check again.'),
      ];
    },
  );

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(JOINLY_START_COMMAND);
    } catch {
      const area = h('textarea', { 'aria-hidden': 'true' }) as HTMLTextAreaElement;
      area.value = JOINLY_START_COMMAND;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copied = true;
    paint();
    setTimeout(() => {
      copied = false;
      paint();
    }, 1_800);
  }

  // 3. Where joinly is.
  const endpointRegion = region(
    'jn-endpoint-region',
    () => (state ? { endpoint: state.settings.endpoint, locked: busy() } : null),
    () => {
      if (!state) return [];
      const input = h('input', {
        id: 'jn-endpoint',
        class: 'field jn-endpoint',
        type: 'text',
        value: draft.endpoint ?? state.settings.endpoint,
        spellcheck: 'false',
        autocomplete: 'off',
        disabled: busy(),
        'aria-describedby': 'jn-endpoint-note',
      }) as HTMLInputElement;
      const note = h('p', { id: 'jn-endpoint-note', class: 'sheet-hint' }, HOST_HINT);
      const save = h('button', { id: 'jn-endpoint-save', class: 'secondary-button', type: 'button', disabled: busy() }, 'Save') as HTMLButtonElement;
      const validate = () => {
        draft.endpoint = input.value;
        const checked = checkEndpoint(input.value);
        note.textContent = checked.ok ? HOST_HINT : checked.reason;
        note.classList.toggle('sheet-error', !checked.ok);
        save.disabled = !checked.ok || busy() || (checked.ok && checked.url === state!.settings.endpoint);
      };
      input.addEventListener('input', validate);
      const commit = async () => {
        const checked = checkEndpoint(input.value);
        if (!checked.ok) return validate();
        const reply = await ask('joinly:save', { endpoint: checked.url });
        if (!reply.error) {
          draft.endpoint = undefined;
          recheck();
        }
        paint();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          void commit();
        }
      });
      save.addEventListener('click', () => void commit());
      queueMicrotask(validate);
      return [
        h('label', { for: 'jn-endpoint', class: 'label' }, 'joinly address'),
        h('div', { class: 'jn-endpoint-row' }, input, save),
        note,
        state.settings.endpoint !== JOINLY_DEFAULT_ENDPOINT
          ? h('button', { class: 'text-button', type: 'button', disabled: busy(), onclick: () => ((draft.endpoint = JOINLY_DEFAULT_ENDPOINT), void commitDefault()) }, 'Use the default address')
          : null,
      ];
    },
  );

  async function commitDefault() {
    const reply = await ask('joinly:save', { endpoint: JOINLY_DEFAULT_ENDPOINT });
    if (!reply.error) {
      draft.endpoint = undefined;
      recheck();
    }
    paint();
  }

  // 4. The opt-in.
  const optinRegion = region(
    'jn-optin-region',
    () => (state ? { on: state.settings.enabled, consenting, busy: busy() } : null),
    () => {
      if (!state) return [];
      const on = state.settings.enabled;
      const points = h('ul', { class: 'jn-points' }, ...CONSENT_POINTS.map((p) => h('li', {}, p)));
      return [
        h(
          'div',
          { class: 'jn-switch-row' },
          h('span', { class: 'jn-switch-text' }, h('span', { id: 'jn-optin-label', class: 'jn-switch-label' }, 'Let the agent join meetings for me'), h('span', { class: 'jn-detail' }, on ? 'On. It joins only when you ask, and asks you before it speaks or writes.' : 'Off. Nothing is joined or listened to.')),
          h('button', {
            id: 'jn-optin',
            class: 'jn-switch',
            type: 'button',
            role: 'switch',
            'aria-checked': String(on),
            'aria-labelledby': 'jn-optin-label',
            onclick: async () => {
              if (!on) {
                consenting = !consenting;
                return paint();
              }
              consenting = false;
              await ask('joinly:save', { enabled: false });
              paint();
            },
          }, h('span', { class: 'jn-knob' })),
        ),
        !on && consenting
          ? h(
              'div',
              { id: 'jn-consent', class: 'jn-consent', role: 'group', 'aria-labelledby': 'jn-consent-title' },
              h('strong', { id: 'jn-consent-title' }, 'Before you turn this on'),
              points,
              h(
                'div',
                { class: 'jn-actions' },
                h('button', { id: 'jn-consent-cancel', class: 'secondary-button', type: 'button', onclick: () => ((consenting = false), paint()) }, 'Not now'),
                h('span', { class: 'spacer' }),
                h('button', {
                  id: 'jn-consent-accept',
                  class: 'primary-button',
                  type: 'button',
                  onclick: async () => {
                    const reply = await ask('joinly:save', { enabled: true, consent: true });
                    if (!reply.error) {
                      consenting = false;
                      recheck();
                    }
                    paint();
                  },
                }, 'I understand, turn on'),
              ),
            )
          : null,
        on ? h('details', { class: 'jn-more' }, h('summary', {}, 'Things to know'), points) : null,
      ];
    },
  );

  // 5. Join a meeting.
  const joinRegion = region(
    'jn-join-region',
    () => (state ? { on: state.settings.enabled, busy: busy(), ready: state.view.status === 'ready', confirming: confirmingJoin, name: state.settings.botName, lang: state.settings.language, tab: tabMeeting()?.url, cal: calendarMeetings.map((m) => `${m.id}${m.start}`).join() } : null),
    () => {
      if (!state || !state.settings.enabled || busy()) return [];
      const ready = state.view.status === 'ready';
      const link = h('input', { id: 'jn-link', class: 'field', type: 'text', placeholder: 'https://meet.google.com/abc-defg-hij', value: draft.link, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'jn-link-note' }) as HTMLInputElement;
      const name = h('input', { id: 'jn-name', class: 'field', type: 'text', maxlength: String(MAX_BOT_NAME), value: draft.name ?? state.settings.botName, autocomplete: 'off', 'aria-describedby': 'jn-name-note' }) as HTMLInputElement;
      const linkNote = h('p', { id: 'jn-link-note', class: 'sheet-hint' }, 'Google Meet, Zoom or Microsoft Teams, https:// links only.');
      const nameNote = h('p', { id: 'jn-name-note', class: 'sheet-hint' }, NAME_HINT);
      const join = h('button', { id: 'jn-join', class: 'primary-button', type: 'button', disabled: true }, 'Join…') as HTMLButtonElement;
      const check = () => {
        if (link.value !== draft.link) linkSource = undefined;
        draft.link = link.value;
        draft.name = name.value;
        const url = link.value.trim() ? checkMeetingUrl(link.value) : undefined;
        const who = checkBotName(name.value);
        linkNote.textContent = !url ? 'Google Meet, Zoom or Microsoft Teams, https:// links only.' : url.ok ? `${url.platform} · ${url.host}${linkSource ? ` · ${linkSource}` : ''}` : url.reason;
        linkNote.classList.toggle('sheet-error', !!url && !url.ok);
        nameNote.classList.toggle('sheet-error', !who.ok);
        nameNote.textContent = who.ok ? NAME_HINT : who.reason;
        join.disabled = !(url?.ok && who.ok && ready);
        return { url, who };
      };
      link.addEventListener('input', check);
      name.addEventListener('input', check);
      join.addEventListener('click', () => {
        const { url, who } = check();
        if (!url?.ok || !who.ok) return;
        confirmingJoin = true;
        paint();
      });
      queueMicrotask(check);

      if (confirmingJoin) {
        const url = checkMeetingUrl(draft.link);
        const who = checkBotName(draft.name ?? state.settings.botName);
        if (!url.ok || !who.ok) {
          confirmingJoin = false;
        } else {
          return [
            h(
              'div',
              { id: 'jn-confirm', class: 'jn-consent', role: 'alertdialog', 'aria-labelledby': 'jn-confirm-title' },
              h('strong', { id: 'jn-confirm-title' }, 'Join this meeting?'),
              h('dl', { class: 'jn-facts' }, h('dt', {}, 'Where'), h('dd', {}, `${url.platform} · ${url.shown}`), h('dt', {}, 'As'), h('dd', {}, who.name)),
              h('p', { class: 'sheet-hint' }, 'The bot appears as a participant and does not announce itself. Have the other attendees been told? Some places require their consent to listen, and some platforms don’t allow bots.'),
              h(
                'div',
                { class: 'jn-actions' },
                h('button', { id: 'jn-confirm-cancel', class: 'secondary-button', type: 'button', onclick: () => ((confirmingJoin = false), paint()) }, 'Cancel'),
                h('span', { class: 'spacer' }),
                h('button', {
                  id: 'jn-confirm-join',
                  class: 'primary-button',
                  type: 'button',
                  onclick: async () => {
                    confirmingJoin = false;
                    const reply = await ask('joinly:join', url.url, who.name, true);
                    if (!reply.error) draft.link = '';
                    paint();
                  },
                }, 'Join meeting'),
              ),
            ),
          ];
        }
      }
      // No pasting: this tab (when it's a meeting) and today's calendar meetings, one click each.
      const pick = (url: string, source: string) => {
        draft.link = url;
        linkSource = source;
        link.value = url;
        check();
        name.focus();
        for (const el of picks.querySelectorAll('.jn-pick')) el.setAttribute('aria-pressed', String((el as HTMLElement).dataset.url === url));
      };
      const tab = tabMeeting();
      const today = meetingsToOffer(calendarMeetings, Date.now()).slice(0, 4);
      const picks = h(
        'div',
        { class: 'jn-picks', role: 'group', 'aria-label': 'Pick a meeting' },
        ...(tab ? [h('button', { class: 'jn-pick', type: 'button', 'data-url': tab.url, 'aria-pressed': String(draft.link === tab.url), onclick: () => pick(tab.url, 'From the tab you’re on') }, icon('tab'), h('span', {}, h('strong', {}, 'This tab'), h('span', {}, `${tab.platform} · ${tab.shown}`)))] : []),
        ...today.map((m) =>
          h(
            'button',
            { class: 'jn-pick', type: 'button', 'data-url': m.url, 'aria-pressed': String(draft.link === m.url), onclick: () => pick(m.url, `From your calendar: ${m.title} at ${clockTime(m.start)}`) },
            icon('calendar'),
            h('span', {}, h('strong', {}, m.title), h('span', {}, `${m.start <= Date.now() ? 'Now' : clockTime(m.start)} · ${m.platform}`)),
          ),
        ),
      );
      return [
        h('h3', { class: 'jn-title' }, 'Join a meeting'),
        tab || today.length ? h('span', { class: 'label' }, 'Pick a meeting') : null,
        tab || today.length ? picks : null,
        h('label', { for: 'jn-link', class: 'label' }, tab || today.length ? 'Or paste a meeting link' : 'Meeting link'),
        link,
        linkNote,
        h('label', { for: 'jn-name', class: 'label' }, 'Bot name'),
        name,
        nameNote,
        h('label', { for: 'jn-lang', class: 'label' }, 'Spoken language'),
        languagePicker(),
        h('p', { id: 'jn-lang-note', class: 'sheet-hint' }, LANGUAGE_HINT),
        ready ? null : h('p', { class: 'sheet-hint' }, 'Start joinly first (above), then press Check again.'),
        h('div', { class: 'jn-actions' }, h('span', { class: 'spacer' }), join),
        h('p', { class: 'sheet-hint' }, 'You can also ask the agent in the conversation: “join this meeting …”. It shows an approval card first.'),
      ];
    },
  );

  // 6. In a meeting: who is there, and the latest talk.
  const meetingRegion = region(
    'jn-meeting-region',
    () => (state ? { m: state.view.meeting, p: state.view.participants, l: state.view.lines, phase: state.view.phase, status: state.view.status, voiceOn: state.view.voice?.state === 'on' } : null),
    () => {
      if (!state || !busy()) return [];
      const v = state.view;
      const leaving = v.phase === 'leaving';
      return [
        h('h3', { class: 'jn-title' }, v.status === 'joined' ? 'In the meeting' : 'Joining'),
        h(
          'div',
          { class: 'jn-actions jn-leave-row' },
          h('span', { class: 'jn-detail' }, v.meeting ? `${v.meeting.host} · as “${v.meeting.botName}”` : (v.detail ?? 'Waiting to be let in.')),
          h('span', { class: 'spacer' }),
          h('button', { id: 'jn-leave', class: 'primary-button danger', type: 'button', disabled: leaving, onclick: () => void ask('joinly:leave') }, v.status === 'joined' ? 'Leave meeting' : 'Cancel joining'),
        ),
        v.status === 'joined' ? participants(v) : null,
        v.status === 'joined' ? talk(v) : null,
        h('p', { class: 'sheet-hint' }, v.voice?.state === 'on' ? 'Voice mode is on, so the bot also answers out loud by itself. Anything the agent says or posts in the conversation still needs your approval. Stop in the conversation also makes it leave.' : 'The agent speaks or writes here only after you approve a card in the conversation. Stop in the conversation also makes it leave.'),
      ];
    },
  );

  function participants(v: JoinlyView) {
    return h(
      'div',
      { class: 'jn-people' },
      h('h4', { class: 'jn-sub' }, `Participants (${v.participants.length})`),
      v.participants.length
        ? h('ul', { class: 'jn-chips' }, ...v.participants.map((name) => h('li', { class: 'jn-chip' }, name)))
        : h('p', { class: 'sheet-hint' }, 'No participants listed yet.'),
    );
  }

  function talk(v: JoinlyView) {
    return h(
      'div',
      { class: 'jn-talk-wrap' },
      h('h4', { class: 'jn-sub' }, 'Latest talk'),
      v.lines.length
        ? h(
            'ol',
            { class: 'jn-talk', 'aria-label': 'Latest talk in the meeting' },
            ...v.lines.map((line) => h('li', { class: `jn-line${line.self ? ' self' : ''}` }, h('span', { class: 'jn-at' }, line.at), h('span', { class: 'jn-who' }, line.speaker), h('span', { class: 'jn-text' }, line.text))),
          )
        : h('p', { class: 'sheet-hint' }, 'Nothing said yet.'),
    );
  }

  // ---- the spoken language ---------------------------------------------------------------------------

  /** joinly's speech recognition assumes English unless told; it is told at the start of each meeting. */
  function languagePicker() {
    const current = state?.settings.language ?? 'auto';
    const select = h(
      'select',
      {
        id: 'jn-lang',
        class: 'field',
        'aria-describedby': 'jn-lang-note',
        onchange: async (e: Event) => {
          await ask('joinly:save', { language: (e.target as HTMLSelectElement).value === 'auto' ? null : (e.target as HTMLSelectElement).value });
          paint();
        },
      },
      h('option', { value: 'auto', ...(current === 'auto' ? { selected: true } : {}) }, 'Not set (joinly assumes English)'),
      ...MEETING_LANGUAGES.map((l) => h('option', { value: l.code, ...(current === l.code ? { selected: true } : {}) }, l.name)),
    ) as HTMLSelectElement;
    select.value = current;
    return customSelect(select);
  }

  // ---- voice mode -----------------------------------------------------------------------------------------

  const voiceRegion = region(
    'jn-voice-region',
    () => (state ? { v: state.view.voice, joined: state.view.status === 'joined', consent: state.settings.voiceConsent, saved: state.settings.voiceModel, confirmingVoice, pickedModel } : null),
    () => {
      if (!state || state.view.status !== 'joined') return [];
      const v: VoiceView = state.view.voice ?? { state: 'off', models: [], ollama: 'unknown', replies: 0 };
      if (v.state === 'on') return voiceOn(v);
      return voiceOff(v);
    },
  );

  function voiceOn(v: VoiceView) {
    const last = v.last
      ? `Last reply: heard → speaking ${v.last.heardToSpeakMs} ms (first word from the model after ${v.last.heardToLlmMs} ms, ${(v.last.totalMs / 1000).toFixed(1)} s in all).`
      : 'Waiting for someone to speak.';
    const until = v.expiresAt ? new Date(v.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return [
      h(
        'div',
        { id: 'jn-voice-on', class: 'jn-voice-on', role: 'status' },
        h('strong', {}, 'Voice mode is on'),
        h('p', { class: 'sheet-hint' }, `The bot answers out loud by itself, using ${v.model ?? 'a model'} on this Mac. Everyone in the meeting can hear it.${v.doing === 'thinking' ? ' Thinking…' : v.doing === 'speaking' ? ' Speaking…' : ''}`),
        h('p', { id: 'jn-voice-last', class: 'sheet-hint' }, `${last} ${v.replies} ${v.replies === 1 ? 'answer' : 'answers'} so far.${until ? ` Switches itself off at ${until}.` : ''}`),
        h('div', { class: 'jn-actions' }, h('span', { class: 'spacer' }), h('button', { id: 'jn-voice-stop', class: 'primary-button danger', type: 'button', onclick: () => void ask('joinly:voice', false) }, 'Stop voice mode')),
      ),
    ];
  }

  function voiceOff(v: VoiceView) {
    const starting = v.state === 'starting';
    const models = v.models;
    const wanted = pickedModel ?? '';
    const chosen = models.includes(wanted) ? wanted : (v.model && models.includes(v.model) ? v.model : (models[0] ?? ''));
    const select = h(
      'select',
      { id: 'jn-voice-model', class: 'field', disabled: starting || !models.length, 'aria-label': 'Model that answers', onchange: (e: Event) => (pickedModel = (e.target as HTMLSelectElement).value) },
      ...models.map((m) => h('option', { value: m }, m)),
    ) as HTMLSelectElement;
    select.value = chosen;
    const turnOn = async () => {
      confirmingVoice = false;
      const reply = await ask('joinly:voice', true, select.value || chosen, true);
      if (reply.error) paint();
    };
    if (confirmingVoice && !starting) {
      return [
        h('h3', { class: 'jn-title' }, 'Voice mode'),
        h(
          'div',
          { id: 'jn-voice-confirm', class: 'jn-consent', role: 'alertdialog', 'aria-labelledby': 'jn-voice-confirm-title' },
          h('strong', { id: 'jn-voice-confirm-title' }, 'Turn on voice mode?'),
          h('p', { class: 'sheet-hint' }, 'The bot will answer out loud on its own using a model on this Mac. Everyone in the meeting can hear it. Turn off any time.'),
          h('p', { class: 'sheet-hint' }, 'It needs no approval card for each sentence. It speaks only: it can’t post, share or leave. It switches itself off after 20 minutes, when the meeting ends, or if something goes wrong. Tell the other attendees first.'),
          h(
            'div',
            { class: 'jn-actions' },
            h('button', { id: 'jn-voice-cancel', class: 'secondary-button', type: 'button', onclick: () => ((confirmingVoice = false), paint()) }, 'Cancel'),
            h('span', { class: 'spacer' }),
            h('button', { id: 'jn-voice-confirm-on', class: 'primary-button', type: 'button', onclick: () => void turnOn() }, 'Turn on voice mode'),
          ),
        ),
      ];
    }
    return [
      h('h3', { class: 'jn-title' }, 'Voice mode'),
      h('p', { class: 'sheet-hint' }, 'Off. Let the bot answer out loud by itself, with a model on this Mac (Ollama). It listens with joinly’s own speech recognition and speaks with joinly’s voice. Off in every new meeting.'),
      models.length
        ? h('div', { class: 'jn-voice-pick' }, h('label', { for: 'jn-voice-model', class: 'label' }, 'Model'), customSelect(select))
        : h('p', { class: 'sheet-hint' }, v.ollama === 'down' ? 'Ollama isn’t answering on this Mac (127.0.0.1:11434). Start it, then press Look again.' : 'Looking for local models…'),
      v.note ? h('p', { id: 'jn-voice-note', class: 'sheet-error', role: 'alert' }, v.note) : null,
      h(
        'div',
        { class: 'jn-actions' },
        h('button', { id: 'jn-voice-look', class: 'secondary-button', type: 'button', onclick: () => void ask('joinly:voice-models') }, 'Look again'),
        h('span', { class: 'spacer' }),
        h('button', {
          id: 'jn-voice-on-button',
          class: 'primary-button',
          type: 'button',
          disabled: starting || !models.length,
          onclick: () => {
            // The first time, the sheet asks in words; afterwards the click itself is the confirmation.
            if (!state!.settings.voiceConsent) {
              confirmingVoice = true;
              return paint();
            }
            void turnOn();
          },
        }, starting ? 'Loading the model…' : 'Turn on voice mode…'),
      ),
    ];
  }

  // ---- the banner: always visible while the agent is in a meeting --------------------------------

  function paintBanner() {
    const v = state?.view;
    const active = !!v && (v.status === 'joined' || !!v.phase);
    banner.hidden = !active;
    toggle.classList.toggle('live', active);
    if (!v || !active) {
      banner.replaceChildren();
      toggle.setAttribute('aria-label', 'Agent in a meeting');
      return;
    }
    const joined = v.status === 'joined' && !!v.meeting;
    const text = v.phase === 'leaving' ? 'Leaving the meeting…' : joined ? `The agent is in a meeting on ${v.meeting!.host}` : 'The agent is joining a meeting, waiting to be let in…';
    const voiceOn = joined && v.voice?.state === 'on';
    const key = `${text}|${v.phase ?? ''}|${joined}|${voiceOn}`;
    toggle.setAttribute('aria-label', `Agent in a meeting: ${text}`);
    if (banner.dataset.key === key) return;
    banner.dataset.key = key;
    banner.replaceChildren(
      ...[
      h('span', { class: 'jn-live-dot', 'aria-hidden': 'true' }),
      h('button', { id: 'banner-open', class: 'jn-banner-text', type: 'button', 'aria-label': `${text}. Open Agent in a meeting`, onclick: () => (isOpen() ? close() : open()) }, text),
      voiceOn ? h('span', { id: 'banner-voice', class: 'jn-banner-voice' }, 'Voice mode on') : null,
      voiceOn ? h('button', { id: 'banner-voice-stop', class: 'secondary-button jn-banner-leave', type: 'button', onclick: () => void ask('joinly:voice', false) }, 'Stop voice') : null,
      h('button', { id: 'banner-leave', class: 'secondary-button jn-banner-leave', type: 'button', disabled: v.phase === 'leaving', onclick: () => void ask('joinly:leave') }, joined ? 'Leave' : 'Cancel'),
      ].filter((n): n is HTMLElement => !!n),
    );
  }

  // ---- the sheet -------------------------------------------------------------------------------------

  function build() {
    if (built) return;
    built = true;
    // Status first; then the meeting when in one, how to start joinly when it isn't running,
    // the opt-in, joining, and last (it rarely changes) where joinly is.
    const order = [statusRegion, meetingRegion, voiceRegion, setupRegion, optinRegion, joinRegion, endpointRegion];
    $('joinly-body').replaceChildren(...order.map((r) => r.el));
  }

  function paint() {
    paintBanner();
    if (!isOpen()) return;
    build();
    for (const r of regions) repaint(r);
    // A question the person has to answer (consent, the join confirmation) is brought into view.
    for (const id of ['jn-consent', 'jn-confirm', 'jn-voice-confirm']) {
      const el = document.getElementById(id);
      if (el && el.dataset.seen !== '1') {
        el.dataset.seen = '1';
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function open() {
    hooks.closeOthers();
    consenting = false;
    confirmingJoin = false;
    confirmingVoice = false;
    message = undefined;
    sheet.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    suggestLink();
    for (const r of regions) r.key = '';
    paint();
    // Look for joinly when the sheet opens (a single GET to this computer, nothing else).
    recheck();
    void ask('joinly:voice-models');
    ($('joinly-body').querySelector<HTMLElement>('#jn-optin') ?? $('joinly-close')).focus();
  }

  function close(returnFocus = true) {
    if (!isOpen()) return;
    sheet.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  $('joinly-close').addEventListener('click', () => close());
  // The companions button opens its own sheet over this one: step aside.
  $('companion').addEventListener('click', () => close(false), true);

  // The calendar's meetings, for the picks (titles are untrusted: drawn as text only).
  const takeCalendar = (view: CalendarView | undefined) => {
    calendarMeetings = view?.connected ? view.meetings : [];
    if (isOpen()) paint();
  };
  on('calendar', takeCalendar);
  void invoke<CalendarView>('calendar:get').then(takeCalendar, () => undefined);

  on('joinly', (next: JoinlyState) => {
    const was = state?.view;
    state = next;
    if (checking && next.view.checkedAt && next.view.checkedAt !== was?.checkedAt) {
      checking = false;
      clearTimeout(checkingTimer);
    }
    if (next.view.status !== 'ready' && next.view.status !== 'unavailable') confirmingJoin = false;
    if (next.view.status !== 'joined' || next.view.voice?.state === 'on') confirmingVoice = false;
    paint();
  });
  void invoke<JoinlyState>('joinly:get')
    .then((first) => {
      state = first;
      paint();
    })
    .catch((err) => console.error('Uranus Browser agent panel: no meetings state yet', err));

  return {
    isOpen,
    /** The current tab changed: "This tab" follows it. */
    repaint: () => isOpen() && paint(),
    /** Escape closes the sheet (or a question in it) before the panel. Returns whether it did. */
    escape() {
      if (!isOpen()) return false;
      if (consenting || confirmingJoin || confirmingVoice) {
        consenting = false;
        confirmingJoin = false;
        confirmingVoice = false;
        paint();
      } else close();
      return true;
    },
  };
}
