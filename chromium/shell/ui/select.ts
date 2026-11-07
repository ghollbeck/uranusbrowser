/**
 * Uranus Browser's own dropdown. The browser's <select> menu is drawn by the OS and ignores the design
 * system, so every picker goes through customSelect(): a styled button plus a listbox in the top
 * layer. The real <select> stays in the DOM (hidden) and remains the source of truth, so the
 * code around it keeps working as before: `.value`, `.selectedIndex`, `options`, `disabled`
 * and the `change` event all behave the same; the picker repaints itself when any of them change.
 *
 * Focus stays on the button while the list is open (aria-activedescendant), so sheets and
 * popovers that react to focus or to clicks outside themselves see nothing unusual: the list
 * lives inside the same element as the button.
 */
import { ICONS } from './icons';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_MENU_HEIGHT = 360;
const EDGE = 8;

const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
const nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')!;

const triggers = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let nextId = 0;
let labelClicksBound = false;

function glyph(path: string, className: string) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', className);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  el.append(p);
  return el;
}

/** A <label for=…> that points at an upgraded select focuses its button instead (the select is hidden). */
function bindLabelClicks() {
  if (labelClicksBound) return;
  labelClicksBound = true;
  document.addEventListener('click', (e) => {
    const label = (e.target as Element | null)?.closest?.('label');
    if (!label?.htmlFor || label.contains(label.querySelector('.fs-trigger'))) return;
    const select = document.getElementById(label.htmlFor);
    if (select instanceof HTMLSelectElement) triggers.get(select)?.focus();
  });
}

/**
 * Upgrades one <select>. Returns the wrapper that now holds the button, the list and the hidden
 * select; use it in place of the select when the select has not been attached yet. A select that
 * is already in the page is replaced in place.
 */
export function customSelect(select: HTMLSelectElement): HTMLElement {
  const existing = triggers.get(select);
  if (existing) return existing.parentElement!;
  bindLabelClicks();

  const uid = `fs${++nextId}`;
  const wrap = document.createElement('span');
  wrap.className = 'fs-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `fs-trigger ${select.className}`.trim();
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${uid}-list`);
  const aria = select.getAttribute('aria-label');
  if (aria) trigger.setAttribute('aria-label', aria);
  for (const name of ['aria-invalid', 'aria-describedby']) {
    const v = select.getAttribute(name);
    if (v) trigger.setAttribute(name, v);
  }
  const text = document.createElement('span');
  text.className = 'fs-value';
  trigger.append(text, glyph(ICONS.chevronDown, 'fs-chevron'));

  const list = document.createElement('div');
  list.className = 'fs-menu';
  list.id = `${uid}-list`;
  list.setAttribute('role', 'listbox');
  list.popover = 'manual';

  select.classList.add('fs-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.parentNode?.insertBefore(wrap, select);
  // Button first: a <label> that wraps the whole picker then activates the button.
  wrap.append(trigger, list, select);
  triggers.set(select, trigger);

  let open = false;
  let active = -1;
  let typed = '';
  let typedAt = 0;

  const items = () => [...list.children] as HTMLElement[];
  const enabled = (i: number) => !!select.options[i] && !select.options[i].disabled;

  function paintTrigger() {
    text.textContent = select.selectedOptions[0]?.textContent ?? '';
    trigger.disabled = select.disabled;
    if (!trigger.hasAttribute('aria-label') && select.labels?.length) trigger.setAttribute('aria-label', select.labels[0].textContent?.trim() ?? '');
    if (select.disabled && open) close();
  }

  function buildItems() {
    const options = [...select.options];
    list.replaceChildren(
      ...options.map((option, i) => {
        const item = document.createElement('div');
        item.className = 'fs-item';
        item.id = `${uid}-o${i}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.selected));
        if (option.disabled) item.setAttribute('aria-disabled', 'true');
        if (option.title) item.title = option.title;
        const label = document.createElement('span');
        label.textContent = option.textContent;
        item.append(label, glyph(ICONS.check, 'fs-check'));
        return item;
      }),
    );
  }

  function setActive(i: number, scroll = true) {
    active = i;
    items().forEach((el, k) => (el.dataset.active = String(k === i)));
    const el = items()[i];
    if (el) {
      trigger.setAttribute('aria-activedescendant', el.id);
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    } else trigger.removeAttribute('aria-activedescendant');
  }

  function step(from: number, dir: 1 | -1) {
    for (let i = from + dir; i >= 0 && i < select.options.length; i += dir) if (enabled(i)) return i;
    return from;
  }

  function place() {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.maxWidth = `${Math.max(r.width, vw - EDGE * 2)}px`;
    list.style.maxHeight = `${MAX_MENU_HEIGHT}px`;
    const below = vh - r.bottom - EDGE - 4;
    const above = r.top - EDGE - 4;
    const wanted = Math.min(list.scrollHeight, MAX_MENU_HEIGHT);
    const down = below >= wanted || below >= above;
    const room = Math.max(96, down ? below : above);
    list.style.maxHeight = `${Math.min(MAX_MENU_HEIGHT, room)}px`;
    const height = Math.min(list.scrollHeight, MAX_MENU_HEIGHT, room);
    list.style.top = `${Math.round(down ? r.bottom + 4 : r.top - 4 - height)}px`;
    const width = list.offsetWidth;
    list.style.left = `${Math.round(Math.max(EDGE, Math.min(r.left, vw - width - EDGE)))}px`;
  }

  function openList() {
    if (open || trigger.disabled || !select.options.length) return;
    // A sheet can be redrawn while the list is open; a picker that left the page lets go quietly.
    if (!trigger.isConnected) return;
    open = true;
    buildItems();
    list.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    place();
    setActive(enabled(select.selectedIndex) ? select.selectedIndex : step(-1, 1));
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
  }

  function close() {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    if (!open) return;
    open = false;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    if (list.matches(':popover-open')) list.hidePopover();
  }

  function onOutside(e: Event) {
    if (!trigger.isConnected) return close();
    const target = e.target as Node;
    if (!list.contains(target) && !trigger.contains(target)) close();
  }

  function onScroll(e: Event) {
    if (!trigger.isConnected || !list.contains(e.target as Node)) close();
  }

  function pick(i: number) {
    if (!enabled(i)) return;
    const changed = select.selectedIndex !== i;
    if (changed) nativeIndex.set!.call(select, i);
    paintTrigger();
    close();
    trigger.focus();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function typeahead(key: string) {
    const now = Date.now();
    typed = now - typedAt > 700 ? key : typed + key;
    typedAt = now;
    const options = [...select.options];
    const from = typed.length === 1 ? active + 1 : active;
    const order = [...options.keys()].slice(from).concat([...options.keys()].slice(0, from));
    const hit = order.find((i) => enabled(i) && options[i].textContent?.trim().toLowerCase().startsWith(typed.toLowerCase()));
    if (hit !== undefined) setActive(hit);
  }

  trigger.addEventListener('click', () => (open ? close() : openList()));
  trigger.addEventListener('blur', () => close());
  trigger.addEventListener('keydown', (e) => {
    const { key } = e;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        e.preventDefault();
        openList();
      } else if (key.length === 1) {
        openList();
        typeahead(key);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown':
        setActive(step(active, 1));
        break;
      case 'ArrowUp':
        setActive(step(active, -1));
        break;
      case 'Home':
        setActive(step(-1, 1));
        break;
      case 'End':
        setActive(step(select.options.length, -1));
        break;
      case 'Enter':
      case ' ':
        pick(active);
        break;
      case 'Escape':
        // Closes the list only; the sheet or panel around it stays for the next Escape.
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close();
        return;
      default:
        if (key.length === 1) typeahead(key);
        else return;
    }
    e.preventDefault();
  });

  // Keep focus on the button while the pointer works the list.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('pointermove', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('.fs-item');
    const i = el ? items().indexOf(el) : -1;
    if (i >= 0 && i !== active && enabled(i)) setActive(i, false);
  });
  list.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('.fs-item');
    if (el) pick(items().indexOf(el));
  });

  // Whatever the page does to the real select repaints the picker.
  const refresh = () => {
    paintTrigger();
    if (open) {
      buildItems();
      setActive(Math.min(active, select.options.length - 1), false);
    }
  };
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() {
      return nativeValue.get!.call(this);
    },
    set(v: string) {
      nativeValue.set!.call(this, v);
      refresh();
    },
  });
  Object.defineProperty(select, 'selectedIndex', {
    configurable: true,
    get() {
      return nativeIndex.get!.call(this);
    },
    set(v: number) {
      nativeIndex.set!.call(this, v);
      refresh();
    },
  });
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'label', 'selected'] });
  select.addEventListener('change', paintTrigger);
  paintTrigger();
  return wrap;
}

/** Upgrades every <select> under `root` that is already in the page. */
export function customSelects(root: ParentNode = document) {
  for (const select of root.querySelectorAll('select')) customSelect(select);
}
