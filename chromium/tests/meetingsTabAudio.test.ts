// Adding the meeting tab's sound mid-recording, with fake chrome.contextMenus / chrome.commands /
// chrome.tabCapture: the menu exists only while recording, the click asks for the stream id in
// the same turn, a repeat is harmless, and a refusal says what to do.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMAND, MENU_CONTEXTS, MENU_ID, MENU_TITLE, createTabAudio, refusal, tabAudioHint, type TabAudioDeps, type TabLike } from '../shell/lib/meetingsTabAudio';
import { Chunker, type Chunk } from '../shell/lib/meetingsChunker';

function fake(grant: 'ok' | Error = 'ok') {
  const log: string[] = [];
  const created: Array<{ id: string; title: string; contexts: string[] }> = [];
  let menuClick: (info: { menuItemId: string | number }, tab?: TabLike) => void = () => undefined;
  let command: (c: string, tab?: TabLike) => void = () => undefined;
  const attached: Array<{ streamId: string; tab: { id: number; url: string } }> = [];
  const said: Array<string | undefined> = [];
  const asked: number[] = [];
  const deps: TabAudioDeps = {
    contextMenus: {
      create: (p) => (created.push(p), log.push('create')),
      remove: () => void log.push('remove'),
      onClicked: { addListener: (fn) => (menuClick = fn) },
    },
    commands: { onCommand: { addListener: (fn) => (command = fn) }, getAll: async () => [{ name: COMMAND, shortcut: '⌘⇧Y' }, { name: 'other', shortcut: 'x' }] },
    tabCapture: {
      getMediaStreamId: ({ targetTabId }) => {
        asked.push(targetTabId);
        log.push('getMediaStreamId');
        return grant === 'ok' ? Promise.resolve(`stream-${targetTabId}`) : Promise.reject(grant);
      },
    },
    accept: (tab) => /^https?:/.test(tab.url ?? ''),
    attach: (streamId, tab) => attached.push({ streamId, tab }),
    say: (m) => said.push(m),
  };
  return { deps, log, created, attached, said, asked, click: (tab?: TabLike) => menuClick({ menuItemId: MENU_ID }, tab), key: (c: string, tab?: TabLike) => command(c, tab) };
}
const meet = { id: 7, url: 'https://meet.google.com/abc-defg-hij' };
const flush = () => new Promise((r) => setTimeout(r, 0));

test('the menu item exists only while a recording runs, on page-like contexts, and is removed on stop', () => {
  const f = fake();
  const t = createTabAudio(f.deps);
  assert.deepEqual(f.log, [], 'nothing before a recording');
  t.setActive(true);
  t.setActive(true);
  assert.deepEqual(f.log, ['create'], 'created once');
  assert.deepEqual(f.created[0], { id: MENU_ID, title: MENU_TITLE, contexts: [...MENU_CONTEXTS] });
  assert.match(MENU_TITLE, /^UrAnus Browser: add this tab’s audio to the meeting notes$/);
  assert.deepEqual([...MENU_CONTEXTS], ['page', 'frame', 'video', 'audio', 'selection']);
  t.setActive(false);
  t.setActive(false);
  assert.deepEqual(f.log, ['create', 'remove']);
  t.setActive(true);
  assert.deepEqual(f.log, ['create', 'remove', 'create'], 'and back for the next recording');
});

test('the click asks for the stream id first thing, in the same turn, then hands it over', async () => {
  const f = fake();
  const t = createTabAudio(f.deps);
  t.setActive(true);
  f.log.length = 0;
  f.click(meet);
  assert.deepEqual(f.log, ['getMediaStreamId'], 'called synchronously inside the click handler');
  assert.deepEqual(f.asked, [7]);
  await flush();
  assert.deepEqual(f.attached, [{ streamId: 'stream-7', tab: meet }]);
  assert.equal(t.attachedTab(), 7);
  assert.equal(f.said.at(-1), undefined, 'any old message is cleared');
});

test('the keyboard command does the same for the tab it is given, and other commands do nothing', async () => {
  const f = fake();
  const t = createTabAudio(f.deps);
  t.setActive(true);
  f.key('anus-open-location', meet);
  assert.deepEqual(f.asked, []);
  f.key(COMMAND, meet);
  assert.deepEqual(f.asked, [7]);
  await flush();
  assert.equal(f.attached.length, 1);
  assert.equal(await t.shortcut(), '⌘⇧Y');
});

test('with no recording, a click or the shortcut does nothing at all', async () => {
  const f = fake();
  createTabAudio(f.deps);
  f.click(meet);
  f.key(COMMAND, meet);
  await flush();
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.attached, []);
});

test('a second click on the same tab is a no-op with a message; another tab replaces it cleanly', async () => {
  const f = fake();
  const t = createTabAudio(f.deps);
  t.setActive(true);
  f.click(meet);
  await flush();
  f.click(meet);
  await flush();
  assert.equal(f.attached.length, 1, 'no second attach');
  assert.deepEqual(f.asked, [7], 'and no second request');
  assert.match(f.said.at(-1) ?? '', /already being added/);
  const other = { id: 9, url: 'https://zoom.us/wc/123/join' };
  f.click(other);
  await flush();
  assert.deepEqual(f.attached.map((a) => a.tab.id), [7, 9]);
  assert.equal(t.attachedTab(), 9);
  // After the capture page reports the sound gone, the same tab can be added again.
  t.detached();
  f.click(other);
  await flush();
  assert.equal(f.attached.length, 3);
});

test('a refusal from Chromium is shown plainly and nothing is attached', async () => {
  const f = fake(new Error('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'));
  const t = createTabAudio(f.deps);
  t.setActive(true);
  f.click(meet);
  await flush();
  assert.deepEqual(f.attached, []);
  assert.equal(t.attachedTab(), undefined);
  assert.match(f.said.at(-1) ?? '', /didn’t allow capturing this tab/);
  assert.match(refusal(new Error('Cannot capture a chrome:// page')), /can’t be captured/);
  assert.match(refusal(new Error('boom')), /couldn’t be captured/);
  assert.ok(!refusal(new Error('secret token abc')).includes('abc'), 'provider text is not echoed');
});

test('a click that arrives after Stop attaches nothing, and pages that cannot be captured are refused up front', async () => {
  const f = fake();
  const t = createTabAudio(f.deps);
  t.setActive(true);
  f.click(meet);
  t.setActive(false); // Stop while the id is on its way
  await flush();
  assert.deepEqual(f.attached, []);
  t.setActive(true);
  f.click({ id: 3, url: 'chrome://settings' });
  f.click(undefined);
  await flush();
  assert.deepEqual(f.asked, [7], 'no request was made for those');
  assert.match(f.said.at(-1) ?? '', /can’t be recorded/);
});

test('the hint tells the user exactly what to do, with the shortcut only if there is one', () => {
  assert.equal(
    tabAudioHint({ tabAudioMenu: MENU_TITLE, tabAudioShortcut: '⌘⇧Y' }),
    'Remote participants’ audio isn’t being captured yet. Click the meeting tab, then press ⌘⇧Y. Or right-click inside the meeting page (not the sidebar) and choose “UrAnus Browser: add this tab’s audio to the meeting notes”.',
  );
  assert.ok(!/press/.test(tabAudioHint({ tabAudioMenu: MENU_TITLE, tabAudioShortcut: '' })));
});

test('a source that starts late has its chunks placed on the recording clock', () => {
  const chunks: Chunk[] = [];
  const c = new Chunker(16000, (x) => chunks.push(x), 1000, 12_340);
  c.push(new Float32Array(16000 * 1.5));
  assert.deepEqual([chunks[0].startMs, chunks[0].endMs], [12_340, 13_340]);
  c.flush(100);
  assert.deepEqual([chunks[1].startMs, chunks[1].endMs], [13_340, 13_840]);
});
