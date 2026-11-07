/**
 * The built-in ad and tracker blocker, on declarativeNetRequest: EasyList and EasyPrivacy,
 * converted to static rulesets at build time (build-adblock.mjs), switched on and off with
 * Settings' "Block ads and trackers" (state.adBlock, on unless turned off), as in Electron.
 *
 * Generic element hiding from EasyList (`##.ad-banner`) is a stylesheet registered as a content
 * script while blocking is on, left out on the sites the lists exempt from it.
 */
export const RULESETS = ['easylist', 'easyprivacy'];
const COSMETIC_ID = 'anus-adblock-cosmetic';
const COSMETIC_CSS = 'rules/cosmetic.css';
const COSMETIC_EXCLUDES = 'rules/cosmetic-exclude.json';

let applied: boolean | undefined;
let applying = Promise.resolve();

export function setAdBlocking(enabled: boolean) {
  applying = applying.then(async () => {
    if (applied === enabled) return;
    applied = enabled;
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets(enabled ? { enableRulesetIds: RULESETS } : { disableRulesetIds: RULESETS });
      await setCosmetic(enabled);
    } catch (err) {
      applied = undefined;
      console.error('UrAnus Browser: the ad blocker failed', err);
    }
  });
  return applying;
}

async function setCosmetic(enabled: boolean) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [COSMETIC_ID] });
  if (!enabled) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [COSMETIC_ID] });
    return;
  }
  if (existing.length) return;
  const excludes = await fetch(chrome.runtime.getURL(COSMETIC_EXCLUDES))
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .catch(() => [] as string[]);
  await chrome.scripting.registerContentScripts([
    {
      id: COSMETIC_ID,
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: excludes,
      css: [COSMETIC_CSS],
      runAt: 'document_start',
      allFrames: true,
      persistAcrossSessions: true,
    },
  ]);
}
