/**
 * The composer's "/" menu: type "/" at the start of a message to pick one of the active
 * companion's skills for it. The picked skill sits above the text field as a chip; sending
 * the message sends the skill's id with it, and the shell puts the saved steps in front of the
 * model (shell/agentPanel.ts). A skill picked with an empty message runs it as it is.
 *
 * It only reads the companions view the sheet already keeps, and only sends an id: the steps
 * never pass through the panel page.
 */
import type { Skill } from '../../shared/skills';
import { ICONS, type IconName } from './icons';

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

export interface PickerHooks {
  /** The active companion's skills, as saved. */
  skills(): Skill[];
  /** "No skills yet": opens the companion's Skills tab. */
  manage(): void;
  /** The text field changed size or content (the composer re-measures). */
  changed(): void;
}

export function setupSkillPicker(hooks: PickerHooks) {
  const input = $<HTMLTextAreaElement>('input');
  const pop = $('skill-pop');
  const chip = $('skill-chip');
  let picked: Pick<Skill, 'id' | 'name'> | undefined;
  let matches: Skill[] = [];
  let highlighted = 0;

  const query = () => /^\/(\S*)$/.exec(input.value)?.[1]?.toLowerCase();
  const isOpen = () => !pop.hidden;

  function paintChip() {
    chip.hidden = !picked;
    chip.replaceChildren();
    if (!picked) return;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip-remove';
    remove.setAttribute('aria-label', `Don’t use the skill ${picked.name}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => {
      picked = undefined;
      paintChip();
      input.focus();
      hooks.changed();
    });
    const label = document.createElement('span');
    label.className = 'skill-chip-name';
    label.textContent = picked.name;
    chip.append(icon('book'), label, remove);
    chip.title = `Skill: ${picked.name}`;
  }

  function close() {
    pop.hidden = true;
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'false');
  }

  function paintMenu() {
    const q = query();
    if (q === undefined) return close();
    const all = hooks.skills();
    matches = all.filter((s) => !q || s.name.toLowerCase().includes(q) || s.when.toLowerCase().includes(q)).slice(0, 8);
    highlighted = Math.min(highlighted, Math.max(0, matches.length - 1));
    const rows: HTMLElement[] = matches.map((s, i) => {
      const li = document.createElement('li');
      li.id = `skill-opt-${i}`;
      li.className = 'skill-opt';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === highlighted));
      const text = document.createElement('span');
      text.className = 'skill-opt-text';
      const name = document.createElement('span');
      name.className = 'skill-opt-name';
      name.textContent = s.name;
      const when = document.createElement('span');
      when.className = 'skill-opt-when';
      when.textContent = s.when;
      text.append(name, when);
      li.append(icon('book'), text);
      // mousedown, so the text field keeps focus.
      li.addEventListener('mousedown', (e) => (e.preventDefault(), pick(s)));
      li.addEventListener('mousemove', () => {
        if (highlighted !== i) (highlighted = i), paintMenu();
      });
      return li;
    });
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'skill-opt empty';
      li.textContent = all.length ? 'No skill matches.' : 'No skills yet. Add one in the companion’s Skills.';
      if (!all.length) {
        li.setAttribute('role', 'option');
        li.addEventListener('mousedown', (e) => (e.preventDefault(), (input.value = ''), close(), hooks.manage()));
      }
      rows.push(li);
    }
    pop.replaceChildren(...rows);
    pop.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (matches.length) input.setAttribute('aria-activedescendant', `skill-opt-${highlighted}`);
  }

  function pick(skill: Pick<Skill, 'id' | 'name'>) {
    picked = { id: skill.id, name: skill.name };
    input.value = '';
    close();
    paintChip();
    input.focus();
    hooks.changed();
  }

  input.setAttribute('aria-controls', 'skill-pop');
  input.setAttribute('aria-autocomplete', 'list');
  input.addEventListener('input', () => {
    highlighted = 0;
    paintMenu();
  });
  // Leaving the field closes the menu, but only if focus is still away when the timer runs: a
  // throttled timer from an earlier blur (the chip's ×) mustn't close a menu opened since.
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 0));
  // Capture: these keys belong to the menu while it's open, before the composer sees Enter.
  $('composer').addEventListener(
    'keydown',
    (e) => {
      if (e.target !== input) return;
      if (!isOpen()) {
        // Backspace in an empty field takes the chip off, as in a token field.
        if (e.key === 'Backspace' && picked && !input.value) {
          picked = undefined;
          paintChip();
          hooks.changed();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (matches.length) highlighted = (highlighted + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        paintMenu();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && matches[highlighted]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(matches[highlighted]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    },
    true,
  );

  return {
    /** The picked skill, for the message being sent; the chip goes. */
    take(): Pick<Skill, 'id' | 'name'> | undefined {
      const out = picked;
      picked = undefined;
      paintChip();
      return out;
    },
    /** Whether a skill is picked (an empty message can still be sent: it runs the skill). */
    has: () => !!picked,
    /** From the Skills tab's "Use". */
    set: (skill: Pick<Skill, 'id' | 'name'>) => pick(skill),
    /** The companion changed: a skill it doesn't have can't stay picked. */
    refresh() {
      if (picked && !hooks.skills().some((s) => s.id === picked!.id)) {
        picked = undefined;
        paintChip();
      }
      if (isOpen()) paintMenu();
    },
    isOpen,
    close,
  };
}
