/**
 * Draws the agent's visual artifacts (shared/artifacts.ts) in the Agent panel: a table, a
 * chart, key-number cards or a one-pager, each with a small toolbar to copy or save it.
 *
 * Their text may come from a web page, so it is only ever put in the DOM as text nodes and
 * SVG text: no innerHTML, no links, no images, nothing clickable except the toolbar. The
 * panel page's CSP forbids inline styles, so everything is classes and SVG attributes.
 * The toolbar's actions run on the user's own click in this page: the clipboard, and a
 * Blob saved through a download anchor.
 */
import {
  bandScale,
  chartDomain,
  chartRows,
  chartSummary,
  fileSlug,
  formatNumber,
  linearScale,
  niceScale,
  arcPath,
  percentText,
  pieSlices,
  toCsv,
  toMarkdown,
  withUnit,
  type Artifact,
} from '../../shared/artifacts';

type Chart = Extract<Artifact, { kind: 'chart' }>;
type Attrs = Record<string, string | number | undefined | false>;

const HTML = 'http://www.w3.org/1999/xhtml';
const SVG = 'http://www.w3.org/2000/svg';

function el(tag: string, attrs: Attrs = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElement {
  const node = document.createElementNS(HTML, tag) as HTMLElement;
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== false) node.setAttribute(key, String(value));
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function svg(tag: string, attrs: Attrs = {}, ...children: Array<Node | string | null | undefined | false>): SVGElement {
  const node = document.createElementNS(SVG, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== false) node.setAttribute(key, String(value));
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const text = (attrs: Attrs, content: string) => svg('text', attrs, content);
const tooltip = (content: string) => svg('title', {}, content);
const num = (n: number) => Math.round(n * 100) / 100;

// ---- icons (the kind of artifact, and the toolbar) -------------------------------------

const PATHS = {
  table: 'M8 2v12M3.33 2h9.33a1.33 1.33 0 0 1 1.33 1.33v9.33a1.33 1.33 0 0 1-1.33 1.33h-9.33a1.33 1.33 0 0 1-1.33-1.33v-9.33a1.33 1.33 0 0 1 1.33-1.33ZM2 6h12M2 10h12',
  chart: 'M2 2v10.67a1.33 1.33 0 0 0 1.33 1.33h10.67M12 11.33V6M8.67 11.33V3.33M5.33 11.33v-2',
  cards: 'M2.67 2h3.33a.67 .67 0 0 1 .67 .67v3.33a.67 .67 0 0 1-.67 .67h-3.33a.67 .67 0 0 1-.67-.67v-3.33a.67 .67 0 0 1 .67-.67ZM10 2h3.33a.67 .67 0 0 1 .67 .67v3.33a.67 .67 0 0 1-.67 .67h-3.33a.67 .67 0 0 1-.67-.67v-3.33a.67 .67 0 0 1 .67-.67ZM10 9.33h3.33a.67 .67 0 0 1 .67 .67v3.33a.67 .67 0 0 1-.67 .67h-3.33a.67 .67 0 0 1-.67-.67v-3.33a.67 .67 0 0 1 .67-.67ZM2.67 9.33h3.33a.67 .67 0 0 1 .67 .67v3.33a.67 .67 0 0 1-.67 .67h-3.33a.67 .67 0 0 1-.67-.67v-3.33a.67 .67 0 0 1 .67-.67Z',
  onepager: 'M10 1.33H4a1.33 1.33 0 0 0-1.33 1.33v10.67a1.33 1.33 0 0 0 1.33 1.33h8a1.33 1.33 0 0 0 1.33-1.33V4.67ZM9.33 1.33v2.67a1.33 1.33 0 0 0 1.33 1.33h2.67M6.67 6H5.33M10.67 8.67H5.33M10.67 11.33H5.33',
  copy: 'M6.67 5.33h6.67a1.33 1.33 0 0 1 1.33 1.33v6.67a1.33 1.33 0 0 1-1.33 1.33h-6.67a1.33 1.33 0 0 1-1.33-1.33v-6.67a1.33 1.33 0 0 1 1.33-1.33ZM2.67 10.67c-.73 0-1.33-.6-1.33-1.33V2.67c0-.73 .6-1.33 1.33-1.33h6.67c.73 0 1.33 .6 1.33 1.33',
  download: 'M14 10v2.67a1.33 1.33 0 0 1-1.33 1.33H3.33a1.33 1.33 0 0 1-1.33-1.33v-2.67M4.67 6.67L8 10L11.33 6.67M8 10L8 2',
  check: 'M13.33 4 6 11.33l-3.33-3.33',
};

function icon(name: keyof typeof PATHS) {
  return svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: PATHS[name] }));
}

// ---- the card ----------------------------------------------------------------------------

let counter = 0;

/** One artifact as a conversation row. */
export function renderArtifact(artifact: Artifact): HTMLElement {
  const uid = `art-${++counter}`;
  const status = el('span', { class: 'art-status', role: 'status' });
  const flash = (message: string) => {
    status.textContent = message;
    window.setTimeout(() => {
      if (status.textContent === message) status.textContent = '';
    }, 2200);
  };
  const body = el('div', { class: 'art-body' });
  let getChart: (() => Promise<SVGSVGElement>) | undefined;
  if (artifact.kind === 'table') body.append(...tableView(artifact));
  else if (artifact.kind === 'chart') {
    const chart = chartView(artifact);
    getChart = chart.exportSvg;
    body.append(...chart.nodes);
  } else if (artifact.kind === 'cards') body.append(cardsView(artifact));
  else body.append(onePagerView(artifact));

  const name = fileSlug(artifact.title);
  const tool = (label: string, aria: string, run: () => Promise<string> | string, glyph: keyof typeof PATHS = 'download') => {
    const button = el('button', { class: 'art-btn', type: 'button', 'aria-label': `${aria}: ${artifact.title}`, title: aria }, icon(glyph), el('span', {}, label));
    button.addEventListener('click', () => {
      void Promise.resolve()
        .then(run)
        .then(flash)
        .catch(() => flash('Couldn’t do that'));
    });
    return button;
  };
  const tools: HTMLElement[] = [tool('Copy', artifact.kind === 'onepager' ? 'Copy as Markdown' : 'Copy as Markdown table', async () => ((await copyText(toMarkdown(artifact))) ? 'Copied' : 'Couldn’t copy'), 'copy')];
  if (artifact.kind === 'table' || artifact.kind === 'cards') {
    tools.push(tool('CSV', 'Download as CSV', () => save(new Blob(['﻿', toCsv(artifact) ?? ''], { type: 'text/csv;charset=utf-8' }), `${name}.csv`)));
  } else if (artifact.kind === 'chart' && getChart) {
    const exportSvg = getChart;
    tools.push(
      tool('SVG', 'Download as SVG', async () => save(new Blob([serialize(await exportSvg())], { type: 'image/svg+xml' }), `${name}.svg`)),
      tool('PNG', 'Download as PNG', async () => save(await toPng(await exportSvg()), `${name}.png`)),
    );
  } else if (artifact.kind === 'onepager') {
    tools.push(tool('.md', 'Download as Markdown', () => save(new Blob([toMarkdown(artifact)], { type: 'text/markdown;charset=utf-8' }), `${name}.md`)));
  }

  const card = el(
    'section',
    { class: 'art', 'data-kind': artifact.kind, 'aria-labelledby': `${uid}-title` },
    el(
      'header',
      { class: 'art-head' },
      el('span', { class: 'art-kind', 'aria-hidden': 'true' }, icon(artifact.kind)),
      el('h3', { class: 'art-title', id: `${uid}-title` }, artifact.title),
    ),
    body,
    'caption' in artifact && artifact.caption ? el('p', { class: 'art-caption' }, artifact.caption) : null,
    el('div', { class: 'art-tools', role: 'group', 'aria-label': `Actions for ${artifact.title}` }, ...tools, status),
  );
  return el('li', { class: 'art-row' }, card);
}

// ---- copy and save (user clicks in this page) ---------------------------------------------

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // The async API refused (no permission or focus): the old route, from the same click.
    const area = el('textarea', { class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' }) as HTMLTextAreaElement;
    area.value = value;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

function save(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename, class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `Saved ${filename}`;
}

/** A box that scrolls sideways fades out its edge while there is more to see. */
function scrollHint(box: HTMLElement) {
  const update = () => {
    const more = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
    if (more) box.setAttribute('data-more', '');
    else box.removeAttribute('data-more');
  };
  box.addEventListener('scroll', update, { passive: true });
  const observer = new ResizeObserver(() => {
    if (!box.isConnected) return observer.disconnect();
    update();
  });
  observer.observe(box);
  return box;
}

// ---- table -------------------------------------------------------------------------------

const NUMERIC = /^[-+−(]?[$€£¥]?\s?\d[\d.,\s]*(%|[kKmMbB]|\s?[a-zA-Z%]{1,3})?\)?$/;

function tableView(artifact: Extract<Artifact, { kind: 'table' }>): Node[] {
  const head = el('tr', {}, ...artifact.columns.map((c) => el('th', { scope: 'col' }, c)));
  const rows = artifact.rows.map((row) =>
    el(
      'tr',
      {},
      ...row.map((cell, i) => (i === 0 ? el('th', { scope: 'row' }, cell) : el('td', { class: NUMERIC.test(cell) ? 'num' : undefined }, cell))),
    ),
  );
  const table = el('table', { class: 'art-table' }, el('caption', { class: 'visually-hidden' }, `${artifact.title}. ${artifact.rows.length} rows, ${artifact.columns.length} columns.`), el('thead', {}, head), el('tbody', {}, ...rows));
  // A wide table scrolls sideways inside its own box; the box takes focus so the keyboard can scroll it.
  return [scrollHint(el('div', { class: 'art-scroll', role: 'region', tabindex: '0', 'aria-label': `${artifact.title}, table` }, table))];
}

// ---- cards -------------------------------------------------------------------------------

function cardsView(artifact: Extract<Artifact, { kind: 'cards' }>): HTMLElement {
  return el(
    'dl',
    { class: 'art-cards' },
    ...artifact.items.map((item) => el('div', { class: 'art-card' }, el('dt', {}, item.label), el('dd', { class: 'art-value' }, item.value), item.note ? el('dd', { class: 'art-note' }, item.note) : null)),
  );
}

// ---- one-pager ---------------------------------------------------------------------------

function onePagerView(artifact: Extract<Artifact, { kind: 'onepager' }>): HTMLElement {
  return el(
    'div',
    { class: 'art-page' },
    ...artifact.sections.map((s) =>
      el('section', { class: 'art-section' }, s.heading ? el('h4', {}, s.heading) : null, s.body ? el('p', {}, s.body) : null, s.bullets.length ? el('ul', {}, ...s.bullets.map((b) => el('li', {}, b))) : null),
    ),
  );
}

// ---- charts ------------------------------------------------------------------------------

const FONT = 11;
const CHAR = 6.1; // average glyph width at FONT, for fitting labels
/** A label, cut to fit `room` pixels; the whole label is in its tooltip. */
function tickLabel(attrs: Attrs, full: string, room: number) {
  const shown = fit(full, room);
  return svg('text', attrs, shown, shown !== full ? tooltip(full) : null);
}
const fit = (label: string, room: number) => {
  const max = Math.max(3, Math.floor(room / CHAR));
  const chars = Array.from(label);
  return chars.length <= max ? label : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
};
const SERIES_CLASSES = 12;
const seriesClass = (i: number) => `art-c${(i % SERIES_CLASSES) + 1}`;

interface Mode {
  /** For a saved picture: title and legend are drawn inside the SVG. */
  standalone: boolean;
}

function chartView(chart: Chart) {
  const holder = el('div', { class: 'art-chart' });
  const legend = legendList(chart);
  const dataTable = el(
    'details',
    { class: 'art-data' },
    el('summary', {}, 'Show data'),
    (() => {
      const { header, rows } = chartRows(chart);
      header[0] = header[0] || 'Category';
      return scrollHint(el('div', { class: 'art-scroll', role: 'region', tabindex: '0', 'aria-label': `${chart.title}, data` }, el('table', { class: 'art-table' }, el('caption', { class: 'visually-hidden' }, `Data for ${chart.title}`), el('thead', {}, el('tr', {}, ...header.map((c) => el('th', { scope: 'col' }, c)))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, i) => (i === 0 ? el('th', { scope: 'row' }, c) : el('td', { class: 'num' }, c)))))))));
    })(),
  );

  let lastWidth = 0;
  const draw = (width: number) => {
    lastWidth = width;
    holder.replaceChildren(drawChart(chart, width, { standalone: false }));
  };
  // The drawing is sized to its box in real pixels, so text stays readable at any panel width.
  const observer = new ResizeObserver(() => {
    if (!holder.isConnected) {
      if (lastWidth) observer.disconnect();
      return;
    }
    const width = Math.floor(holder.clientWidth);
    if (width >= 120 && Math.abs(width - lastWidth) >= 1) draw(width);
  });
  observer.observe(holder);
  draw(300);

  // A picture to save: drawn on its own at a fixed width, with its colours written out.
  const exportSvg = async () => {
    const stage = el('div', { class: 'art-stage' });
    holder.closest('.art')?.append(stage);
    try {
      const picture = drawChart(chart, 640, { standalone: true });
      stage.append(picture);
      return inlineStyles(picture, getComputedStyle(holder.closest('.art') ?? holder).getPropertyValue('--art-bg').trim() || '#ffffff');
    } finally {
      stage.remove();
    }
  };
  return { nodes: [holder, legend, dataTable], exportSvg };
}

function legendList(chart: Chart): HTMLElement {
  if (chart.type === 'pie') {
    const slices = pieSlices(chart.series[0].values);
    return el(
      'ul',
      { class: 'art-legend pie' },
      ...chart.labels.map((label, i) =>
        el('li', {}, el('span', { class: `art-swatch ${seriesClass(i)}`, 'aria-hidden': 'true' }), el('span', { class: 'art-legend-label' }, label), el('span', { class: 'art-legend-value' }, chart.unit === '%' ? withUnit(formatNumber(chart.series[0].values[i]), '%') : `${withUnit(formatNumber(chart.series[0].values[i]), chart.unit)} · ${percentText(slices[i].fraction)}`)),
      ),
    );
  }
  if (chart.series.length < 2) return el('ul', { class: 'art-legend', hidden: '' });
  return el('ul', { class: 'art-legend' }, ...chart.series.map((s, i) => el('li', {}, el('span', { class: `art-swatch ${seriesClass(i)}`, 'aria-hidden': 'true' }), el('span', { class: 'art-legend-label' }, s.name))));
}

/** Draws the chart at `width` pixels wide. */
export function drawChart(chart: Chart, width: number, mode: Mode): SVGSVGElement {
  const g = svg('g');
  let height = 0;
  let top = 0;
  const label = chartSummary(chart);
  if (mode.standalone) {
    g.append(text({ class: 'art-x-title', x: 12, y: 22 }, chart.title));
    top = 34;
  }
  if (chart.type === 'pie') height = drawPie(g, chart, width, top, mode);
  else if (chart.type === 'line') height = drawLine(g, chart, width, top);
  else height = drawBars(g, chart, width, top);
  if (mode.standalone && chart.type !== 'pie' && chart.series.length > 1) height = legendInside(g, chart, width, height);
  const root = svg('svg', { class: 'art-svg', width: num(width), height: num(height), viewBox: `0 0 ${num(width)} ${num(height)}`, role: 'img', 'aria-label': label, focusable: 'false' }, g) as SVGSVGElement;
  if (mode.standalone) root.insertBefore(svg('rect', { class: 'art-bg-rect', width: num(width), height: num(height) }), g);
  return root;
}

function legendInside(g: SVGElement, chart: Chart, width: number, y: number): number {
  let x = 12;
  let row = y + 8;
  chart.series.forEach((s, i) => {
    const w = 22 + s.name.length * CHAR + 12;
    if (x + w > width - 8 && x > 12) {
      x = 12;
      row += 18;
    }
    g.append(svg('rect', { class: seriesClass(i), x, y: row, width: 10, height: 10, rx: 2 }), text({ class: 'art-tick start', x: x + 15, y: row + 9 }, s.name));
    x += w;
  });
  return row + 22;
}

const yTicks = (chart: Chart) => {
  const domain = chartDomain(chart.series.flatMap((s) => s.values), chart.type);
  return niceScale(domain.min, domain.max, 5);
};

const tickText = (value: number, chart: Chart) => withUnit(formatNumber(value), chart.unit);

function drawBars(g: SVGElement, chart: Chart, width: number, top: number): number {
  const scale = yTicks(chart);
  const n = chart.labels.length;
  const seriesCount = chart.series.length;
  const tickWidth = Math.max(...scale.ticks.map((t) => tickText(t, chart).length)) * CHAR + 10;
  const left = Math.max(30, tickWidth);
  const right = 10;
  const slot = (width - left - right) / n;
  const horizontal = slot < 40 && n > 1;

  if (!horizontal) {
    const plotTop = top + 16;
    const plotBottom = plotTop + 150;
    const y = linearScale(scale.min, scale.max, plotBottom, plotTop);
    const bands = bandScale(n, left, width - right, 0.28);
    for (const t of scale.ticks) {
      g.append(svg('line', { class: t === 0 ? 'art-axis' : 'art-grid', x1: left, x2: width - right, y1: num(y(t)), y2: num(y(t)) }), text({ class: 'art-tick end', x: left - 6, y: num(y(t) + 3.5) }, tickText(t, chart)));
    }
    const barW = Math.max(2, (bands.width - (seriesCount - 1) * 2) / seriesCount);
    chart.series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const x = bands.start(i) + si * (barW + 2);
        const y0 = y(0);
        const y1 = y(v);
        g.append(svg('rect', { class: `art-bar ${seriesClass(si)}`, x: num(x), y: num(Math.min(y0, y1)), width: num(barW), height: num(Math.max(1, Math.abs(y1 - y0))), rx: 2 }, tooltip(`${chart.labels[i]}${seriesCount > 1 ? `, ${s.name}` : ''}: ${tickText(v, chart)}`)));
        // The number on top of the bar, when it fits.
        if (seriesCount === 1 && barW >= 24) g.append(text({ class: 'art-value-label', x: num(x + barW / 2), y: num(v >= 0 ? y1 - 4 : y1 + 12) }, formatNumber(v)));
      }),
    );
    chart.labels.forEach((labelText, i) => g.append(tickLabel({ class: 'art-tick middle', x: num(bands.center(i)), y: plotBottom + 16 }, labelText, bands.size - 2)));
    return plotBottom + 26;
  }

  // Many categories or a narrow panel: one row per category, labels on the left.
  const labelRoom = Math.min(width * 0.42, Math.max(...chart.labels.map((l) => l.length)) * CHAR + 8);
  const lx = Math.max(60, labelRoom);
  const valueRoom = 46;
  const rowH = Math.max(22, seriesCount * 14 + 8);
  const plotTop = top + 6;
  const plotBottom = plotTop + n * rowH;
  const x = linearScale(scale.min, scale.max, lx, width - valueRoom);
  const bands = bandScale(n, plotTop, plotBottom, 0.26);
  for (const t of scale.ticks) {
    g.append(svg('line', { class: t === 0 ? 'art-axis' : 'art-grid', x1: num(x(t)), x2: num(x(t)), y1: plotTop, y2: plotBottom }), text({ class: 'art-tick middle', x: num(x(t)), y: plotBottom + 14 }, tickText(t, chart)));
  }
  const barH = Math.max(3, (bands.width - (seriesCount - 1) * 2) / seriesCount);
  chart.labels.forEach((labelText, i) => g.append(tickLabel({ class: 'art-tick end', x: lx - 6, y: num(bands.center(i) + 3.5) }, labelText, lx - 10)));
  chart.series.forEach((s, si) =>
    s.values.forEach((v, i) => {
      const yy = bands.start(i) + si * (barH + 2);
      const x0 = x(0);
      const x1 = x(v);
      g.append(svg('rect', { class: `art-bar ${seriesClass(si)}`, x: num(Math.min(x0, x1)), y: num(yy), width: num(Math.max(1, Math.abs(x1 - x0))), height: num(barH), rx: 2 }, tooltip(`${chart.labels[i]}${seriesCount > 1 ? `, ${s.name}` : ''}: ${tickText(v, chart)}`)));
      if (barH >= 9) g.append(text({ class: 'art-value-label start', x: num(Math.max(x0, x1) + 4), y: num(yy + barH / 2 + 3.5) }, formatNumber(v)));
    }),
  );
  return plotBottom + 24;
}

function drawLine(g: SVGElement, chart: Chart, width: number, top: number): number {
  const scale = yTicks(chart);
  const n = chart.labels.length;
  const tickWidth = Math.max(...scale.ticks.map((t) => tickText(t, chart).length)) * CHAR + 10;
  const left = Math.max(30, tickWidth);
  const right = 14;
  const plotTop = top + 10;
  const plotBottom = plotTop + 150;
  const y = linearScale(scale.min, scale.max, plotBottom, plotTop);
  const px = (i: number) => (n === 1 ? (left + width - right) / 2 : left + 8 + (i * (width - right - left - 16)) / (n - 1));
  for (const t of scale.ticks) g.append(svg('line', { class: t === 0 ? 'art-axis' : 'art-grid', x1: left, x2: width - right, y1: num(y(t)), y2: num(y(t)) }), text({ class: 'art-tick end', x: left - 6, y: num(y(t) + 3.5) }, tickText(t, chart)));
  chart.series.forEach((s, si) => {
    const points = s.values.map((v, i) => `${num(px(i))},${num(y(v))}`);
    if (chart.series.length === 1 && n > 1) g.append(svg('polygon', { class: `art-area ${seriesClass(si)}`, points: `${num(px(0))},${num(y(Math.max(scale.min, Math.min(0, scale.max))))} ${points.join(' ')} ${num(px(n - 1))},${num(y(Math.max(scale.min, Math.min(0, scale.max))))}` }));
    g.append(svg('polyline', { class: `art-line ${seriesClass(si)}`, points: points.join(' ') }));
    s.values.forEach((v, i) =>
      g.append(svg('circle', { class: `art-dot ${seriesClass(si)}`, cx: num(px(i)), cy: num(y(v)), r: n > 16 ? 2 : 3.2 }, tooltip(`${chart.labels[i]}${chart.series.length > 1 ? `, ${s.name}` : ''}: ${tickText(v, chart)}`))),
    );
  });
  // Thin the category labels so they never collide.
  const longest = Math.max(...chart.labels.map((l) => Math.min(l.length, 14)));
  const every = Math.max(1, Math.ceil((longest * CHAR + 6) / Math.max(1, (width - right - left) / n)));
  chart.labels.forEach((labelText, i) => {
    if (i % every === 0) g.append(tickLabel({ class: 'art-tick middle', x: num(px(i)), y: plotBottom + 16 }, labelText, ((width - right - left) / n) * every - 4));
  });
  return plotBottom + 26;
}

function drawPie(g: SVGElement, chart: Chart, width: number, top: number, mode: Mode): number {
  const values = chart.series[0].values;
  const slices = pieSlices(values);
  const size = Math.min(width - 24, 190);
  const cx = mode.standalone ? width * 0.3 : width / 2;
  const cy = top + size / 2 + 6;
  const radius = size / 2;
  const live = slices.filter((s) => s.fraction > 0);
  if (live.length === 1) {
    g.append(svg('circle', { class: `art-slice ${seriesClass(live[0].index)}`, cx: num(cx), cy: num(cy), r: num(radius) }, tooltip(`${chart.labels[live[0].index]}: 100%`)));
  } else {
    for (const s of live) {
      g.append(svg('path', { class: `art-slice ${seriesClass(s.index)}`, d: arcPath(cx, cy, radius, s.start, s.end) }, tooltip(`${chart.labels[s.index]}: ${withUnit(formatNumber(s.value), chart.unit)} (${percentText(s.fraction)})`)));
    }
  }
  for (const s of live) {
    if (s.fraction < 0.07) continue;
    const mid = (s.start + s.end) / 2;
    const r = live.length === 1 ? 0 : radius * 0.62;
    g.append(text({ class: 'art-slice-label', x: num(cx + r * Math.cos(mid)), y: num(cy + r * Math.sin(mid) + 4) }, percentText(s.fraction)));
  }
  if (mode.standalone) {
    // The legend sits beside the pie in a saved picture.
    const lx = cx + radius + 24;
    chart.labels.forEach((labelText, i) => {
      const row = top + 14 + i * 18;
      g.append(svg('rect', { class: seriesClass(i), x: num(lx), y: row, width: 10, height: 10, rx: 2 }), text({ class: 'art-tick start', x: num(lx + 15), y: row + 9 }, `${fit(labelText, width - lx - 120)}  ${withUnit(formatNumber(values[i]), chart.unit)}`));
    });
    return Math.max(cy + radius + 14, top + 24 + chart.labels.length * 18);
  }
  return cy + radius + 8;
}

// ---- saving a chart as a picture -----------------------------------------------------------

const COPY_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'paint-order'];

/** The same SVG with its CSS-driven colours and fonts written onto the elements, so it stands alone. */
function inlineStyles(source: SVGSVGElement, background: string): SVGSVGElement {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const from = [source, ...source.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  from.forEach((node, i) => {
    const style = getComputedStyle(node);
    for (const prop of COPY_PROPS) {
      const value = style.getPropertyValue(prop);
      if (value) to[i].setAttribute(prop, value);
    }
    to[i].removeAttribute('class');
  });
  clone.setAttribute('xmlns', SVG);
  clone.removeAttribute('role');
  clone.removeAttribute('focusable');
  const backdrop = clone.querySelector('rect');
  if (backdrop) backdrop.setAttribute('fill', background);
  return clone;
}

const serialize = (node: SVGSVGElement) => `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(node)}\n`;

async function toPng(node: SVGSVGElement): Promise<Blob> {
  const width = Number(node.getAttribute('width'));
  const height = Number(node.getAttribute('height'));
  const image = new Image();
  // A data: URL, which the panel's CSP allows for images (a blob: URL would not be).
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize(node))}`;
  await image.decode();
  const scale = 2;
  const canvas = el('canvas', { width: width * scale, height: height * scale }) as HTMLCanvasElement;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width * scale, height * scale);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no picture'))), 'image/png'));
}
