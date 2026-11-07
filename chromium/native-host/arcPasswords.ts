import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { querySqlite } from './browserImport';
import type { ArcPasswords } from '../shared/arcPasswords';

/** Passwords are decrypted in memory after macOS authorizes Arc Safe Storage access.
 * No CSV export, plaintext temp file, logging, or destination database writes.
 */
export function decryptArcPassword(value: Buffer, key: Buffer): string {
  if (value.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported Arc password encryption.');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]);
  try { return plain.toString('utf8'); } finally { plain.fill(0); }
}

export async function readArcPasswords(): Promise<ArcPasswords> {
  const result: ArcPasswords = { credentials: [], skipped: 0, warnings: [] };
  const root = path.join(os.homedir(), 'Library/Application Support/Arc/User Data');
  const profiles = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name));
  const rows: Array<{ url: string; username: string; encrypted: string }> = [];
  for (const profile of profiles) {
    for (const name of ['Login Data', 'Login Data For Account']) {
      const file = path.join(root, profile.name, name);
      if (!fs.existsSync(file)) continue;
      try {
        rows.push(...await querySqlite<{ url: string; username: string; encrypted: string }>(file,
          'SELECT origin_url AS url, username_value AS username, hex(password_value) AS encrypted FROM logins WHERE blacklisted_by_user = 0 AND length(password_value) > 0'));
      } catch { result.warnings.push(`Couldn’t read saved passwords in Arc’s ${profile.name}. Close Arc and try the password import again.`); }
    }
  }
  if (!rows.length) return result;
  let key: Buffer;
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Arc Safe Storage'], { timeout: 120000 });
    // security appends one newline; do not trim meaningful keychain whitespace.
    key = crypto.pbkdf2Sync(stdout.replace(/\r?\n$/, ''), 'saltysalt', 1003, 16, 'sha1');
  } catch {
    result.warnings.push('Passwords were not imported. Allow access to “Arc Safe Storage” when macOS asks, then use Import passwords again.');
    result.skipped += rows.length;
    return result;
  }
  try {
    for (const row of rows) {
      try {
        if (!['http:', 'https:'].includes(new URL(row.url).protocol)) { result.skipped++; continue; }
        const password = decryptArcPassword(Buffer.from(row.encrypted, 'hex'), key);
        if (!password) { result.skipped++; continue; }
        result.credentials.push({ url: row.url, username: row.username || '', password });
      } catch { result.skipped++; }
    }
  } finally { key.fill(0); }
  if (result.skipped) result.warnings.push(`${result.skipped} Arc logins used an unsupported format or could not be decrypted.`);
  return result;
}
