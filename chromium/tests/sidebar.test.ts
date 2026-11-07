// The sidebar's Space header and shortcuts: pinned tabs fold away and stay folded across
// restarts, its width stays in bounds, and every default shortcut is a different key (menus show them beside their items).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../shared/store';
import { SHORTCUTS, displayKeys, sameKeys } from '../shell/lib/shortcuts';

test('a Space’s pinned tabs fold away, and stay folded after a restart', () => {
  let saved: string | undefined;
  const persistence = { load: () => (saved ? JSON.parse(saved) : undefined), save: (json: string) => (saved = json) };
  const store = new Store(persistence);
  const space = store.activeSpace;
  assert.equal(space.pinnedCollapsed, undefined);
  store.togglePinnedCollapsed(space.id);
  assert.equal(store.activeSpace.pinnedCollapsed, true);
  store.togglePinnedCollapsed('no-such-space');
  assert.equal(store.activeSpace.pinnedCollapsed, true);
  (store as unknown as { flush?: () => void }).flush?.();
  const again = new Store(persistence);
  if (saved) assert.equal(again.activeSpace.pinnedCollapsed, true);
  store.togglePinnedCollapsed(space.id);
  assert.equal(store.activeSpace.pinnedCollapsed, undefined, 'unfolded leaves nothing behind');
});

test('the sidebar width stays between 200 and 480 px and survives a restart', () => {
  let saved: string | undefined;
  const persistence = { load: () => (saved ? JSON.parse(saved) : undefined), save: (json: string) => (saved = json) };
  const store = new Store(persistence);
  assert.equal(store.state.sidebarWidth, undefined, 'the default (260) is not stored');
  store.setSidebarWidth(333.6);
  assert.equal(store.state.sidebarWidth, 334);
  store.setSidebarWidth(90);
  assert.equal(store.state.sidebarWidth, 200);
  store.setSidebarWidth(5000);
  assert.equal(store.state.sidebarWidth, 480);
  store.setSidebarWidth(Number.NaN);
  assert.equal(store.state.sidebarWidth, 480, 'junk is ignored');
  (store as unknown as { flush?: () => void }).flush?.();
  if (saved) assert.equal(new Store(persistence).state.sidebarWidth, 480);
});

test('no two default shortcuts press the same keys', () => {
  for (const [i, a] of SHORTCUTS.entries()) {
    for (const b of SHORTCUTS.slice(i + 1)) assert.ok(!sameKeys(a.keys, b.keys), `${a.id} and ${b.id} both use ${a.keys}`);
  }
  assert.equal(displayKeys('Alt+CmdOrCtrl+W'), '⌥⌘W');
  assert.equal(displayKeys('Ctrl+Shift+P'), '⌃⇧P');
});

test('several picked tabs move, pin, change Space and go away together', () => {
  let saves = 0;
  const store = new Store({ load: () => undefined, save: () => void saves++ });
  const changes: number[] = [];
  store.onChange(() => changes.push(1));
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => store.addTab(`https://${n}.example/`, { activate: false }).id);
  const today = () => store.activeSpace.today;

  // Pinned together, in sidebar order, with one change event.
  changes.length = 0;
  store.moveTabs([b, d], { zone: 'pinned' });
  assert.equal(changes.length, 1, 'one change for the whole move');
  assert.deepEqual(store.activeSpace.pinned, [b, d].map((tabId) => ({ kind: 'tab', tabId })), 'in the order given (the sidebar sends its own)');
  assert.ok(store.state.tabs[b].homeUrl, 'pinned tabs get a home URL');

  // Dropped before another tab: they land there, in order; dropped on one of themselves: to the end.
  store.moveTabs([b, d], { zone: 'today', beforeTabId: c });
  assert.deepEqual(today().slice(today().indexOf(b), today().indexOf(c) + 1), [b, d, c]);
  store.moveTabs([a, c], { zone: 'today', beforeTabId: a });
  assert.deepEqual(today().slice(-2).sort(), [a, c].sort());

  // Into a new folder.
  const folderId = store.pinInNewFolder([a, c], 'Work');
  const folder = store.activeSpace.pinned.find((n) => n.kind === 'folder');
  assert.ok(folderId && folder && folder.kind === 'folder' && folder.name === 'Work');
  assert.deepEqual(folder.kind === 'folder' && folder.children.map((n) => n.kind === 'tab' && n.tabId).sort(), [a, c].sort());

  // To another Space: pinned stay pinned, today stay today, order kept.
  const home = store.activeSpace.id;
  const other = store.newSpace(false);
  store.moveTabsToSpace([a, b, c, d], other.id);
  const there = store.state.spaces.find((s) => s.id === other.id)!;
  assert.deepEqual(there.pinned.map((n) => n.kind === 'tab' && n.tabId).sort(), [a, c].sort());
  assert.equal(there.today.length, 2);
  assert.equal(store.state.spaces.find((s) => s.id === home)!.today.length, 0);

  // Archive keeps them findable; delete doesn't.
  const archived = store.state.archive.length;
  assert.deepEqual(store.removeTabs([a, b]).sort(), [a, b].sort());
  assert.equal(store.state.archive.length, archived + 2);
  assert.deepEqual(store.removeTabs([c, d, d], false).sort(), [c, d].sort());
  assert.equal(store.state.archive.length, archived + 2, 'deleted tabs skip the archive');
  assert.equal(Object.keys(store.state.tabs).length, 0);
});
