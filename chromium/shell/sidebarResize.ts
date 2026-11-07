/**
 * The sidebar's right edge drags to make it wider or narrower (200–480 px), as in Arc.
 * While dragging, the window is laid out at the new width every frame (anusApi.ts sends it
 * to setFrame, patch 0044); letting go saves it, and a double-click goes back to 260.
 * Only in Uranus Browser's own browser, and only while the sidebar is shown (docked or floating).
 */
import { previewSidebarWidth, sidebarResizable } from './anusApi';

const MIN = 200;
const MAX = 480;
const DEFAULT = 260;

if (document.documentElement.dataset.surface === 'window') {
  const handle = document.createElement('div');
  handle.className = 'sidebar-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Sidebar width');
  document.body.append(handle);

  const current = () => document.getElementById('sidebar')?.getBoundingClientRect().width ?? DEFAULT;
  const clamp = (w: number) => Math.round(Math.min(MAX, Math.max(MIN, w)));
  const save = (width: number) => window.anus.setSidebarWidth?.(width);

  let start: { x: number; width: number } | undefined;
  let width = DEFAULT;
  let frame = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !sidebarResizable()) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { x: e.screenX, width: current() };
    width = start.width;
    document.documentElement.classList.add('sidebar-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    width = clamp(start.width + e.screenX - start.x);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => previewSidebarWidth(width));
  });
  const end = () => {
    if (!start) return;
    start = undefined;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove('sidebar-resizing');
    previewSidebarWidth(width);
    save(width);
    previewSidebarWidth(undefined);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    if (!sidebarResizable()) return;
    width = DEFAULT;
    previewSidebarWidth(width);
    save(width);
    previewSidebarWidth(undefined);
  });
}
