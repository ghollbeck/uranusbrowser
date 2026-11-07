/**
 * Where the native host finds the model provider's API key. The key lives only in this
 * process: it is never sent to the shell, a page or a log, and errors are scrubbed of it.
 *
 * Looked up in order:
 *  1. the macOS Keychain, a generic password with service KEYCHAIN_SERVICE and account
 *     KEYCHAIN_ACCOUNT (Settings › AI stores it there through saveOpenaiKey, as does
 *     chromium/scripts/set-openai-key.sh); a key still under LEGACY_KEYCHAIN_SERVICE is
 *     copied to the new service on first use, and left where it is;
 *  2. OPENAI_API_KEY in the host's environment, for development (Chromium starts the host
 *     with the app's environment, so this needs Uranus Browser launched from that shell).
 */
import { execFile } from 'node:child_process';
import { OPENAI_KEY_PATTERN } from '../shared/aiProtocol';

export const KEYCHAIN_SERVICE = 'dev.oprimo.anus.agent.openai';
export const KEYCHAIN_ACCOUNT = 'api-key';
/** The service the key was stored under before the app became Uranus Browser; read once and moved. */
export const LEGACY_KEYCHAIN_SERVICE = 'dev.oprimo.flecha.agent.openai';

export type KeySource = 'keychain' | 'environment';

export interface SecretStore {
  /** The key and where it came from, or undefined when there's none. */
  openaiKey(): Promise<{ key: string; source: KeySource } | undefined>;
  /** Stores a key in the Keychain (Settings › AI). The key never comes back out to the shell. */
  saveOpenaiKey?(key: string): Promise<void>;
  removeOpenaiKey?(): Promise<void>;
}

function keychain(service: string, account: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

/**
 * Runs one `security` command read from stdin (`security -i`), so the key never appears in a
 * process listing the way an argument would.
 */
function securityStdin(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', ['-i'], { timeout: 10_000 }, (err, _stdout, stderr) => {
      // `security -i` exits 0 even when a command fails; its complaint is on stderr.
      if (err || /error|could not|failed/i.test(stderr)) reject(new Error('The macOS Keychain refused the change.'));
      else resolve();
    });
    child.stdin?.end(`${command}\n`);
  });
}

export const systemSecrets: SecretStore = {
  async saveOpenaiKey(key: string) {
    if (process.platform !== 'darwin') throw new Error('Saving a key needs the macOS Keychain.');
    const clean = key.trim();
    // Checked twice (the shell checks too): the key goes inside quotes on a command line.
    if (!OPENAI_KEY_PATTERN.test(clean)) throw new Error('That doesn’t look like an OpenAI API key (sk-…).');
    await securityStdin(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l "Uranus Browser OpenAI API key" -w "${clean}"`);
  },
  async removeOpenaiKey() {
    if (process.platform !== 'darwin') return;
    for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
      await new Promise<void>((resolve) =>
        execFile('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT], { timeout: 10_000 }, () => resolve()),
      );
    }
  },
  async openaiKey() {
    const stored = await keychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (stored) return { key: stored, source: 'keychain' };
    const legacy = await keychain(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (legacy) {
      // Best effort: the key is usable either way, and the old item stays until the user removes the key.
      await this.saveOpenaiKey?.(legacy).catch(() => undefined);
      return { key: legacy, source: 'keychain' };
    }
    const env = process.env.OPENAI_API_KEY?.trim();
    if (env) return { key: env, source: 'environment' };
    return undefined;
  },
};

/** Takes `secret`, and anything shaped like an API key, out of text bound for the UI or a log. */
export function scrub(text: string, secret?: string) {
  let out = text;
  if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  return out.replace(/\b(sk|rk|pk)-[A-Za-z0-9_*-]{8,}/g, '[redacted]');
}
