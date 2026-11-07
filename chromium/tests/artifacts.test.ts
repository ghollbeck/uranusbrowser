// Visual artifacts (shared/artifacts.ts): the tool's schema is strict, what the model sends is
// clamped and cleaned, exports can't smuggle formulas or Markdown, and the chart math is right.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_TOOL,
  LIMITS,
  arcPath,
  bandScale,
  chartDomain,
  chartSummary,
  cleanBlock,
  cleanLine,
  csvCell,
  fileSlug,
  formatNumber,
  linearScale,
  mdEscape,
  niceScale,
  percentText,
  pieSlices,
  toCsv,
  toMarkdown,
  validateArtifact,
  withUnit,
  type Artifact,
} from '../shared/artifacts';
import { BROWSER_TOOLS } from '../shared/browserAgent';

const U = (code: number) => String.fromCodePoint(code);

/** A complete argument object, as the model's strict schema forces it: every field present, unused ones null. */
const args = (over: Record<string, unknown>) => ({
  id: null,
  kind: 'table',
  title: 'T',
  caption: null,
  columns: null,
  rows: null,
  chart_type: null,
  labels: null,
  series: null,
  unit: null,
  items: null,
  sections: null,
  ...over,
});
const table = (over: Record<string, unknown> = {}) => args({ kind: 'table', title: 'Laptops', columns: ['Model', 'Price'], rows: [['A', '1,000'], ['B', '900']], ...over });
const chart = (over: Record<string, unknown> = {}) =>
  args({ kind: 'chart', title: 'Sales', chart_type: 'bar', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'EU', values: [10, 20, 15] }], ...over });
const ok = (raw: unknown) => {
  const r = validateArtifact(raw);
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.ok ? r : (undefined as never);
};
const bad = (raw: unknown) => {
  const r = validateArtifact(raw);
  assert.ok(!r.ok, 'expected a rejection');
  return r.ok ? '' : r.error;
};

// ---- the tool spec ----------------------------------------------------------------------

/** Every object in the schema, with its path. */
function objects(schema: any, path = 'parameters'): Array<{ path: string; schema: any }> {
  const found: Array<{ path: string; schema: any }> = [];
  if (schema && typeof schema === 'object') {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) found.push({ path, schema });
    for (const [key, value] of Object.entries(schema.properties ?? {})) found.push(...objects(value, `${path}.${key}`));
    if (schema.items) found.push(...objects(schema.items, `${path}[]`));
  }
  return found;
}

test('the tool schema is strict: every object closed, every property required, no unsupported keywords', () => {
  const spec = ARTIFACT_TOOL;
  assert.equal(spec.name, 'show_artifact');
  const all = objects(spec.parameters);
  assert.ok(all.length >= 4, 'the nested objects are covered too');
  for (const { path, schema } of all) {
    assert.equal(schema.additionalProperties, false, `${path} is closed`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: every property is required`);
  }
  const text = JSON.stringify(spec.parameters);
  for (const word of ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'format', 'oneOf', 'allOf', 'default', 'minimum', 'maximum']) {
    assert.ok(!text.includes(`"${word}"`), `strict mode doesn't take ${word}`);
  }
  assert.deepEqual(Object.keys(spec.parameters.properties).sort(), Object.keys(args({})).sort(), 'the schema matches the validator’s fields');
});

test('the tool has no markup, link or image fields', () => {
  const keys = objects(ARTIFACT_TOOL.parameters).flatMap(({ schema }) => Object.keys(schema.properties));
  for (const key of keys) assert.ok(!/html|markdown|markup|svg|href|link|url|src|image|script|style|code/i.test(key), `field ${key}`);
});

test('the tool is separate from the browser tools, and its enums are what the validator accepts', () => {
  assert.ok(!BROWSER_TOOLS.some((t) => (t.name as string) === ARTIFACT_TOOL.name));
  const props = ARTIFACT_TOOL.parameters.properties as any;
  assert.deepEqual(props.kind.enum, ['table', 'chart', 'cards', 'onepager']);
  assert.deepEqual(props.chart_type.enum, ['bar', 'line', 'pie', null]);
  assert.ok(ARTIFACT_TOOL.description.length < 2200);
});

// ---- validation --------------------------------------------------------------------------

test('a table, chart, cards and one-pager validate into their kinds', () => {
  const t = ok(table()).artifact;
  assert.deepEqual(t, { kind: 'table', title: 'Laptops', columns: ['Model', 'Price'], rows: [['A', '1,000'], ['B', '900']] });
  const c = ok(chart({ unit: '%', caption: 'Source: me' })).artifact;
  assert.deepEqual(c, { kind: 'chart', title: 'Sales', type: 'bar', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'EU', values: [10, 20, 15] }], unit: '%', caption: 'Source: me' });
  const k = ok(args({ kind: 'cards', title: 'Key', items: [{ label: 'Users', value: '1.2M', note: null }, { label: 'Churn', value: '2%', note: 'down' }] })).artifact;
  assert.deepEqual(k, { kind: 'cards', title: 'Key', items: [{ label: 'Users', value: '1.2M' }, { label: 'Churn', value: '2%', note: 'down' }] });
  const o = ok(args({ kind: 'onepager', title: 'Brief', sections: [{ heading: 'Why', body: 'Because.', bullets: ['a', 'b'] }] })).artifact;
  assert.deepEqual(o, { kind: 'onepager', title: 'Brief', sections: [{ heading: 'Why', body: 'Because.', bullets: ['a', 'b'] }] });
});

test('the id is kept when valid and refused when it is not', () => {
  assert.equal(ok(table({ id: 'cmp_1' })).artifact.id, 'cmp_1');
  assert.equal(ok(table({ id: null })).artifact.id, undefined);
  for (const id of ['a b', '../x', '<img>', 'x'.repeat(41), '', 'é']) assert.match(bad(table({ id })), /id must be/);
});

test('structural mistakes come back as a message for the model, not a throw', () => {
  assert.match(bad(null), /JSON object/);
  assert.match(bad([]), /JSON object/);
  assert.match(bad('x'), /JSON object/);
  assert.match(bad(table({ kind: 'diagram' })), /kind must be/);
  assert.match(bad(table({ title: '' })), /title is required/);
  assert.match(bad(table({ title: `  ${U(0x200b)} ` })), /title is required/);
  assert.match(bad(table({ title: 5 })), /title must be a string/);
  assert.match(bad(table({ columns: null })), /columns must be an array/);
  assert.match(bad(table({ columns: [] })), /at least one header/);
  assert.match(bad(table({ rows: [] })), /at least one row/);
  assert.match(bad(table({ rows: [['a', 1]] })), /must be a string/);
  assert.match(bad(table({ rows: ['a'] })), /must be an array/);
  assert.match(bad(chart({ chart_type: 'radar' })), /chart_type must be/);
  assert.match(bad(chart({ labels: [] })), /at least one/);
  assert.match(bad(chart({ series: [] })), /at least one/);
  assert.match(bad(args({ kind: 'cards', title: 'x', items: [] })), /at least one/);
  assert.match(bad(args({ kind: 'onepager', title: 'x', sections: [{ heading: '', body: '', bullets: [] }] })), /is empty/);
});

test('unknown fields are refused, at the top and nested', () => {
  assert.match(bad({ ...table(), html: '<b>x</b>' }), /unknown field "html"/i);
  assert.match(bad(chart({ series: [{ name: 'a', values: [1, 2, 3], color: 'red' }] })), /unknown field "color"/);
  assert.match(bad(args({ kind: 'cards', title: 'x', items: [{ label: 'a', value: 'b', note: null, href: 'http://x' }] })), /unknown field "href"/);
  assert.match(bad(args({ kind: 'onepager', title: 'x', sections: [{ heading: 'a', body: 'b', bullets: [], style: 'x' }] })), /unknown field "style"/);
  // __proto__ as a key (JSON.parse makes it an own property) is just an unknown field.
  assert.match(bad(JSON.parse('{"__proto__": {"x": 1}, "kind": "table", "title": "t"}')), /unknown field/i);
});

test('sizes are clamped, with a note for the model', () => {
  const many = Array.from({ length: 80 }, (_, i) => [`r${i}`, 'x']);
  const r = ok(table({ rows: many }));
  assert.equal((r.artifact as Extract<Artifact, { kind: 'table' }>).rows.length, LIMITS.rows);
  assert.ok(r.warnings.some((w) => /first 50 rows/.test(w)));
  const wide = ok(table({ columns: Array.from({ length: 12 }, (_, i) => `c${i}`), rows: [Array.from({ length: 12 }, () => 'x')] }));
  assert.equal((wide.artifact as any).columns.length, LIMITS.columns);
  assert.equal((wide.artifact as any).rows[0].length, LIMITS.columns, 'rows are cut to the columns kept');
  const long = ok(table({ title: 'T'.repeat(500), caption: 'c'.repeat(900), rows: [['x'.repeat(900), 'y']] }));
  assert.equal(Array.from(long.artifact.title).length, LIMITS.title);
  assert.ok(long.artifact.title.endsWith('…'));
  assert.equal(Array.from((long.artifact as any).caption).length, LIMITS.caption);
  assert.equal(Array.from((long.artifact as any).rows[0][0]).length, LIMITS.cell);
  const cards = ok(args({ kind: 'cards', title: 'k', items: Array.from({ length: 20 }, (_, i) => ({ label: `l${i}`, value: 'v', note: null })) }));
  assert.equal((cards.artifact as any).items.length, LIMITS.items);
});

test('ragged rows are padded or cut to the column count, with a note', () => {
  const r = ok(table({ rows: [['only'], ['a', 'b', 'c']] }));
  assert.deepEqual((r.artifact as any).rows, [['only', ''], ['a', 'b']]);
  assert.ok(r.warnings.some((w) => /padded or cut/.test(w)));
});

test('a huge input is bounded before it is processed, and the total is capped', () => {
  const started = Date.now();
  const r = ok(table({ title: 'x'.repeat(5_000_000) }));
  assert.ok(Date.now() - started < 1500, 'a 5 MB title is cut fast');
  assert.equal(Array.from(r.artifact.title).length, LIMITS.title);
  // 50 rows x 8 cells x 200 chars is 80k: over the total cap.
  const heavy = Array.from({ length: 50 }, () => Array.from({ length: 8 }, () => 'z'.repeat(200)));
  assert.match(bad(table({ columns: Array.from({ length: 8 }, (_, i) => `c${i}`), rows: heavy })), /Too much text/);
});

test('control, invisible and bidi characters are stripped from every text field', () => {
  assert.equal(cleanLine('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg', 50), 'abcde fg');
  assert.equal(cleanLine(`x${U(0x200b)}y${U(0x200e)}z${U(0x202e)}w${U(0x2066)}v${U(0x2069)}u${U(0xfeff)}q${U(0xad)}s`, 50), 'xyzwvuqs');
  assert.equal(cleanLine('line1\nline2\r\n\tline3', 50), 'line1 line2 line3');
  assert.equal(cleanLine('  many    spaces   ', 50), 'many spaces');
  assert.equal(cleanLine('lone \ud800 high and \udc00 low', 50), 'lone high and low');
  assert.equal(cleanLine('😀😀😀😀', 3), '😀😀…', 'cut by code point, never through an emoji');
  assert.equal(cleanBlock(`a\r\n\r\n\r\n\r\nb${U(0)}${U(0x202e)}  c \n d`, 50), 'a\n\nb c\nd');
  const r = ok(table({ title: `Ti${U(0x202e)}tle`, columns: [`A${U(0)}`, 'B'], rows: [[`x${U(0x200b)}1`, `y${U(7)}`]] })).artifact as any;
  assert.equal(r.title, 'Title');
  assert.deepEqual(r.columns, ['A', 'B']);
  assert.deepEqual(r.rows, [['x1', 'y']]);
});

test('chart numbers must be finite, in range and one per label', () => {
  // JSON can't carry NaN or Infinity, but a model's call can hold them as other types, and
  // in-process callers can pass the real thing.
  for (const v of [Number.NaN, Infinity, -Infinity, '12', null, undefined, {}, [1], true]) {
    assert.match(bad(chart({ series: [{ name: 'a', values: [1, v, 3] }] })), /finite number/, String(v));
  }
  assert.match(bad(chart({ series: [{ name: 'a', values: [1, 1e16, 3] }] })), /too large/);
  assert.match(bad(chart({ series: [{ name: 'a', values: [1, 2] }] })), /2 values but there are 3 labels/);
  assert.match(bad(chart({ series: [{ name: 'a', values: [1, 2, 3, 4] }] })), /4 values but there are 3 labels/);
  assert.match(bad(chart({ labels: Array.from({ length: 30 }, (_, i) => `${i}`), series: [{ name: 'a', values: Array(30).fill(1) }] })), /at most 24 labels/);
  assert.match(bad(chart({ series: Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })) })), /At most 6 series/);
  assert.equal(Object.is((ok(chart({ series: [{ name: 'a', values: [-0, 1, 2] }] })).artifact as any).series[0].values[0], 0), true, 'no negative zero');
  const negatives = ok(chart({ series: [{ name: 'a', values: [-5, 0, 5] }] }));
  assert.deepEqual((negatives.artifact as any).series[0].values, [-5, 0, 5]);
});

test('a pie takes one series of non-negative numbers with something above zero', () => {
  const pie = (over: Record<string, unknown>) => chart({ chart_type: 'pie', ...over });
  ok(pie({}));
  assert.match(bad(pie({ series: [{ name: 'a', values: [1, 2, 3] }, { name: 'b', values: [1, 2, 3] }] })), /exactly one series/);
  assert.match(bad(pie({ series: [{ name: 'a', values: [1, -2, 3] }] })), /non-negative/);
  assert.match(bad(pie({ series: [{ name: 'a', values: [0, 0, 0] }] })), /above zero/);
  assert.match(bad(pie({ labels: Array.from({ length: 13 }, (_, i) => `${i}`), series: [{ name: 'a', values: Array(13).fill(1) }] })), /at most 12 labels/);
});

test('injection-looking strings stay plain text through validation', () => {
  const evil = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '=HYPERLINK("http://evil","x")', '"; DROP TABLE users;--', '${process.env.OPENAI_API_KEY}', '{{constructor.constructor("x")()}}', '`rm -rf /`'];
  const r = ok(table({ title: evil[0], columns: ['a', evil[1]], rows: [[evil[2], evil[3]], [evil[4], evil[5]], [evil[6], evil[7]]] })).artifact as any;
  // Kept verbatim as text (the panel never parses it); nothing is executed or interpreted here.
  assert.equal(r.title, evil[0]);
  assert.equal(r.rows[0][0], evil[2]);
  assert.equal(r.rows[2][1], evil[7]);
  assert.equal(JSON.parse(JSON.stringify(r)).rows[1][1], evil[5]);
});

// ---- exports -----------------------------------------------------------------------------

test('CSV cells that start like a formula are neutralised, others are untouched', () => {
  for (const cell of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(1)', '=HYPERLINK("http://e","x")', '\t=1', '\r=1', '+cmd|\' /C calc\'!A0', '-@x']) {
    const out = csvCell(cell);
    assert.ok(out.startsWith("'") || out.startsWith('"\'') , `${JSON.stringify(cell)} → ${out}`);
  }
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('-5'), '-5', 'a plain negative number stays a number');
  assert.equal(csvCell('+1.5e3'), '+1.5e3');
  assert.equal(csvCell('=1+1').slice(0, 2), "'=");
});

test('toCsv: table, chart and cards; none for a one-pager', () => {
  const t = ok(table({ rows: [['=cmd()', '1,000'], ['B', '9']] })).artifact;
  assert.equal(toCsv(t), "Model,Price\r\n'=cmd(),\"1,000\"\r\nB,9\r\n");
  const c = ok(chart({ unit: 'EUR', series: [{ name: 'EU', values: [10, 20.5, -3] }, { name: '@US', values: [1, 2, 3] }] })).artifact;
  assert.equal(toCsv(c), "Category,EU (EUR),@US (EUR)\r\nQ1,10,1\r\nQ2,20.5,2\r\nQ3,-3,3\r\n".replace('@US (EUR)', "'@US (EUR)"));
  const k = ok(args({ kind: 'cards', title: 'k', items: [{ label: 'A', value: '=1', note: 'n' }] })).artifact;
  assert.equal(toCsv(k), "Item,Value,Note\r\nA,'=1,n\r\n");
  assert.equal(toCsv(ok(args({ kind: 'onepager', title: 'p', sections: [{ heading: 'h', body: 'b', bullets: [] }] })).artifact), null);
});

test('Markdown export escapes what would turn page text into links, HTML or structure', () => {
  assert.equal(mdEscape('[x](javascript:alert(1))'), '\\[x\\](javascript:alert(1))');
  assert.equal(mdEscape('<img src=x onerror=1>'), '\\<img src=x onerror=1\\>');
  assert.equal(mdEscape('a|b'), 'a\\|b');
  assert.equal(mdEscape('*bold* _it_ `code` ~~s~~'), '\\*bold\\* \\_it\\_ \\`code\\` \\~\\~s\\~\\~');
  assert.equal(mdEscape('# heading\n- item\n> quote\n1. one\nplain'), '\\# heading  \n\\- item  \n\\> quote  \n\\1. one  \nplain');
  const t = ok(table({ title: '# Hi', rows: [['[a](http://evil)', 'x|y'], ['line', '<b>']] })).artifact;
  const md = toMarkdown(t);
  assert.ok(md.startsWith('### \\# Hi\n'));
  assert.ok(md.includes('| \\[a\\](http://evil) | x\\|y |'));
  assert.ok(md.includes('| line | \\<b\\> |'));
  assert.ok(md.includes('| Model | Price |\n| --- | --- |'));
  assert.ok(!/<b>/.test(md));
});

test('Markdown for each kind has the shape a document expects', () => {
  const c = toMarkdown(ok(chart({ unit: '%', caption: 'Source: x' })).artifact);
  assert.ok(c.includes('| Category | EU (%) |'));
  assert.ok(c.includes('| Q2 | 20 |'));
  assert.ok(c.includes('_Bar chart_'));
  assert.ok(c.includes('_Source: x_'));
  const k = toMarkdown(ok(args({ kind: 'cards', title: 'Key', items: [{ label: 'Users', value: '1.2M', note: 'up' }] })).artifact);
  assert.ok(k.includes('| Users | 1.2M | up |'));
  const o = toMarkdown(ok(args({ kind: 'onepager', title: 'Brief', sections: [{ heading: 'Why', body: 'Because.', bullets: ['a', 'b'] }, { heading: '', body: '', bullets: ['solo'] }] })).artifact);
  assert.equal(o, '# Brief\n\n## Why\n\nBecause.\n\n- a\n- b\n\n- solo\n');
});

test('file names are safe', () => {
  assert.equal(fileSlug('Q3 Sales: EU vs. US!'), 'q3-sales-eu-vs-us');
  assert.equal(fileSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(fileSlug('Café Münch'), 'cafe-munch');
  assert.equal(fileSlug('   '), 'artifact');
  assert.equal(fileSlug('日本語'), 'artifact');
  assert.ok(fileSlug('x'.repeat(300)).length <= 48);
  assert.ok(!fileSlug('a/b\\c:d*e').match(/[/\\:*]/));
});

// ---- chart math ---------------------------------------------------------------------------

test('niceScale gives round bounds and 1-2-5 steps', () => {
  assert.deepEqual(niceScale(0, 100), { min: 0, max: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] });
  assert.deepEqual(niceScale(0, 97).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceScale(0, 10).ticks, [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceScale(0, 1).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(niceScale(3, 17).ticks, [0, 5, 10, 15, 20]);
  const s = niceScale(-30, 70);
  assert.ok(s.min <= -30 && s.max >= 70);
  assert.ok(s.ticks.includes(0));
  assert.ok(niceScale(0.1, 0.9).ticks.every((t) => Number(t.toFixed(10)) === t), 'no float noise like 0.30000000000000004');
  for (const [lo, hi] of [[0, 1e9], [1e6, 5e6], [-1e-3, 3e-3], [5, 5], [0, 0], [-7, -7], [10, 1], [0, 0.000001]]) {
    const n = niceScale(lo, hi);
    assert.ok(n.ticks.length >= 2 && n.ticks.length <= 12, `${lo}..${hi} gives ${n.ticks.length} ticks`);
    assert.ok(n.min <= Math.min(lo, hi) && n.max >= Math.max(lo, hi), `${lo}..${hi} is covered`);
    assert.equal(n.ticks[0], n.min);
    assert.ok(Math.abs(n.ticks.at(-1)! - n.max) < n.step / 1000);
  }
  assert.equal(niceScale(Number.NaN, 1).ticks.length, 5, 'garbage in, a default scale out');
});

test('chartDomain: bars include zero, lines only when zero is near', () => {
  assert.deepEqual(chartDomain([50, 80], 'bar'), { min: 0, max: 80 });
  assert.deepEqual(chartDomain([-5, -2], 'bar'), { min: -5, max: 0 });
  assert.deepEqual(chartDomain([950, 1000], 'line'), { min: 950, max: 1000 });
  assert.deepEqual(chartDomain([10, 100], 'line'), { min: 0, max: 100 });
  assert.deepEqual(chartDomain([], 'bar'), { min: 0, max: 1 });
});

test('linearScale and bandScale map as expected', () => {
  const y = linearScale(0, 100, 200, 0);
  assert.equal(y(0), 200);
  assert.equal(y(100), 0);
  assert.equal(y(25), 150);
  assert.equal(linearScale(5, 5, 0, 10)(5), 5, 'a flat domain maps to the middle');
  const b = bandScale(4, 0, 200, 0.2);
  assert.equal(b.size, 50);
  assert.equal(b.width, 40);
  assert.equal(b.start(0), 5);
  assert.equal(b.center(1), 75);
  assert.equal(bandScale(0, 0, 100).size, 100, 'no division by zero');
});

test('pie angles sum to a full turn and start at twelve o’clock', () => {
  const s = pieSlices([1, 1, 2]);
  assert.equal(s[0].start, -Math.PI / 2);
  assert.ok(Math.abs(s[0].end - s[1].start) < 1e-12);
  assert.ok(Math.abs(s[2].end - (-Math.PI / 2 + 2 * Math.PI)) < 1e-12);
  assert.deepEqual(s.map((x) => x.fraction), [0.25, 0.25, 0.5]);
  const z = pieSlices([0, 3, 0]);
  assert.equal(z[0].fraction, 0);
  assert.equal(z[0].start, z[0].end);
  assert.equal(z[1].fraction, 1);
  assert.deepEqual(pieSlices([0, 0]).map((x) => x.fraction), [0, 0]);
  assert.deepEqual(pieSlices([-4, 4]).map((x) => x.fraction), [0, 1], 'a negative never gets an angle');
});

test('arcPath: a wedge, a half, a full circle, nothing', () => {
  assert.equal(arcPath(50, 50, 40, -Math.PI / 2, 0), 'M 50 50 L 50 10 A 40 40 0 0 1 90 50 Z');
  assert.match(arcPath(50, 50, 40, -Math.PI / 2, Math.PI), / 0 1 1 /, 'more than half a turn sets the large-arc flag');
  const full = arcPath(50, 50, 40, -Math.PI / 2, 1.5 * Math.PI);
  assert.equal((full.match(/A /g) ?? []).length, 2, 'a full circle is two arcs');
  assert.equal(arcPath(50, 50, 40, 1, 1), '');
  assert.ok(!/NaN|Infinity/.test(arcPath(0, 0, 10, 0, 6)));
  assert.equal(arcPath(50, 50, 40, -Math.PI / 2, 0, 20), 'M 50 10 A 40 40 0 0 1 90 50 L 70 50 A 20 20 0 0 0 50 30 Z', 'a ring segment');
});

test('number formatting is compact and locale independent', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(1234.5), '1,234.5');
  assert.equal(formatNumber(12500), '12.5k');
  assert.equal(formatNumber(3_200_000), '3.2M');
  assert.equal(formatNumber(-4_000_000_000), '-4B');
  assert.equal(formatNumber(0.456), '0.46');
  assert.equal(withUnit('5', '%'), '5%');
  assert.equal(withUnit('5', '$'), '$5');
  assert.equal(withUnit('5', 'ms'), '5 ms');
  assert.equal(withUnit('5'), '5');
  assert.equal(percentText(0.235), '23.5%');
  assert.equal(percentText(0.5), '50%');
  assert.equal(percentText(0.004), '<1%');
  assert.equal(percentText(0), '0%');
});

test('a chart has a one-sentence text alternative', () => {
  const c = ok(chart({ unit: 'EUR' })).artifact as Extract<Artifact, { kind: 'chart' }>;
  const s = chartSummary(c);
  assert.match(s, /^Bar chart: Sales\. 3 categories, 1 series\. Values from 10 EUR to 20 EUR\./);
  const p = chartSummary({ ...c, type: 'pie' });
  assert.match(p, /^Pie chart: Sales\. 3 slices\./);
});
