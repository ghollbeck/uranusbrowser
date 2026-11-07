import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../shared/store';

function profile() {
  const store = new Store({ load: () => undefined, save: () => {} });
  store.importArc({ spaces: [{ sourceId: 'arc-work', name: 'Research', color: '#123456', isolated: true,
    pinned: [{ kind: 'folder', name: 'Papers', children: [{ kind: 'tab', url: 'https://example.org/paper', title: 'Paper' }] }],
    today: [{ url: 'https://example.org/current', title: 'Current work' }],
  }], favorites: [{ url: 'https://example.org', title: 'Favorite' }] });
  store.setPreferences({ theme: 'dark', peekPinnedLinks: false });
  store.setOnboarded(true);
  return store;
}

test('replaying and completing onboarding preserves every existing tab, nested folder, favorite, isolated Space and preference', () => {
  const store = profile();
  const before = structuredClone(store.state);
  store.replayOnboarding();
  assert.equal(store.state.onboardingReplay, true);
  assert.equal(store.state.onboarded, false);
  const during = structuredClone(store.state);
  delete during.onboardingReplay;
  during.onboarded = true;
  assert.deepEqual(during, before);
  store.setOnboarded(true);
  assert.deepEqual(store.state, before);
});

test('replay survives a restart and skipping it preserves the existing profile', () => {
  const store = profile();
  const before = structuredClone(store.state);
  store.replayOnboarding();
  let saved = '';
  const persistence = { load: () => structuredClone(store.state), save: (s: string) => { saved = s; } };
  const restarted = new Store(persistence);
  assert.equal(restarted.state.onboardingReplay, true);
  restarted.setOnboarded(true);
  restarted.saveNow();
  assert.deepEqual(JSON.parse(saved), JSON.parse(JSON.stringify(before)));
});

test('normal first-time onboarding keeps its existing behavior and does not enter replay mode', () => {
  const store = new Store({ load: () => undefined, save: () => {} });
  assert.equal(store.state.onboardingReplay, undefined);
  store.setOnboarded(true);
  assert.equal(store.state.onboardingReplay, undefined);
});
