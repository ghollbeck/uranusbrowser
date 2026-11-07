/**
 * The URL bar's site panel in the Chromium shell, as the Electron spike's capturePage,
 * clearSiteData and site permissions: Chromium's browsingData and contentSettings, and a
 * screenshot of the page for the clipboard.
 */
import type { Store } from '../shared/store';
import { broadcast, handle } from './hub';

export interface SiteControlsContext {
  store: Store;
  /** The Chromium tab on screen, if the active UrAnus Browser tab has one. */
  activeChromeId(): number | undefined;
  /** The window UrAnus Browser's tabs live in. */
  mainWindow(): Promise<number>;
}

type Decision = 'allow' | 'block' | 'ask';

/** The sidebar's permission names (Electron's) and the content settings that decide them. */
const SETTINGS: Record<string, Array<'location' | 'camera' | 'microphone' | 'notifications' | 'clipboard'>> = {
  geolocation: ['location'],
  media: ['camera', 'microphone'],
  notifications: ['notifications'],
  'clipboard-read': ['clipboard'],
};

/** A content settings pattern for exactly one origin. */
function patternFor(origin: string) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}/*`;
}

/** Signs out of one site: cookies, storage and cache. */
async function clearSite(origin: string) {
  const data: chrome.browsingData.DataTypeSet = {
    cookies: true,
    localStorage: true,
    indexedDB: true,
    cacheStorage: true,
    serviceWorkers: true,
    fileSystems: true,
    webSQL: true,
  };
  await chrome.browsingData
    .remove({ origins: [origin] }, { ...data, cache: true })
    // Older builds don't filter the HTTP cache by origin.
    .catch(() => chrome.browsingData.remove({ origins: [origin] }, data));
}

export function registerSiteControls(ctx: SiteControlsContext) {
  const { store } = ctx;

  /** Copies the visible page as an image, through the window's frame page (the clipboard needs a document). */
  async function capturePage() {
    if (ctx.activeChromeId() === undefined) return;
    const windowId = await ctx.mainWindow();
    const png = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    broadcast('clipboard', windowId, { png, message: 'Screenshot copied' });
  }

  handle({
    capturePage: () => capturePage().catch((err) => console.error('UrAnus Browser shell: screenshot failed', err)),
    clearSiteData: async (origin: string) => {
      if (!/^https?:\/\//.test(String(origin))) return;
      await clearSite(String(origin));
      const chromeId = ctx.activeChromeId();
      if (chromeId !== undefined) await chrome.tabs.reload(chromeId);
      broadcast('flash', 'Site data cleared');
    },
    setSitePermission: async (origin: string, permission: string, decision: Decision) => {
      const settings = SETTINGS[String(permission)];
      if (!settings || !/^https?:\/\//.test(String(origin))) return;
      const chosen = decision === 'allow' || decision === 'block' ? decision : undefined;
      store.setSitePermission(String(origin), String(permission), chosen);
      const primaryPattern = patternFor(String(origin));
      for (const name of settings) {
        // "Ask" is Chromium's default; setting it back forgets the decision.
        await chrome.contentSettings[name]
          .set({ primaryPattern, setting: chosen ?? 'ask' })
          .catch((err: unknown) => console.warn(`UrAnus Browser shell: ${name} for ${origin}`, err));
      }
    },
  });
}
