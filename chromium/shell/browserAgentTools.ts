/**
 * The Agent panel's browser tools, as the shell runs them for the native host (which has
 * already checked each call against the approval rules in shared/browserAgent.ts).
 *
 * Reading and inspecting run in the extension's isolated world (chrome.scripting), so a
 * page's own scripts can't change what the agent sees of the DOM; clicks and keys are real
 * input events through chrome.debugger, as the coding-agent tools send them. Elements are
 * named by refs ("e12") from the last read_page, kept here per tab as CSS paths. Before
 * acting on one, the shell checks it is still the element (and the page) the host approved,
 * and refuses with STALE if not: nothing is retried. Before a click or keys, the agent's own
 * pointer glides to the element on the page (agentOverlay.ts), so you can see what it's about
 * to do, and the action fires once it is there.
 */
import type { AgentResult } from '../shared/agentTools';
import type { TargetInfo } from '../shared/browserAgent';

export const STALE = '[stale]';

export interface BrowserAgentHelpers {
  activeTab(): { id: string; title: string; url: string } | undefined;
  listTabs(): unknown[];
  hasTab(id: string): boolean;
  activate(id: string): void;
  /** Opens a URL in a new, active UrAnus Browser tab. */
  open(url: string): string;
  /** The tool's tab (the active one when id is null) with its Chromium tab. */
  target(id: string | null | undefined, action: string): Promise<{ tabId: string; chromeId: number }>;
  bringForward(tabId: string, chromeId: number): Promise<void>;
  debug(chromeId: number, method: string, params?: object): Promise<unknown>;
  pressKey(chromeId: number, key: string): Promise<void>;
  settle(chromeId: number): Promise<void>;
  /** Shows the agent's pointer gliding to a point in the page; resolves when it's there. */
  pointAt?(chromeId: number, point: { x: number; y: number }): Promise<void>;
}

const text = (value: unknown): AgentResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const fail = (message: string): AgentResult => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * Per Chromium tab: what the last read_page saw (its URL, and a token it left in that
 * document's isolated world) and its refs' CSS paths. A ref only means something in that
 * very document: after a navigation, a reload or a tab switch it is refused as STALE.
 */
const refs = new Map<number, { url: string; token: string; paths: Record<string, string> }>();
chrome.tabs.onRemoved.addListener((chromeId) => refs.delete(chromeId));

/**
 * Downloads an action started: the agent may not download without approval, and a link can
 * download whatever it looks like (Content-Disposition), so while an action runs any new
 * download is cancelled and reported.
 */
let watchingDownloads = 0;
const caughtDownloads: string[] = [];
chrome.downloads?.onCreated.addListener((item) => {
  if (!watchingDownloads) return;
  void chrome.downloads.cancel(item.id).catch(() => undefined);
  caughtDownloads.push(item.filename || item.url);
});
async function noDownloads<T>(act: () => Promise<T>): Promise<T | AgentResult> {
  watchingDownloads++;
  const before = caughtDownloads.length;
  try {
    const result = await act();
    // Give a response that turns into a download a moment to show up.
    await new Promise((r) => setTimeout(r, 400));
    if (caughtDownloads.length > before) {
      return fail(`${STALE} That started a download, which UrAnus Browser cancelled: downloads need the user’s approval.`);
    }
    return result;
  } finally {
    watchingDownloads--;
  }
}

async function inPage<A extends unknown[], R>(chromeId: number, func: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: chromeId }, func, args, world: 'ISOLATED' } as any);
  if (!result) throw new Error('The page didn’t answer (it may still be loading)');
  return result.result as Awaited<R>;
}

/** The CSS path of `ref`, if it belongs to the document now in the tab; else throws (STALE). */
async function pathFor(chromeId: number, ref: string | null | undefined) {
  if (!ref) return undefined;
  const known = refs.get(chromeId);
  const path = known?.paths[ref];
  if (!known || !path) throw new Error(`Unknown ref ${ref}. Read the page again to get current refs.`);
  const tab = await chrome.tabs.get(chromeId);
  const token = await inPage(chromeId, readToken).catch(() => undefined);
  if (tab.url !== known.url || token !== known.token) {
    throw new Error(`${STALE} The page has changed since the agent read it, so ${ref} may be something else now.`);
  }
  return path;
}

export function browserAgentTools(h: BrowserAgentHelpers): Record<string, (args: Record<string, any>) => Promise<AgentResult>> {
  /** Glides the agent's pointer onto the element at `path` (or the focused one) first. */
  async function aim(chromeId: number, path: string | null) {
    if (!h.pointAt) return;
    const point = await inPage(chromeId, centreOf, path).catch(() => null);
    if (point) await h.pointAt(chromeId, point).catch(() => undefined);
  }

  /** The inspected target, or a STALE failure when it no longer matches the approved one. */
  async function verify(chromeId: number, path: string | undefined, fingerprint: string | null | undefined) {
    const tab = await chrome.tabs.get(chromeId);
    const now = (await inPage(chromeId, describeTarget, path ?? null)) as Omit<TargetInfo, 'url' | 'title'>;
    if (fingerprint && `${tab.url}|${now.fingerprint}` !== fingerprint) return undefined;
    return now;
  }

  return {
    agent_list_tabs: async () => text(h.listTabs()),

    agent_get_active_tab: async () => {
      const tab = h.activeTab();
      return tab ? text(tab) : fail('There is no active tab');
    },

    agent_switch_tab: async ({ tabId }) => {
      if (!h.hasTab(String(tabId))) return fail(`No tab with id ${tabId}`);
      h.activate(String(tabId));
      return text('ok');
    },

    agent_inspect: async ({ tabId, ref }) => {
      // Nothing open yet: only navigating makes sense, into a new tab.
      if (!tabId && !ref && !h.activeTab()) return text({ url: '', title: 'New tab', fingerprint: 'no tab' } satisfies TargetInfo);
      const t = await h.target(tabId, 'looking at the page');
      const tab = await chrome.tabs.get(t.chromeId);
      const path = await pathFor(t.chromeId, ref);
      // Navigation needs no element, and some pages (the new tab page, say) can't be scripted.
      const inspected = await inPage(t.chromeId, describeTarget, path ?? null).catch((err) => {
        if (path) throw err;
        return { fingerprint: 'page' } as Omit<TargetInfo, 'url' | 'title'>;
      });
      if (path && !inspected.element) return fail(`The element ${ref} isn’t on the page any more. Read the page again.`);
      const info: TargetInfo = { url: tab.url ?? '', title: tab.title ?? '', ...inspected, fingerprint: `${tab.url}|${inspected.fingerprint}` };
      return text(info);
    },

    agent_read_page: async ({ tabId }) => {
      const t = await h.target(tabId, 'reading the page');
      const tab = await chrome.tabs.get(t.chromeId);
      const token = crypto.randomUUID();
      const page = await inPage(t.chromeId, snapshotPage, 12_000, token);
      refs.set(t.chromeId, { url: tab.url ?? '', token, paths: page.paths });
      const lines = [
        `Title: ${tab.title ?? ''}`,
        `URL: ${tab.url ?? ''}`,
        `Scroll: ${page.scroll}`,
        page.selection ? `Selected text: ${page.selection}` : 'Selected text: (none)',
        '',
        `Headings:\n${page.headings.map((x) => `- ${x}`).join('\n') || '(none)'}`,
        '',
        `Interactive elements (${page.elements.length}${page.truncated ? ', more not listed' : ''}):`,
        ...page.elements,
        '',
        `Visible text:\n${page.text}`,
      ];
      return text(lines.join('\n'));
    },

    agent_navigate: async ({ tabId, url, action, fingerprint }) => {
      if (!tabId && !h.activeTab()) {
        if (!url) return fail('There is no tab to go back or forward in');
        const id = h.open(String(url));
        const opened = await h.target(id, `opening ${url}`);
        await h.settle(opened.chromeId);
        const tab = await chrome.tabs.get(opened.chromeId);
        return text({ tabId: id, url: tab.url, title: tab.title });
      }
      const t = await h.target(tabId, url ? `opening ${url}` : (action ?? 'navigating'));
      if (fingerprint && (await chrome.tabs.get(t.chromeId)).url !== String(fingerprint).split('|')[0]) {
        return fail(`${STALE} The tab moved to another page before the agent could navigate.`);
      }
      return noDownloads(async () => {
        if (url) await chrome.tabs.update(t.chromeId, { url: String(url) });
        else if (action === 'back') await chrome.tabs.goBack(t.chromeId).catch(() => undefined);
        else if (action === 'forward') await chrome.tabs.goForward(t.chromeId).catch(() => undefined);
        else if (action === 'reload') await chrome.tabs.reload(t.chromeId);
        await h.settle(t.chromeId);
        const tab = await chrome.tabs.get(t.chromeId);
        return text({ url: tab.url, title: tab.title });
      });
    },

    agent_scroll: async ({ tabId, direction, amount, ref }) => {
      const t = await h.target(tabId, 'scrolling');
      const path = await pathFor(t.chromeId, ref);
      const result = await inPage(t.chromeId, scrollPage, path ?? null, String(direction), String(amount));
      return result.ok ? text(result.position) : fail(result.position);
    },

    agent_click: async ({ tabId, ref, fingerprint }) => {
      const t = await h.target(tabId, 'clicking');
      const path = await pathFor(t.chromeId, ref);
      if (!(await verify(t.chromeId, path, fingerprint))) return fail(`${STALE} The page changed before the click.`);
      await h.bringForward(t.tabId, t.chromeId);
      const point = await inPage(t.chromeId, pointFor, path!);
      if (typeof point === 'string') return fail(point);
      await h.pointAt?.(t.chromeId, point).catch(() => undefined);
      await h.debug(t.chromeId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      // Hovering can open a menu or shift the layout: the approved element must still be the
      // one under the pointer, right before the press.
      if ((await inPage(t.chromeId, stillAt, path!, point.x, point.y)) !== true) {
        return fail(`${STALE} Something else moved under the pointer before the click.`);
      }
      return noDownloads(async () => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await h.debug(t.chromeId, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
        }
        await h.settle(t.chromeId);
        const tab = await chrome.tabs.get(t.chromeId);
        return text({ clicked: ref, url: tab.url, title: tab.title });
      });
    },

    agent_type: async ({ tabId, ref, text: value, clear, fingerprint }) => {
      const t = await h.target(tabId, 'typing');
      const path = await pathFor(t.chromeId, ref);
      if (!(await verify(t.chromeId, path, fingerprint))) return fail(`${STALE} The field changed before the agent could type.`);
      await h.bringForward(t.tabId, t.chromeId);
      await aim(t.chromeId, path ?? null);
      const ready = await inPage(t.chromeId, focusField, path ?? null, !!clear);
      if (ready !== true) return fail(ready);
      await h.debug(t.chromeId, 'Input.insertText', { text: String(value) });
      return text({ typed: String(value).length });
    },

    agent_press: async ({ tabId, key, ref, fingerprint }) => {
      const t = await h.target(tabId, `pressing ${key}`);
      const path = await pathFor(t.chromeId, ref);
      if (!(await verify(t.chromeId, path, fingerprint))) return fail(`${STALE} The page changed before the key press.`);
      await h.bringForward(t.tabId, t.chromeId);
      await aim(t.chromeId, path ?? null);
      if (path) {
        const ready = await inPage(t.chromeId, focusField, path, false);
        if (ready !== true) return fail(ready);
      }
      return noDownloads(async () => {
        await h.pressKey(t.chromeId, key === 'Space' ? ' ' : String(key));
        await h.settle(t.chromeId);
        const tab = await chrome.tabs.get(t.chromeId);
        return text({ pressed: key, url: tab.url });
      });
    },
  };
}

// ---- in the page (isolated world): self-contained, they're serialized ---------------

/** The page for the model: what it says, what's selected, and its controls with refs. */
function snapshotPage(maxText: number, token: string) {
  // Marks this document (in the isolated world, out of the page's reach) for pathFor.
  (globalThis as unknown as { __anusAgentDoc: string }).__anusAgentDoc = token;
  const clipText = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const cssPath = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        return parts.join(' > ');
      }
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${same.indexOf(node) + 1})` : node.tagName.toLowerCase());
    }
    return `html > ${parts.join(' > ')}`;
  };
  const nameOf = (el: Element) => {
    const h = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; placeholder?: string; alt?: string; value?: string };
    const by = el.getAttribute('aria-labelledby');
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ') : '';
    return clipText(
      el.getAttribute('aria-label') || labelled || h.labels?.[0]?.innerText || h.alt || el.getAttribute('title') || h.placeholder || h.innerText || (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el as HTMLInputElement).type) ? h.value : '') || '',
      80,
    );
  };
  const roleOf = (el: Element) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', file: 'file' } as Record<string, string>)[type] ?? 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return 'generic';
  };

  // Card numbers, one-time codes and tokens stay out of what the model reads.
  const secretField = (el: Element) =>
    /pass|pwd|secret|token|otp|one-time|cvv|cvc|csc|cc-|card|iban|ssn|pin\b|api.?key/i.test(
      `${el.getAttribute('autocomplete') ?? ''} ${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
    );
  const selector =
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=switch], [role=option], [role=combobox], [role=textbox], [contenteditable=""], [contenteditable=true]';
  const paths: Record<string, string> = {};
  const elements: string[] = [];
  let truncated = false;
  let n = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (!shown(el)) continue;
    if (n >= 250) {
      truncated = true;
      break;
    }
    const ref = `e${++n}`;
    paths[ref] = cssPath(el);
    const input = el as HTMLInputElement;
    const r = el.getBoundingClientRect();
    const facts = [
      el.tagName === 'INPUT' ? `type=${input.type}` : '',
      el.tagName === 'A' ? `href=${clipText((el as HTMLAnchorElement).href, 100)}` : '',
      !secretField(el) && ((el.tagName === 'INPUT' && !['password', 'hidden', 'file'].includes(input.type) && !['checkbox', 'radio', 'submit', 'button'].includes(input.type) && input.value) || el.tagName === 'TEXTAREA'
        ? `value="${clipText(input.value ?? '', 60)}"`
        : ''),
      input.type === 'password' && input.value ? 'value=(filled)' : '',
      secretField(el) && input.value ? 'value=(filled)' : '',
      ['checkbox', 'radio'].includes(input.type) ? (input.checked ? 'checked' : 'unchecked') : '',
      (el as HTMLButtonElement).disabled ? 'disabled' : '',
      r.bottom < 0 || r.top > innerHeight ? 'offscreen' : '',
    ].filter(Boolean);
    elements.push(`[${ref}] ${roleOf(el)} "${nameOf(el)}"${facts.length ? ` (${facts.join(', ')})` : ''}`);
  }
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(shown).slice(0, 30).map((h) => `${h.tagName.toLowerCase()}: ${clipText((h as HTMLElement).innerText, 100)}`);
  const scroller = document.scrollingElement ?? document.documentElement;
  const max = Math.max(0, scroller.scrollHeight - innerHeight);
  return {
    paths,
    elements,
    truncated,
    headings,
    selection: clipText(String(getSelection() ?? ''), 2000),
    scroll: max ? `${Math.round((scroller.scrollTop / max) * 100)}% of the page (${Math.round(scroller.scrollTop)} of ${Math.round(max)} px)` : 'the page fits on screen',
    text: clipText(document.body?.innerText ?? '', maxText),
  };
}

/** Describes the element at `path` (or the focused one) for the approval rules. */
function describeTarget(path: string | null) {
  const el = path ? document.querySelector(path) : document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (!el) return { fingerprint: path ? 'missing' : 'page' };
  const clipText = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const h = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; placeholder?: string; value?: string; type?: string; form?: HTMLFormElement | null; disabled?: boolean };
  const tag = el.tagName.toLowerCase();
  const by = el.getAttribute('aria-labelledby');
  const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ') : '';
  const name = clipText(
    el.getAttribute('aria-label') || labelled || h.labels?.[0]?.innerText || el.getAttribute('alt') || el.getAttribute('title') || h.placeholder || h.innerText || (tag === 'input' && ['submit', 'button', 'reset'].includes(h.type ?? '') ? (h.value ?? '') : ''),
    80,
  );
  const form = (h.form ?? el.closest('form')) as HTMLFormElement | null;
  const type = tag === 'button' ? (el.getAttribute('type') || 'submit').toLowerCase() : tag === 'input' ? (h.type ?? 'text') : undefined;
  const submits = !!form && ((tag === 'button' && type === 'submit') || (tag === 'input' && ['submit', 'image'].includes(type ?? '')));
  const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
  const editable =
    h.isContentEditable || tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color', 'file', 'hidden'].includes(type ?? 'text'));
  const element = {
    tag,
    role: el.getAttribute('role') || (anchor ? 'link' : tag),
    name,
    type,
    href: anchor?.href,
    download: anchor?.hasAttribute('download') || undefined,
    target: anchor?.target || undefined,
    autocomplete: el.getAttribute('autocomplete') || undefined,
    hints: clipText([el.getAttribute('name'), el.id, h.placeholder].filter(Boolean).join(' '), 120) || undefined,
    inForm: !!form,
    submits,
    editable,
    expandable: el.hasAttribute('aria-expanded') || tag === 'summary' || undefined,
    disabled: !!h.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
    readonly: (el as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true' || undefined,
  };
  return { element, fingerprint: [path ?? 'focus', tag, element.role, name, type ?? '', anchor?.href ?? '', submits].join('|') };
}

/** Where to click `path`: its centre, scrolled into view, if nothing covers it. */
function pointFor(path: string) {
  const el = document.querySelector(path);
  if (!el) return 'The element isn’t on the page any more.';
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return 'The element isn’t visible.';
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return 'Something else covers that element (a dialog or banner?).';
  return { x, y };
}

/** The centre of the element at `path` (or the focused one), scrolled into view; null if none shows. */
function centreOf(path: string | null) {
  const el = path ? document.querySelector(path) : document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  // A wide field: aim near its start, where the text goes, as a person would.
  const x = r.width > 160 ? r.left + Math.min(40, r.width / 4) : r.left + r.width / 2;
  return { x: Math.round(x), y: Math.round(r.top + r.height / 2) };
}

/** The token snapshotPage left in this document, if it did. */
function readToken() {
  return (globalThis as unknown as { __anusAgentDoc?: string }).__anusAgentDoc ?? null;
}

/** Whether the element at `path` (or one inside it) is still what's at (x, y). */
function stillAt(path: string, x: number, y: number) {
  const el = document.querySelector(path);
  const hit = document.elementFromPoint(x, y);
  return !!el && !!hit && (hit === el || el.contains(hit) || hit.contains(el));
}

/** Focuses the field at `path` (or keeps the focused one), emptying it if asked. */
function focusField(path: string | null, clear: boolean): true | string {
  const el = (path ? document.querySelector(path) : document.activeElement) as HTMLElement | null;
  if (!el || el === document.body) return 'There is no field to type into.';
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();
  // An element that can't take focus would leave the keys to whatever had it before.
  const focused = document.activeElement;
  if (!focused || (focused !== el && !el.contains(focused))) return 'That element can’t take keyboard focus, so nothing was typed or pressed.';
  if (clear) {
    if ('value' in el) {
      (el as HTMLInputElement).value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  return true;
}

/** Scrolls the page (or whatever on it scrolls) or brings `path` into view. */
function scrollPage(path: string | null, direction: string, amount: string) {
  if (path) {
    const el = document.querySelector(path);
    if (!el) return { ok: false, position: 'The element isn’t on the page any more.' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    return { ok: true, position: 'Scrolled the element into view.' };
  }
  const canScroll = (el: Element) => el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  let scroller: Element = document.scrollingElement ?? document.documentElement;
  if (scroller.scrollHeight <= innerHeight + 4) {
    // An app that scrolls a panel, not the page: take its biggest scrolling element.
    let best: Element | undefined;
    for (const el of document.querySelectorAll('body *')) {
      if (canScroll(el) && (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth)) best = el;
    }
    if (best) scroller = best;
  }
  const view = scroller === document.scrollingElement ? innerHeight : scroller.clientHeight;
  const step = view * ({ page: 0.9, half: 0.5, small: 0.25 } as Record<string, number>)[amount];
  const before = scroller.scrollTop;
  const top = direction === 'top' ? 0 : direction === 'bottom' ? scroller.scrollHeight : before + (direction === 'up' ? -step : step);
  scroller.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
  const max = Math.max(0, scroller.scrollHeight - view);
  const now = scroller.scrollTop;
  return { ok: true, position: `Scrolled ${direction}: now ${max ? Math.round((now / max) * 100) : 100}% (${Math.round(now)} of ${Math.round(max)} px)${now === before ? '; it was already at the end' : ''}.` };
}
