import type { DetectedBrowser, ImportResult } from '../../shared/types';

/** What a detected browser has to bring over, as the tour and Settings › Import list it. */
export function browserDetail(b: DetectedBrowser) {
  if (b.id === 'arc') return 'Spaces, folders, favorites, tabs, history & passwords';
  const what = [b.hasBookmarks && 'Bookmarks', b.hasHistory && 'history'].filter(Boolean).join(' & ') || 'Data';
  return `${what}${b.profiles > 1 ? ` · ${b.profiles} profiles` : ''}`;
}

/** One line on what an import brought over, or the first thing that went wrong. */
export function importSummary(r: ImportResult) {
  const parts = [r.spaces && `${r.spaces.toLocaleString()} spaces`, r.passwords && `${r.passwords.toLocaleString()} passwords`, r.bookmarks && `${r.bookmarks.toLocaleString()} saved tabs`, r.history && `${r.history.toLocaleString()} pages`].filter(Boolean);
  if (r.passwordsSkipped) parts.push(`${r.passwordsSkipped.toLocaleString()} logins kept or skipped`);
  const summary = parts.length ? parts.join(' · ') : 'Nothing new to import';
  return r.warnings.length ? `${summary}. ${r.warnings.join(' ')}` : summary;
}

/** The same mapping and consent wording in setup and Settings. */
export const ARC_MAPPING = 'Arc Spaces → Spaces; favorites → the top shelf; pinned tabs and nested folders → Pinned; open tabs → Today. Split groups become folders. Existing imported Spaces and favorites are kept when you import again.';
export const ARC_LIMITS = 'History is imported. Cached page files, cookies, active sign-ins and passkeys stay in Arc; pages reload when opened. Arc profiles with separate logins become isolated Spaces, where you sign in again.';
export const ARC_PASSWORDS = 'Include Arc passwords (macOS may ask for Arc Safe Storage access). Saved locally in the password manager; existing logins are kept.';
