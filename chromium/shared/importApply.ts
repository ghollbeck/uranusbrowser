import type { HistoryEntry, ImportResult } from './types';
import type { Store } from './store';

export type ImportTab = { url: string; title: string; sourceId?: string };
export type ImportNode = ({ kind: 'tab' } & ImportTab) | { kind: 'folder'; name: string; children: ImportNode[] };

/** Arc's sidebar, as arcImport.ts reads it. */
export interface ArcImport {
  spaces: Array<{ sourceId?: string; name: string; emoji?: string; color?: string; isolated?: boolean; pinned: ImportNode[]; today: ImportTab[] }>;
  warnings?: string[];
  favorites: ImportTab[];
}

/**
 * What `readBrowser` (browserImport.ts) found in another browser, before any of it is added
 * to UrAnus Browser. Plain data, so it can cross from the Chromium build's native host to the shell.
 */
export interface BrowserImportData {
  /** The browser's name, which the new Space of bookmarks takes. */
  name: string;
  /** Arc's sidebar: its Spaces, pinned tabs and favourites, in place of bookmarks. */
  arc?: ArcImport;
  /** Bookmarks for one new Space, already tidied (web pages only, each once). */
  bookmarks?: ImportNode[];
  bookmarkCount: number;
  history: HistoryEntry[];
  warnings: string[];
}

/**
 * Adds what was read to UrAnus Browser: Arc's Spaces, or a Space of bookmarks, and the history.
 * Kept free of Node so the shell extension can run it too.
 */
export async function applyBrowserImport(
  data: BrowserImportData,
  store: Pick<Store, 'importArc' | 'importBookmarks'>,
  history: { merge(entries: HistoryEntry[]): number | Promise<number> },
): Promise<ImportResult> {
  const result: ImportResult = { spaces: 0, bookmarks: 0, history: 0, warnings: [...data.warnings] };
  if (data.arc) {
    const added = store.importArc(data.arc);
    result.spaces = added.spaces;
    result.bookmarks = added.tabs;
    result.warnings.push(...(data.arc.warnings ?? []));
  }
  if (data.bookmarks?.length) {
    store.importBookmarks(data.name, data.bookmarks);
    result.spaces = 1;
    result.bookmarks = data.bookmarkCount;
  }
  if (data.history.length) result.history = await history.merge(data.history);
  return result;
}
