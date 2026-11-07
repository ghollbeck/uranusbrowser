// Opening System Settings panes for the first-run permissions step: only the three fixed names work,
// and the only program ever run is /usr/bin/open with the fixed address for that name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIVACY_PANES, isPrivacyPane, openPrivacyPane } from '../native-host/privacyPanes';

type Call = { file: string; args: string[] };
const runner = (fail = false) => {
  const calls: Call[] = [];
  const run = ((file: string, args: string[], _opts: object, cb: (err: Error | null) => void) => {
    calls.push({ file, args });
    cb(fail ? new Error('no') : null);
  }) as never;
  return { calls, run };
};

test('the three panes are the ones asked for, each a System Settings privacy address', () => {
  assert.deepEqual(Object.keys(PRIVACY_PANES).sort(), ['appManagement', 'camera', 'microphone']);
  for (const url of Object.values(PRIVACY_PANES)) assert.match(url, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_[A-Za-z]+$/);
  assert.match(PRIVACY_PANES.appManagement, /Privacy_AppBundles$/);
});

test('a known name opens exactly its address with /usr/bin/open', { skip: process.platform !== 'darwin' }, async () => {
  const { calls, run } = runner();
  assert.equal(await openPrivacyPane('appManagement', run), true);
  assert.deepEqual(calls, [{ file: '/usr/bin/open', args: [PRIVACY_PANES.appManagement] }]);
});

test('privacy panes are unavailable on platforms without macOS System Settings', { skip: process.platform === 'darwin' }, async () => {
  const { calls, run } = runner();
  assert.equal(await openPrivacyPane('camera', run), false);
  assert.equal(calls.length, 0, 'no macOS command is run on this platform');
});

test('anything else (other names, addresses, odd values, inherited properties) opens nothing', async () => {
  const { calls, run } = runner();
  for (const bad of ['', 'files', 'https://evil.example', '-a Calculator', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera', 'constructor', '__proto__', 'toString', 42, null, undefined, {}, ['camera']]) {
    assert.equal(isPrivacyPane(bad), false, String(bad));
    assert.equal(await openPrivacyPane(bad, run), false, String(bad));
  }
  assert.equal(calls.length, 0, 'nothing was run');
});

test('when open itself fails the answer is false, not a crash', async () => {
  const { run } = runner(true);
  assert.equal(await openPrivacyPane('camera', run), false);
});
