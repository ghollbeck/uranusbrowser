/**
 * Pieces the Diet page and the sidebar's Diet summary share: the A-E chip, the plate (donut of
 * time by category), category tiles and site icons. Port of the iOS app's DietComponents.swift.
 * Every string from a page (titles, hosts) goes in as a text node.
 */
import { CATEGORY, GRADE_COLOR, GRADE_INK, type DietCategory, type NutriGrade } from '../lib/dietModel';
import type { Slice } from '../lib/dietStats';
import { icon } from './dietIcons';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, string | number | boolean | undefined | ((e: any) => void)>;

/** A small DOM builder: `on…` props are listeners, `style` is a string, everything else an attribute. */
export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export function gradeChip(g: NutriGrade, size = 24) {
  return h('span', { class: 'grade-chip', style: `--size:${size}px;background:${GRADE_COLOR[g]};color:${GRADE_INK[g]}`, 'aria-label': `Grade ${g}` }, g);
}

export function iconTile(c: DietCategory, size = 32) {
  const tile = h('span', { class: 'icon-tile', style: `--size:${size}px;--tint:${CATEGORY[c].color}` });
  tile.append(icon(CATEGORY[c].icon, Math.round(size * 0.5)));
  return tile;
}

/** The site's icon from Chromium's own cache (nothing is fetched from the site). */
export function siteIcon(host: string, size = 28) {
  const img = h('img', { class: 'site-icon', width: size, height: size, alt: '' }) as HTMLImageElement;
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', `https://${host}/`);
  url.searchParams.set('size', '32');
  img.src = url.href;
  return img;
}

/**
 * Donut of time by category, drawn in on first show, with the health score in the middle.
 * `animate` is false for redraws, so a live update doesn't replay the draw-in.
 */
export function plate(slices: Slice[], health: number, size = 140, line = 22, animate = true) {
  const r = (size - line) / 2;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', `plate${animate ? ' draw' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const ring = (stroke: string, cls: string) => {
    const el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', String(size / 2));
    el.setAttribute('cy', String(size / 2));
    el.setAttribute('r', String(r));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', String(line));
    el.setAttribute('class', cls);
    return el;
  };
  svg.append(ring('currentColor', 'plate-track'));
  let start = 0;
  for (const s of slices.filter((x) => x.share > 0.004)) {
    const arc = ring(CATEGORY[s.category].color, 'plate-arc');
    const len = Math.max(0, s.share * c - 0.004 * c);
    arc.setAttribute('stroke-dasharray', `${len} ${c}`);
    arc.setAttribute('stroke-dashoffset', String(-start * c));
    arc.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    arc.style.setProperty('--len', String(len));
    arc.style.setProperty('--delay', `${start * 1.1}s`);
    svg.append(arc);
    start += s.share;
  }
  return h(
    'div',
    { class: 'plate-wrap', style: `width:${size}px;height:${size}px` },
    svg,
    h('div', { class: 'plate-center' }, h('strong', { class: 'plate-score', style: `font-size:${Math.round(size * 0.31)}px` }, String(Math.round(health))), h('small', {}, 'health')),
  );
}

/** The A-E scale with the current grade lifted out of it; on first show a highlight runs from A to the grade. */
export function scoreStrip(g: NutriGrade, animate = true) {
  const grades: NutriGrade[] = ['A', 'B', 'C', 'D', 'E'];
  const strip = h('div', { class: 'score-strip', role: 'img', 'aria-label': `Diet score ${g}` });
  const cells = grades.map((x) => h('span', { class: 'score-cell', style: `background:${GRADE_COLOR[x]};color:${GRADE_INK[x]}` }, x));
  strip.append(...cells);
  const target = grades.indexOf(g);
  if (!animate) {
    cells[target].classList.add('on');
    return strip;
  }
  let i = 0;
  const stepTo = () => {
    cells.forEach((c, n) => c.classList.toggle('on', n === i));
    if (i++ < target) setTimeout(stepTo, 140);
  };
  requestAnimationFrame(stepTo);
  return strip;
}
