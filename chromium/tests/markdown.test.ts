// The agent's answers as Markdown: what the parser makes of what models write, and what it refuses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linksIn, parseInline, parseMarkdown, safeHref, shortAddress, type Block, type Inline } from '../shell/lib/markdown';

const text = (nodes: Inline[]): string => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : n.t === 'img' ? `[img ${n.alt}]` : `{${n.t}:${text(n.c)}}`)).join('');

test('inline: emphasis, code, strikethrough, escapes; snake_case and lone stars stay text', () => {
  assert.equal(text(parseInline('**Bold** and *it* and _it2_ and ~~gone~~ and `a*b*c`')), '{b:Bold} and {i:it} and {i:it2} and {s:gone} and a*b*c');
  assert.equal(text(parseInline('use my_var_name and 2 * 3 * 4 and \\*not\\*')), 'use my_var_name and 2 * 3 * 4 and *not*');
  assert.equal(text(parseInline('**unclosed bold while it streams')), '**unclosed bold while it streams');
  assert.equal(text(parseInline('***both***')), '{b:{i:both}}');
  // Inside a word, double underscores are letters (as in CommonMark); on their own they're bold.
  assert.equal(text(parseInline('use my__private__name and obj__x then __bold__')), 'use my__private__name and obj__x then {b:bold}');
  assert.equal(text(parseInline('line one  \nline two\nsame line')), 'line one\nline two same line');
});

test('links: titled, bare, autolinked; only http(s) and mailto; punctuation stays outside', () => {
  const nodes = parseInline('See [ETH news](https://ethz.ch/en/news.html "t"), https://example.com/a. and <https://x.org> or (https://en.wikipedia.org/wiki/Bern_(city)).');
  const links = nodes.filter((n) => n.t === 'link') as Array<Extract<Inline, { t: 'link' }>>;
  assert.deepEqual(links.map((l) => [l.href, !!l.bare]), [
    ['https://ethz.ch/en/news.html', false],
    ['https://example.com/a', true],
    ['https://x.org/', true],
    ['https://en.wikipedia.org/wiki/Bern_(city)', true],
  ]);
  assert.match(text(nodes), /\{link:https:\/\/example\.com\/a\}\. and/);
  // Anything else stays as its words.
  assert.equal(text(parseInline('[click](javascript:alert(1)) [file](file:///etc/passwd) [data](data:text/html,x)')), 'click file data');
  assert.equal(safeHref('https://user:pw@evil.example/'), undefined, 'no credentials in an address');
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeHref('mailto:a@b.c', false), undefined);
});

test('images are kept as images (shown on a click), only from http(s)', () => {
  const [img] = parseInline('![A mountain](https://upload.example/m.jpg?x=1)');
  assert.deepEqual(img, { t: 'img', src: 'https://upload.example/m.jpg?x=1', alt: 'A mountain' });
  assert.equal(text(parseInline('![x](data:image/png;base64,AAA)')), 'x');
});

test('raw HTML is text, not markup', () => {
  const [p] = parseMarkdown('<img src=x onerror=alert(1)> <b>hi</b>') as Array<Extract<Block, { t: 'p' }>>;
  assert.equal(text(p.c), '<img src=x onerror=alert(1)> <b>hi</b>');
});

test('blocks: headings, lists (nested, ordered with a start), quotes, rules, code', () => {
  const blocks = parseMarkdown(['## Plan', '', '1. First', '2. Second', '   - nested a', '   - nested b', '3. Third', '', '> quoted **bold**', '', '---', '', '```ts', 'const a = 1;', '```', 'After'].join('\n'));
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'list', 'quote', 'hr', 'code', 'p']);
  const list = blocks[1] as Extract<Block, { t: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
  assert.equal(list.items[1][1]?.t, 'list', 'the nested list is inside the second item');
  assert.deepEqual(blocks[4], { t: 'code', lang: 'ts', v: 'const a = 1;' });
  const started = parseMarkdown('3. three\n4. four')[0] as Extract<Block, { t: 'list' }>;
  assert.equal(started.start, 3);
  // A fence still streaming runs to the end.
  assert.deepEqual(parseMarkdown('```\nhalf'), [{ t: 'code', lang: '', v: 'half' }]);
});

test('tables: alignment, inline content, ragged rows, pipes in code', () => {
  const [table] = parseMarkdown(['| Plan | Price | Link |', '|:---|---:|:--:|', '| **Small** | 49 € | [buy](https://acme.example/buy) |', '| Big `a|b` | ask |'].join('\n')) as Array<Extract<Block, { t: 'table' }>>;
  assert.equal(table.t, 'table');
  assert.deepEqual(table.align, ['left', 'right', 'center']);
  assert.equal(text(table.rows[0][0]), '{b:Small}');
  assert.equal(table.rows[0][2][0].t, 'link');
  assert.equal(text(table.rows[1][0]), 'Big a|b');
  assert.equal(table.rows[1].length, 3, 'a short row is padded');
});

test('sources and short names for pills', () => {
  const blocks = parseMarkdown('Read [a](https://a.example/x) and https://b.example/y.\n\n| s |\n|---|\n| https://a.example/x |');
  assert.deepEqual(linksIn(blocks), ['https://a.example/x', 'https://b.example/y']);
  assert.equal(shortAddress('https://www.ethz.ch/en/news/2026/item.html'), 'ethz.ch/en/…');
  assert.equal(shortAddress('https://example.com/'), 'example.com');
  assert.equal(shortAddress('https://example.com/pricing'), 'example.com/pricing');
  assert.equal(shortAddress('mailto:a@b.c'), 'a@b.c');
});
