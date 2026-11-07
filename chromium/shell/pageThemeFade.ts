/**
 * Web pages fade between light and dark too, on the same one-second curve as Uranus Browser's own
 * pages (lib/themeFade.ts). A page recolours itself when its prefers-color-scheme flips; to
 * fade that, each visible tab starts a View Transition just before the switch: the browser
 * keeps a picture of the page as it was, the scheme flips underneath, and the old picture
 * crossfades into the new page. native.ts waits until every tab has its picture (or a short
 * timeout) before it switches the theme.
 *
 * Only the tabs on screen (each window's active tab) and only when the scheme really changes.
 * Pages Uranus Browser can't script (chrome://, other extensions, the Web Store) just switch at once.
 * Tabs a server themed reload instead, and fade that way (serverThemedTabs.ts).
 */

import { serverThemedTabIds } from './serverThemedTabs';
import { THEME_FADE_CSS } from './themeFadeCss';

/** How long a page may stay on its old picture waiting for the scheme to flip. */
const HOLD_MS = 1000;
/** How long the switch waits for the tabs to be ready. */
const READY_MS = 250;

/** Runs in the tab: resolves once the old picture is taken (true), or false when there is nothing to fade. */
function startFade(toDark: boolean, holdMs: number, css: string): Promise<boolean> {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const doc = document as Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } };
  if (mq.matches === toDark || !doc.startViewTransition || document.visibilityState !== 'visible') return Promise.resolve(false);
  const style = document.createElement('style');
  style.textContent = css;
  document.documentElement.append(style);
  return new Promise((ready) => {
    try {
      const transition = doc.startViewTransition!(
        () =>
          new Promise<void>((done) => {
            ready(true);
            // The new picture is taken once the page has the new scheme; matches changes as
            // soon as it does, ahead of the change event.
            const start = performance.now();
            const poll = () => (mq.matches === toDark || performance.now() - start > holdMs ? done() : setTimeout(poll, 16));
            poll();
          }),
      );
      void transition.finished.finally(() => style.remove());
    } catch {
      style.remove();
      ready(false);
    }
  });
}

/** Gets every visible tab ready to fade to `scheme`; resolves when they are, or after READY_MS. */
export async function prepareTabFades(scheme: 'light' | 'dark') {
  const [tabs, serverThemed] = await Promise.all([
    chrome.tabs.query({ active: true }).catch(() => [] as chrome.tabs.Tab[]),
    serverThemedTabIds().catch(() => new Set<number>()),
  ]);
  const ready = tabs
    .filter((tab) => tab.id !== undefined && !tab.discarded && !serverThemed.has(tab.id) && /^(https?|file):/.test(tab.url ?? tab.pendingUrl ?? ''))
    .map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id! }, func: startFade, args: [scheme === 'dark', HOLD_MS, THEME_FADE_CSS] })
        .catch(() => undefined),
    );
  await Promise.race([Promise.all(ready), new Promise((resolve) => setTimeout(resolve, READY_MS))]);
}
