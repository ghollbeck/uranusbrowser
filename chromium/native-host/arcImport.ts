import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArcImport, ImportNode, ImportTab } from '../shared/importApply';

export type { ArcImport, ImportNode, ImportTab } from '../shared/importApply';

/** Arc encodes dictionaries as alternating keys and values. Only read its live sidebar. */
export function arcSidebarPath() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json');
}
export function readArcSidebar(file = arcSidebarPath()): ArcImport {
  return parseArcSidebar(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const webURL = (url: unknown): url is string => {
  try { return typeof url === 'string' && ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
};

/** Maps favorites to the global shelf, folders/pins to pinned, and unpinned tabs to Today.
 * Split groups become named folders because our saved sidebar nodes hold one tab each.
 * Path-local cycle detection preserves intentionally repeated URLs in different Spaces.
 */
export function parseArcSidebar(json: any): ArcImport {
  const containers = json?.sidebar?.containers;
  if (!Array.isArray(containers)) throw new Error('This does not look like an Arc sidebar.');
  const mains = containers.filter((c) => Array.isArray(c?.spaces) && Array.isArray(c?.items));
  if (!mains.length) throw new Error('No Arc spaces were found in this sidebar.');
  const result: ArcImport = { spaces: [], favorites: [] };
  const seenSpaces = new Set<string>();
  const seenFavorites = new Set<string>();
  let remaining = 20000;
  let skipped = 0;
  for (const main of mains) {
    const items = new Map<string, any>();
    for (const item of main.items) if (object(item) && typeof item.id === 'string') items.set(item.id, item);
    const nodes = (ids: unknown, ancestors = new Set<string>(), depth = 0): ImportNode[] => {
      if (!Array.isArray(ids) || depth > 64) { if (depth > 64) skipped++; return []; }
      return ids.flatMap((id): ImportNode[] => {
        if (typeof id !== 'string' || ancestors.has(id)) { skipped++; return []; }
        const item = items.get(id);
        if (!item || remaining-- <= 0) { skipped++; return []; }
        const next = new Set(ancestors).add(id);
        const tab = item.data?.tab;
        if (tab) {
          if (!webURL(tab.savedURL)) { skipped++; return []; }
          return [{ kind: 'tab', sourceId: id, url: tab.savedURL, title: item.title || tab.savedTitle || tab.savedURL }];
        }
        const children = nodes(item.childrenIds, next, depth + 1);
        if (item.data?.list || item.data?.splitView) return [{ kind: 'folder', name: item.title || (item.data?.splitView ? 'Split tabs' : 'Untitled folder'), children }];
        if (!children.length && !item.data?.itemContainer) skipped++;
        return children;
      });
    };
    const flatten = (entries: ImportNode[]): ImportTab[] => entries.flatMap((n) => n.kind === 'tab' ? [n] : flatten(n.children));
    const children = (space: any, key: string) => {
      for (const entries of [space.newContainerIDs, space.containerIDs]) {
        if (!Array.isArray(entries)) continue;
        const at = entries.findIndex((v: any) => v === key || (object(v) && key in v));
        if (at >= 0 && typeof entries[at + 1] === 'string') return items.get(entries[at + 1])?.childrenIds;
      }
      return [];
    };
    for (const space of main.spaces) {
      if (!object(space) || typeof space.id !== 'string' || seenSpaces.has(space.id)) continue;
      seenSpaces.add(space.id);
      const color = space.customInfo?.windowTheme?.primaryColorPalette?.midTone;
      const rgb = color && [color.red, color.green, color.blue];
      result.spaces.push({
        sourceId: space.id,
        name: typeof space.title === 'string' && space.title ? space.title : 'Space',
        emoji: typeof space.customInfo?.iconType?.emoji_v2 === 'string' ? space.customInfo.iconType.emoji_v2 : undefined,
        color: rgb?.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
          ? '#' + rgb.map((v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') : undefined,
        isolated: !!space.profile?.custom,
        pinned: nodes(children(space, 'pinned')),
        today: flatten(nodes(children(space, 'unpinned'))),
      });
    }
    // Every Arc profile has its own favorites container. Merge them into our global shelf.
    for (const id of main.topAppsContainerIDs ?? []) {
      if (typeof id !== 'string' || !items.has(id)) continue;
      for (const tab of flatten(nodes(items.get(id)?.childrenIds))) {
        if (seenFavorites.has(tab.sourceId || tab.url)) continue;
        seenFavorites.add(tab.sourceId || tab.url);
        result.favorites.push(tab);
      }
    }
  }
  result.warnings = skipped ? [`${skipped} unsupported or invalid Arc entries were skipped (including Arc documents and easels).`] : [];
  if (remaining <= 0) result.warnings.push('Arc import stopped at 20,000 entries.');
  return result;
}
