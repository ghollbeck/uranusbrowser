/**
 * chrome.debugger, shared by the features that need the DevTools protocol on a tab (the
 * responsive phone, boost scripts on pages whose CSP forbids eval). Each feature holds the
 * tab by name and the attachment goes once nobody holds it, so tabs that don't need the
 * protocol never have it attached.
 */
const PROTOCOL = '1.3';

const holders = new Map<number, Set<string>>();
const attaching = new Map<number, Promise<boolean>>();
const detachListeners: Array<(tabId: number, reason: string) => void> = [];

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  holders.delete(source.tabId);
  for (const fn of detachListeners) fn(source.tabId, reason);
});

/** Called when Chromium ends an attachment: the tab closed, or the user cancelled it. */
export function onDebuggerDetach(fn: (tabId: number, reason: string) => void) {
  detachListeners.push(fn);
}

/** Attaches for `holder`, if no one had. Resolves false when Chromium refuses (a chrome:// page, say). */
export async function hold(tabId: number, holder: string): Promise<boolean> {
  const set = holders.get(tabId);
  if (set) {
    set.add(holder);
    return (await attaching.get(tabId)) ?? true;
  }
  holders.set(tabId, new Set([holder]));
  const attach = chrome.debugger
    .attach({ tabId }, PROTOCOL)
    .then(() => true)
    .catch((err: Error) => {
      // Attached already (by a previous background that went to sleep): keep using it.
      if (/already attached/i.test(String(err?.message ?? err))) return true;
      holders.delete(tabId);
      return false;
    });
  attaching.set(tabId, attach);
  const ok = await attach;
  attaching.delete(tabId);
  return ok;
}

/** Lets go for `holder`; detaches once no feature holds the tab. */
export async function release(tabId: number, holder: string) {
  const set = holders.get(tabId);
  if (!set?.delete(holder) || set.size) return;
  holders.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

export const isHeld = (tabId: number, holder: string) => !!holders.get(tabId)?.has(holder);

export function send<T = unknown>(tabId: number, method: string, params: object = {}): Promise<T | undefined> {
  return chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>).then(
    (r) => r as T,
    () => undefined,
  );
}
