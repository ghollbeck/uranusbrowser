// The Agent panel's layout: toggling, docking, resizing, and keeping side and width per
// profile across restarts (through the storage the background uses).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LAYOUT,
  MAX_WIDTH,
  MIN_WIDTH,
  PANEL_STORAGE_KEY,
  clampWidth,
  close,
  dock,
  loadLayout,
  resize,
  restore,
  saveLayout,
  sideForDrop,
  toggle,
  widthFromDrag,
  type PanelStorage,
} from '../shell/lib/agentPanelState';

/** chrome.storage.local, as far as the panel uses it, kept in a Map like the profile's. */
function fakeStorage(): PanelStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
  };
}

test('starts closed, docked right, about 400 px wide', () => {
  assert.deepEqual(DEFAULT_LAYOUT, { open: false, side: 'right', width: 400 });
  assert.deepEqual(restore(undefined), DEFAULT_LAYOUT);
});

test('toggle opens and closes; close always closes', () => {
  const opened = toggle(DEFAULT_LAYOUT);
  assert.equal(opened.open, true);
  assert.equal(toggle(opened).open, false);
  assert.equal(close(opened).open, false);
  assert.equal(close(DEFAULT_LAYOUT).open, false);
  // Toggling leaves where it is alone.
  assert.equal(opened.side, 'right');
  assert.equal(opened.width, 400);
});

test('dock moves it between sides without changing anything else', () => {
  const left = dock(toggle(DEFAULT_LAYOUT), 'left');
  assert.deepEqual(left, { open: true, side: 'left', width: 400 });
  assert.equal(dock(left, 'right').side, 'right');
});

test('width is kept between the limits', () => {
  assert.equal(resize(DEFAULT_LAYOUT, 10).width, MIN_WIDTH);
  assert.equal(resize(DEFAULT_LAYOUT, 5000).width, MAX_WIDTH);
  assert.equal(resize(DEFAULT_LAYOUT, 455.6).width, 456);
  assert.equal(clampWidth(Number.NaN), 400);
});

test('dropping on the left half docks left, the right half docks right', () => {
  // A window at x 100, 1200 wide: its middle is at 700.
  assert.equal(sideForDrop(150, 100, 1200), 'left');
  assert.equal(sideForDrop(699, 100, 1200), 'left');
  assert.equal(sideForDrop(700, 100, 1200), 'right');
  assert.equal(sideForDrop(1290, 100, 1200), 'right');
});

test('the resize edge is the inner side: dragging it toward the page widens the panel', () => {
  // Docked right, the edge is on the panel's left: moving left by 50 adds 50.
  assert.equal(widthFromDrag('right', 400, 1000, 950), 450);
  // Docked left, the edge is on its right: moving right adds.
  assert.equal(widthFromDrag('left', 400, 600, 650), 450);
  assert.equal(widthFromDrag('right', 400, 1000, 2000), MIN_WIDTH);
});

test('side and width persist per profile across a restart; open does not', async () => {
  const profile = fakeStorage();
  // First launch: nothing saved, the default.
  let layout = await loadLayout(profile);
  assert.deepEqual(layout, DEFAULT_LAYOUT);
  // Open it, drag it left, widen it.
  layout = resize(dock(toggle(layout), 'left'), 480);
  await saveLayout(profile, layout);
  assert.deepEqual(profile.data.get(PANEL_STORAGE_KEY), { side: 'left', width: 480 });
  // Restart: same profile, so left and 480, closed until asked for.
  const relaunched = await loadLayout(profile);
  assert.deepEqual(relaunched, { open: false, side: 'left', width: 480 });
  // Dock back right: that persists too.
  await saveLayout(profile, dock(relaunched, 'right'));
  assert.equal((await loadLayout(profile)).side, 'right');
  // Another profile is separate.
  assert.deepEqual(await loadLayout(fakeStorage()), DEFAULT_LAYOUT);
});

test('a damaged saved layout falls back to safe values', () => {
  assert.deepEqual(restore({ side: 'top', width: 'wide' }), DEFAULT_LAYOUT);
  assert.deepEqual(restore({ side: 'left', width: 99999 }), { open: false, side: 'left', width: MAX_WIDTH });
  assert.deepEqual(restore('nonsense'), DEFAULT_LAYOUT);
});

test('a dragged panel docks in the outer quarters and floats in between, where you let go', async () => {
  const { dropTarget, float, dock, resize, restore, persisted, DEFAULT_LAYOUT } = await import('../shell/lib/agentPanelState');
  const win = { width: 1440, height: 900 };
  const layout = { ...DEFAULT_LAYOUT, open: true };
  assert.deepEqual(dropTarget({ x: 200, y: 400 }, { x: 10, y: 10 }, win, layout), { kind: 'dock', side: 'left' });
  assert.deepEqual(dropTarget({ x: 1300, y: 400 }, { x: 10, y: 10 }, win, layout), { kind: 'dock', side: 'right' });
  // In the middle: floats with the grabbed spot under the pointer, its default height.
  assert.deepEqual(dropTarget({ x: 700, y: 120 }, { x: 20, y: 22 }, win, layout), { kind: 'float', rect: { x: 680, y: 98, width: 400, height: 640 } });
  // Kept inside the window.
  assert.deepEqual(dropTarget({ x: 1000, y: 880 }, { x: 20, y: 22 }, win, layout), { kind: 'float', rect: { x: 980, y: 260, width: 400, height: 640 } });
  // A short window: no taller than it.
  assert.equal((dropTarget({ x: 700, y: 10 }, { x: 0, y: 0 }, { width: 1440, height: 500 }, layout) as { rect: { height: number } }).rect.height, 484);

  const floating = float(layout, { x: 680.4, y: 98, width: 400, height: 640 });
  assert.deepEqual(floating.float, { x: 680, y: 98, width: 400, height: 640 });
  // Resizing keeps its right edge.
  assert.deepEqual(resize(floating, 480).float, { x: 600, y: 98, width: 480, height: 640 });
  // Saved and restored; docking again forgets the float.
  assert.deepEqual(restore(persisted(floating)).float, floating.float);
  assert.equal(dock(floating, 'left').float, undefined);
  assert.equal(dock(floating, 'left').side, 'left');
  assert.equal(restore({ side: 'right', width: 400, float: { x: 'a' } }).float, undefined, 'a bad float is dropped');
});
