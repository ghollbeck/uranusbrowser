/**
 * How boosts are named and which pages they apply to, without Node, so the Chromium
 * shell's stored boosts follow the same rules as the Electron version's boosts folder.
 *
 * A boost is named after its host: `github.com.ts` (script), `github.com.css` (styles), or
 * `all.css` for every site. It applies to that host and its subdomains.
 */
export type BoostKind = 'script' | 'styles';

export const BOOST_EXTENSIONS: Record<BoostKind, string> = { script: '.ts', styles: '.css' };

/** `github.com.ts` → { host: 'github.com', kind: 'script' }. */
export function parseBoostName(filename: string): { host: string; kind: BoostKind } | undefined {
  const match = filename.match(/^(.+)\.(ts|css)$/);
  if (!match || match[1].startsWith('.')) return undefined;
  return { host: match[1], kind: match[2] === 'ts' ? 'script' : 'styles' };
}

export const boostName = (host: string, kind: BoostKind) => host + BOOST_EXTENSIONS[kind];

/** Whether a boost for `host` applies to the page at `url`. */
export function boostMatches(url: string, host: string) {
  if (host === 'all') return /^https?:/.test(url);
  try {
    const hostname = new URL(url).hostname;
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/** The host a new boost for this page is named after (without `www.`), if it has one. */
export function boostHostFor(url: string | undefined) {
  if (!url || !/^https?:/.test(url)) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}
