/**
 * Console errors per tab since its last page load, for the sidebar's error badge, as in
 * Electron. The content scripts (consoleHook.ts, consoleBridge.ts) count them, so no tab needs
 * the DevTools protocol attached just to have a badge.
 */
import { sessionKey } from '../incognito';

// Each copy of the shell (regular, incognito) keeps its own.
const SESSION_KEY = sessionKey('consoleErrors');

/** By Chromium tab id; kept in session storage so a background that slept still knows. */
const counts = new Map<number, number>();
const loaded = chrome.storage.session.get(SESSION_KEY).then((saved) => {
  for (const [id, n] of Object.entries((saved[SESSION_KEY] as Record<string, number> | undefined) ?? {})) {
    if (!counts.has(Number(id))) counts.set(Number(id), n);
  }
});

let onChange: () => void = () => {};
let changeTimer: ReturnType<typeof setTimeout> | undefined;
/** For a noisy page: one sidebar update per burst. */
function changed() {
  void chrome.storage.session.set({ [SESSION_KEY]: Object.fromEntries(counts) });
  changeTimer ??= setTimeout(() => {
    changeTimer = undefined;
    onChange();
  }, 300);
}

// Listeners go on as the background starts, so the message that woke it isn't lost.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.anus !== 'console-errors' || sender.tab?.id === undefined || sender.frameId !== 0) return;
  const tabId = sender.tab.id;
  const count = Math.max(0, Math.min(1000, Number(message.count) || 0));
  void loaded.then(() => {
    counts.set(tabId, (counts.get(tabId) ?? 0) + count);
    changed();
  });
});
// A new page starts from zero (not a same-document navigation, which onCommitted doesn't report).
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  void loaded.then(() => counts.delete(tabId) && changed());
});
chrome.tabs.onRemoved.addListener((tabId) => void loaded.then(() => counts.delete(tabId) && changed()));

export function watchConsoleErrors(fn: () => void) {
  onChange = fn;
}

/** Counts by Uranus Browser tab id, for UiState.consoleErrors (only tabs that have some). */
export function consoleErrors(anusIdFor: (chromeTabId: number) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tabId, n] of counts) {
    const id = anusIdFor(tabId);
    if (id && n > 0) out[id] = n;
  }
  return out;
}
