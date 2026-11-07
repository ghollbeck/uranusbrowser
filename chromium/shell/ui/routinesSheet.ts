/**
 * The Agent panel's Routines sheet: the list (with each one's next run, an on/off switch and Run
 * now), the form to make or edit one, and each routine's run history with a viewer. It only
 * draws what the shell saved (shell/routines.ts) and asks the shell to change it. Everything
 * from a transcript (which may hold text from web pages) is drawn as plain text nodes, built
 * with DOM calls, never innerHTML.
 */
import {
  MAX_INTERVAL_MINUTES,
  MAX_MATCH,
  MAX_MEETING_OFFSET,
  MAX_ROUTINE_INSTRUCTIONS,
  MAX_ROUTINE_NAME,
  MIN_INTERVAL_MINUTES,
  STATUS_LABEL,
  WEEKDAYS,
  WEEK_ORDER,
  dayName,
  describeTrigger,
  describeWhen,
  shortDayName,
  type RoutineField,
  type RunRecord,
  type Trigger,
} from '../../shared/routines';
import { invoke, on } from '../client';
import type { RoutineView, RoutinesView } from '../routines';
import { ICONS, type IconName } from './icons';
import { customSelect } from './select';

type Reply = { error?: string; field?: RoutineField; id?: string };
type Child = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | undefined | ((e: Event) => void)>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const accent = (hue: number) => `hsl(${hue} 62% 52%)`;

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

const dot = (hue: number) => {
  const el = h('span', { class: 'dot', 'aria-hidden': 'true' });
  el.style.setProperty('--accent', accent(hue));
  return el;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** An epoch time as the value of a datetime-local input (the user's own zone). */
const localInput = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export interface RoutinesHooks {
  /** The Agent panel page closes the other sheet before this one opens. */
  beforeOpen(): void;
  /** "Save as a skill" on a run that went well: the companions sheet opens a draft to review. */
  saveAsSkill?(routine: RoutineView, record: RunRecord): void;
  /** "Connect a calendar": the Meetings sheet's Calendar screen (meeting routines need one). */
  openCalendar?(): void;
}

interface Draft {
  id?: string;
  name: string;
  companionId: string;
  instructions: string;
  kind: Trigger['kind'];
  time: string;
  days: number[];
  minutes: string;
  at: string;
  /** A meeting trigger: before or after, how many minutes, and an optional title filter. */
  when: 'before' | 'after';
  offset: string;
  match: string;
  enabled: boolean;
}

type Screen =
  | { kind: 'list' }
  | { kind: 'edit'; draft: Draft; routine?: RoutineView }
  | { kind: 'history'; routine: RoutineView; records: RunRecord[]; open?: string };

const RUN_NOW_HINT = 'The agent is working. Run it when it has finished.';

/** Starting points for meeting routines: they fill the form; the user edits and saves. */
const MEETING_TEMPLATES = [
  {
    name: 'Prepare for meetings',
    blurb: '10 min before each meeting',
    when: 'before' as const,
    minutes: 10,
    instructions:
      'Prepare me for this meeting. From its title, work out who or what it is about, look up the company or people on the web, and check my recent notes on them. Give me a short brief: who they are, what we last discussed, and three questions or points to raise. Keep it under 150 words.',
  },
  {
    name: 'Follow up after meetings',
    blurb: '5 min after each meeting',
    when: 'after' as const,
    minutes: 5,
    instructions:
      'Write the follow-up for this meeting from its notes: a short summary, the decisions, and the action items with owners. Then draft a follow-up email to the attendees for me to review. Only draft: don’t send anything.',
  },
] as const;

export function setupRoutines(hooks: RoutinesHooks) {
  let view: RoutinesView | undefined;
  let screen: Screen = { kind: 'list' };
  let message: { text: string; field?: RoutineField } | undefined;
  const sheet = $('routines-sheet');
  const toggle = $('routines-open');

  const routineById = (id: string) => view?.routines.find((r) => r.id === id);

  // ---- the header button, and the card for what is overdue ---------------------------------

  function paintHeader() {
    const available = !!view?.available;
    toggle.hidden = !available;
    const overdue = view?.overdue ?? 0;
    const badge = $('routines-badge');
    badge.hidden = overdue === 0;
    badge.textContent = overdue > 9 ? '9+' : String(overdue);
    toggle.setAttribute('aria-label', overdue ? `Routines: ${overdue} overdue` : 'Routines');
    toggle.dataset.tip = overdue ? `Routines (${overdue} overdue)` : 'Routines';
    paintCard();
  }

  /** The first overdue routine, as a card above the conversation: you decide before it does anything. */
  function paintCard() {
    const card = $('routines-card');
    const overdue = (view?.routines ?? []).filter((r) => r.status === 'overdue');
    if (!view?.available || !overdue.length) {
      card.hidden = true;
      card.replaceChildren();
      return;
    }
    const first = overdue[0];
    const busy = view.busy;
    card.hidden = false;
    card.replaceChildren(
      h(
        'div',
        { class: 'routines-card-text' },
        h('strong', {}, `Routine overdue: ${first.name}`),
        h('span', {}, `Was due ${first.pending ? describeWhen(first.pending.since, Date.now()) : 'earlier'}. It didn’t run because Uranus Browser was closed or busy.`),
      ),
      h(
        'div',
        { class: 'routines-card-actions' },
        h('button', { class: 'primary-button small', type: 'button', disabled: busy, title: busy ? RUN_NOW_HINT : '', onclick: () => void runNow(first.id) }, 'Run now'),
        h('button', { class: 'secondary-button small', type: 'button', onclick: () => void skip(first.id) }, 'Skip'),
        overdue.length > 1 ? h('button', { class: 'text-button small', type: 'button', onclick: () => open() }, `${overdue.length - 1} more`) : null,
      ),
    );
  }

  // ---- opening and closing ------------------------------------------------------------------

  function open() {
    if (!sheet.hidden) return;
    hooks.beforeOpen();
    screen = { kind: 'list' };
    message = undefined;
    sheet.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    void refresh().then(() => $('routines-new')?.focus());
    paint();
  }

  function close(returnFocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle.focus();
  }

  const isOpen = () => !sheet.hidden;

  async function refresh() {
    view = await invoke<RoutinesView>('routines:get').catch(() => view);
    paintHeader();
    paint();
  }

  /** Runs a change in the shell; keeps why not if it said no. */
  async function ask(name: string, ...args: unknown[]): Promise<Reply> {
    const reply = await invoke<Reply>(name, ...args).catch((err): Reply => ({ error: err instanceof Error ? err.message : 'Something went wrong.' }));
    message = reply?.error ? { text: reply.error, field: reply.field } : undefined;
    return reply ?? {};
  }

  async function runNow(id: string) {
    const reply = await ask('routines:runNow', id);
    if (reply.error) {
      // Shown in the sheet, which opens for it if it was the card that asked.
      const text = reply.error;
      if (!isOpen()) open();
      message = { text };
      paint();
      return;
    }
    close(false);
  }

  async function skip(id: string) {
    await ask('routines:skip', id);
    paint();
  }

  // ---- painting -----------------------------------------------------------------------------

  function paint() {
    if (sheet.hidden) return;
    const body = $('routines-body');
    const current = screen;
    const title = $('routines-title');
    title.textContent = current.kind === 'edit' ? (current.draft.id ? 'Edit routine' : 'New routine') : current.kind === 'history' ? (current.open ? 'Run' : 'History') : 'Routines';
    $('routines-back').hidden = current.kind === 'list';
    $('routines-back').setAttribute('aria-label', current.kind === 'history' && current.open ? 'Back to history' : 'Back to routines');
    body.replaceChildren(current.kind === 'edit' ? editForm(current) : current.kind === 'history' ? historyScreen(current) : list());
  }

  /** The reason a change was refused, where it belongs: under the fields it names (none: at the bottom). */
  const errorIn = (...fields: Array<RoutineField | undefined>) => (message && fields.includes(message.field) ? h('p', { class: 'sheet-error', role: 'alert', id: 'routines-error' }, message.text) : null);

  // ---- the list -----------------------------------------------------------------------------

  function whenLine(r: RoutineView) {
    const now = Date.now();
    switch (r.status) {
      case 'running':
        return { text: 'Running now', tone: 'running' };
      case 'overdue':
        return { text: `Overdue: was due ${r.pending ? describeWhen(r.pending.since, now) : 'earlier'}`, tone: 'overdue' };
      case 'waiting':
        return { text: 'Waiting for the agent to finish', tone: 'waiting' };
      case 'off':
        return { text: 'Off', tone: 'off' };
      case 'finished':
        return { text: 'Ran once. Edit its time to run it again', tone: 'off' };
      default:
        return { text: r.nextAt ? `Next: ${describeWhen(r.nextAt, now)}` : 'Not scheduled', tone: 'next' };
    }
  }

  function routineRow(r: RoutineView) {
    const v = view!;
    const busy = v.busy;
    const when = whenLine(r);
    const comp = v.companions.find((c) => c.id === r.companionId);
    const toggleOn = r.enabled;
    const canRun = r.status !== 'running';
    const sw = h('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(toggleOn),
      'aria-label': `${r.name}: ${toggleOn ? 'on' : 'off'}`,
      'data-tip': toggleOn ? 'Turn off' : 'Turn on',
      onclick: async () => {
        await ask('routines:setEnabled', r.id, !toggleOn);
        paint();
      },
    }, h('span', { class: 'switch-thumb' }));
    return h(
      'li',
      { class: `routine ${r.status}` },
      h(
        'div',
        { class: 'routine-top' },
        h(
          'span',
          { class: 'routine-text' },
          h('span', { class: 'routine-name' }, r.name),
          h('span', { class: 'routine-meta' }, comp ? dot(comp.hue) : null, `${r.companionName ?? 'Companion removed'} · ${describeTrigger(r.trigger, Date.now())}`),
          h('span', { class: `routine-when ${when.tone}` }, when.text),
          r.lastRun ? h('span', { class: 'routine-last' }, `Last run: ${STATUS_LABEL[r.lastRun.status]}, ${describeWhen(r.lastRun.at, Date.now())}`) : null,
        ),
        sw,
      ),
      h(
        'div',
        { class: 'routine-actions' },
        ...(r.status === 'overdue'
          ? [
              h('button', { class: 'primary-button small', type: 'button', disabled: busy || !canRun, title: busy ? RUN_NOW_HINT : '', onclick: () => void runNow(r.id) }, 'Run now'),
              h('button', { class: 'secondary-button small', type: 'button', onclick: async () => (await skip(r.id), undefined) }, 'Skip'),
            ]
          : [h('button', { class: 'secondary-button small', type: 'button', disabled: busy || !canRun, title: busy ? RUN_NOW_HINT : '', onclick: () => void runNow(r.id) }, 'Run now')]),
        h('span', { class: 'spacer' }),
        h('button', { class: 'text-button small', type: 'button', 'aria-label': `History of ${r.name}, ${r.recordCount} run${r.recordCount === 1 ? '' : 's'}`, onclick: () => void openHistory(r.id) }, 'History', r.recordCount ? h('span', { class: 'person-count' }, String(r.recordCount)) : null),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': `Edit ${r.name}`, 'data-tip': 'Edit', onclick: () => edit(r) }, icon('pencil')),
      ),
    );
  }

  function list() {
    const v = view;
    if (!v) return h('p', { class: 'sheet-hint' }, 'Loading…');
    if (!v.available) return h('p', { class: 'sheet-hint' }, 'Routines aren’t available in private windows.');
    const full = v.routines.length >= v.limit;
    return h(
      'div',
      {},
      v.busy ? h('p', { class: 'sheet-hint' }, 'The agent is working. A routine that comes due waits until it has finished.') : null,
      h('button', { id: 'routines-new', class: 'secondary-button wide', type: 'button', disabled: full, onclick: () => edit(undefined) }, icon('plus'), 'New routine'),
      full ? h('p', { class: 'sheet-hint' }, `You can have up to ${v.limit} routines.`) : null,
      v.routines.length
        ? h('ul', { class: 'routine-list', 'aria-label': 'Routines' }, ...v.routines.map(routineRow))
        : h(
            'div',
            { class: 'routines-empty' },
            h('span', { class: 'empty-mark', 'aria-hidden': 'true' }, icon('clock')),
            h('p', { class: 'routines-empty-title' }, 'No routines yet'),
            h('p', { class: 'sheet-hint' }, 'A routine is a task the agent does for you on a schedule: every morning, every hour, or once at a set time. Routines run only while Uranus Browser is open.'),
            h('p', { class: 'sheet-hint' }, 'If Uranus Browser was closed when one was due, it waits for you here instead of running late.'),
          ),
      v.routines.length ? h('p', { class: 'sheet-hint routines-foot' }, 'Routines run only while Uranus Browser is open. A routine that was missed waits for you here. Approval cards still ask first, and if nobody answers for 10 minutes the run stops and does nothing.') : null,
      message ? errorIn(message.field) : null,
    );
  }

  // ---- the form -----------------------------------------------------------------------------

  function draftFor(r?: RoutineView): Draft {
    const t = r?.trigger;
    return {
      id: r?.id,
      name: r?.name ?? '',
      companionId: r && hasCompanion(r.companionId) ? r.companionId : (view?.companions[0]?.id ?? 'general'),
      instructions: r?.instructions ?? '',
      kind: t?.kind ?? 'daily',
      time: t?.kind === 'daily' ? t.time : '09:00',
      days: t?.kind === 'daily' ? [...t.days] : [...WEEKDAYS],
      minutes: t?.kind === 'interval' ? String(t.minutes) : '60',
      at: t?.kind === 'once' ? localInput(t.at) : localInput(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000),
      when: t?.kind === 'meeting' ? t.when : 'before',
      offset: t?.kind === 'meeting' ? String(t.minutes) : '10',
      match: t?.kind === 'meeting' ? t.match : '',
      enabled: r?.enabled ?? true,
    };
  }
  const hasCompanion = (companionId: string) => !!view?.companions.some((c) => c.id === companionId);

  function edit(r?: RoutineView) {
    message = undefined;
    screen = { kind: 'edit', draft: draftFor(r), routine: r };
    paint();
    $('rf-name')?.focus();
  }

  function editForm(state: Extract<Screen, { kind: 'edit' }>) {
    const { draft, routine } = state;
    const invalid = (field: RoutineField) => (message?.field === field ? 'true' : undefined);
    const describedBy = (field: RoutineField) => (message?.field === field ? 'routines-error' : undefined);
    const name = h('input', { id: 'rf-name', class: 'field', type: 'text', maxlength: String(MAX_ROUTINE_NAME), value: draft.name, autocomplete: 'off', required: true, 'aria-invalid': invalid('name'), 'aria-describedby': describedBy('name') }) as HTMLInputElement;
    const companion = h(
      'select',
      { id: 'rf-companion', class: 'field', 'aria-invalid': invalid('companion'), 'aria-describedby': describedBy('companion') },
      ...(view?.companions ?? []).map((c) => h('option', { value: c.id }, c.name)),
    ) as HTMLSelectElement;
    companion.value = draft.companionId;
    const instructions = h('textarea', { id: 'rf-instructions', class: 'field', rows: '6', maxlength: String(MAX_ROUTINE_INSTRUCTIONS), placeholder: 'What the agent should do, as you would ask it in the chat. For example: Read this page and tell me what changed since yesterday.', 'aria-invalid': invalid('instructions'), 'aria-describedby': describedBy('instructions') }) as HTMLTextAreaElement;
    instructions.value = draft.instructions;
    const counter = h('span', { class: 'rf-counter', 'aria-hidden': 'true' }, `${draft.instructions.length}/${MAX_ROUTINE_INSTRUCTIONS}`);
    instructions.addEventListener('input', () => (counter.textContent = `${instructions.value.length}/${MAX_ROUTINE_INSTRUCTIONS}`));

    // When: daily, every N minutes, or once.
    const time = h('input', { id: 'rf-time', class: 'field', type: 'time', value: draft.time, required: true, 'aria-invalid': invalid('time'), 'aria-describedby': describedBy('time') }) as HTMLInputElement;
    const minutes = h('input', { id: 'rf-minutes', class: 'field', type: 'number', min: String(MIN_INTERVAL_MINUTES), max: String(MAX_INTERVAL_MINUTES), step: '1', inputmode: 'numeric', value: draft.minutes, 'aria-invalid': invalid('minutes'), 'aria-describedby': describedBy('minutes') }) as HTMLInputElement;
    const at = h('input', { id: 'rf-at', class: 'field', type: 'datetime-local', value: draft.at, min: localInput(Date.now()), 'aria-invalid': invalid('at'), 'aria-describedby': describedBy('at') }) as HTMLInputElement;
    // Around meetings: N minutes before or after each meeting in the connected calendar.
    const offset = h('input', { id: 'rf-offset', class: 'field rf-offset', type: 'number', min: '0', max: String(MAX_MEETING_OFFSET), step: '5', inputmode: 'numeric', value: draft.offset, 'aria-label': 'Minutes', 'aria-invalid': invalid('offset'), 'aria-describedby': describedBy('offset') }) as HTMLInputElement;
    const whenSelect = h('select', { id: 'rf-when', class: 'field', 'aria-label': 'Before or after' }, h('option', { value: 'before' }, 'minutes before it starts'), h('option', { value: 'after' }, 'minutes after it ends')) as HTMLSelectElement;
    whenSelect.value = draft.when;
    const match = h('input', { id: 'rf-match', class: 'field', type: 'text', maxlength: String(MAX_MATCH), value: draft.match, placeholder: 'Every meeting', autocomplete: 'off' }) as HTMLInputElement;
    function meetingFields() {
      const cal = view?.calendar;
      return h(
        'div',
        { class: 'when-fields', id: 'when-meeting' },
        h('span', { class: 'label' }, 'Runs'),
        h('div', { class: 'rf-meeting-row' }, offset, customSelect(whenSelect)),
        h('label', { for: 'rf-match', class: 'label' }, 'Only meetings whose title contains (optional)'),
        match,
        cal?.connected
          ? h('p', { class: 'sheet-hint' }, `Meetings come from your calendar: timed events with a Google Meet, Zoom or Teams link${cal.upcoming ? ` (${cal.upcoming} coming up in the next day and a half)` : '; none coming up right now'}. The agent gets the meeting’s title and time, as data.`)
          : h(
              'div',
              { class: 'rf-calendar-needed' },
              h('span', {}, 'Connect your calendar first: meeting routines run around its meetings.'),
              hooks.openCalendar ? h('button', { class: 'secondary-button small', type: 'button', onclick: () => hooks.openCalendar!() }, 'Connect a calendar…') : null,
            ),
      );
    }
    const days = new Set(draft.days);
    const dayButtons = WEEK_ORDER.map((d) => {
      const b = h('button', { class: 'day', type: 'button', 'aria-pressed': String(days.has(d)), 'aria-label': dayName(d), 'data-tip': dayName(d), onclick: () => {
        if (days.has(d)) days.delete(d);
        else days.add(d);
        b.setAttribute('aria-pressed', String(days.has(d)));
      } }, shortDayName(d).slice(0, 2));
      return b;
    });
    const dayRow = h('div', { class: 'days', role: 'group', 'aria-label': 'Days of the week', id: 'rf-days' }, ...dayButtons);
    const pickDays = (set: number[]) => {
      days.clear();
      for (const d of set) days.add(d);
      dayButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(days.has(WEEK_ORDER[i]))));
    };
    const panels = {
      daily: h(
        'div',
        { class: 'when-fields', id: 'when-daily' },
        h('label', { for: 'rf-time', class: 'label' }, 'At'),
        time,
        h('span', { class: 'label' }, 'On'),
        dayRow,
        h('div', { class: 'day-presets' }, h('button', { class: 'text-button small', type: 'button', onclick: () => pickDays(WEEKDAYS) }, 'Weekdays'), h('button', { class: 'text-button small', type: 'button', onclick: () => pickDays([0, 1, 2, 3, 4, 5, 6]) }, 'Every day')),
      ),
      interval: h(
        'div',
        { class: 'when-fields', id: 'when-interval' },
        h('label', { for: 'rf-minutes', class: 'label' }, 'Every (minutes)'),
        minutes,
        h('p', { class: 'sheet-hint' }, `At least ${MIN_INTERVAL_MINUTES} minutes. It counts from when you save.`),
      ),
      once: h('div', { class: 'when-fields', id: 'when-once' }, h('label', { for: 'rf-at', class: 'label' }, 'Date and time'), at, h('p', { class: 'sheet-hint' }, 'Your local time. It runs once, if Uranus Browser is open then.')),
      meeting: meetingFields(),
    } as const;
    let kind = draft.kind;
    const segments = h('div', { class: 'segments', role: 'radiogroup', 'aria-label': 'When to run' });
    const labels: Array<[Trigger['kind'], string]> = [['daily', 'Daily'], ['interval', 'Interval'], ['once', 'Once'], ['meeting', 'Meeting']];
    const showKind = () => {
      for (const [k, el] of Object.entries(panels)) el.hidden = k !== kind;
      for (const b of segments.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    };
    for (const [k, label] of labels) {
      segments.append(h('button', { class: 'segment', type: 'button', role: 'radio', 'data-kind': k, 'aria-checked': String(k === kind), tabindex: k === kind ? '0' : '-1', onclick: () => {
        kind = k;
        for (const b of segments.querySelectorAll('button')) b.tabIndex = b.dataset.kind === kind ? 0 : -1;
        showKind();
      } }, label));
    }
    segments.addEventListener('keydown', (e) => {
      const order = labels.map(([k]) => k);
      const i = order.indexOf(kind);
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      kind = order[(i + step + order.length) % order.length];
      showKind();
      for (const b of segments.querySelectorAll('button')) b.tabIndex = b.dataset.kind === kind ? 0 : -1;
      segments.querySelector<HTMLElement>(`[data-kind="${kind}"]`)?.focus();
    });
    showKind();

    const enabled = h('input', { id: 'rf-enabled', type: 'checkbox', class: 'check' }) as HTMLInputElement;
    enabled.checked = draft.enabled;

    const save = async () => {
      const trigger: Record<string, unknown> =
        kind === 'daily'
          ? { kind, time: time.value, days: [...days] }
          : kind === 'interval'
            ? { kind, minutes: minutes.value.trim() === '' ? NaN : Number(minutes.value) }
            : kind === 'meeting'
              ? { kind, when: whenSelect.value, minutes: offset.value.trim() === '' ? NaN : Number(offset.value), match: match.value }
              : { kind, at: at.value ? new Date(at.value).getTime() : NaN };
      const reply = await ask('routines:save', { id: draft.id, name: name.value, companionId: companion.value, instructions: instructions.value, trigger, enabled: enabled.checked });
      if (reply.error) {
        // Keep what was typed, show why, and put the cursor on the field that needs it.
        screen = { kind: 'edit', routine, draft: { ...draft, name: name.value, companionId: companion.value, instructions: instructions.value, kind, time: time.value, days: [...days], minutes: minutes.value, at: at.value, when: whenSelect.value === 'after' ? 'after' : 'before', offset: offset.value, match: match.value, enabled: enabled.checked } };
        paint();
        const target = { name: 'rf-name', companion: 'rf-companion', instructions: 'rf-instructions', time: 'rf-time', days: 'rf-days', minutes: 'rf-minutes', at: 'rf-at', limit: 'rf-name', offset: 'rf-offset' }[reply.field ?? 'name'];
        const field = $(target);
        (field?.id === 'rf-days' ? field.querySelector<HTMLElement>('button') : field)?.focus();
        return;
      }
      screen = { kind: 'list' };
      paint();
      $('routines-new')?.focus();
    };

    // A new routine can start from one of the meeting templates: they fill the form, nothing is saved.
    const useTemplate = (t: (typeof MEETING_TEMPLATES)[number]) => {
      name.value = t.name;
      instructions.value = t.instructions;
      counter.textContent = `${instructions.value.length}/${MAX_ROUTINE_INSTRUCTIONS}`;
      whenSelect.value = t.when;
      whenSelect.dispatchEvent(new Event('change'));
      offset.value = String(t.minutes);
      kind = 'meeting';
      for (const b of segments.querySelectorAll('button')) b.tabIndex = b.dataset.kind === kind ? 0 : -1;
      showKind();
      name.focus();
    };
    return h(
      'form',
      { class: 'edit', novalidate: true, onsubmit: (e) => (e.preventDefault(), void save()) },
      routine
        ? null
        : h(
            'div',
            { class: 'rf-templates', role: 'group', 'aria-label': 'Start from a template' },
            h('span', { class: 'label' }, 'Start from'),
            h('div', { class: 'rf-template-row' }, ...MEETING_TEMPLATES.map((t) => h('button', { class: 'rf-template', type: 'button', onclick: () => useTemplate(t) }, icon(t.when === 'before' ? 'clock' : 'check'), h('span', {}, h('strong', {}, t.name), h('span', {}, t.blurb))))),
          ),
      h('label', { for: 'rf-name', class: 'label' }, 'Name'),
      name,
      errorIn('name'),
      h('label', { for: 'rf-companion', class: 'label' }, 'Who runs it'),
      customSelect(companion),
      errorIn('companion'),
      h('label', { for: 'rf-instructions', class: 'label' }, 'Instructions', counter),
      instructions,
      errorIn('instructions'),
      h('span', { class: 'label' }, 'When'),
      segments,
      panels.daily,
      panels.interval,
      panels.once,
      panels.meeting,
      errorIn('time', 'days', 'minutes', 'at', 'offset'),
      h('label', { class: 'check-row', for: 'rf-enabled' }, enabled, h('span', {}, 'Turn it on')),
      h('p', { class: 'sheet-hint' }, 'It runs as a new conversation in this panel, only while Uranus Browser is open. Anything that sends, buys or changes an account still asks you first, and it stops if no one answers for 10 minutes.'),
      errorIn(undefined, 'limit'),
      h(
        'div',
        { class: 'edit-actions' },
        routine ? h('button', { class: 'text-button danger', type: 'button', onclick: () => confirmRemove(routine) }, 'Delete') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'secondary-button', type: 'button', onclick: () => ((message = undefined), (screen = { kind: 'list' }), paint()) }, 'Cancel'),
        h('button', { class: 'primary-button', type: 'submit' }, 'Save'),
      ),
    );
  }

  /** Deleting takes its history with it: ask in place first. */
  function confirmRemove(r: RoutineView) {
    const body = $('routines-body');
    const row = h(
      'div',
      { class: 'confirm', role: 'alertdialog', 'aria-label': `Delete ${r.name}` },
      h('span', {}, `Delete “${r.name}”${r.recordCount ? ` and its ${r.recordCount} run record${r.recordCount === 1 ? '' : 's'}` : ''}?`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'secondary-button', type: 'button', onclick: () => row.remove() }, 'Keep'),
      h('button', { class: 'primary-button', type: 'button', onclick: async () => {
        const reply = await ask('routines:remove', r.id);
        screen = { kind: 'list' };
        paint();
        if (!reply.error) $('routines-new')?.focus();
      } }, 'Delete'),
    );
    body.querySelector('.confirm')?.remove();
    body.append(row);
    row.querySelector<HTMLElement>('button')?.focus();
  }

  // ---- history ------------------------------------------------------------------------------

  async function openHistory(id: string) {
    const r = routineById(id);
    if (!r) return;
    const reply = await invoke<{ records: RunRecord[] }>('routines:history', id).catch(() => ({ records: [] as RunRecord[] }));
    message = undefined;
    screen = { kind: 'history', routine: r, records: reply.records ?? [] };
    paint();
    $('routines-body').querySelector<HTMLElement>('.record-main, .text-button')?.focus();
  }

  function historyScreen(state: Extract<Screen, { kind: 'history' }>) {
    const { routine, records } = state;
    const opened = state.open ? records.find((x) => x.id === state.open) : undefined;
    if (opened) return recordViewer(state, opened);
    const now = Date.now();
    return h(
      'div',
      {},
      h('p', { class: 'sheet-hint' }, `${routine.name}: the last ${Math.min(records.length, 30) || 30} runs are kept on this computer, in this profile.`),
      records.length
        ? h(
            'ul',
            { class: 'records', 'aria-label': `Runs of ${routine.name}` },
            ...records.map((rec) =>
              h(
                'li',
                { class: 'record' },
                h(
                  'button',
                  { class: 'record-main', type: 'button', onclick: () => ((screen = { ...state, open: rec.id }), paint(), $('routines-back').focus()) },
                  h('span', { class: `status-chip ${rec.status}` }, STATUS_LABEL[rec.status]),
                  h('span', { class: 'record-text' }, h('span', { class: 'record-when' }, describeWhen(rec.startedAt, now)), h('span', { class: 'record-reason' }, rec.reason ?? (rec.finishedAt ? `Took ${duration(rec.finishedAt - rec.startedAt)}` : ''))),
                  icon('arrowRight'),
                ),
                rec.status === 'running'
                  ? null
                  : h('button', { class: 'icon-button', type: 'button', 'aria-label': `Delete the record from ${describeWhen(rec.startedAt, now)}`, 'data-tip': 'Delete record', onclick: async () => {
                      await ask('routines:deleteRecord', rec.id);
                      await reloadHistory();
                    } }, icon('trash')),
              ),
            ),
          )
        : h('p', { class: 'memory-empty' }, 'No runs yet. Use Run now to try it.'),
      records.some((x) => x.status !== 'running') ? h('button', { class: 'text-button danger', type: 'button', onclick: () => confirmClear(routine) }, 'Clear history') : null,
      message ? errorIn(message.field) : null,
    );
  }

  async function reloadHistory() {
    if (screen.kind !== 'history') return paint();
    const reply = await invoke<{ records: RunRecord[] }>('routines:history', screen.routine.id).catch(() => ({ records: screen.kind === 'history' ? screen.records : [] }));
    if (screen.kind !== 'history') return;
    const open = screen.open && reply.records.some((r) => r.id === (screen as { open?: string }).open) ? screen.open : undefined;
    screen = { ...screen, records: reply.records, open };
    paint();
  }

  function recordViewer(state: Extract<Screen, { kind: 'history' }>, rec: RunRecord) {
    const now = Date.now();
    return h(
      'div',
      { class: 'viewer' },
      h(
        'div',
        { class: 'viewer-head' },
        h('span', { class: `status-chip ${rec.status}` }, STATUS_LABEL[rec.status]),
        h('span', { class: 'viewer-meta' }, `${rec.companionName || 'Companion'} · ${describeWhen(rec.startedAt, now)}${rec.finishedAt ? ` · ${duration(rec.finishedAt - rec.startedAt)}` : ''}`),
      ),
      rec.reason ? h('p', { class: 'viewer-reason' }, rec.reason) : null,
      rec.transcript.length
        ? h(
            'ol',
            { class: 'run-lines', 'aria-label': 'What happened' },
            ...rec.transcript.map((l) => h('li', { class: `run-line ${l.kind}` }, h('span', { class: 'run-label' }, { user: 'Instructions', assistant: 'Agent', tool: 'Step', approval: 'Approval', notice: 'Notice' }[l.kind] + (l.state && l.kind !== 'user' && l.kind !== 'assistant' && l.kind !== 'notice' ? ` · ${l.state}` : '')), h('span', { class: 'run-text' }, l.text))),
          )
        : h('p', { class: 'memory-empty' }, rec.status === 'running' ? 'It is running. The conversation is in the panel.' : 'Nothing was recorded for this run.'),
      rec.truncated ? h('p', { class: 'sheet-hint' }, 'Only the end of a long conversation is kept.') : null,
      // A run that went well can become a skill: a draft of its instructions and the steps that worked, to read before saving.
      rec.status === 'done' && hooks.saveAsSkill
        ? h(
            'div',
            { class: 'skill-offer' },
            h('span', { class: 'skill-offer-text' }, h('strong', {}, 'Did this go the way you want?'), h('span', {}, `Save it as one of ${rec.companionName || 'the companion'}’s skills, to do it this way again whenever you ask.`)),
            h('button', { class: 'secondary-button small', type: 'button', onclick: () => hooks.saveAsSkill!(state.routine, rec) }, 'Save as skill'),
          )
        : null,
      h('p', { class: 'sheet-hint' }, 'This is a trimmed copy kept on this computer. Text from web pages is shown as plain text.'),
      rec.status === 'running'
        ? null
        : h('button', { class: 'text-button danger', type: 'button', onclick: async () => {
            await ask('routines:deleteRecord', rec.id);
            screen = { ...state, open: undefined };
            await reloadHistory();
            $('routines-back').focus();
          } }, 'Delete this record'),
    );
  }

  function confirmClear(r: RoutineView) {
    const body = $('routines-body');
    const row = h(
      'div',
      { class: 'confirm', role: 'alertdialog', 'aria-label': 'Clear history' },
      h('span', {}, `Clear all of ${r.name}’s run records?`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'secondary-button', type: 'button', onclick: () => row.remove() }, 'Keep'),
      h('button', { class: 'primary-button', type: 'button', onclick: async () => (await ask('routines:clearHistory', r.id), await reloadHistory()) }, 'Clear'),
    );
    body.querySelector('.confirm')?.remove();
    body.append(row);
    row.querySelector<HTMLElement>('button')?.focus();
  }

  // ---- wiring -------------------------------------------------------------------------------

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  $('routines-close').addEventListener('click', () => close());
  const back = () => {
    message = undefined;
    if (screen.kind === 'history' && screen.open) screen = { ...screen, open: undefined };
    else screen = { kind: 'list' };
    paint();
  };
  $('routines-back').addEventListener('click', back);
  let running = false;
  on('routines', (next: RoutinesView) => {
    view = next;
    // A run began (a routine came due while the sheet was open): the conversation is what to watch now, and its approval cards are there.
    const nowRunning = next.routines.some((r) => r.status === 'running');
    if (nowRunning && !running && isOpen()) close(false);
    running = nowRunning;
    paintHeader();
    if (screen.kind === 'history') {
      const r = next.routines.find((x) => x.id === (screen as { routine: RoutineView }).routine.id);
      if (r) screen = { ...screen, routine: r };
      void reloadHistory();
    } else if (screen.kind === 'list') paint();
  });
  void refresh();

  return {
    isOpen,
    close,
    /** Escape steps back first (form, viewer), then closes the sheet. Returns whether it did anything. */
    escape() {
      if (!isOpen()) return false;
      if (screen.kind !== 'list') back();
      else close();
      return true;
    },
  };
}
