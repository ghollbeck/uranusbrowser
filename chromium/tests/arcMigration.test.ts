import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { parseArcSidebar } from '../native-host/arcImport';
import { decryptArcPassword } from '../native-host/arcPasswords';
import { Store } from '../shared/store';
import { applyBrowserImport } from '../shared/importApply';

const tab = (id: string, url = 'https://example.com/' + id) => ({ id, data: { tab: { savedURL: url, savedTitle: id } } });
const sidebar = () => ({ sidebar: { containers: [{ global: {} }, {
  spaces: ['s', { id: 's', title: 'Work', profile: { custom: {} }, newContainerIDs: [{ pinned: {} }, 'pins', { unpinned: {} }, 'today'], customInfo: { windowTheme: { primaryColorPalette: { midTone: { red: 1.1, green: 0.5, blue: -0.2 } } } } }],
  items: [tab('a'), tab('b'), tab('c'), tab('unsafe', 'javascript:alert(1)'),
    { id: 'pins', childrenIds: ['folder', 'unsafe'] }, { id: 'today', childrenIds: ['c'] },
    { id: 'folder', title: 'Nested', data: { list: {} }, childrenIds: ['a', 'split', 'folder'] },
    { id: 'split', data: { splitView: {} }, childrenIds: ['b'] },
    { id: 'fav1', childrenIds: ['a'] }, { id: 'fav2', childrenIds: ['b'] }],
  topAppsContainerIDs: [{ default: true }, 'fav1', { custom: {} }, 'fav2'],
} ] } });

test('Arc migration maps all favorites, nested/split groups, newer containers, colors and Today; cycles and unsafe URLs are skipped', () => {
  const data = parseArcSidebar(sidebar());
  assert.equal(data.spaces.length, 1);
  assert.equal(data.favorites.length, 2);
  assert.equal(data.spaces[0].today[0].title, 'c');
  assert.equal(data.spaces[0].color, '#ff8000');
  assert.equal(data.spaces[0].isolated, true);
  assert.equal(data.spaces[0].pinned[0].kind, 'folder');
  assert.ok(data.warnings?.length);
  assert.ok(!JSON.stringify(data).includes('javascript:'));
});

test('Applying Arc twice preserves local work, survives persistence and reports only additions; empty import leaves a usable Space', async () => {
  let saved = '';
  const store = new Store({ load: () => undefined, save: (s) => { saved = s; } });
  store.addTab('https://local.example');
  const data = { name: 'Arc', bookmarkCount: 0, history: [], warnings: [], arc: parseArcSidebar(sidebar()) };
  const history = { merge: () => 0 };
  const first = await applyBrowserImport(data, store, history);
  assert.equal(first.spaces, 1);
  assert.equal(first.bookmarks, 5);
  store.saveNow();
  const reloaded = new Store({ load: () => JSON.parse(saved), save: () => {} });
  const again = await applyBrowserImport(data, reloaded, history);
  assert.equal(again.spaces, 0);
  assert.equal(again.bookmarks, 0);
  assert.ok(Object.values(reloaded.state.tabs).some((t) => t.url === 'https://local.example'));
  const empty = new Store({ load: () => undefined, save: () => {} });
  empty.importArc({ spaces: [], favorites: [] });
  assert.ok(empty.activeSpace);
});

test('Arc v10 passwords decrypt with the macOS key derivation; unsupported formats fail closed', () => {
  const key = crypto.pbkdf2Sync('test secret', 'saltysalt', 1003, 16, 'sha1');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const blob = Buffer.concat([Buffer.from('v10'), cipher.update('pāssword\n'), cipher.final()]);
  assert.equal(decryptArcPassword(blob, key), 'pāssword\n');
  assert.throws(() => decryptArcPassword(Buffer.from('v20unsupported'), key));
});
