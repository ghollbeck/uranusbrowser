/**
 * Where the Agent panel sits: open or not, docked left or right of the page (or floating over
 * it, anywhere in the window), and how wide.
 * The side and width are kept per profile (chrome.storage.local); every window shows the
 * panel the same way. Opening starts closed on each launch.
 */
export type PanelSide = 'left' | 'right';

/** A floating panel's place in the window, px from its top left corner, margins included. */
export interface FloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelLayout {
  open: boolean;
  side: PanelSide;
  /** The panel strip's width in px, its margins included. */
  width: number;
  /** Set while it floats over the page instead of docking beside it. */
  float?: FloatRect;
}

/** Where a drag would put the panel: docked on a side, or floating at a rect. */
export type DropTarget = { kind: 'dock'; side: PanelSide } | { kind: 'float'; rect: FloatRect };

export const PANEL_STORAGE_KEY = 'agentPanel';
export const DEFAULT_WIDTH = 400;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;
export const MIN_HEIGHT = 320;
export const DEFAULT_FLOAT_HEIGHT = 640;
/** The window's outer quarters dock; the middle floats. */
export const DOCK_ZONE = 0.25;
export const DEFAULT_LAYOUT: PanelLayout = { open: false, side: 'right', width: DEFAULT_WIDTH };

export const clampWidth = (width: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number.isFinite(width) ? width : DEFAULT_WIDTH)));

export const toggle = (layout: PanelLayout): PanelLayout => ({ ...layout, open: !layout.open });
export const close = (layout: PanelLayout): PanelLayout => ({ ...layout, open: false });
export const dock = (layout: PanelLayout, side: PanelSide): PanelLayout => {
  const { float: _float, ...docked } = layout;
  return { ...docked, side };
};
export const float = (layout: PanelLayout, rect: FloatRect): PanelLayout => ({ ...layout, float: clampFloat(rect) });
/** A floating panel keeps its right edge where it was, as a right-docked one does. */
export const resize = (layout: PanelLayout, width: number): PanelLayout => {
  const w = clampWidth(width);
  if (!layout.float) return { ...layout, width: w };
  return { ...layout, float: clampFloat({ ...layout.float, x: layout.float.x + layout.float.width - w, width: w }) };
};

/** What's saved: the side, width and float, not whether it's open. */
export const persisted = (layout: PanelLayout) => ({ side: layout.side, width: layout.width, ...(layout.float ? { float: layout.float } : {}) });

/** A float rect with whole, sane numbers (the browser also keeps it inside the window). */
export function clampFloat(rect: FloatRect): FloatRect {
  const n = (v: number, fallback: number) => (Number.isFinite(v) ? Math.round(v) : fallback);
  return {
    x: Math.max(0, n(rect.x, 0)),
    y: Math.max(0, n(rect.y, 0)),
    width: clampWidth(rect.width),
    height: Math.max(MIN_HEIGHT, Math.min(4000, n(rect.height, DEFAULT_FLOAT_HEIGHT))),
  };
}

/**
 * Where a dragged panel would land, from the pointer in window coordinates: the outer
 * quarters dock it on that side, anywhere between floats it there, keeping the spot you
 * grabbed it by under the pointer.
 */
export function dropTarget(
  pointer: { x: number; y: number },
  grab: { x: number; y: number },
  win: { width: number; height: number },
  layout: PanelLayout,
): DropTarget {
  if (pointer.x < win.width * DOCK_ZONE) return { kind: 'dock', side: 'left' };
  if (pointer.x > win.width * (1 - DOCK_ZONE)) return { kind: 'dock', side: 'right' };
  const width = layout.float?.width ?? layout.width;
  const height = Math.min(layout.float?.height ?? DEFAULT_FLOAT_HEIGHT, Math.max(MIN_HEIGHT, win.height - 16));
  const x = Math.min(Math.max(0, pointer.x - grab.x), Math.max(0, win.width - width));
  const y = Math.min(Math.max(0, pointer.y - grab.y), Math.max(0, win.height - height));
  return { kind: 'float', rect: clampFloat({ x, y, width, height }) };
}

/** A saved layout, checked: anything missing or odd falls back to the default. */
export function restore(saved: unknown): PanelLayout {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<PanelLayout>;
  const f = s.float as Partial<FloatRect> | undefined;
  const floatOk = f && typeof f === 'object' && ['x', 'y', 'width', 'height'].every((k) => typeof f[k as keyof FloatRect] === 'number');
  return {
    open: false,
    side: s.side === 'left' ? 'left' : 'right',
    width: typeof s.width === 'number' ? clampWidth(s.width) : DEFAULT_WIDTH,
    ...(floatOk ? { float: clampFloat(f as FloatRect) } : {}),
  };
}

/** Where a dragged panel lands: the half of the window the pointer was let go over. */
export function sideForDrop(pointerScreenX: number, windowLeft: number, windowWidth: number): PanelSide {
  return pointerScreenX < windowLeft + windowWidth / 2 ? 'left' : 'right';
}

/** Width from a resize drag: the inner edge follows the pointer. */
export function widthFromDrag(side: PanelSide, startWidth: number, startX: number, x: number) {
  return clampWidth(side === 'right' ? startWidth + (startX - x) : startWidth + (x - startX));
}

/** Storage as the panel module uses it, so tests can hand it a fake. */
export interface PanelStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadLayout(storage: PanelStorage) {
  return restore((await storage.get(PANEL_STORAGE_KEY))[PANEL_STORAGE_KEY]);
}

export async function saveLayout(storage: PanelStorage, layout: PanelLayout) {
  await storage.set({ [PANEL_STORAGE_KEY]: persisted(layout) });
}
