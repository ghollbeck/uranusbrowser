/**
 * Sites that pick light or dark on their server (Google Search, for one) can't follow a theme
 * switch the way a page with prefers-color-scheme CSS does: the page they sent stays as it was.
 * They ask for the Sec-CH-Prefers-Color-Scheme client hint, so the browser tells them the scheme
 * on every request to them; this notes, per tab, which scheme its page was made for, and when
 * the scheme flips (Uranus Browser's Appearance setting, or macOS when that is followed) reloads just
 * the tabs made for the other one. Every other tab is left alone.
 *
 * A tab you are looking at doesn't just reload: its new page cross-fades in on the theme-fade
 * curve, like a page that recolours itself (pageThemeFade.ts). A reload can't be a View
 * Transition, so the tab navigates to its own address instead (a replace; scroll is carried over
 * by hand), after the old page and, through a one-shot content script, the new one opted in.
 *
 * Chromium tells a brand-new tab's first page request macOS's scheme, not Uranus Browser's (the
 * Appearance setting reaches the tab only after that), so a new Google tab came out in the wrong
 * one. While the setting is Light or Dark, a session rule sets the hint to it on every page request
 * to the origins that ask for it (useScheme()); with System, Chromium's own value is right.
 *
 * A tab can miss its note: its page request may come without a tab (a Space with its own cookies
 * opens the page before the tab is attached, patch 0034). So the origins that ask for the hint
 * are also remembered, from any request to them, and a tab on one of them that has no note is
 * taken to be made for the old scheme.
 *
 * Listeners are added at import, in the background's first turn, so a page load that wakes the
 * background isn't missed. The notes live in chrome.storage.session, which outlasts the worker;
 * the origins in chrome.storage.local, which outlasts the browser.
 */
import { CROSS_DOCUMENT_CSS, SCROLL_KEY } from './themeFadeCss';

type Scheme = 'light' | 'dark';
const KEY = 'serverThemedTabs';
const ORIGINS_KEY = 'serverThemedOrigins';
/** The last theme switches and what each did to the tabs on screen (origins only), for diagnosing. */
const LOG_KEY = 'themeSwitchLog';
const HINT = 'sec-ch-prefers-color-scheme';
const MAX_ORIGINS = 200;
/** The session rule that sends the Appearance setting as the hint (no other session rules exist). */
const HINT_RULE = 990001;

async function load(): Promise<Record<string, Scheme>> {
  return ((await chrome.storage.session.get(KEY))[KEY] as Record<string, Scheme> | undefined) ?? {};
}
let queue = Promise.resolve();
/** Read-modify-write of the notes, one at a time. */
function update(fn: (notes: Record<string, Scheme>) => void) {
  queue = queue.then(async () => {
    const notes = await load();
    fn(notes);
    await chrome.storage.session.set({ [KEY]: notes });
  }).catch((err) => console.error('Uranus Browser shell: server-themed tabs', err));
  return queue;
}

/** The scheme a page was asked for, or undefined when the site didn't ask for the hint. */
export function hintedScheme(headers: chrome.webRequest.HttpHeader[] | undefined): Scheme | undefined {
  const value = headers?.find((h) => h.name.toLowerCase() === HINT)?.value?.trim().toLowerCase();
  return value === 'dark' || value === 'light' ? value : undefined;
}

const originOf = (url: string | undefined) => {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return '';
  }
};

/** The origins seen asking for the hint, newest last; loaded once per worker. */
let origins: Promise<string[]> | undefined;
const knownOrigins = () =>
  (origins ??= chrome.storage.local
    .get(ORIGINS_KEY)
    .then((v) => (v[ORIGINS_KEY] as string[] | undefined) ?? [])
    .catch(() => []));
function rememberOrigin(url: string) {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  void knownOrigins().then((list) => {
    if (list.includes(origin)) return;
    list.push(origin);
    list.splice(0, Math.max(0, list.length - MAX_ORIGINS));
    refreshHintRule();
    return chrome.storage.local.set({ [ORIGINS_KEY]: list });
  }).catch(() => undefined);
}

/** The Appearance setting when it isn't System. */
let wanted: Scheme | undefined;
let ruleQueue = Promise.resolve();
function refreshHintRule() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return ruleQueue;
  ruleQueue = ruleQueue
    .then(async () => {
      const hosts = [...new Set((await knownOrigins()).map((o) => originOf(o) && new URL(o).hostname).filter(Boolean))] as string[];
      const rule: chrome.declarativeNetRequest.Rule | undefined =
        wanted && hosts.length
          ? {
              id: HINT_RULE,
              priority: 1,
              condition: { requestDomains: hosts, resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[] },
              action: {
                type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
                requestHeaders: [{ header: HINT, operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: wanted }],
              },
            }
          : undefined;
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [HINT_RULE], addRules: rule ? [rule] : [] });
    })
    .catch((err) => console.error('Uranus Browser shell: colour scheme hint rule', err));
  return ruleQueue;
}

/** The Appearance setting changed (or the background started): pages are asked for in that scheme. */
export function useScheme(theme: 'system' | Scheme) {
  wanted = theme === 'system' ? undefined : theme;
  return refreshHintRule();
}

if (chrome.webRequest?.onSendHeaders) {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const scheme = hintedScheme(details.requestHeaders);
      if (scheme) rememberOrigin(details.url);
      if (details.tabId < 0 || details.type !== 'main_frame') return;
      void update((notes) => {
        if (scheme) notes[details.tabId] = scheme;
        else delete notes[details.tabId];
      });
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'image'] },
    ['requestHeaders', 'extraHeaders'],
  );
  chrome.tabs.onRemoved.addListener((tabId) => void update((notes) => delete notes[tabId]));
}

/** The tabs whose page a server themed (they reload on a switch instead of recolouring). */
export async function serverThemedTabIds() {
  return new Set(Object.keys(await load()).map(Number));
}

const SCRIPT_PREFIX = 'anus-view-transition-';
/** How long the new page's one-shot script stays registered. */
const SCRIPT_MS = 6000;

// A worker that was stopped mid-switch can't take its scripts back; they would fade whatever the
// origin loads next.
if (chrome.scripting?.getRegisteredContentScripts) {
  void chrome.scripting
    .getRegisteredContentScripts()
    .then((scripts) => {
      const ids = scripts.map((s) => s.id).filter((id) => id.startsWith(SCRIPT_PREFIX));
      return ids.length ? chrome.scripting.unregisterContentScripts({ ids }) : undefined;
    })
    .catch(() => undefined);
}

/**
 * Runs in the tab: opts the page in to a cross-document transition, then leaves for its own
 * address. Answers 'kept' when the page stayed: one that runs its own navigations (the Navigation
 * API's intercept) or cancels them keeps its document, and the tab then plainly reloads.
 */
async function leaveForFade(css: string, scrollKey: string): Promise<'left' | 'kept'> {
  if (document.visibilityState !== 'visible') return location.reload(), 'left';
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  // Going to the same address with a #fragment would only scroll, so the fragment is left off
  // and put back by the new page.
  const address = new URL(location.href);
  const hash = address.hash;
  address.hash = '';
  try {
    sessionStorage.setItem(scrollKey, JSON.stringify([scrollX, scrollY, hash]));
  } catch {
    // The page opens at the top.
  }
  // The browser reads the rule when the page is left; give it a frame to take it up.
  await Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    new Promise((resolve) => setTimeout(resolve, 400)),
  ]);
  const navigation = (globalThis as { navigation?: EventTarget & { transition: unknown } }).navigation;
  let cancelled = false;
  // Added after the page's own listeners, so it sees whether one of them cancelled.
  const watch = (event: Event) => (cancelled = event.defaultPrevented);
  navigation?.addEventListener('navigate', watch);
  location.replace(address.href);
  navigation?.removeEventListener('navigate', watch);
  if (!cancelled && !navigation?.transition) return 'left';
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  return 'kept';
}

type How = 'fade' | 'reload' | 'kept, reloaded';

/** Loads the tab's page again for the new scheme, with a fade when the tab is on screen. */
async function reloadFor(tab: chrome.tabs.Tab): Promise<How> {
  const id = tab.id!;
  const origin = tab.active && /^https?:/.test(tab.url ?? '') ? new URL(tab.url!).origin : undefined;
  if (!origin) return chrome.tabs.reload(id).then(() => 'reload' as const, () => 'reload' as const);
  const script = `${SCRIPT_PREFIX}${id}`;
  await chrome.scripting.unregisterContentScripts({ ids: [script] }).catch(() => undefined);
  const registered = await chrome.scripting
    .registerContentScripts([{ id: script, matches: [`${origin}/*`], js: ['viewTransitionIn.js'], runAt: 'document_start', persistAcrossSessions: false }])
    .then(() => true, () => false);
  const left =
    registered &&
    (await chrome.scripting.executeScript({ target: { tabId: id }, func: leaveForFade, args: [CROSS_DOCUMENT_CSS, SCROLL_KEY] }).then(
      ([injection]) => injection?.result !== 'kept',
      // The page may go before the script can answer.
      async () => (await chrome.tabs.get(id).catch(() => undefined))?.status === 'loading',
    ));
  if (registered) setTimeout(() => void chrome.scripting.unregisterContentScripts({ ids: [script] }).catch(() => undefined), SCRIPT_MS);
  if (left) return 'fade';
  await chrome.tabs.reload(id).catch(() => undefined);
  return registered ? 'kept, reloaded' : 'reload';
}

let logQueue = Promise.resolve();
/** Keeps the last few switches in LOG_KEY, one write at a time. */
function logSwitch(entry: { scheme: Scheme; tabs: Array<{ origin: string; how: string }> }) {
  logQueue = logQueue
    .then(() => chrome.storage.local.get(LOG_KEY))
    .then((v) => chrome.storage.local.set({ [LOG_KEY]: [...((v[LOG_KEY] as unknown[] | undefined) ?? []), { at: new Date().toISOString(), ...entry }].slice(-10) }))
    .catch(() => undefined);
}
/** The last switch asked for: every window reports it again, and those repeats aren't logged. */
let lastCall = { scheme: '', at: 0 };


/**
 * The colour scheme is now `scheme`: reloads the tabs whose page was made for the other one.
 * Safe to call more than once (each window's frame page reports the change): a reloaded tab's
 * note moves to the new scheme straight away.
 */
export async function schemeChanged(scheme: Scheme) {
  const repeat = lastCall.scheme === scheme && Date.now() - lastCall.at < 3000;
  lastCall = { scheme, at: Date.now() };
  const [tabs, known] = await Promise.all([chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]), knownOrigins()]);
  const stale: number[] = [];
  const unnoted: number[] = [];
  await update((notes) => {
    for (const [id, made] of Object.entries(notes)) {
      if (made === scheme) continue;
      notes[id] = scheme;
      stale.push(Number(id));
    }
    // Made before the switch, so for the old scheme.
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id in notes || !known.includes(originOf(tab.url))) continue;
      notes[tab.id] = scheme;
      stale.push(tab.id);
      unnoted.push(tab.id);
    }
  });
  const done = await Promise.all(
    stale.map(async (id) => {
      const tab = await chrome.tabs.get(id).catch(() => undefined);
      // A sleeping tab loads with the new scheme when it is next shown.
      if (!tab || tab.discarded || tab.frozen) return undefined;
      const how = await reloadFor(tab);
      return tab.active ? { origin: originOf(tab.url), how: unnoted.includes(id) ? `${how} (by origin)` : how } : undefined;
    }),
  );
  const shown = tabs.filter((t) => t.active && /^https?:/.test(t.url ?? '') && !stale.includes(t.id!));
  if (repeat && !stale.length) return;
  logSwitch({
    scheme,
    tabs: [...done.filter((d) => d !== undefined), ...shown.map((t) => ({ origin: originOf(t.url), how: 'left alone' }))],
  });
}
