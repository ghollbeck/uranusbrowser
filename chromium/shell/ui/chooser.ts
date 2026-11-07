/**
 * Two small popovers of the Agent panel, after Strawberry's:
 *
 *  - the history list (the clock-arrow button beside "New conversation"): past conversations,
 *    newest first, searchable, with a dot on one that finished while you weren't looking;
 *  - the composer's selector: who the agent works as (companions), which model answers (every
 *    provider's models, in a Model flyout) and how hard it thinks (a Thinking flyout). Its pill
 *    shows the companion and the model. It is the only model picker in the panel.
 *
 * The shell keeps both (agentPanel.ts); this only draws them and sends what you pick.
 */
import type { ChoiceView, ThreadSummary } from '../agentPanel';
import type { CompanionsView } from '../agentPanel';
import type { ReasoningEffort } from '../../shared/browserAgent';
import { invoke, on } from '../client';
import { ICONS, type IconName } from './icons';
import type { ModelMenu } from './modelMenu';

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

type Props = Record<string, string | boolean | undefined | ((e: Event) => void)>;
function h(tag: string, props: Props = {}, ...children: Array<Node | string | null | undefined | false>) {
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

/** A companion's face: a soft disc in its colour with its initial. */
function avatar(name: string, hue: number, cls = 'avatar') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' }, (name.trim()[0] ?? '•').toUpperCase());
  el.style.setProperty('--hue', String(hue));
  return el;
}

/** "9m", "3h", "1d", "2w": how long ago, as short as the list's right edge allows. */
export function ago(then: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs}h`;
  const d = Math.round(hrs / 24);
  if (d < 7) return `${d}d`;
  const w = Math.round(d / 7);
  return w < 52 ? `${w}w` : `${Math.round(d / 365)}y`;
}

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const EFFORT_NAMES: Record<ReasoningEffort, string> = { low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Ultra' };
const EFFORT_HINTS: Record<ReasoningEffort, string> = { low: 'Quickest. Fine for most browsing', medium: 'A little more care', high: 'For research and comparisons', xhigh: 'Slowest, most careful' };

export interface ChooserHooks {
  /** Whether the agent is working: no switching conversations or companions then. */
  busy(): boolean;
  /** Opens the companions sheet (editing companions, their memory). */
  manageCompanions(): void;
  /** A notice in the panel, for a "no" from the shell. */
  say(text: string): void;
  /** The chat's models (modelMenu.ts): the pill names one; the Model flyout lists them. */
  models: ModelMenu;
}

export function setupChooser(hooks: ChooserHooks) {
  // ---- popovers: one open at a time; outside clicks and Escape close them -----------------

  const pops: Array<{ pop: HTMLElement; button: HTMLElement; close(): void }> = [];
  function closeAll(except?: HTMLElement) {
    for (const p of pops) if (p.pop !== except && !p.pop.hidden) p.close();
  }
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Element;
    if (pops.some((p) => p.pop.contains(target) || p.button.contains(target)) || $('chooser-fly').contains(target)) return;
    closeAll();
  });

  // ---- the history list ----------------------------------------------------------------------

  let threads: ThreadSummary[] = [];
  let onlyUnread = false;
  const historyPop = $('history-pop');
  const historyButton = $('history');

  function paintHistory() {
    if (historyPop.hidden) return;
    const q = $<HTMLInputElement>('history-search').value.trim().toLowerCase();
    const shown = threads.filter((t) => (!q || t.title.toLowerCase().includes(q) || t.companion.name.toLowerCase().includes(q)) && (!onlyUnread || t.unread));
    const busy = hooks.busy();
    $('history-list').replaceChildren(
      ...shown.map((t) =>
        h(
          'li',
          { class: `history-row${t.current ? ' current' : ''}`, role: 'option', 'aria-selected': String(t.current) },
          h(
            'button',
            {
              class: 'history-open',
              type: 'button',
              title: t.title,
              disabled: busy && !t.current,
              onclick: () => void openThread(t),
            },
            avatar(t.companion.name, t.companion.hue),
            h('span', { class: 'history-title' }, t.title),
            t.unread ? h('span', { class: 'unread-dot', 'aria-label': 'Unread' }) : null,
            h('span', { class: 'history-age' }, ago(t.updatedAt)),
          ),
          h(
            'button',
            {
              class: 'history-remove icon-button small',
              type: 'button',
              'aria-label': `Delete “${t.title}”`,
              'data-tip': 'Delete',
              onclick: () => void invoke('agentThreads:remove', t.id),
            },
            icon('close'),
          ),
        ),
      ),
    );
    $('history-empty').hidden = shown.length > 0;
    $('history-empty').textContent = threads.length ? 'Nothing matches.' : 'No conversations yet.';
  }

  async function openThread(t: ThreadSummary) {
    closeHistory();
    if (t.current) return;
    const reply = await invoke<{ error?: string }>('agentThreads:open', t.id).catch(() => ({ error: 'Couldn’t open that conversation.' }));
    if (reply?.error) hooks.say(reply.error);
  }

  function openHistory() {
    closeAll(historyPop);
    historyPop.hidden = false;
    historyButton.setAttribute('aria-expanded', 'true');
    historyButton.classList.add('on');
    void invoke<ThreadSummary[]>('agentThreads:list').then((list) => {
      threads = list ?? [];
      paintHistory();
    });
    paintHistory();
    $('history-search').focus();
  }
  function closeHistory() {
    historyPop.hidden = true;
    historyButton.setAttribute('aria-expanded', 'false');
    historyButton.classList.remove('on');
  }
  pops.push({ pop: historyPop, button: historyButton, close: closeHistory });
  historyButton.addEventListener('click', () => (historyPop.hidden ? openHistory() : closeHistory()));
  $('history-search').addEventListener('input', paintHistory);
  $('history-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (historyPop.querySelector<HTMLButtonElement>('.history-open:not(:disabled)'))?.click();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      historyPop.querySelector<HTMLButtonElement>('.history-open')?.focus();
    }
  });
  $('history-list').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...historyPop.querySelectorAll<HTMLButtonElement>('.history-open')];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  $('history-unread').addEventListener('click', () => {
    onlyUnread = !onlyUnread;
    $('history-unread').setAttribute('aria-pressed', String(onlyUnread));
    paintHistory();
  });
  on('agentThreads', (list: ThreadSummary[]) => {
    threads = list;
    const unread = threads.some((t) => t.unread && !t.current);
    historyButton.classList.toggle('has-unread', unread);
    paintHistory();
  });
  void invoke<ThreadSummary[]>('agentThreads:list').then((list) => {
    threads = list ?? [];
    historyButton.classList.toggle('has-unread', threads.some((t) => t.unread && !t.current));
  });

  // ---- the composer's selector ---------------------------------------------------------------

  let people: CompanionsView | undefined;
  let choice: ChoiceView | undefined;
  /** Which flyout is open beside the menu. */
  let flyKind: 'model' | 'thinking' | undefined;
  const pop = $('chooser-pop');
  const button = $('chooser');
  const fly = $('chooser-fly');

  const activePerson = () => people?.companions.find((c) => c.id === people!.active) ?? people?.companions[0];

  const effort = (): ReasoningEffort => choice?.modes.default.effort ?? 'low';

  function paintButton() {
    const c = activePerson();
    const model = hooks.models.label();
    $('chooser-label').textContent = model;
    button.dataset.ready = String(hooks.models.ready());
    $('chooser-dot').replaceWith(Object.assign(avatar(c?.name ?? 'General', c?.hue ?? 262, 'chooser-dot avatar'), { id: 'chooser-dot' }));
    button.setAttribute('aria-label', `${c?.name ?? 'General'}, ${model}, ${EFFORT_NAMES[effort()]} thinking. Change companion, model or thinking`);
    button.dataset.tip = `${c?.name ?? 'General'} · ${model} · ${EFFORT_NAMES[effort()]} thinking`;
  }

  function paintPop() {
    if (pop.hidden) return;
    const q = $<HTMLInputElement>('chooser-search').value.trim().toLowerCase();
    const busy = hooks.busy();
    const list = (people?.companions ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || (c.role ?? '').toLowerCase().includes(q));
    $('chooser-people').replaceChildren(
      ...list.map((c) => {
        const on = c.id === people?.active;
        return h(
          'li',
          {},
          h(
            'button',
            {
              class: `chooser-row${on ? ' on' : ''}`,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': String(on),
              disabled: busy && !on,
              title: c.role || undefined,
              onclick: async () => {
                if (on) return closePop();
                const reply = await invoke<{ error?: string }>('companions:select', c.id).catch(() => ({ error: 'Couldn’t switch companions.' }));
                if (reply?.error) hooks.say(reply.error);
                closePop();
              },
            },
            avatar(c.name, c.hue),
            h('span', { class: 'chooser-name' }, c.name),
            on ? h('span', { class: 'check', 'aria-hidden': 'true' }, icon('check')) : null,
          ),
        );
      }),
    );
    const row = (kind: 'model' | 'thinking', iconName: IconName, label: string, value: string) => {
      const el = h(
        'button',
        {
          id: `chooser-${kind}`,
          class: `chooser-row mode${flyKind === kind ? ' open' : ''}`,
          type: 'button',
          role: 'menuitem',
          'aria-haspopup': 'menu',
          'aria-expanded': String(flyKind === kind),
          onclick: () => (flyKind === kind ? closeFly() : openFly(kind, el)),
          onkeydown: (e: Event) => {
            if ((e as KeyboardEvent).key === 'ArrowRight' || (e as KeyboardEvent).key === 'ArrowLeft') {
              e.preventDefault();
              openFly(kind, el);
              fly.querySelector<HTMLElement>('[aria-checked="true"], .mm-item:not([aria-disabled]), .chooser-row')?.focus();
            }
          },
        },
        h('span', { class: 'mode-icon' }, icon(iconName)),
        h('span', { class: 'chooser-name' }, label),
        h('span', { class: 'chooser-value' }, value),
        h('span', { class: 'more', 'aria-hidden': 'true' }, icon('chevron')),
      );
      el.addEventListener('pointerenter', () => openFly(kind, el));
      return h('li', {}, el);
    };
    $('chooser-modes').replaceChildren(row('model', 'sparkle', 'Model', hooks.models.label()), row('thinking', 'zap', 'Thinking', EFFORT_NAMES[effort()]));
    $('chooser-manage').toggleAttribute('disabled', false);
  }

  /** The Model list (every provider's models) or the Thinking choices, beside the menu. */
  function paintFly() {
    if (!flyKind) return;
    if (flyKind === 'model') {
      fly.replaceChildren(...hooks.models.render(() => closePop()));
      fly.setAttribute('aria-label', 'Model');
      return;
    }
    const current = effort();
    fly.setAttribute('aria-label', 'Thinking');
    fly.replaceChildren(
      h('div', { class: 'mm-head' }, 'How hard it thinks'),
      ...EFFORTS.map((e) =>
        h(
          'button',
          {
            class: 'mm-item',
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(e === current),
            onclick: async () => {
              choice = await invoke<ChoiceView>('agentChoice:set', { mode: 'default', effort: e });
              paintButton();
              paintPop();
              paintFly();
            },
          },
          h('span', { class: 'mm-label' }, EFFORT_NAMES[e]),
          h('span', { class: 'mm-detail' }, EFFORT_HINTS[e]),
          e === current ? icon('check') : null,
        ),
      ),
      h('p', { class: 'mm-note' }, 'More thinking is slower and uses more of your plan or credits.'),
    );
  }

  function openFly(kind: 'model' | 'thinking', row: HTMLElement) {
    const changed = flyKind !== kind;
    flyKind = kind;
    for (const el of pop.querySelectorAll('.chooser-row.mode')) {
      el.classList.toggle('open', el === row);
      el.setAttribute('aria-expanded', String(el === row));
    }
    paintFly();
    fly.hidden = false;
    // The models come fresh from the account each time the list opens.
    if (kind === 'model' && changed) void hooks.models.refresh();
    // Beside the menu when there's room, else just above it.
    const panel = $('panel').getBoundingClientRect();
    const menu = pop.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const width = fly.offsetWidth;
    const form = $('composer').getBoundingClientRect();
    if (menu.left - panel.left >= width + 8) {
      fly.style.left = `${menu.left - form.left - width - 6}px`;
      fly.style.top = '';
      fly.style.bottom = `${Math.max(0, form.bottom - Math.min(panel.bottom - 8, r.bottom + 8))}px`;
    } else {
      fly.style.left = `${Math.max(panel.left + 8, menu.right - width) - form.left}px`;
      fly.style.top = '';
      fly.style.bottom = `${form.bottom - menu.top + 6}px`;
    }
    // Never past the panel's top edge: a long list scrolls inside instead.
    fly.style.maxHeight = `${Math.max(140, Math.floor(form.bottom - parseFloat(fly.style.bottom) - panel.top - 12))}px`;
  }
  function closeFly() {
    fly.hidden = true;
    flyKind = undefined;
    for (const el of pop.querySelectorAll('.chooser-row.mode')) {
      el.classList.remove('open');
      el.setAttribute('aria-expanded', 'false');
    }
  }
  fly.addEventListener('keydown', (e) => {
    const items = [...fly.querySelectorAll<HTMLElement>('.mm-item:not([aria-disabled])')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const back = flyKind && $(`chooser-${flyKind}`);
      closeFly();
      back?.focus();
    }
  });
  // The list changes (a pick, fresh models, the provider): the pill and an open list follow.
  hooks.models.onChange(() => {
    paintButton();
    if (!pop.hidden) paintPop();
    if (flyKind === 'model') paintFly();
  });

  /** Updates the shell pushed; a reply to an older question mustn't undo them. */
  let peopleUpdates = 0;
  let choiceUpdates = 0;

  async function openPop() {
    closeAll(pop);
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    $<HTMLInputElement>('chooser-search').value = '';
    paintPop();
    $('chooser-search').focus();
    // Fresh lists: the models come from the account the first time. A change the shell sent
    // meanwhile (a companion picked in the sheet) is newer than these answers: it wins.
    const seen = { people: peopleUpdates, choice: choiceUpdates };
    const [p, c] = await Promise.all([invoke<CompanionsView>('companions:get').catch(() => people), invoke<ChoiceView>('agentChoice:get').catch(() => choice)]);
    if (seen.people === peopleUpdates) people = p ?? people;
    if (seen.choice === choiceUpdates) choice = c ?? choice;
    paintButton();
    paintPop();
  }
  function closePop() {
    pop.hidden = true;
    closeFly();
    button.setAttribute('aria-expanded', 'false');
  }
  pops.push({ pop, button, close: closePop });
  button.addEventListener('click', () => (pop.hidden ? void openPop() : closePop()));
  $('chooser-search').addEventListener('input', paintPop);
  $('chooser-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pop.querySelector<HTMLButtonElement>('.chooser-row:not(:disabled)')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pop.querySelector<HTMLButtonElement>('#chooser-people .chooser-row:not(:disabled)')?.click();
    }
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if ((e.target as Element).id === 'chooser-search') return;
    e.preventDefault();
    const rows = [...pop.querySelectorAll<HTMLButtonElement>('.chooser-row:not(:disabled)')];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  pop.addEventListener('pointerleave', (e) => {
    if (!fly.contains(e.relatedTarget as Node)) closeFly();
  });
  $('chooser-manage').addEventListener('click', () => {
    closePop();
    hooks.manageCompanions();
  });

  on('companions', (view: CompanionsView) => {
    peopleUpdates++;
    people = view;
    paintButton();
    paintPop();
  });
  on('agentChoice', (view: ChoiceView) => {
    choiceUpdates++;
    choice = view;
    paintButton();
    paintPop();
  });
  void invoke<CompanionsView>('companions:get').then((view) => {
    if (peopleUpdates === 0) people = view;
    paintButton();
  });
  void invoke<ChoiceView>('agentChoice:get').then((view) => {
    if (choiceUpdates === 0) choice = view;
    paintButton();
  });

  return {
    /** Escape closes an open popover (the flyout first). Returns whether it did. */
    escape() {
      if (!fly.hidden) {
        closeFly();
        return true;
      }
      if (!pop.hidden) {
        closePop();
        button.focus();
        return true;
      }
      if (!historyPop.hidden) {
        closeHistory();
        historyButton.focus();
        return true;
      }
      return false;
    },
    /** The agent started or stopped: rows that can't be picked while it works. */
    repaint() {
      paintPop();
      paintHistory();
    },
  };
}
