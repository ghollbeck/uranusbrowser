/**
 * The Agent panel page (agent.html?window=<id>), shown by the browser beside the page area
 * (patch 0042). It draws the conversation the native host runs and sends what the user does;
 * it never sees the API key, and page text reaches it only as the short tool log.
 *
 * Its dock handle drags the panel to the other side of the window; its inner edge resizes it.
 * Neither moves keyboard focus: the page keeps it until you click or tab into the panel.
 */
import '../lib/themeFade';
import type { ChatEntry, ChatSnapshot, PageChip } from '../../shared/browserAgent';
import type { UiState } from '../../shared/types';
import { cmd, invoke, on } from '../client';
import { clampWidth, dropTarget, widthFromDrag, type DropTarget, type PanelLayout, type PanelSide } from '../lib/agentPanelState';
import { ICONS, type IconName } from './icons';
import { setupCompanions } from './companionsSheet';
import { renderArtifact } from './artifacts';
import { setupRoutines } from './routinesSheet';
import { setupMeetings as setupJoinly } from './joinlySheet';
import { setupMeetings } from './meetingsSheet';
import { setupChooser } from './chooser';
import { setupModelMenu } from './modelMenu';
import { setupSkillPicker } from './skillPicker';
import { renderMarkdown } from './markdownView';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const windowId = Number(new URLSearchParams(location.search).get('window')) || undefined;

function icon(name: IconName) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  el.append(path);
  return el;
}
for (const el of document.querySelectorAll<HTMLElement>('i[data-icon]')) el.replaceWith(icon(el.dataset.icon as IconName));

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

// ---- layout: side, width, the dock handle and the resize edge ----------------------------

let layout: PanelLayout = { open: true, side: 'right', width: 400 };

function applyLayout(next: PanelLayout) {
  layout = next;
  // A floating panel lays out like a right-docked one: its resize edge is on the left.
  document.body.dataset.side = layout.float ? 'right' : layout.side;
  document.body.classList.toggle('floating', !!layout.float);
  const other = layout.side === 'right' ? 'left' : 'right';
  $('dock-handle').setAttribute('aria-label', layout.float ? 'Move the panel: drag it anywhere, or press Enter to dock it on the right' : `Move the panel: drag it to the ${other} or into the middle to float it, or press Enter`);
  $('dock-handle').dataset.tip = layout.float ? 'Drag to move · to an edge to dock' : `Drag to move or float · to the ${other} to dock`;
  const edge = $('resize');
  edge.setAttribute('aria-valuenow', String(layout.width));
  edge.setAttribute('aria-valuemin', '320');
  edge.setAttribute('aria-valuemax', '720');
}

on('agentPanel', (panel: PanelLayout & { focusWindow?: number }) => {
  applyLayout(panel);
  // Opened from the keyboard shortcut: the composer, since that's what you asked for.
  if (panel.open && panel.focusWindow !== undefined && panel.focusWindow === windowId) $('input').focus();
});

async function windowBounds() {
  const fallback = { left: screenX, top: screenY, width: outerWidth, height: outerHeight };
  if (windowId === undefined) return fallback;
  const w = await chrome.windows.get(windowId).catch(() => undefined);
  return { left: w?.left ?? fallback.left, top: w?.top ?? fallback.top, width: w?.width ?? fallback.width, height: w?.height ?? fallback.height };
}

/**
 * Dragging the handle: while you drag, the window's frame page draws where the panel would
 * land (docked on a side, or floating where you'd let go); the panel moves on release.
 */
function setupDockDrag() {
  const handle = $('dock-handle');
  const hint = $('dock-hint');
  type Bounds = Awaited<ReturnType<typeof windowBounds>>;
  let drag: { pointer: number; startX: number; startY: number; grab: { x: number; y: number }; bounds: Bounds; moved: boolean; target?: DropTarget } | undefined;
  let frame = 0;
  const sendPreview = () => {
    frame = 0;
    cmd('agentPanel:preview')(drag?.moved && drag.target ? { windowId, width: layout.width, target: drag.target } : null);
  };

  const targetAt = (e: PointerEvent) => {
    const b = drag!.bounds;
    return dropTarget({ x: e.screenX - b.left, y: e.screenY - b.top }, drag!.grab, b, layout);
  };

  handle.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    // Where on the panel you grabbed it: a floating panel keeps that spot under the pointer.
    drag = { pointer: e.pointerId, startX: e.screenX, startY: e.screenY, grab: { x: e.clientX, y: e.clientY }, bounds: { left: screenX, top: screenY, width: outerWidth, height: outerHeight }, moved: false };
    drag.bounds = await windowBounds();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.hypot(e.screenX - drag.startX, e.screenY - drag.startY) < 6) return;
    drag.moved = true;
    const target = (drag.target = targetAt(e));
    document.body.classList.add('docking');
    document.body.dataset.drop = target.kind === 'dock' ? target.side : 'float';
    hint.hidden = false;
    hint.textContent =
      target.kind === 'float'
        ? 'Release to float it here'
        : !layout.float && target.side === layout.side
          ? `Release to keep it on the ${target.side}`
          : `Release to dock on the ${target.side}`;
    if (!frame) frame = requestAnimationFrame(sendPreview);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moved = drag.moved;
    const target = moved ? targetAt(e) : undefined;
    drag = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    cmd('agentPanel:preview')(null);
    document.body.classList.remove('docking');
    delete document.body.dataset.drop;
    hint.hidden = true;
    if (!target) return;
    if (target.kind === 'float') cmd('agentPanel:float')(target.rect);
    else if (layout.float || target.side !== layout.side) cmd('agentPanel:dock')(target.side);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    // Floating: back to the right; docked: to the other side.
    cmd('agentPanel:dock')((layout.float || layout.side === 'left' ? 'right' : 'left') satisfies PanelSide);
  });
}

function setupResize() {
  const edge = $('resize');
  let drag: { pointer: number; startX: number; startWidth: number } | undefined;
  let frame = 0;
  let wanted = layout.width;
  let asked = layout.width;
  let lastKeyAt = -Infinity;
  const send = () => {
    frame = 0;
    cmd('agentPanel:resize')(wanted);
  };
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    edge.setPointerCapture(e.pointerId);
    drag = { pointer: e.pointerId, startX: e.screenX, startWidth: layout.float?.width ?? layout.width };
    document.body.classList.add('resizing');
  });
  edge.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    wanted = widthFromDrag(layout.float ? 'right' : layout.side, drag.startWidth, drag.startX, e.screenX);
    if (!frame) frame = requestAnimationFrame(send);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag = undefined;
    document.body.classList.remove('resizing');
  };
  edge.addEventListener('pointerup', end);
  edge.addEventListener('pointercancel', end);
  edge.addEventListener('keydown', (e) => {
    const side = layout.float ? 'right' : layout.side;
    const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
    const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    // A held key repeats faster than the layout comes back: step from the width asked for
    // last while keys are arriving, and from the real one otherwise.
    const now = performance.now();
    if (now - lastKeyAt > 400) asked = layout.float?.width ?? layout.width;
    lastKeyAt = now;
    asked = clampWidth(asked + (e.key === grow ? 16 : -16));
    cmd('agentPanel:resize')(asked);
  });
}

// ---- the current tab ---------------------------------------------------------------------

function hueFor(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The current tab, as the composer's chip shows it and a sent message carries it. */
let currentPage: PageChip | undefined;
/** The current tab's address: the meeting sheet offers it when it is a meeting. Never sent anywhere from here. */
let currentUrl: string | undefined;

/** A small square with the site's first letter, tinted per site. */
function siteTile(site: string, cls = 'site-tile') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' }, (site.replace(/^[^a-z0-9]+/i, '')[0] ?? '•').toUpperCase());
  el.style.setProperty('--hue', String(hueFor(site)));
  return el;
}

on('state', (s: UiState) => {
  const space = s.spaces.find((sp) => sp.id === s.activeSpaceId) ?? s.spaces[0];
  const tab = space?.activeTabId ? s.tabs[space.activeTabId] : undefined;
  let site = '';
  try {
    site = tab ? new URL(tab.url).host.replace(/^www\./, '') : '';
  } catch {
    site = '';
  }
  const title = tab ? tab.customTitle || tab.title || 'Untitled' : 'No tab';
  currentPage = tab ? { title, host: site } : undefined;
  currentUrl = tab?.url;
  joinlySheet?.repaint();
  $('page-chip-title').textContent = title;
  $('page-chip-host').textContent = site;
  $('page-chip').title = tab ? `${title}\n${tab.url}` : '';
  $('page-chip').setAttribute('aria-label', tab ? `Current tab: ${title}${site ? `, ${site}` : ''}` : 'No current tab');
  $('page-chip-icon').replaceWith(Object.assign(siteTile(site), { id: 'page-chip-icon' }));
  meetings?.repaint();
});

// ---- the conversation --------------------------------------------------------------------

let snapshot: ChatSnapshot | undefined;
/** A follow-up written while the agent works; it goes as soon as the agent is free. */
let queued: string | undefined;

const TOOL_STATE: Record<string, string> = {
  running: '',
  done: '',
  failed: 'Failed',
  declined: 'Declined',
  blocked: 'Not allowed',
};

function renderEntry(entry: ChatEntry, previous: ChatEntry | undefined): HTMLElement {
  switch (entry.kind) {
    case 'user':
      return h(
        'li',
        { class: 'msg user' },
        entry.page ? h('div', { class: 'chip sent' }, siteTile(entry.page.host), h('span', { class: 'chip-text' }, h('span', { class: 'chip-title' }, entry.page.title), h('span', { class: 'chip-host' }, entry.page.host))) : null,
        h('div', { class: 'bubble' }, entry.text),
      );
    case 'assistant': {
      // The agent's mark starts each of its turns, as a name would in a chat.
      const startsTurn = !previous || previous.kind === 'user';
      // Markdown, drawn as DOM nodes (markdownView.ts): link pills open a new tab.
      const body = renderMarkdown(entry.text, { open: (url) => cmd('newTab')(url) });
      body.classList.add('text');
      return h('li', { class: 'msg assistant' }, startsTurn ? h('span', { class: 'agent-mark', 'aria-hidden': 'true' }, icon('agent')) : null, body);
    }
    case 'notice':
      return h('li', { class: `notice ${entry.tone}${entry.text.startsWith('Routine: ') ? ' routine-notice' : ''}`, role: entry.tone === 'error' ? 'alert' : undefined }, entry.text);
    case 'tool': {
      const label = TOOL_STATE[entry.state];
      const site = currentPage?.host ?? '';
      return h(
        'li',
        { class: `step ${entry.state}` },
        entry.tool === 'read_page' || entry.tool === 'navigate' || entry.tool === 'list_tabs' || entry.tool === 'get_active_tab' || entry.tool === 'switch_tab' ? siteTile(site, 'site-tile step-tile') : h('span', { class: 'step-tile icon' }, icon(stepIcon(entry.tool))),
        h('span', { class: 'step-text' }, h('span', { class: 'step-summary' }, entry.summary), entry.detail ? h('span', { class: 'step-detail' }, entry.detail) : null),
        entry.state === 'running' ? h('span', { class: 'spinner', 'aria-label': 'Running' }) : label ? h('span', { class: 'step-state' }, label) : null,
      );
    }
    case 'artifact':
      return renderArtifact(entry.artifact);
    case 'approval': {
      const pending = entry.state === 'pending';
      const decide = (approve: boolean) => () => cmd('agent:action')({ action: 'decide', approvalId: entry.id, approve });
      return h(
        'li',
        { class: `approval ${entry.state}`, role: 'group', 'aria-label': 'Approval needed' },
        h('div', { class: 'approval-head' }, icon('shield'), h('strong', {}, pending ? 'Approve this action?' : approvalLabel(entry.state))),
        h('p', { class: 'approval-summary' }, entry.summary),
        // A memory card has no site: its tile is the memory mark.
        h('div', { class: 'chip' }, entry.tab.host ? siteTile(entry.tab.host) : h('span', { class: 'site-tile memory-tile', 'aria-hidden': 'true' }, icon(entry.skill ? 'book' : 'star')), h('span', { class: 'chip-text' }, h('span', { class: 'chip-title' }, entry.tab.title), entry.tab.host ? h('span', { class: 'chip-host' }, entry.tab.host) : null)),
        h('ul', { class: 'approval-reasons' }, ...entry.reasons.map((r) => h('li', {}, r))),
        // A skill's steps are what's being approved: shown open.
        entry.full ? h('details', { class: 'approval-full', open: !!entry.skill && pending }, h('summary', {}, entry.skill ? 'The steps' : 'Show all of it'), h('pre', {}, entry.full)) : null,
        pending
          ? h(
              'div',
              { class: 'approval-actions' },
              h('button', { class: 'secondary-button', type: 'button', onclick: decide(false) }, 'Decline'),
              h('button', { class: 'text-button', type: 'button', onclick: takeOver }, 'Take over'),
              h('span', { class: 'spacer' }),
              h('button', { class: 'primary-button', type: 'button', onclick: decide(true) }, 'Approve'),
            )
          : null,
      );
    }
  }
}

const stepIcon = (tool: string): IconName => tool.startsWith('meeting_') ? 'users' : (({ scroll: 'arrowDown', click: 'pointer', type: 'keyboard', press: 'keyboard', remember: 'star', use_skill: 'book', save_skill: 'book', read_file: 'fileText' }) as Record<string, IconName>)[tool] ?? 'sparkle';

const approvalLabel = (state: string) => ({ approved: 'Approved', declined: 'Declined: nothing was done', expired: 'Stopped: nothing was done' })[state] ?? state;

const atBottom = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
/** Whether the transcript keeps showing the latest entry: until you scroll up, and again once you're back. */
let follow = true;

function render(next: ChatSnapshot) {
  const before = snapshot;
  snapshot = next;
  const list = $('transcript');
  // Only what changed is redrawn, in place, so scrolling and focus stay where they are.
  next.entries.forEach((entry, i) => {
    const previous = next.entries[i - 1];
    const key = `${JSON.stringify(entry)}|${previous?.kind ?? ''}`;
    const existing = list.children[i] as HTMLElement | undefined;
    if (existing?.dataset.key === key) return;
    const el = renderEntry(entry, previous);
    el.dataset.key = key;
    if (existing) existing.replaceWith(el);
    else list.append(el);
  });
  while (list.children.length > next.entries.length) list.lastElementChild!.remove();
  // Your own new message, and a card waiting for you, always come into view.
  const last = next.entries.at(-1);
  const grew = next.entries.length > (before?.entries.length ?? 0);
  if ((grew && last?.kind === 'user') || (last?.kind === 'approval' && last.state === 'pending')) follow = true;
  if (follow) list.scrollTop = list.scrollHeight;
  $('to-latest').hidden = follow || atBottom(list);
  $('empty').hidden = next.entries.length > 0;

  const busy = next.status !== 'idle';
  if (companions && (before?.status !== 'idle') !== busy) {
    companions.repaint();
    chooser?.repaint();
  }
  const status = $('status');
  status.textContent = next.provider?.ready === false ? 'Not set up' : '';
  status.dataset.status = next.status;
  $('working').hidden = !busy;
  $('working').dataset.status = next.status;
  $('working-text').textContent = next.status === 'waiting' ? 'Waiting for your approval' : (next.activity ?? 'Working on it…');
  $('stop').hidden = !busy;
  $('send').hidden = busy && !$<HTMLTextAreaElement>('input').value.trim();
  paintPlaceholder();
  const banner = $('provider');
  banner.hidden = next.provider?.ready !== false;
  $('provider-text').textContent = next.provider?.ready === false ? (next.provider.detail ?? 'The agent isn’t set up.') : '';
  models.setProvider(next.provider, busy);
  // The agent is free: a queued follow-up goes now.
  if (!busy && queued) {
    const text = queued;
    queued = undefined;
    cmd('agent:action')({ action: 'send', text, page: currentPage });
  }
}

on('agent:chat', (next: ChatSnapshot) => render(next));

/** The text field's hint: a follow-up while the agent works; "/" when the companion has skills. */
function paintPlaceholder() {
  const busy = !!snapshot && snapshot.status !== 'idle';
  $<HTMLTextAreaElement>('input').placeholder = busy ? (queued ? 'Follow-up queued…' : 'Queue a follow-up…') : companions?.activeSkills().length ? 'Ask anything, or type / for a skill…' : 'Ask or work on anything…';
}

function send() {
  const input = $<HTMLTextAreaElement>('input');
  const busy = !!snapshot && snapshot.status !== 'idle';
  // A skill picked with "/" and no words runs as it is.
  const text = input.value.trim() || (!busy && skillPicker.has() ? 'Do this now.' : '');
  if (!text) return;
  if (busy) {
    // A picked skill waits on its chip for a message of its own.
    queued = queued ? `${queued}\n${text}` : text;
  } else {
    const skill = skillPicker.take();
    cmd('agent:action')({ action: 'send', text: skill && !input.value.trim() ? `Use the skill “${skill.name}”.` : text, page: currentPage, ...(skill ? { skill: skill.id } : {}) });
  }
  input.value = '';
  autosize();
  if (snapshot) render(snapshot);
}

function takeOver() {
  cmd('agent:takeOver')();
}

function autosize() {
  const input = $<HTMLTextAreaElement>('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('input').addEventListener('input', () => {
  autosize();
  if (snapshot) $('send').hidden = snapshot.status !== 'idle' && !$<HTMLTextAreaElement>('input').value.trim();
});
$('transcript').addEventListener('scroll', () => {
  follow = atBottom($('transcript'));
  $('to-latest').hidden = follow;
});
$('to-latest').addEventListener('click', () => {
  follow = true;
  $('transcript').scrollTo({ top: $('transcript').scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
$('stop').addEventListener('click', () => {
  queued = undefined;
  cmd('agent:action')({ action: 'stop' });
});
$('takeover').addEventListener('click', takeOver);
// "Not set up": straight to Settings › AI.
$('provider-setup').addEventListener('click', () => void invoke('openSettings', 'ai'));
$('new-chat').addEventListener('click', () => {
  queued = undefined;
  cmd('agent:action')({ action: 'reset' });
});
$('close').addEventListener('click', () => {
  // A recording in progress asks before the panel goes (meetings sheet).
  if (meetings.beforeClose()) return;
  cmd('agentPanel:close')();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) {
    e.preventDefault();
    // An open sheet closes first; the next Escape closes the panel (or asks, if a meeting is being recorded).
    if (chooser?.escape() || joinlySheet?.escape() || companions?.escape() || routines?.escape() || meetings?.escape()) return;
    if (meetings?.beforeClose()) return;
    cmd('agentPanel:close')();
  }
});

const models = setupModelMenu();
const companions = setupCompanions({ busy: () => !!snapshot && snapshot.status !== 'idle', useSkill: (skill) => skillPicker.set(skill) });
// The composer's "/" menu: the active companion's skills.
const skillPicker = setupSkillPicker({
  skills: () => companions.activeSkills(),
  manage: () => companions.open(undefined, 'skills'),
  changed: () => autosize(),
});
on('companions', () => (skillPicker.refresh(), paintPlaceholder()));
// Routines: one sheet open at a time.
const routines = setupRoutines({
  beforeOpen: () => companions.close(),
  // Meeting routines need a calendar: the Meetings sheet's Calendar screen connects one.
  openCalendar: () => {
    routines.close(false);
    meetings.openCalendar();
  },
  saveAsSkill: async (routine, record) => {
    const draft = await invoke<{ name: string; when: string; steps: string }>('companions:draftSkill', { routineName: routine.name, instructions: routine.instructions, transcript: record.transcript });
    routines.close(false);
    companions.draftSkill(record.companionId || routine.companionId, draft, { kind: 'routine', name: routine.name });
  },
});
$('companion').addEventListener('click', () => routines.close(false), true);
// The agent joining a meeting through the user's own joinly server: the sheet and the banner.
const joinlySheet = setupJoinly({ closeOthers: () => { while (companions.isOpen()) companions.escape(); }, currentUrl: () => currentUrl });
// The user's own meeting notes: record, transcribe, summarise.
const meetings = setupMeetings({
  busy: () => !!snapshot && snapshot.status !== 'idle',
  // "Discuss in chat": the meeting's notes go to the agent as the user's own message.
  discuss: (text) => {
    if (snapshot && snapshot.status !== 'idle') return false;
    cmd('agent:action')({ action: 'send', text });
    return true;
  },
  page: () => currentPage,
  closePanel: () => cmd('agentPanel:close')(),
});
// The history list (beside "New conversation") and the composer's companion and mode selector.
const chooser = setupChooser({
  models,
  busy: () => !!snapshot && snapshot.status !== 'idle',
  manageCompanions: () => companions.open(),
  say: (text) => {
    const status = $('status');
    status.textContent = text;
    setTimeout(() => snapshot && render(snapshot), 4000);
  },
});
setupDockDrag();
setupResize();
void invoke<PanelLayout & { chat?: ChatSnapshot }>('agentPanel:get')
  .then((current) => {
    applyLayout({ ...current, open: true });
    if (current.chat) render(current.chat);
  })
  .catch((err) => console.error('Uranus Browser agent panel: no layout yet', err))
  .finally(() => cmd('agent:action')({ action: 'hello' }));
