/**
 * The agent's answers as Markdown: a small parser for what chat models write (GitHub-style),
 * into a plain tree that ui/markdownView.ts turns into DOM nodes. Pure (no DOM, no chrome.*),
 * so it is testable, and it never produces HTML: an answer can quote a web page, so every
 * string here ends up as a text node, and raw HTML in the source stays visible text.
 *
 * Blocks: paragraphs, headings, fenced code, block quotes, lists (nested by indentation, task
 * boxes shown as text), tables with column alignment, and rules. Inline: code, bold, italic,
 * strikethrough, links, images, autolinks and bare web addresses, and backslash escapes.
 * Addresses are kept only when they are http(s) (or mailto for links): anything else
 * (javascript:, data:, file:) stays as its text.
 *
 * It is forgiving, for answers that are still streaming: an unclosed code fence runs to the
 * end, an unclosed `**` is just two asterisks.
 */

export type Align = 'left' | 'center' | 'right' | undefined;

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b' | 'i' | 's'; c: Inline[] }
  /** `bare`: a web address written as it is, so its pill shows the site rather than a title. */
  | { t: 'link'; href: string; c: Inline[]; bare?: boolean }
  | { t: 'img'; src: string; alt: string }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

/** Answers longer than this are parsed up to here (the panel keeps entries short anyway). */
const MAX_SOURCE = 60_000;
const MAX_DEPTH = 6;

// ---- addresses ------------------------------------------------------------------------------

/** An address a link may point to: http(s) or mailto, as a full URL; undefined otherwise. */
export function safeHref(raw: string, allowMail = true): string | undefined {
  const value = raw.trim().replace(/^<|>$/g, '');
  try {
    const u = new URL(value);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.username || u.password ? undefined : u.href;
    if (allowMail && u.protocol === 'mailto:') return u.href;
  } catch {
    // Not a URL.
  }
  return undefined;
}

/** "ethz.ch", "ethz.ch/news/…": how a pill names an address. */
export function shortAddress(href: string, withPath = true): string {
  try {
    const u = new URL(href);
    if (u.protocol === 'mailto:') return u.pathname;
    const host = u.host.replace(/^www\./, '');
    if (!withPath) return host;
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '');
    if (!path) return host;
    const first = path.split('/').filter(Boolean);
    const shown = first.length > 1 ? `/${first[0]}/…` : `/${first[0] ?? ''}`;
    return `${host}${shown.length > 24 ? `${shown.slice(0, 23)}…` : shown}`;
  } catch {
    return href;
  }
}

// ---- inline -----------------------------------------------------------------------------------

/** Characters a bare address can't end with: the sentence's own punctuation. */
const TRAILING = /[.,;:!?'"’”)\]]+$/;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/y;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Escapes: \* stays a star.
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    // A hard break: two spaces, or a backslash, before a newline.
    if (ch === '\n') {
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '');
        push({ t: 'br' });
      } else text += ' ';
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        push({ t: 'code', v: src.slice(i + run.length, end).replace(/\n/g, ' ').replace(/^ (.+) $/, '$1') });
        i = end + run.length;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      // Images and links: ![alt](src) and [text](href "title").
      const image = ch === '!' && src[i + 1] === '[';
      if (ch === '[' || image) {
        const open = image ? i + 1 : i;
        const close = matchBracket(src, open);
        if (close > 0 && src[close + 1] === '(') {
          const target = linkTarget(src, close + 2);
          if (target) {
            const label = src.slice(open + 1, close);
            const href = safeHref(target.url, !image);
            if (image) {
              if (href) push({ t: 'img', src: href, alt: label.trim() });
              else text += label;
            } else if (href) push({ t: 'link', href, c: parseInline(label, depth + 1) });
            else {
              // Not an address we open: just its words.
              flush();
              out.push(...parseInline(label, depth + 1));
            }
            i = target.end;
            continue;
          }
        }
      }
      // <https://…> autolinks.
      if (ch === '<') {
        const m = /^<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/.exec(src.slice(i));
        const href = m && safeHref(m[1]);
        if (m && href) {
          push({ t: 'link', href, c: [{ t: 'text', v: m[1] }], bare: true });
          i += m[0].length;
          continue;
        }
      }
      // Bare web addresses.
      if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s(["'“‘]/.test(src[i - 1]))) {
        BARE_URL.lastIndex = i;
        const m = BARE_URL.exec(src);
        if (m) {
          let raw = m[0];
          // A closing bracket that opened inside the address (Wikipedia's) stays part of it.
          while (TRAILING.test(raw) && !(raw.endsWith(')') && (raw.match(/\(/g)?.length ?? 0) >= (raw.match(/\)/g)?.length ?? 0))) raw = raw.replace(/[.,;:!?'"’”)\]]$/, '');
          const href = safeHref(raw);
          if (href) {
            push({ t: 'link', href, c: [{ t: 'text', v: raw }], bare: true });
            i += raw.length;
            continue;
          }
        }
      }
      // Emphasis: ** __ ~~ then * _.
      const two = src.slice(i, i + 2);
      // __ inside a word (__init__, window.__x) is text, as with a single underscore.
      const inWord = two === '__' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]);
      if ((two === '**' || two === '__' || two === '~~') && !inWord) {
        let end = findClose(src, i + 2, two);
        if (two === '__' && end > 0 && /[\p{L}\p{N}]/u.test(src[end + 2] ?? '')) end = -1;
        // ***both***: the bold closes at the end of the run, around an italic.
        while (end > 0 && src[end + 2] === two[0]) end++;
        if (end > i + 2) {
          push({ t: two === '~~' ? 's' : 'b', c: parseInline(src.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
      if ((ch === '*' || ch === '_') && src[i + 1] && !/\s/.test(src[i + 1])) {
        // An underscore inside a word (snake_case) is a letter, not emphasis.
        const wordBefore = ch === '_' && i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]);
        const end = wordBefore ? -1 : findClose(src, i + 1, ch);
        if (end > i + 1 && !(ch === '_' && /[\p{L}\p{N}]/u.test(src[end + 1] ?? ''))) {
          push({ t: 'i', c: parseInline(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** The `]` that closes the `[` at `open`, minding nesting and escapes; -1 if none on this text. */
function matchBracket(src: string, open: number): number {
  let level = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '[') level++;
    else if (src[i] === ']' && --level === 0) return i;
    else if (src[i] === '\n' && src[i + 1] === '\n') return -1;
  }
  return -1;
}

/** `(url "title")` from `start` (just after the parenthesis): the address and where it ends. */
function linkTarget(src: string, start: number): { url: string; end: number } | undefined {
  let level = 1;
  for (let i = start; i < src.length && i < start + 2048; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === '(') level++;
    else if (c === ')' && --level === 0) {
      const inner = src.slice(start, i).trim();
      const url = /^<([^>]*)>/.exec(inner)?.[1] ?? inner.split(/\s+/)[0] ?? '';
      return { url, end: i + 1 };
    } else if (c === '\n') return undefined;
  }
  return undefined;
}

/** Where `mark` closes emphasis opened before `from`: not after a space, not escaped. */
function findClose(src: string, from: number, mark: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (src.startsWith(mark, i) && !/\s/.test(src[i - 1] ?? ' ') && i > from) {
      // ** inside *…* is the bold's, not this italic's end.
      if (mark.length === 1 && src[i + 1] === mark) {
        i++;
        continue;
      }
      return i;
    }
    if (src[i] === '\n' && src[i + 1] === '\n') return -1;
  }
  return -1;
}

// ---- blocks ---------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const BULLET = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isBlank = (line: string) => !line.trim();

/** Splits a table row into cells: outer pipes optional, \| is a pipe in a cell. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '`') {
      code = !code;
      cur += '`';
    } else if (s[i] === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.slice(0, MAX_SOURCE).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n').trim()) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      endPara();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end, while it streams)
      blocks.push({ t: 'code', lang: fence[2].toLowerCase(), v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endPara();
      blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (RULE.test(line) && !(para.length && /^ {0,3}-+\s*$/.test(line))) {
      endPara();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    // A table: a row with a pipe, then a separator row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      if (head.length === align.length || head.length > 1) {
        endPara();
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
          const row = cells(lines[i]);
          rows.push(head.map((_, k) => parseInline(row[k] ?? '')));
          i++;
        }
        blocks.push({ t: 'table', align: head.map((_, k) => align[k]), head: head.map((h) => parseInline(h)), rows });
        continue;
      }
    }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      endPara();
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (!isBlank(lines[i]) && inner.length && !FENCE.test(lines[i])))) inner.push(lines[i++].replace(QUOTE, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(inner.join('\n'), depth + 1) });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet && depth < MAX_DEPTH && (!para.length || bullet[1].length === 0)) {
      endPara();
      const indent = bullet[1].length;
      const ordered = /\d/.test(bullet[2]);
      const start = ordered ? parseInt(bullet[2], 10) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const b = BULLET.exec(l);
        if (b && b[1].length <= indent + 1 && /\d/.test(b[2]) === ordered) {
          items.push([b[3]]);
          i++;
          continue;
        }
        if (isBlank(l)) {
          // A blank line inside a list continues it only if the next line is indented or a sibling.
          const next = lines[i + 1] ?? '';
          const nb = BULLET.exec(next);
          if ((nb && nb[1].length <= indent + 1 && /\d/.test(nb[2]) === ordered) || /^ {2,}\S/.test(next)) {
            items.at(-1)?.push('');
            i++;
            continue;
          }
          break;
        }
        // Indented lines (a nested list, a continued item) belong to the item above.
        if (items.length && (/^ {2,}/.test(l) || (!BULLET.test(l) && !FENCE.test(l) && !HEADING.test(l) && !QUOTE.test(l)))) {
          items.at(-1)!.push(l.replace(new RegExp(`^ {0,${indent + 4}}`), ''));
          i++;
          continue;
        }
        break;
      }
      blocks.push({ t: 'list', ordered, start, items: items.map((item) => parseMarkdown(item.join('\n'), depth + 1)) });
      continue;
    }
    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}

/** Every link in the answer, in order, once each: for a sources row. */
export function linksIn(blocks: Block[]): string[] {
  const seen = new Set<string>();
  const walkInline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === 'link' && /^https?:/.test(n.href)) seen.add(n.href);
      if ('c' in n && Array.isArray(n.c)) walkInline(n.c as Inline[]);
    }
  };
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t === 'p' || b.t === 'h') walkInline(b.c);
      else if (b.t === 'quote') walk(b.c);
      else if (b.t === 'list') b.items.forEach(walk);
      else if (b.t === 'table') [...b.head, ...b.rows.flat()].forEach(walkInline);
    }
  };
  walk(blocks);
  return [...seen];
}
