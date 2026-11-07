// Several windows: each shows its own Space and tab, and marks the tabs another window has on screen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../shared/store';
import { forWindow } from '../shell/lib/windowView';
import type { UiState } from '../shared/types';

const fresh = () => new Store({ load: () => undefined, save: () => undefined });
const tabs = (store: Store, ...names: string[]) => names.map((n) => store.addTab(`https://${n}.example/`, { activate: false }).id);
const ui = (store: Store, windows?: UiState['windows']) => ({ ...structuredClone(store.state), tint: store.activeSpace.color, windows }) as unknown as UiState;

test("showView shows another window's Space and tab without counting as a visit", () => {
  const store = fresh();
  const [a, b] = tabs(store, 'a', 'b');
  store.activate(a);
  const work = store.newSpace();
  const seen = store.state.tabs[b].lastActive;
  store.showView(store.state.spaces[0].id, b);
  assert.equal(store.state.activeSpaceId, store.state.spaces[0].id);
  assert.equal(store.activeTab?.id, b);
  assert.equal(store.state.tabs[b].lastActive, seen, 'a focus switch is not a pick');
  store.showView(work.id, undefined);
  assert.equal(store.state.activeSpaceId, work.id);
  assert.equal(store.activeTab, undefined, 'a new window starts with nothing on screen');
  store.showView('gone', 'gone');
  assert.equal(store.state.activeSpaceId, work.id, 'an unknown Space keeps the current one');
});

test('with one window the state is drawn as it is', () => {
  const store = fresh();
  tabs(store, 'a');
  const state = ui(store);
  assert.equal(forWindow(state, 1), state);
});

test("a window behind draws its own tab and Space, and marks the focused window's tab", () => {
  const store = fresh();
  const [a, b] = tabs(store, 'a', 'b');
  const home = store.state.spaces[0];
  const work = store.newSpace();
  store.switchSpace(home.id);
  store.activate(a);
  // Window 1 is focused on `a`; window 2 shows `b` in the Work Space.
  const state = ui(store, { views: { 2: { spaceId: work.id, tabId: b } }, showing: { 1: a, 2: b }, parked: {} });

  const focused = forWindow(state, 1);
  assert.equal(focused.activeSpaceId, home.id);
  assert.deepEqual(focused.shownElsewhere, [b]);

  const behind = forWindow(state, 2);
  assert.equal(behind.activeSpaceId, work.id);
  assert.equal(behind.spaces.find((s) => s.id === work.id)?.activeTabId, b);
  assert.equal(behind.tint, work.color);
  assert.deepEqual(behind.shownElsewhere, [a]);
  assert.equal(state.spaces.find((s) => s.id === work.id)?.activeTabId, undefined, 'the shared state is left alone');
});

test('a window whose tab another window took is told so', () => {
  const store = fresh();
  const [a] = tabs(store, 'a');
  store.activate(a);
  const space = store.state.spaces[0].id;
  // Window 2 had `a` on screen; window 1 picked it, so window 2 is parked on it.
  const state = ui(store, { views: { 2: { spaceId: space, tabId: a } }, showing: { 1: a }, parked: { 2: a } });
  const behind = forWindow(state, 2);
  assert.equal(behind.parkedTab, a);
  assert.equal(behind.spaces[0].activeTabId, a, 'its sidebar still has the tab selected');
  assert.deepEqual(behind.shownElsewhere, [a]);
  assert.equal(forWindow(state, 1).parkedTab, undefined);
});
