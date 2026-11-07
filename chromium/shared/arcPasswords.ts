/** Private host → background-worker payload. Never send credentials to UI state or storage. */
export interface ArcCredential { url: string; username: string; password: string }
export interface ArcPasswords { credentials: ArcCredential[]; skipped: number; warnings: string[] }
export interface PasswordSink {
  getSavedPasswordList(): Promise<Array<{ username: string; affiliatedDomains: Array<{ url: string; signonRealm: string }> }>>;
  addPassword(options: ArcCredential & { note: string; useAccountStore: boolean }): Promise<void>;
}

/** Existing origin/username pairs win, even when Arc has a different password. */
export async function saveArcPasswords(data: ArcPasswords, sink: PasswordSink) {
  const origin = (url: string) => { try { return new URL(url).origin; } catch { return ''; } };
  const key = (url: string, user: string) => JSON.stringify([origin(url), user]);
  let passwords = 0;
  let passwordsSkipped = data.skipped;
  let failed = 0;
  try {
    const existing = await sink.getSavedPasswordList();
    const seen = new Set(existing.flatMap((entry) => entry.affiliatedDomains.map((d) => key(d.url || d.signonRealm, entry.username))));
    for (const entry of data.credentials) {
      const id = key(entry.url, entry.username);
      if (!/^https?:\/\//i.test(entry.url) || !entry.password || seen.has(id)) { passwordsSkipped++; continue; }
      try {
        await sink.addPassword({ url: entry.url, username: entry.username, password: entry.password, note: '', useAccountStore: false });
        seen.add(id);
        passwords++;
      } catch { failed++; }
    }
  } finally {
    for (const entry of data.credentials) entry.password = '';
    data.credentials.length = 0;
  }
  const warnings = [...data.warnings];
  if (failed) warnings.push(`${failed} passwords could not be saved. Existing saved passwords were kept.`);
  return { passwords, passwordsSkipped, warnings };
}
