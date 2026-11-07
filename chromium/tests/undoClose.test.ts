// ⌘Z in the sidebar (and ⇧⌘T): the last close or delete comes back where it was, in its Space,
// folder and place, with its history, and still after a restart.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, findFolder, pinnedTabIds } from '../shared/store';

const memory = () => {
  let saved: string | undefined;
  return { load: () => (saved ? JSON.parse(saved) : undefined), save: (json: string) => void (saved = json) };
};
const fresh = () => new Store({ load: () => undefined, save: () => undefined });
const tabs = (store: Store, ...names: string[]) => names.map((n) => store.addTab(`https://${n}.example/`, { activate: false }).id);

test('a closed Today tab comes back in its place, shown, and leaves the archive', () => {
  const store = fresh();
  const [a, b, c] = tabs(store, 'a', 'b', 'c');
  store.activate(b);
  store.updateTab(b, { history: { entries: [{ url: 'https://b.example/' }, { url: 'https://b.example/2' }].map((e) => ({ ...e, title: '' })), index: 1 } });
  const order = [...store.activeSpace.today];
  store.closeTab(b);
  assert.ok(!(b in store.state.tabs));
  assert.equal(store.state.archive[0].url, 'https://b.example/');

  assert.equal(store.undoClose(), b);
  assert.deepEqual(store.activeSpace.today, order);
  assert.equal(store.activeSpace.activeTabId, b);
  assert.equal(store.state.tabs[b].history?.index, 1, 'back/forward come back too');
  assert.equal(store.state.archive.length, 0, 'no archive entry for a tab that is open again');
  assert.equal(store.undoClose(), undefined, 'nothing left to undo');
  assert.ok(store.state.tabs[a] && store.state.tabs[c]);
});

test('several closes undo newest first, each where it was', () => {
  const store = fresh();
  const [a, b, c, d] = tabs(store, 'a', 'b', 'c', 'd');
  const order = [...store.activeSpace.today];
  store.closeTab(b);
  store.closeTab(d);
  store.closeTab(a);
  assert.deepEqual(store.activeSpace.today, [c]);
  assert.equal(store.undoClose(), a);
  assert.equal(store.undoClose(), d);
  assert.equal(store.undoClose(), b);
  assert.deepEqual(store.activeSpace.today, order);
});

test('one action that closed many tabs is one undo', () => {
  const store = fresh();
  const [a, b, c, d] = tabs(store, 'a', 'b', 'c', 'd');
  const order = [...store.activeSpace.today];
  store.closeTodayTabs(order[0], 'below');
  assert.equal(store.activeSpace.today.length, 1);
  store.undoClose();
  assert.deepEqual(store.activeSpace.today, order);

  store.clearToday();
  assert.equal(store.activeSpace.today.length, 0);
  store.undoClose();
  assert.deepEqual(store.activeSpace.today, order);

  store.removeTabs([b, d], false);
  assert.equal(store.state.archive.filter((x) => x.url.includes('b.example')).length, 0, 'Delete skips the archive');
  store.undoClose();
  assert.deepEqual(store.activeSpace.today, order);
  assert.equal(store.state.recentlyClosed?.length, 0);
  assert.ok([a, c].every((id) => store.state.tabs[id]));
});

test('deleted pinned tabs and favorites go back into their folder and place', () => {
  const store = fresh();
  const [a, b, c, f] = tabs(store, 'a', 'b', 'c', 'f');
  store.moveTabs([a, b, c], { zone: 'pinned' });
  const folder = store.pinInNewFolder([b, c])!;
  store.moveTab(f, { zone: 'favorites' });
  const pinned = () => JSON.stringify(store.activeSpace.pinned);
  const before = pinned();

  store.removeTabs([c], false);
  assert.equal(pinnedTabIds(findFolder(store.activeSpace.pinned, folder)!.children).length, 1);
  store.undoClose();
  assert.equal(pinned(), before);
  assert.equal(store.state.tabs[c].homeUrl, 'https://c.example/', 'still a pinned tab');

  store.removeTabs([f]);
  assert.deepEqual(store.state.favorites, []);
  store.undoClose();
  assert.deepEqual(store.state.favorites, [f]);
});

test('a folder deleted with its tabs comes back whole', () => {
  const store = fresh();
  const [a, b, c] = tabs(store, 'a', 'b', 'c');
  store.moveTabs([a, b, c], { zone: 'pinned' });
  const folder = store.pinInNewFolder([a, b])!;
  store.renameFolder(folder, 'Work');
  const before = JSON.stringify(store.activeSpace.pinned);
  assert.deepEqual(store.deleteFolder(folder, false).sort(), [a, b].sort());
  assert.equal(findFolder(store.activeSpace.pinned, folder), undefined);
  store.undoClose();
  assert.equal(JSON.stringify(store.activeSpace.pinned), before);
  assert.equal(findFolder(store.activeSpace.pinned, folder)?.name, 'Work');
  assert.ok(store.state.tabs[a] && store.state.tabs[b]);
});

test('an unloaded pinned tab opens again at the page it showed', () => {
  const store = fresh();
  const [p] = tabs(store, 'p');
  store.moveTab(p, { zone: 'pinned' });
  store.activate(p);
  store.updateTab(p, { url: 'https://p.example/deep/page' });
  assert.equal(store.closeTab(p), 'unloaded');
  assert.equal(store.state.tabs[p].url, 'https://p.example/');
  assert.equal(store.activeSpace.activeTabId, undefined);
  assert.equal(store.undoClose(), p);
  assert.equal(store.state.tabs[p].url, 'https://p.example/deep/page');
  assert.equal(store.activeSpace.activeTabId, p);
});

test('a tab whose Space is gone comes back in the current one', () => {
  const store = fresh();
  const home = store.activeSpace.id;
  const other = store.newSpace();
  const [x] = tabs(store, 'x');
  store.closeTab(x);
  store.switchSpace(home);
  store.deleteSpace(other.id);
  store.undoClose();
  assert.deepEqual(store.activeSpace.today, [x]);
});

test('closes that aren’t the user’s (a phone mirror, a tab moving to AnusMini, auto-archive) aren’t undone', () => {
  const store = fresh();
  const [a, b] = tabs(store, 'a', 'b');
  store.closeTab(a, false);
  store.updateTab(b, { lastActive: 0 });
  store.archiveStale();
  assert.equal(store.state.recentlyClosed?.length ?? 0, 0);
  assert.equal(store.undoClose(), undefined);
});

test('undo still works after a restart, and the list stays short', () => {
  const persistence = memory();
  const store = new Store(persistence);
  const [a] = tabs(store, 'a');
  store.closeTab(a);
  store.saveNow();
  const again = new Store(persistence);
  assert.equal(again.undoClose(), a);
  assert.deepEqual(again.activeSpace.today, [a]);

  const many = tabs(again, ...Array.from({ length: 40 }, (_, i) => `t${i}`));
  for (const id of many) again.closeTab(id);
  assert.equal(again.state.recentlyClosed?.length, 30);
});
