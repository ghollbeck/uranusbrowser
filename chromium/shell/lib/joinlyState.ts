/**
 * The Meetings settings per profile (chrome.storage.local): whether the user has opted in,
 * where their joinly server is, and the name the bot uses. Plain functions on plain data so
 * what is saved, and what is refused, is testable without a browser. The checks themselves
 * (shared/joinly.ts) are shared with the native host, which never takes the shell's word.
 */
import { DEFAULT_SETTINGS, emptyView, restoreSettings, type JoinlyConfig, type JoinlySettings, type JoinlyView } from '../../shared/joinly';

export const JOINLY_KEY = 'joinly';

export interface JoinlyStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadSettings(storage: JoinlyStorage): Promise<JoinlySettings> {
  return restoreSettings((await storage.get(JOINLY_KEY))[JOINLY_KEY]);
}

export const saveSettings = (storage: JoinlyStorage, settings: JoinlySettings) => storage.set({ [JOINLY_KEY]: settings });

export const configOf = (settings: JoinlySettings): JoinlyConfig => ({ enabled: settings.enabled, endpoint: settings.endpoint, ...(settings.language ? { language: settings.language } : {}) });

/** What the panel shows before the host has said anything. */
export const initialView = (settings: JoinlySettings): JoinlyView => emptyView(configOf(settings));

/** The host can't be asked (or didn't answer): said plainly, with what to do. */
export function helperView(settings: JoinlySettings, detail: string, error?: string): JoinlyView {
  return { ...initialView(settings), reason: 'helper', detail, error, checkedAt: Date.now() };
}

export const HELPER_SILENT =
  'Uranus Browser’s helper didn’t answer. If you just updated Uranus Browser, quit and reopen it so the new helper starts; a helper from before meetings existed can’t talk to joinly.';
export const NOT_IN_PRIVATE = 'Meetings aren’t available in private windows.';

export { DEFAULT_SETTINGS };
