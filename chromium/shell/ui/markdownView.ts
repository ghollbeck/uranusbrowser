/**
 * The agent's answers, drawn: the Markdown tree from lib/markdown.ts as DOM nodes, never as
 * HTML (an answer can quote a page, so every string is a text node).
 *
 *  - Links and bare web addresses are pills: the site's icon (from Chromium's own icon cache,
 *    through the extension's `_favicon` endpoint, so nothing is fetched from the site), the
 *    title or a short address, and the host. A click opens a new tab; the full address is the
 *    pill's tooltip.
 *  - Images are not loaded on their own. A model can be talked by a page into writing an image
 *    address that carries what it read (the address is the leak, the moment it loads), so an
 *    image is a card naming its site, and loads when you click Show.
 *  - Tables scroll sideways inside the answer; code blocks have their language and a Copy button.
 */
import { parseMarkdown, shortAddress, type Align, type Block, type Inline } from '../lib/markdown';
import { ICONS, type IconName } from './icons';

export interface MarkdownHooks {
  /** Opens an address in a new tab (the shell's newTab). */
  open(url: string): void;
}

type Child = Node | string | null | undefined | false;

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

function icon(name: IconName) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  el.append(path);
  return el;
}

/** The site's icon from Chromium's cache (a grey globe when it has none); its letter if that fails. */
function favicon(href: string) {
  const host = (() => {
    try {
      return new URL(href).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const box = h('span', { class: 'md-fav', 'aria-hidden': 'true' });
  if (href.startsWith('mailto:')) {
    box.textContent = '@';
    return box;
  }
  const img = h('img', { alt: '', src: chrome.runtime.getURL(`/_favicon/?size=32&pageUrl=${encodeURIComponent(href)}`), loading: 'lazy', decoding: 'async' }) as HTMLImageElement;
  img.addEventListener('error', () => {
    img.remove();
    box.textContent = (host[0] ?? '•').toUpperCase();
  });
  box.append(img);
  return box;
}

/** Plain text of inline nodes (for labels and tooltips). */
const plain = (nodes: Inline[]): string => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.t === 'img' ? n.alt : plain(n.c))).join('');

export function renderMarkdown(source: string, hooks: MarkdownHooks): HTMLElement {
  const root = h('div', { class: 'md' });
  root.append(...parseMarkdown(source).map((b) => block(b, hooks)));
  return root;
}

function block(b: Block, hooks: MarkdownHooks): HTMLElement {
  switch (b.t) {
    case 'p':
      return h('p', {}, ...inline(b.c, hooks));
    case 'h':
      // Answers sit inside a conversation: their headings stay small (h3 and below).
      return h(`h${Math.min(6, b.level + 2)}`, { class: `md-h md-h${Math.min(3, b.level)}` }, ...inline(b.c, hooks));
    case 'hr':
      return h('hr');
    case 'quote':
      return h('blockquote', {}, ...b.c.map((x) => block(x, hooks)));
    case 'list': {
      const list = h(b.ordered ? 'ol' : 'ul', b.ordered && b.start !== 1 ? { start: String(b.start) } : {});
      for (const item of b.items) {
        // A one-paragraph item is drawn without its paragraph margin.
        const tight = item.length >= 1 && item[0].t === 'p';
        const li = h('li', {}, ...item.map((x, i) => (tight && i === 0 && x.t === 'p' ? h('span', {}, ...inline(x.c, hooks)) : block(x, hooks))));
        // "[ ] task" and "[x] done" show as boxes.
        const first = li.firstChild?.firstChild;
        if (first?.nodeType === Node.TEXT_NODE && /^\[( |x|X)\] /.test(first.textContent ?? '')) {
          const done = /^\[[xX]\]/.test(first.textContent ?? '');
          first.textContent = (first.textContent ?? '').slice(4);
          li.classList.add('md-task');
          li.prepend(h('span', { class: `md-box${done ? ' done' : ''}`, role: 'img', 'aria-label': done ? 'Done' : 'To do' }, done ? icon('check') : null));
        }
        list.append(li);
      }
      return list;
    }
    case 'code':
      return codeBlock(b.lang, b.v);
    case 'table':
      return table(b.align, b.head, b.rows, hooks);
  }
}

function codeBlock(lang: string, text: string) {
  const copy = h('button', { class: 'md-copy', type: 'button', 'aria-label': 'Copy code' }, icon('copy'), h('span', {}, 'Copy')) as HTMLButtonElement;
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    copy.querySelector('span')!.textContent = 'Copied';
    setTimeout(() => (copy.querySelector('span')!.textContent = 'Copy'), 1500);
  });
  return h('div', { class: 'md-code' }, h('div', { class: 'md-code-head' }, h('span', {}, lang || 'text'), copy), h('pre', {}, h('code', {}, text)));
}

function table(align: Align[], head: Inline[][], rows: Inline[][][], hooks: MarkdownHooks) {
  const cell = (tag: 'th' | 'td', content: Inline[], k: number) => h(tag, align[k] ? { class: `md-${align[k]}` } : {}, ...inline(content, hooks, true));
  return h(
    'div',
    { class: 'md-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Table' },
    h('table', { class: 'md-table' }, h('thead', {}, h('tr', {}, ...head.map((c, k) => cell('th', c, k)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, k) => cell('td', c, k)))))),
  );
}

function inline(nodes: Inline[], hooks: MarkdownHooks, compact = false): Node[] {
  const out = nodes.map((n): Node => {
    switch (n.t) {
      case 'text':
        return document.createTextNode(n.v);
      case 'code':
        return h('code', { class: 'md-inline-code' }, n.v);
      case 'b':
        return h('strong', {}, ...inline(n.c, hooks, compact));
      case 'i':
        return h('em', {}, ...inline(n.c, hooks, compact));
      case 's':
        return h('s', {}, ...inline(n.c, hooks, compact));
      case 'br':
        return h('br');
      case 'link':
        return link(n.href, n.bare ? undefined : n.c, hooks, compact);
      case 'img':
        return image(n.src, n.alt);
    }
  });
  // A pill and the punctuation right after it stay on one line: no lone comma starting a line.
  for (let i = 0; i < out.length - 1; i++) {
    const pill = out[i];
    const next = out[i + 1];
    const mark = next.nodeType === Node.TEXT_NODE ? /^[.,;:!?)\]’”]+/.exec(next.textContent ?? '')?.[0] : undefined;
    if (!(pill instanceof HTMLElement) || !pill.classList.contains('md-link') || !mark) continue;
    next.textContent = (next.textContent ?? '').slice(mark.length);
    out[i] = h('span', { class: 'md-nowrap' }, pill, mark);
  }
  return out;
}

function link(href: string, label: Inline[] | undefined, hooks: MarkdownHooks, compact: boolean) {
  const host = shortAddress(href, false);
  const title = label ? plain(label).trim() : '';
  // A label that is just the address (or its host) reads as the site, not as a title.
  const titled = !!title && !/^https?:\/\//i.test(title) && title.replace(/^www\./, '') !== host;
  const a = h(
    'a',
    { class: `md-link${compact ? ' compact' : ''}`, href, title: href, rel: 'noreferrer noopener' },
    favicon(href),
    // In a table cell a bare address is just its site, to keep the column narrow.
    h('span', { class: 'md-link-label' }, titled ? title : shortAddress(href, !compact)),
    titled && !compact ? h('span', { class: 'md-link-host' }, host) : null,
  );
  a.addEventListener('click', (e) => {
    e.preventDefault();
    hooks.open(href);
  });
  return a;
}

function image(src: string, alt: string) {
  const host = shortAddress(src, false);
  const card = h('span', { class: 'md-image' });
  const show = h('button', { class: 'md-image-show', type: 'button', title: src }, icon('camera'), h('span', { class: 'md-image-text' }, h('strong', {}, alt || 'Image'), h('span', {}, `From ${host}. Click to show it.`))) as HTMLButtonElement;
  show.addEventListener('click', () => {
    const img = h('img', { src, alt, referrerpolicy: 'no-referrer', decoding: 'async' }) as HTMLImageElement;
    img.addEventListener('error', () => card.replaceChildren(h('span', { class: 'md-image-failed' }, `The image from ${host} couldn’t be loaded.`)));
    card.replaceChildren(h('figure', {}, img, alt ? h('figcaption', {}, alt) : null));
  });
  card.append(show);
  return card;
}
