/**
 * The Agent panel's companions sheet: who the agent works as, and everything each companion
 * has. It only draws what the shell saved (shell/agentPanel.ts) and asks the shell to change
 * it; nothing here reaches the model. Built with DOM calls, never innerHTML: names, notes,
 * file text and skills are text.
 *
 * Screens:
 *  - the list: every companion, with what it has ("3 skills · 2 files · 5 notes"); a click on
 *    a row picks it, the chevron opens its profile;
 *  - a profile, in four tabs: About (role and instructions), Knowledge (project context and
 *    files), Skills and Memory. Built-in companions can't be renamed or re-instructed (a copy
 *    can), but their knowledge, skills and memory are yours to fill;
 *  - the companion form (name, role, instructions, colour) and the skill form (name, when to
 *    use it, steps). A routine run that went well opens the skill form with a draft.
 */
import { MAX_INSTRUCTIONS, MAX_NAME, MAX_NOTE, MAX_NOTES, MAX_ROLE, type Companion } from '../../shared/companions';
import { ACCEPT, KIND_LABEL, MAX_CONTEXT, MAX_FILES, kindOf, sizeLabel, type CompanionFile } from '../../shared/knowledge';
import { MAX_SKILL_NAME, MAX_SKILL_STEPS, MAX_SKILL_WHEN, MAX_SKILLS, sourceLabel, type Skill } from '../../shared/skills';
import type { CompanionsView } from '../agentPanel';
import { invoke, on } from '../client';
import { ICONS, type IconName } from './icons';

type Reply = { error?: string; id?: string; note?: string };
type Child = Node | string | null | undefined | false;
export type ProfileTab = 'about' | 'knowledge' | 'skills' | 'memory';
type SkillDraft = Partial<Pick<Skill, 'id' | 'name' | 'when' | 'steps'>>;

type Screen =
  | { kind: 'list' }
  | { kind: 'profile'; id: string; tab: ProfileTab }
  | { kind: 'edit'; companion?: Companion; draft: Partial<Companion>; from?: string }
  | { kind: 'skill'; companionId: string; draft: SkillDraft; from?: { kind: 'routine'; name: string } };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const HUES = [262, 205, 150, 30, 330, 280, 0, 180];
const accent = (hue: number) => `hsl(${hue} 62% 52%)`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

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

/** A companion's face: a tile in its colour with its initial. */
function face(c: Pick<Companion, 'name' | 'hue'>, cls = 'face') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' }, (c.name.trim()[0] ?? '•').toUpperCase());
  el.style.setProperty('--hue', String(c.hue));
  return el;
}

/** A file's bytes as base64, in slices (one big String.fromCharCode overflows the stack). */
async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export interface SheetHooks {
  /** Whether the agent is working: switching companions would pull the conversation out from under it. */
  busy(): boolean;
  /** "Use now" on a skill: the composer gets it as its picked skill. */
  useSkill(skill: Pick<Skill, 'id' | 'name'>): void;
}

export function setupCompanions(hooks: SheetHooks) {
  let view: CompanionsView | undefined;
  let screen: Screen = { kind: 'list' };
  let message: string | undefined;
  /** Files being read right now, by name: shown in the Knowledge tab until they land. */
  let reading: string[] = [];
  /** The file whose preview is open, and its first lines. */
  let preview: { id: string; text?: string } | undefined;
  /** A change arrived while you were typing: drawn when you leave the field. */
  let stale = false;
  const sheet = $('sheet');
  const toggle = $('companion');

  const active = () => view?.companions.find((c) => c.id === view!.active) ?? view?.companions[0];
  const byId = (id: string) => view?.companions.find((c) => c.id === id);

  function paintHeader() {
    const c = active();
    $('companion-name').textContent = c?.name ?? 'General';
    $('companion-dot').style.setProperty('--accent', accent(c?.hue ?? 262));
    toggle.setAttribute('aria-label', `Companion: ${c?.name ?? 'General'}. Choose a companion, or see what it knows`);
    const title = $('empty-title');
    title.textContent = c && c.id !== 'general' ? `${c.name}: ${c.role || 'ready to work'}.` : 'Ask about this page, or have the agent work on it.';
  }

  function show(next: Screen) {
    screen = next;
    message = undefined;
    preview = undefined;
    paint();
    sheet.querySelector('.sheet-body')?.scrollTo({ top: 0 });
  }

  function open(next: Screen = { kind: 'list' }) {
    // Only one sheet at a time (the meetings and routines sheets listen for this too).
    document.dispatchEvent(new CustomEvent('sheet:open', { detail: 'companions' }));
    sheet.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    show(next);
    const body = $('sheet-body');
    (body.querySelector<HTMLElement>(next.kind === 'list' ? '[role="radio"][aria-checked="true"]' : 'input, textarea, [role="tab"][aria-selected="true"]') ?? $('sheet-close')).focus();
  }

  function close(returnFocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    // The header button is hidden where the composer's selector opens the sheet: focus goes back there.
    if (returnFocus) (toggle.hidden ? (document.getElementById('chooser') ?? toggle) : toggle).focus();
  }

  const isOpen = () => !sheet.hidden;

  /** Runs a change in the shell; shows why not if it said no. */
  async function ask(name: string, ...args: unknown[]): Promise<Reply> {
    const reply = await invoke<Reply>(name, ...args).catch((err) => ({ error: err instanceof Error ? err.message : 'Something went wrong.' }));
    message = reply?.error;
    return reply ?? {};
  }

  /** Where Back goes from each screen. */
  function parent(s: Screen): Screen | undefined {
    if (s.kind === 'profile') return { kind: 'list' };
    if (s.kind === 'skill') return { kind: 'profile', id: s.companionId, tab: 'skills' };
    if (s.kind === 'edit') return s.from ? { kind: 'profile', id: s.from, tab: 'about' } : { kind: 'list' };
    return undefined;
  }

  function paint() {
    stale = false;
    if (!view || sheet.hidden) return;
    // A companion that went away (removed in another window) takes its screens with it.
    if ((screen.kind === 'profile' && !byId(screen.id)) || (screen.kind === 'skill' && !byId(screen.companionId))) screen = { kind: 'list' };
    const body = $('sheet-body');
    const s = screen;
    $('sheet-title').textContent =
      s.kind === 'list' ? 'Companions' : s.kind === 'profile' ? 'Companion' : s.kind === 'edit' ? (s.companion ? 'Edit companion' : 'New companion') : s.draft.id ? 'Edit skill' : 'New skill';
    $('sheet-back').hidden = !parent(s);
    $('sheet-back').setAttribute('aria-label', s.kind === 'skill' ? 'Back to skills' : s.kind === 'profile' || !('from' in s && s.from) ? 'Back to companions' : 'Back');
    body.replaceChildren(s.kind === 'list' ? list() : s.kind === 'profile' ? profile(s) : s.kind === 'edit' ? editForm(s) : skillForm(s));
  }

  // ---- the list --------------------------------------------------------------------------

  function counts(id: string) {
    const v = view!;
    const parts = [
      v.skills[id]?.length ? plural(v.skills[id].length, 'skill') : '',
      v.files[id]?.length ? plural(v.files[id].length, 'file') : '',
      v.memory[id]?.length ? plural(v.memory[id].length, 'note') : '',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  function list() {
    const v = view!;
    const busy = hooks.busy();
    const rows = v.companions.map((c) => {
      const checked = c.id === v.active;
      const meta = counts(c.id);
      return h(
        'li',
        { class: `person${checked ? ' on' : ''}` },
        h(
          'button',
          {
            class: 'person-main',
            type: 'button',
            role: 'radio',
            'aria-checked': String(checked),
            disabled: busy && !checked,
            onclick: async () => {
              if (checked) return close();
              const reply = await ask('companions:select', c.id);
              if (!reply.error) close();
              else paint();
            },
          },
          face(c),
          h('span', { class: 'person-text' }, h('span', { class: 'person-name' }, c.name), h('span', { class: 'person-role' }, c.role || 'Your own companion'), meta ? h('span', { class: 'person-meta' }, meta) : null),
          checked ? icon('check') : null,
        ),
        h('button', { class: 'icon-button person-open', type: 'button', 'aria-label': `Open ${c.name}: skills, files and memory`, 'data-tip': 'Skills, files, memory', onclick: () => show({ kind: 'profile', id: c.id, tab: 'about' }) }, icon('chevron')),
      );
    });
    return h(
      'div',
      {},
      busy ? h('p', { class: 'sheet-hint' }, 'The agent is working. Stop it or wait to switch companions.') : null,
      h('ul', { class: 'people', role: 'radiogroup', 'aria-label': 'Companion' }, ...rows),
      h('button', { class: 'secondary-button wide', type: 'button', onclick: () => show({ kind: 'edit', draft: { hue: HUES[0] } }) }, icon('plus'), 'New companion'),
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
    );
  }

  // ---- a profile ---------------------------------------------------------------------------

  function profile(s: Extract<Screen, { kind: 'profile' }>) {
    const v = view!;
    const c = byId(s.id)!;
    const isActive = c.id === v.active;
    const busy = hooks.busy();
    const tabs: Array<{ id: ProfileTab; label: string; count?: number }> = [
      { id: 'about', label: 'About' },
      { id: 'knowledge', label: 'Knowledge', count: (v.files[c.id]?.length ?? 0) + (v.context[c.id] ? 1 : 0) },
      { id: 'skills', label: 'Skills', count: v.skills[c.id]?.length ?? 0 },
      { id: 'memory', label: 'Memory', count: v.memory[c.id]?.length ?? 0 },
    ];
    const tablist = h(
      'div',
      { class: 'profile-tabs', role: 'tablist', 'aria-label': `${c.name}` },
      ...tabs.map((t) =>
        h(
          'button',
          {
            class: 'profile-tab',
            type: 'button',
            role: 'tab',
            id: `ptab-${t.id}`,
            'aria-selected': String(t.id === s.tab),
            'aria-controls': 'ptab-panel',
            tabindex: t.id === s.tab ? '0' : '-1',
            onclick: () => show({ ...s, tab: t.id }),
          },
          t.label,
          t.count ? h('span', { class: 'profile-tab-count' }, String(t.count)) : null,
        ),
      ),
    );
    // Arrow keys move between tabs, as a tab list does.
    tablist.addEventListener('keydown', (e) => {
      const i = tabs.findIndex((t) => t.id === s.tab);
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      show({ ...s, tab: tabs[(i + step + tabs.length) % tabs.length].id });
      $('sheet-body').querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });

    const panel = s.tab === 'about' ? about(c) : s.tab === 'knowledge' ? knowledge(c) : s.tab === 'skills' ? skills(c) : memory(c);
    return h(
      'div',
      { class: 'profile' },
      h(
        'div',
        { class: 'profile-head' },
        face(c, 'face large'),
        h('div', { class: 'profile-who' }, h('span', { class: 'profile-name' }, c.name), h('span', { class: 'profile-role' }, c.role || 'Your own companion')),
        isActive
          ? h('span', { class: 'profile-active' }, icon('check'), 'Working as')
          : h(
              'button',
              {
                class: 'secondary-button small',
                type: 'button',
                disabled: busy,
                'data-tip': busy ? 'The agent is working' : undefined,
                onclick: async () => {
                  const reply = await ask('companions:select', c.id);
                  if (reply.error) paint();
                },
              },
              'Use',
            ),
      ),
      tablist,
      h('div', { id: 'ptab-panel', class: 'profile-panel', role: 'tabpanel', 'aria-labelledby': `ptab-${s.tab}` }, panel),
    );
  }

  function about(c: Companion) {
    return h(
      'div',
      {},
      h('h3', { class: 'section-title' }, 'Instructions'),
      c.instructions
        ? h('p', { class: 'about-text' }, c.instructions)
        : h('p', { class: 'sheet-hint' }, c.preset ? 'Helps with whatever you’re doing, with no special focus.' : 'No instructions yet. Edit to say what it should focus on and how.'),
      h('p', { class: 'sheet-hint' }, 'Instructions shape its focus and tone. They can’t turn off the approval cards: those always ask first.'),
      h(
        'div',
        { class: 'edit-actions' },
        c.preset
          ? h(
              'button',
              { class: 'secondary-button', type: 'button', onclick: () => show({ kind: 'edit', draft: { name: `${c.name} copy`.slice(0, MAX_NAME), role: c.role, instructions: c.instructions, hue: c.hue }, from: c.id }) },
              icon('copy'),
              'Make an editable copy',
            )
          : h('button', { class: 'secondary-button', type: 'button', onclick: () => show({ kind: 'edit', companion: c, draft: { ...c }, from: c.id }) }, icon('pencil'), 'Edit'),
      ),
      c.preset ? h('p', { class: 'sheet-hint' }, 'Built in: its name and instructions stay as they are, but its knowledge, skills and memory are yours to fill.') : null,
    );
  }

  // ---- knowledge: project context and files ------------------------------------------------

  function knowledge(c: Companion) {
    const v = view!;
    const saved = v.context[c.id] ?? '';
    const files = v.files[c.id] ?? [];
    const area = h('textarea', { id: 'k-context', class: 'field', rows: '6', maxlength: String(MAX_CONTEXT), placeholder: 'What you’re working on, who it’s for, names and terms to know, how you like things done…', 'aria-describedby': 'k-context-hint' }) as HTMLTextAreaElement;
    area.value = saved;
    const counter = h('span', { class: 'field-count' }, `${saved.length}/${MAX_CONTEXT}`);
    const saveButton = h('button', { class: 'secondary-button small', type: 'button', disabled: true }, 'Save') as HTMLButtonElement;
    const status = h('span', { class: 'field-status', role: 'status' });
    const save = async () => {
      if (area.value === (view!.context[c.id] ?? '')) return;
      saveButton.disabled = true;
      const reply = await ask('companions:setContext', c.id, area.value);
      if (reply.error) return paint();
      status.textContent = 'Saved';
      setTimeout(() => (status.textContent = ''), 1600);
    };
    area.addEventListener('input', () => {
      counter.textContent = `${area.value.length}/${MAX_CONTEXT}`;
      saveButton.disabled = area.value === (view!.context[c.id] ?? '');
      status.textContent = '';
    });
    // Leaving the field keeps what you wrote, as a note app would.
    area.addEventListener('blur', () => void save());
    saveButton.addEventListener('click', () => void save());

    const picker = h('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: '-1' }) as HTMLInputElement;
    picker.addEventListener('change', () => void addFiles(c, [...(picker.files ?? [])]));
    const full = files.length >= MAX_FILES;
    const drop = h(
      'button',
      { class: 'drop-zone', type: 'button', disabled: full, onclick: () => picker.click() },
      icon('paperclip'),
      h('span', {}, h('span', { class: 'drop-title' }, full ? `${MAX_FILES} files is the most a companion can have` : 'Add files'), h('span', { class: 'drop-text' }, full ? 'Remove one to add another.' : 'Or drop them here. PDF, Word, RTF, HTML, Markdown, CSV and text.')),
    );
    for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, (e) => (e.preventDefault(), drop.classList.add('over')));
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (!full) void addFiles(c, [...((e as DragEvent).dataTransfer?.files ?? [])]);
    });

    return h(
      'div',
      { class: 'knowledge' },
      h('h3', { class: 'section-title' }, 'Project context', h('span', { class: 'spacer' }), status, counter),
      h('p', { id: 'k-context-hint', class: 'sheet-hint' }, `Background ${c.name} gets with every message. Write it once instead of repeating it in each chat.`),
      area,
      h('div', { class: 'row-end' }, saveButton),
      h('h3', { class: 'section-title' }, 'Files', files.length ? h('span', { class: 'memory-count' }, `${files.length}/${MAX_FILES}`) : null),
      h('p', { class: 'sheet-hint' }, `${c.name} reads these when they help with what you ask. Only their text is kept, in this profile; what it reads goes to the model with your messages.`),
      files.length || reading.length ? h('ul', { class: 'files' }, ...files.map((f) => fileRow(c, f)), ...reading.map((name) => h('li', { class: 'file reading' }, h('span', { class: 'file-icon' }, h('span', { class: 'spinner', 'aria-label': 'Reading' })), h('span', { class: 'file-text' }, h('span', { class: 'file-name' }, name), h('span', { class: 'file-meta' }, 'Reading…'))))) : null,
      drop,
      picker,
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
    );
  }

  function fileRow(c: Companion, f: CompanionFile) {
    const opened = preview?.id === f.id;
    return h(
      'li',
      { class: `file${opened ? ' open' : ''}` },
      h(
        'button',
        {
          class: 'file-main',
          type: 'button',
          'aria-expanded': String(opened),
          onclick: async () => {
            if (opened) {
              preview = undefined;
              return paint();
            }
            preview = { id: f.id };
            paint();
            const reply = await invoke<{ text?: string; error?: string }>('companions:filePreview', c.id, f.id).catch(() => ({ text: '' }));
            if (preview?.id === f.id) {
              preview.text = reply.text ?? '';
              paint();
            }
          },
        },
        h('span', { class: 'file-icon' }, icon('fileText')),
        h('span', { class: 'file-text' }, h('span', { class: 'file-name' }, f.name), h('span', { class: 'file-meta' }, `${KIND_LABEL[f.kind]} · ${sizeLabel(f.chars)}${f.truncated ? ' (cut)' : ''}`)),
      ),
      h('button', { class: 'icon-button', type: 'button', 'aria-label': `Remove ${f.name}`, 'data-tip': 'Remove', onclick: async () => (await ask('companions:removeFile', c.id, f.id), paint()) }, icon('trash')),
      opened ? h('pre', { class: 'file-preview' }, preview?.text === undefined ? 'Loading…' : preview.text ? `${preview.text}${f.chars > preview.text.length ? '\n…' : ''}` : 'No text.') : null,
    );
  }

  async function addFiles(c: Companion, picked: File[]) {
    message = undefined;
    const room = MAX_FILES - (view!.files[c.id]?.length ?? 0);
    const usable = picked.filter((f) => kindOf(f.name));
    const problems: string[] = [];
    if (usable.length < picked.length) problems.push(`Skipped ${plural(picked.length - usable.length, 'file')} Uranus Browser can’t read.`);
    if (usable.length > room) problems.push(`Only ${plural(room, 'more file')} fit${room === 1 ? 's' : ''}.`);
    const queue = usable.slice(0, Math.max(0, room));
    reading = queue.map((f) => f.name);
    paint();
    for (const file of queue) {
      const reply = await invoke<Reply>('companions:addFile', c.id, { name: file.name, data: await toBase64(file) }).catch((err) => ({ error: err instanceof Error ? err.message : 'That file couldn’t be added.' }) as Reply);
      if (reply.error) problems.push(reply.error);
      else if (reply.note) problems.push(`${file.name}: ${reply.note}`);
      reading = reading.filter((name) => name !== file.name);
      paint();
    }
    message = problems.join(' ') || undefined;
    paint();
  }

  // ---- skills ------------------------------------------------------------------------------

  function skills(c: Companion) {
    const v = view!;
    const list = v.skills[c.id] ?? [];
    const isActive = c.id === v.active;
    return h(
      'div',
      {},
      h('p', { class: 'sheet-hint' }, `Ways of doing a task that ${c.name} follows when a request matches. Type / in the chat to use one straight away.`),
      list.length
        ? h(
            'ul',
            { class: 'skills' },
            ...list.map((k) =>
              h(
                'li',
                { class: 'skill' },
                h(
                  'button',
                  { class: 'skill-main', type: 'button', onclick: () => show({ kind: 'skill', companionId: c.id, draft: { ...k } }) },
                  h('span', { class: 'skill-icon' }, icon('book')),
                  h('span', { class: 'skill-text' }, h('span', { class: 'skill-name' }, k.name), h('span', { class: 'skill-when' }, k.when || 'No “when to use it” yet'), h('span', { class: 'skill-source' }, sourceLabel(k.source))),
                ),
                isActive ? h('button', { class: 'secondary-button small', type: 'button', 'data-tip': 'Use it for your next message', onclick: () => (hooks.useSkill(k), close()) }, 'Use') : null,
              ),
            ),
          )
        : h(
            'div',
            { class: 'memory-empty' },
            icon('book'),
            h(
              'span',
              {},
              h('span', { class: 'memory-empty-title' }, 'No skills yet'),
              h('span', { class: 'memory-empty-text' }, 'Write one here, say “save this as a skill” after the agent does something well, or save a routine run that went well from its History.'),
            ),
          ),
      list.length < MAX_SKILLS
        ? h('button', { class: 'secondary-button wide', type: 'button', onclick: () => show({ kind: 'skill', companionId: c.id, draft: {} }) }, icon('plus'), 'New skill')
        : h('p', { class: 'sheet-hint' }, `${MAX_SKILLS} skills is the most a companion can have.`),
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
    );
  }

  function skillForm(s: Extract<Screen, { kind: 'skill' }>) {
    const c = byId(s.companionId)!;
    const { draft } = s;
    const existing = draft.id ? view!.skills[c.id]?.find((k) => k.id === draft.id) : undefined;
    const name = h('input', { id: 'k-name', class: 'field', type: 'text', maxlength: String(MAX_SKILL_NAME), value: draft.name ?? '', placeholder: 'e.g. Weekly competitor check', autocomplete: 'off', required: true }) as HTMLInputElement;
    const when = h('input', { id: 'k-when', class: 'field', type: 'text', maxlength: String(MAX_SKILL_WHEN), value: draft.when ?? '', placeholder: 'e.g. When I ask how our competitors’ prices changed', autocomplete: 'off' }) as HTMLInputElement;
    const steps = h('textarea', { id: 'k-steps', class: 'field mono', rows: '11', maxlength: String(MAX_SKILL_STEPS), placeholder: '1. Open …\n2. Read …\n3. Put the results in a table with …' }) as HTMLTextAreaElement;
    steps.value = draft.steps ?? '';
    const counter = h('span', { class: 'field-count' }, `${steps.value.length}/${MAX_SKILL_STEPS}`);
    steps.addEventListener('input', () => (counter.textContent = `${steps.value.length}/${MAX_SKILL_STEPS}`));
    // Typing is kept in the screen, so a repaint (a change from another window) doesn't lose it.
    for (const [el, key] of [[name, 'name'], [when, 'when'], [steps, 'steps']] as const) el.addEventListener('input', () => (draft[key] = el.value));
    const save = async () => {
      const reply = await ask('companions:saveSkill', c.id, { id: draft.id, name: name.value, when: when.value, steps: steps.value }, s.from);
      if (reply.error) return paint();
      show({ kind: 'profile', id: c.id, tab: 'skills' });
    };
    return h(
      'form',
      { class: 'edit', novalidate: true, onsubmit: (e) => (e.preventDefault(), void save()) },
      h('p', { class: 'form-for' }, face(c, 'face small'), `${c.name}’s skill`, s.from ? h('span', { class: 'skill-source' }, ` · drafted from the routine “${s.from.name}”`) : existing ? h('span', { class: 'skill-source' }, ` · ${sourceLabel(existing.source)}`) : null),
      s.from ? h('p', { class: 'sheet-hint' }, 'This draft is the routine’s instructions and the steps that worked in that run. Read it through and trim anything you don’t want repeated.') : null,
      h('label', { for: 'k-name', class: 'label' }, 'Name'),
      name,
      h('label', { for: 'k-when', class: 'label' }, 'When to use it'),
      when,
      h('div', { class: 'label-row' }, h('label', { for: 'k-steps', class: 'label' }, 'Steps'), counter),
      steps,
      h('p', { class: 'sheet-hint' }, 'Write it as you would for a new colleague. A skill can’t turn off the approval cards.'),
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
      h(
        'div',
        { class: 'edit-actions' },
        existing
          ? h('button', { class: 'text-button danger', type: 'button', onclick: async () => {
              const reply = await ask('companions:removeSkill', c.id, existing.id);
              if (reply.error) return paint();
              show({ kind: 'profile', id: c.id, tab: 'skills' });
            } }, 'Remove')
          : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'secondary-button', type: 'button', onclick: () => show(parent(s)!) }, 'Cancel'),
        h('button', { class: 'primary-button', type: 'submit' }, existing ? 'Save' : 'Save skill'),
      ),
    );
  }

  // ---- memory ------------------------------------------------------------------------------

  function memory(c: Companion) {
    const notes = view!.memory[c.id] ?? [];
    const full = notes.length >= MAX_NOTES;
    const noteInput = h('input', { id: 'note-input', class: 'note-field', type: 'text', maxlength: String(MAX_NOTE), placeholder: full ? 'Memory is full. Remove a note first.' : 'Add a note, e.g. “I prefer metric units”', autocomplete: 'off', disabled: full, 'aria-label': `Add a note to ${c.name}’s memory` }) as HTMLInputElement;
    const addButton = h('button', { class: 'secondary-button', type: 'button', disabled: true, onclick: () => void addNote() }, 'Add') as HTMLButtonElement;
    const addNote = async () => {
      const text = noteInput.value.trim();
      if (!text) return;
      const reply = await ask('companions:addNote', c.id, text);
      if (!reply.error) noteInput.value = '';
      paint();
      $<HTMLInputElement>('note-input')?.focus();
    };
    noteInput.addEventListener('input', () => (addButton.disabled = !noteInput.value.trim()));
    noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void addNote();
      }
    });
    return h(
      'section',
      { class: 'memory', 'aria-labelledby': 'memory-title' },
      h('h3', { id: 'memory-title', class: 'section-title' }, `What ${c.name} remembers`, h('span', { class: 'spacer' }), notes.length ? h('span', { class: 'memory-count', title: `${notes.length} of ${MAX_NOTES} notes` }, `${notes.length}/${MAX_NOTES}`) : null),
      h('p', { class: 'sheet-hint' }, `Facts and preferences ${c.name} brings into every new chat. They’re sent to the model with your messages.`),
      notes.length
        ? h(
            'ul',
            { class: 'notes' },
            ...notes.map((n) =>
              h('li', { class: 'note' }, h('span', { class: 'note-text' }, n.text), h('button', { class: 'icon-button', type: 'button', 'aria-label': `Remove note: ${n.text.slice(0, 60)}`, 'data-tip': 'Remove', onclick: async () => (await ask('companions:removeNote', c.id, n.id), paint()) }, icon('trash'))),
            ),
          )
        : h(
            'div',
            { class: 'memory-empty' },
            icon('sparkle'),
            h('span', {}, h('span', { class: 'memory-empty-title' }, 'Nothing remembered yet'), h('span', { class: 'memory-empty-text' }, 'Say “remember that…” in chat. You approve each note before it’s saved.')),
          ),
      h('div', { class: 'note-add' }, noteInput, addButton),
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
      notes.length > 1 ? h('button', { class: 'text-button danger', type: 'button', onclick: () => confirmClear(c) }, 'Clear all notes') : null,
    );
  }

  /** Clearing is one click too many to take back: ask in place first. */
  function confirmClear(c: Companion) {
    const body = $('sheet-body');
    const row = h(
      'div',
      { class: 'confirm', role: 'alertdialog', 'aria-label': 'Clear all notes' },
      h('span', {}, `Remove every note ${c.name} has saved?`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'secondary-button', type: 'button', onclick: () => paint() }, 'Keep'),
      h('button', { class: 'primary-button', type: 'button', onclick: async () => (await ask('companions:clearNotes', c.id), paint()) }, 'Clear'),
    );
    body.querySelector('.confirm')?.remove();
    body.append(row);
    row.querySelector<HTMLElement>('button')?.focus();
  }

  // ---- the companion form: name, role, instructions, colour ------------------------------

  function editForm(state: Extract<Screen, { kind: 'edit' }>) {
    const { companion, draft } = state;
    let hue = draft.hue ?? HUES[0];
    const name = h('input', { id: 'f-name', class: 'field', type: 'text', maxlength: String(MAX_NAME), value: draft.name ?? '', autocomplete: 'off', required: true }) as HTMLInputElement;
    const role = h('input', { id: 'f-role', class: 'field', type: 'text', maxlength: String(MAX_ROLE), value: draft.role ?? '', placeholder: 'What it’s for, in a few words', autocomplete: 'off' }) as HTMLInputElement;
    const instructions = h('textarea', { id: 'f-instructions', class: 'field', rows: '7', maxlength: String(MAX_INSTRUCTIONS), placeholder: 'How it should work: what to focus on, its tone, what to leave to you…' }) as HTMLTextAreaElement;
    instructions.value = draft.instructions ?? '';
    for (const [el, key] of [[name, 'name'], [role, 'role'], [instructions, 'instructions']] as const) el.addEventListener('input', () => (draft[key] = el.value));
    const swatches = h(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' },
      ...HUES.map((value) => {
        const button = h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(value === hue), 'aria-label': `Colour ${HUES.indexOf(value) + 1}`, onclick: () => {
          hue = draft.hue = value;
          for (const el of swatches.querySelectorAll('.swatch')) el.setAttribute('aria-checked', String(el === button));
        } });
        button.style.setProperty('--accent', accent(value));
        return button;
      }),
    );
    const save = async () => {
      const reply = await ask('companions:save', { id: companion?.id, name: name.value, role: role.value, instructions: instructions.value, hue });
      if (reply.error) return paint();
      // A new companion (or copy) opens on its profile, ready for knowledge and skills.
      show({ kind: 'profile', id: companion?.id ?? reply.id ?? view!.active, tab: 'about' });
    };
    return h(
      'form',
      { class: 'edit', novalidate: true, onsubmit: (e) => (e.preventDefault(), void save()) },
      h('label', { for: 'f-name', class: 'label' }, 'Name'),
      name,
      h('label', { for: 'f-role', class: 'label' }, 'Role'),
      role,
      h('label', { for: 'f-instructions', class: 'label' }, 'Instructions'),
      instructions,
      h('p', { class: 'sheet-hint' }, 'These shape its focus and tone. They can’t turn off the approval cards: those always ask first.'),
      h('span', { class: 'label' }, 'Colour'),
      swatches,
      message ? h('p', { class: 'sheet-error', role: 'alert' }, message) : null,
      h(
        'div',
        { class: 'edit-actions' },
        companion
          ? h('button', { class: 'text-button danger', type: 'button', onclick: async () => {
              const reply = await ask('companions:remove', companion.id);
              if (reply.error) return paint();
              show({ kind: 'list' });
            } }, 'Remove')
          : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'secondary-button', type: 'button', onclick: () => show(parent(state)!) }, 'Cancel'),
        h('button', { class: 'primary-button', type: 'submit' }, 'Save'),
      ),
    );
  }

  // ---- wiring ----------------------------------------------------------------------------

  /** Whether you're typing in the sheet: a repaint would take the field away under you. */
  const typing = () => {
    const el = document.activeElement;
    return !!el && sheet.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text'));
  };
  sheet.addEventListener('focusout', () => setTimeout(() => stale && !typing() && paint(), 0));

  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  document.addEventListener('sheet:open', (e) => {
    if ((e as CustomEvent).detail !== 'companions') close(false);
  });
  $('sheet-close').addEventListener('click', () => close());
  $('sheet-back').addEventListener('click', () => {
    const back = parent(screen);
    if (back) show(back);
  });
  on('companions', (next: CompanionsView) => {
    view = next;
    paintHeader();
    if (typing()) stale = true;
    else paint();
  });
  void invoke<CompanionsView>('companions:get')
    .then((first) => {
      view = first;
      paintHeader();
      paint();
    })
    .catch((err) => console.error('Uranus Browser agent panel: no companions yet', err));

  return {
    isOpen,
    /** Opens the sheet: the list, or a companion's profile on a tab. */
    open: (companionId?: string, tab: ProfileTab = 'about') => open(companionId ? { kind: 'profile', id: companionId, tab } : { kind: 'list' }),
    /** Opens the skill form with a draft (a routine run that went well); saved only if the user saves it. */
    draftSkill: (companionId: string, draft: SkillDraft, from: { kind: 'routine'; name: string }) => open({ kind: 'skill', companionId, draft, from }),
    /** Closes the sheet without moving focus (another sheet is opening). */
    close: () => close(false),
    /** Escape steps back a screen, then closes the sheet. Returns whether it did anything. */
    escape() {
      if (!isOpen()) return false;
      const back = parent(screen);
      if (back) show(back);
      else close();
      return true;
    },
    /** The agent started or stopped working: switching is disabled while it works. */
    repaint: () => !typing() && paint(),
    /** The active companion's skills, for the composer's "/" menu. */
    activeSkills: (): Skill[] => (view ? (view.skills[view.active] ?? []) : []),
  };
}
