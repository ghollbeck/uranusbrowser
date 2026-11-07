/**
 * Switching between light and dark fades instead of snapping: one second on OpenWhisper's
 * slow-fast-slow curve, cubic-bezier(0.37, 0, 0.63, 1) — gentle at both ends, quick in the
 * middle. The CSS side is `.theme-fading` in tokens.css. Chromium recolours a page in the same
 * frame its prefers-color-scheme flips, before the media query's change event, so the class has
 * to be on beforehand: the background sends 'theme-fade' to every shell page, then switches the
 * theme a few frames later (native.ts). A flip macOS makes on its own gets the change event only.
 * JS-painted colours (the window frame) follow the same curve through tweenColor().
 */
import { on } from '../client';

export const THEME_FADE_MS = 1000;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
/** Shared so this file's change listener runs before anyone else's on the same object. */
export const systemDark = matchMedia('(prefers-color-scheme: dark)');

/** cubic-bezier(0.37, 0, 0.63, 1) at time t (0–1): solves x(s) = t, returns y(s). */
export function themeEase(t: number) {
  const [x1, y1, x2, y2] = [0.37, 0, 0.63, 1];
  const bez = (s: number, a: number, b: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let s = t;
  for (let i = 0; i < 8; i++) {
    const dx = 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (bez(s, x1, x2) - t) / dx));
  }
  return bez(s, y1, y2);
}

/** #rrggbb between `from` and `to`. */
export function mixHex(from: string, to: string, t: number) {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return '#' + [0, 1, 2].map((i) => Math.round(ch(from, i) + (ch(to, i) - ch(from, i)) * t).toString(16).padStart(2, '0')).join('');
}

let fadeStart = -Infinity;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;
/** How long the class stays on: the fade, plus the background's lead and some slack. */
const ARMED_MS = THEME_FADE_MS + 400;

/** True from 'theme-fade' until the fade is over. */
export const themeFading = () => performance.now() < fadeStart + ARMED_MS;

function startFade() {
  if (reducedMotion.matches) return;
  fadeStart = performance.now();
  document.documentElement.classList.add('theme-fading');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => document.documentElement.classList.remove('theme-fading'), ARMED_MS);
}
on('theme-fade', startFade);
systemDark.addEventListener('change', () => {
  if (!themeFading()) startFade();
});

/**
 * Calls `paint` with colours from `from` to `to` on the fade's curve, one per frame, while a
 * theme fade is running; otherwise paints `to` at once. Returns a function that stops it.
 */
export function tweenColor(from: string | undefined, to: string, paint: (color: string) => void) {
  if (!from || from === to || !themeFading()) {
    paint(to);
    return () => {};
  }
  const start = performance.now();
  let frame = 0;
  const step = () => {
    const t = Math.min(1, (performance.now() - start) / THEME_FADE_MS);
    paint(mixHex(from, to, themeEase(t)));
    if (t < 1) frame = requestAnimationFrame(step);
  };
  step();
  return () => cancelAnimationFrame(frame);
}
