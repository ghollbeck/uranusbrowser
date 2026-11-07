/**
 * Opens a pane of macOS System Settings > Privacy & Security from a fixed list. The shell asks
 * by name; nothing else is ever passed to `open`, so a page or a bug can't make it open an
 * arbitrary address.
 */
import { execFile } from 'node:child_process';

export const PRIVACY_PANES = {
  /** "Allow Uranus Browser to modify other apps" (macOS App Management). There is no prompt API for it. */
  appManagement: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
} as const;
export type PrivacyPane = keyof typeof PRIVACY_PANES;

export const isPrivacyPane = (pane: unknown): pane is PrivacyPane => typeof pane === 'string' && Object.hasOwn(PRIVACY_PANES, pane);

/** Opens the pane; false when the name isn't on the list or `open` fails. */
export function openPrivacyPane(pane: unknown, run: typeof execFile = execFile): Promise<boolean> {
  if (process.platform !== 'darwin' || !isPrivacyPane(pane)) return Promise.resolve(false);
  return new Promise((resolve) => run('/usr/bin/open', [PRIVACY_PANES[pane]], { timeout: 10_000 }, (err) => resolve(!err)));
}
