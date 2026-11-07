/**
 * Visual artifacts for the Agent panel: a table, a chart, key-number cards or a one-pager
 * that the agent shows inline in the conversation. Pure data and functions, with no Node and
 * no chrome.*, so the native host (which validates what the model sends), the panel (which
 * draws it) and the tests all share one copy.
 *
 * An artifact is display only. It carries no markup, no links and no images, only plain
 * strings and numbers; its text may come from an untrusted web page, so everything is
 * clamped, stripped of control and invisible characters, and later drawn as DOM text. The
 * host is the authority: `validateArtifact()` is the only way a model's arguments become an
 * `Artifact`.
 */
import type { ToolParameters } from './browserAgent';

// ---- limits --------------------------------------------------------------------------

export const LIMITS = {
  id: 40,
  title: 100,
  caption: 300,
  columns: 8,
  rows: 50,
  header: 60,
  cell: 200,
  labels: 24,
  pieSlices: 12,
  series: 6,
  seriesName: 40,
  label: 40,
  unit: 12,
  items: 12,
  itemLabel: 60,
  itemValue: 40,
  itemNote: 160,
  sections: 8,
  heading: 80,
  body: 1200,
  bullets: 8,
  bullet: 240,
  /** Magnitude of a chart value: beyond this a number is a mistake, not data. */
  maxValue: 1e15,
  /** All text of one artifact together, so a huge call can't swamp the panel. */
  totalChars: 24_000,
} as const;

export const ARTIFACT_KINDS = ['table', 'chart', 'cards', 'onepager'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const CHART_TYPES = ['bar', 'line', 'pie'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

// ---- the validated shape -------------------------------------------------------------

interface Base {
  /** Lets a later call replace this artifact in place. */
  id?: string;
  title: string;
}

export type Artifact =
  | (Base & { kind: 'table'; columns: string[]; rows: string[][]; caption?: string })
  | (Base & { kind: 'chart'; type: ChartType; labels: string[]; series: Array<{ name: string; values: number[] }>; unit?: string; caption?: string })
  | (Base & { kind: 'cards'; items: Array<{ label: string; value: string; note?: string }> })
  | (Base & { kind: 'onepager'; sections: Array<{ heading: string; body: string; bullets: string[] }> });

// ---- the tool, as the model sees it ----------------------------------------------------

const nullable = (schema: Record<string, unknown>) => {
  const type = schema.type as string;
  const enumValues = schema.enum as unknown[] | undefined;
  return { ...schema, type: [type, 'null'], ...(enumValues ? { enum: [...enumValues, null] } : {}) };
};

/**
 * `show_artifact`. OpenAI's strict mode needs every property required and no unknown
 * ones, so the fields that don't apply to a kind are sent as null. There are no HTML,
 * Markdown, URL or image fields on purpose: the panel draws the content itself.
 */
export const ARTIFACT_TOOL = {
  name: 'show_artifact',
  description:
    'Show the user a visual in the chat: a table, a chart, key-number cards or a one-pager. Use it only when the user asks for a visual, a table, a chart or a summary card, or when you compare several things side by side. Display only: it changes nothing and reads nothing. Plain text only (no HTML, Markdown or links). ' +
    'kind "table": columns (up to 8 headers) and rows (up to 50, each an array of strings, one per column). ' +
    'kind "chart": chart_type bar, line or pie; labels (up to 24 categories, up to 12 for pie); series (up to 6, each a name and one number per label; pie takes exactly one series of non-negative numbers); optional unit such as "%" or "EUR". ' +
    'kind "cards": items (up to 12) of label, value and an optional note, for a few key numbers. ' +
    'kind "onepager": sections (up to 8) of heading, body and bullets. ' +
    'Set the fields of the other kinds to null. To change an artifact you showed earlier ("make it a bar chart", "add a row"), call again with the same id and the full new content; it replaces the old one in place.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: ['string', 'null'], description: 'Short id (letters, digits, - and _). Reuse an earlier id to replace that artifact; null for a new one.' },
      kind: { type: 'string', enum: [...ARTIFACT_KINDS] },
      title: { type: 'string', description: 'Up to 100 characters.' },
      caption: { type: ['string', 'null'], description: 'Optional one-line note under a table or chart, such as the source or period.' },
      columns: { type: ['array', 'null'], items: { type: 'string' }, description: 'table only.' },
      rows: { type: ['array', 'null'], items: { type: 'array', items: { type: 'string' } }, description: 'table only: each row has one string per column.' },
      chart_type: nullable({ type: 'string', enum: [...CHART_TYPES], description: 'chart only.' }),
      labels: { type: ['array', 'null'], items: { type: 'string' }, description: 'chart only: the categories (x axis, or pie slices).' },
      series: {
        type: ['array', 'null'],
        description: 'chart only.',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' }, description: 'One number per label.' } },
          required: ['name', 'values'],
          additionalProperties: false,
        },
      },
      unit: { type: ['string', 'null'], description: 'chart only: a short unit, such as "%", "$" or "ms".' },
      items: {
        type: ['array', 'null'],
        description: 'cards only.',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' }, note: { type: ['string', 'null'] } },
          required: ['label', 'value', 'note'],
          additionalProperties: false,
        },
      },
      sections: {
        type: ['array', 'null'],
        description: 'onepager only.',
        items: {
          type: 'object',
          properties: { heading: { type: 'string' }, body: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
          required: ['heading', 'body', 'bullets'],
          additionalProperties: false,
        },
      },
    },
    required: ['id', 'kind', 'title', 'caption', 'columns', 'rows', 'chart_type', 'labels', 'series', 'unit', 'items', 'sections'],
    additionalProperties: false,
  } satisfies ToolParameters,
} as const;

// ---- sanitising ----------------------------------------------------------------------

/** C0 and C1 controls except tab, newline and carriage return (handled separately). */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Zero-width, bidi override/isolate and line/paragraph separator characters: they hide or reorder text. */
const INVISIBLE_RANGES: Array<[number, number]> = [[0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const hex4 = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([from, to]) => (from === to ? hex4(from) : `${hex4(from)}-${hex4(to)}`)).join('')}]`, 'g');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Cuts to `max` characters (code points), with an ellipsis when something was cut. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** One line of plain text: controls and invisible characters gone, whitespace collapsed, clipped. */
export function cleanLine(value: string, max: number): string {
  // Bound the work first: a huge string is cut before it is scanned.
  const bounded = value.length > max * 4 + 16 ? value.slice(0, max * 4 + 16) : value;
  const text = bounded.replace(LONE_SURROGATE, '').replace(INVISIBLE, '').replace(/[\t\r\n\u0085]+/g, ' ').replace(CONTROLS, '').replace(/ {2,}/g, ' ').trim();
  return clipText(text, max);
}

/** A few lines of plain text (a section body): the same, but line breaks stay (no more than one blank line). */
export function cleanBlock(value: string, max: number): string {
  const bounded = value.length > max * 4 + 16 ? value.slice(0, max * 4 + 16) : value;
  const text = bounded
    .replace(LONE_SURROGATE, '')
    .replace(INVISIBLE, '')
    .replace(/\r\n?|\u0085/g, '\n')
    .replace(CONTROLS, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clipText(text, max);
}

// ---- validation ----------------------------------------------------------------------

export type ArtifactResult = { ok: true; artifact: Artifact; warnings: string[] } | { ok: false; error: string };

const TOP_KEYS = new Set(['id', 'kind', 'title', 'caption', 'columns', 'rows', 'chart_type', 'labels', 'series', 'unit', 'items', 'sections']);

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null;

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') fail(`${what} must be a string.`);
  return v as string;
}
function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} must be an array.`);
  return v as unknown[];
}
function onlyKeys(obj: Record<string, unknown>, allowed: string[], what: string) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(`${what} has an unknown field "${clipText(key, 30)}".`);
}

/**
 * Checks what the model sent and turns it into an Artifact: sizes are clamped (the reasons
 * come back as `warnings`), text is cleaned, numbers must be finite. Anything structurally
 * wrong comes back as `error`, a message meant for the model.
 */
export function validateArtifact(raw: unknown): ArtifactResult {
  const warnings: string[] = [];
  try {
    return { ok: true, artifact: build(raw, warnings), warnings };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    return { ok: false, error: 'The artifact could not be read.' };
  }
}

function build(raw: unknown, warnings: string[]): Artifact {
  if (!isRecord(raw)) return fail('The arguments must be a JSON object.');
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) fail(`Unknown field "${clipText(key, 30)}". Allowed: ${[...TOP_KEYS].join(', ')}.`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) return fail(`kind must be one of ${ARTIFACT_KINDS.join(', ')}.`);

  let id: string | undefined;
  if (present(raw.id)) {
    const value = str(raw.id, 'id').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) fail(`id must be 1 to ${LIMITS.id} letters, digits, - or _.`);
    id = value;
  }
  const title = cleanLine(str(raw.title ?? '', 'title'), LIMITS.title);
  if (!title) fail('title is required.');
  const base = { ...(id ? { id } : {}), title };
  const caption = present(raw.caption) ? cleanLine(str(raw.caption, 'caption'), LIMITS.caption) : '';

  const counted = (n: number, max: number, what: string) => {
    if (n > max) warnings.push(`Only the first ${max} ${what} were shown.`);
    return Math.min(n, max);
  };
  let chars = title.length + caption.length;
  const spend = (text: string) => {
    chars += text.length;
    return text;
  };

  let artifact: Artifact;
  switch (kind as ArtifactKind) {
    case 'table': {
      const columnsIn = list(raw.columns, 'columns');
      if (!columnsIn.length) fail('columns must have at least one header.');
      const columns = columnsIn.slice(0, counted(columnsIn.length, LIMITS.columns, 'columns')).map((c, i) => spend(cleanLine(str(c, `columns[${i}]`), LIMITS.header)));
      const rowsIn = list(raw.rows, 'rows');
      if (!rowsIn.length) fail('rows must have at least one row.');
      let padded = false;
      const rows = rowsIn.slice(0, counted(rowsIn.length, LIMITS.rows, 'rows')).map((row, r) => {
        const cells = list(row, `rows[${r}]`);
        if (cells.length !== columns.length) padded = true;
        return columns.map((_, c) => (c < cells.length ? spend(cleanLine(str(cells[c], `rows[${r}][${c}]`), LIMITS.cell)) : ''));
      });
      if (padded) warnings.push('Some rows had a different number of cells than there are columns; they were padded or cut.');
      artifact = { ...base, kind: 'table', columns, rows, ...(caption ? { caption } : {}) };
      break;
    }
    case 'chart': {
      const type = raw.chart_type;
      if (typeof type !== 'string' || !(CHART_TYPES as readonly string[]).includes(type)) return fail(`chart_type must be one of ${CHART_TYPES.join(', ')}.`);
      const pie = type === 'pie';
      const labelsIn = list(raw.labels, 'labels');
      if (!labelsIn.length) fail('labels must have at least one entry.');
      const maxLabels = pie ? LIMITS.pieSlices : LIMITS.labels;
      if (labelsIn.length > maxLabels) fail(`A ${type} chart takes at most ${maxLabels} labels; group the rest into "Other" or use a table.`);
      const labels = labelsIn.map((l, i) => spend(cleanLine(str(l, `labels[${i}]`), LIMITS.label)));
      const seriesIn = list(raw.series, 'series');
      if (!seriesIn.length) fail('series must have at least one entry.');
      if (seriesIn.length > LIMITS.series) fail(`At most ${LIMITS.series} series.`);
      if (pie && seriesIn.length !== 1) fail('A pie chart takes exactly one series.');
      const series = seriesIn.map((s, i) => {
        if (!isRecord(s)) return fail(`series[${i}] must be an object with name and values.`);
        onlyKeys(s, ['name', 'values'], `series[${i}]`);
        const name = spend(cleanLine(str(s.name, `series[${i}].name`), LIMITS.seriesName));
        const valuesIn = list(s.values, `series[${i}].values`);
        if (valuesIn.length !== labels.length) fail(`series[${i}] has ${valuesIn.length} values but there are ${labels.length} labels; give one number per label.`);
        const values = valuesIn.map((v, j) => {
          if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`series[${i}].values[${j}] must be a finite number.`);
          if (Math.abs(v) > LIMITS.maxValue) fail(`series[${i}].values[${j}] is too large.`);
          if (pie && v < 0) fail('A pie chart needs non-negative numbers.');
          return v === 0 ? 0 : v; // no negative zero
        });
        return { name: name || `Series ${i + 1}`, values };
      });
      if (pie && !series[0].values.some((v) => v > 0)) fail('A pie chart needs at least one number above zero.');
      const unit = present(raw.unit) ? spend(cleanLine(str(raw.unit, 'unit'), LIMITS.unit)) : '';
      artifact = { ...base, kind: 'chart', type: type as ChartType, labels, series, ...(unit ? { unit } : {}), ...(caption ? { caption } : {}) };
      break;
    }
    case 'cards': {
      const itemsIn = list(raw.items, 'items');
      if (!itemsIn.length) fail('items must have at least one entry.');
      const items = itemsIn.slice(0, counted(itemsIn.length, LIMITS.items, 'cards')).map((item, i) => {
        if (!isRecord(item)) return fail(`items[${i}] must be an object with label, value and note.`);
        onlyKeys(item, ['label', 'value', 'note'], `items[${i}]`);
        const label = spend(cleanLine(str(item.label, `items[${i}].label`), LIMITS.itemLabel));
        const value = spend(cleanLine(str(item.value, `items[${i}].value`), LIMITS.itemValue));
        if (!label && !value) fail(`items[${i}] is empty.`);
        const note = present(item.note) ? spend(cleanLine(str(item.note, `items[${i}].note`), LIMITS.itemNote)) : '';
        return { label, value, ...(note ? { note } : {}) };
      });
      artifact = { ...base, kind: 'cards', items };
      break;
    }
    case 'onepager': {
      const sectionsIn = list(raw.sections, 'sections');
      if (!sectionsIn.length) fail('sections must have at least one entry.');
      const sections = sectionsIn.slice(0, counted(sectionsIn.length, LIMITS.sections, 'sections')).map((section, i) => {
        if (!isRecord(section)) return fail(`sections[${i}] must be an object with heading, body and bullets.`);
        onlyKeys(section, ['heading', 'body', 'bullets'], `sections[${i}]`);
        const heading = spend(cleanLine(str(section.heading ?? '', `sections[${i}].heading`), LIMITS.heading));
        const body = spend(cleanBlock(str(section.body ?? '', `sections[${i}].body`), LIMITS.body));
        const bulletsIn = present(section.bullets) ? list(section.bullets, `sections[${i}].bullets`) : [];
        const bullets = bulletsIn
          .slice(0, counted(bulletsIn.length, LIMITS.bullets, 'bullets'))
          .map((b, j) => spend(cleanLine(str(b, `sections[${i}].bullets[${j}]`), LIMITS.bullet)))
          .filter(Boolean);
        if (!heading && !body && !bullets.length) fail(`sections[${i}] is empty.`);
        return { heading, body, bullets };
      });
      artifact = { ...base, kind: 'onepager', sections };
      break;
    }
  }
  if (chars > LIMITS.totalChars) fail(`Too much text (${chars} characters; at most ${LIMITS.totalChars}). Show less, or split it.`);
  return artifact;
}

// ---- exports: Markdown and CSV ----------------------------------------------------------

/** Escapes what Markdown would act on, so page text pasted into a document stays text. */
export function mdEscape(text: string): string {
  return text
    .replace(/[\\`*_[\]<>|~]/g, '\\$&')
    .replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/gm, (_, space: string, mark: string) => `${space}\\${mark}`)
    .replace(/\n/g, '  \n');
}

const mdCell = (text: string) => mdEscape(text).replace(/\s*\n\s*/g, ' ') || ' ';

function mdTable(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(mdCell).join(' | ')} |`;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** The numbers of a chart as a table: one row per label, one column per series. */
export function chartRows(chart: Extract<Artifact, { kind: 'chart' }>): { header: string[]; rows: string[][] } {
  const header = ['', ...chart.series.map((s) => (chart.unit ? `${s.name} (${chart.unit})` : s.name))];
  if (chart.type === 'pie') header[0] = 'Slice';
  const rows = chart.labels.map((label, i) => [label, ...chart.series.map((s) => String(s.values[i]))]);
  return { header, rows };
}

export function toMarkdown(artifact: Artifact): string {
  const title = mdEscape(artifact.title).replace(/\n/g, ' ');
  switch (artifact.kind) {
    case 'table':
      return [`### ${title}`, mdTable(artifact.columns, artifact.rows), artifact.caption ? `_${mdEscape(artifact.caption)}_` : ''].filter(Boolean).join('\n\n') + '\n';
    case 'chart': {
      const { header, rows } = chartRows(artifact);
      header[0] = header[0] || 'Category';
      return [`### ${title}`, `_${artifact.type[0].toUpperCase()}${artifact.type.slice(1)} chart_`, mdTable(header, rows), artifact.caption ? `_${mdEscape(artifact.caption)}_` : ''].filter(Boolean).join('\n\n') + '\n';
    }
    case 'cards':
      return [`### ${title}`, mdTable(['Item', 'Value', 'Note'], artifact.items.map((i) => [i.label, i.value, i.note ?? '']))].join('\n\n') + '\n';
    case 'onepager':
      return (
        [`# ${title}`, ...artifact.sections.map((s) => [s.heading ? `## ${mdEscape(s.heading).replace(/\n/g, ' ')}` : '', s.body ? mdEscape(s.body) : '', s.bullets.length ? s.bullets.map((b) => `- ${mdEscape(b).replace(/\s*\n\s*/g, ' ')}`).join('\n') : ''].filter(Boolean).join('\n\n'))].join('\n\n') + '\n'
      );
  }
}

/**
 * A cell as spreadsheets read it. A text cell that starts with = + - @ (or a tab or
 * carriage return) is a formula there, so it gets a leading apostrophe; plain numbers stay numbers.
 */
export function csvCell(value: string): string {
  let cell = value;
  if (/^[=+\-@\t\r]/.test(cell) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** A table, chart or cards as CSV; null for a one-pager, which has no rows. */
export function toCsv(artifact: Artifact): string | null {
  switch (artifact.kind) {
    case 'table':
      return csv([artifact.columns, ...artifact.rows]);
    case 'chart': {
      const { header, rows } = chartRows(artifact);
      header[0] = header[0] || 'Category';
      return csv([header, ...rows]);
    }
    case 'cards':
      return csv([['Item', 'Value', 'Note'], ...artifact.items.map((i) => [i.label, i.value, i.note ?? ''])]);
    case 'onepager':
      return null;
  }
}

/** A safe file name from a title: letters, digits and dashes, never empty. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'artifact';
}

// ---- chart geometry (so drawing is testable) ----------------------------------------------

/** The "nice" step for roughly `x`: 1, 2, 5 or 10 times a power of ten. */
function niceNumber(x: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(x));
  const fraction = x / 10 ** exponent;
  const nice = round ? (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10) : fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

const clean = (v: number) => Number(v.toPrecision(12));

export interface Scale {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/** Round axis bounds and ticks around [min, max], with about `target` ticks. */
export function niceScale(min: number, max: number, target = 5): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    // A flat series: open a window around the value.
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const step = niceNumber(niceNumber(max - min, false) / Math.max(1, target - 1), true);
  const lo = clean(Math.floor(min / step) * step);
  const hi = clean(Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let i = 0; i < 100; i++) {
    const v = clean(lo + i * step);
    if (v > hi + step / 2) break;
    ticks.push(v);
  }
  return { min: lo, max: hi, step, ticks };
}

/** The value range a chart needs. Bars always start at zero; lines only when zero is near the data. */
export function chartDomain(values: number[], type: ChartType): { min: number; max: number } {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!values.length || !Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (type === 'bar') {
    min = Math.min(0, min);
    max = Math.max(0, max);
  } else if (type === 'line' && min >= 0 && min <= max * 0.5) min = 0;
  return { min, max };
}

/** Maps [d0, d1] onto [r0, r1]. A degenerate domain maps everything to the middle of the range. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (d0 === d1) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** `count` equal bands across [r0, r1]; `pad` is the share of each band left empty. */
export function bandScale(count: number, r0: number, r1: number, pad = 0.2) {
  const size = (r1 - r0) / Math.max(1, count);
  const inner = size * (1 - pad);
  return { size, width: inner, start: (i: number) => r0 + i * size + (size - inner) / 2, center: (i: number) => r0 + i * size + size / 2 };
}

export interface Slice {
  index: number;
  value: number;
  fraction: number;
  /** Radians, clockwise from twelve o'clock is -PI/2 in SVG's coordinates. */
  start: number;
  end: number;
}

/** Angles for a pie, starting at twelve o'clock and going clockwise. Zero slices take no angle. */
export function pieSlices(values: number[]): Slice[] {
  const total = values.reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
  let angle = -Math.PI / 2;
  return values.map((raw, index) => {
    const value = raw > 0 ? raw : 0;
    const fraction = total > 0 ? value / total : 0;
    const start = angle;
    angle += fraction * Math.PI * 2;
    return { index, value, fraction, start, end: total > 0 && index === values.length - 1 ? -Math.PI / 2 + Math.PI * 2 : angle };
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** An SVG path for a pie wedge (or a ring segment when `inner` > 0). */
export function arcPath(cx: number, cy: number, radius: number, start: number, end: number, inner = 0): string {
  const span = end - start;
  const point = (r: number, a: number) => `${r2(cx + r * Math.cos(a))} ${r2(cy + r * Math.sin(a))}`;
  if (span <= 0) return '';
  if (span >= Math.PI * 2 - 1e-6) {
    // A full circle can't be one arc: two halves.
    const mid = start + Math.PI;
    const outer = `M ${point(radius, start)} A ${radius} ${radius} 0 1 1 ${point(radius, mid)} A ${radius} ${radius} 0 1 1 ${point(radius, start)} Z`;
    return inner > 0 ? `${outer} M ${point(inner, start)} A ${inner} ${inner} 0 1 0 ${point(inner, mid)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z` : outer;
  }
  const large = span > Math.PI ? 1 : 0;
  if (inner > 0) return `M ${point(radius, start)} A ${radius} ${radius} 0 ${large} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
  return `M ${r2(cx)} ${r2(cy)} L ${point(radius, start)} A ${radius} ${radius} 0 ${large} 1 ${point(radius, end)} Z`;
}

/** A compact number for axes and labels: 1,234 / 12.5k / 3.2M. English formatting, whatever the locale. */
export function formatNumber(value: number, maxDecimals = 2): string {
  const abs = Math.abs(value);
  const fmt = (n: number, decimals: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(n);
  if (abs >= 1e9) return `${fmt(value / 1e9, 2)}B`;
  if (abs >= 1e6) return `${fmt(value / 1e6, 2)}M`;
  if (abs >= 1e4) return `${fmt(value / 1e3, 1)}k`;
  return fmt(value, abs >= 100 ? Math.min(maxDecimals, 1) : maxDecimals);
}

/** A number with the chart's unit: "$" and other currency signs in front, the rest behind. */
export function withUnit(text: string, unit?: string): string {
  if (!unit) return text;
  if (unit === '%' || unit === '°' || unit === '‰') return `${text}${unit}`;
  if (/^[$€£¥₹₩]$/.test(unit)) return `${unit}${text}`;
  return `${text} ${unit}`;
}

/** Share of a pie slice as text, "23.5%" or "<1%". */
export function percentText(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return '<1%';
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** One sentence for a screen reader: what the chart shows, without the numbers table. */
export function chartSummary(chart: Extract<Artifact, { kind: 'chart' }>): string {
  const flat = chart.series.flatMap((s) => s.values);
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  const kind = chart.type === 'pie' ? 'Pie chart' : chart.type === 'line' ? 'Line chart' : 'Bar chart';
  const shape = chart.type === 'pie' ? `${chart.labels.length} slices` : `${chart.labels.length} categories, ${chart.series.length} series`;
  const range = chart.type === 'pie' ? '' : ` Values from ${withUnit(formatNumber(lo), chart.unit)} to ${withUnit(formatNumber(hi), chart.unit)}.`;
  return `${kind}: ${chart.title}. ${shape}.${range} The numbers are under Show data.`;
}
