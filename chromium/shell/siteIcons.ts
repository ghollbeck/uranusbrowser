import { siteOrigin } from '../shared/siteOrigin';
import { chromiumIcon } from './favicons';
import { declaredIcons } from './lib/declaredIcons';
import { incognito } from './incognito';

const STORAGE_KEY = 'siteIcons';
const RETRY_MS = 15 * 60_000;
const MAX_BYTES = 300_000;
const MAX_SVG_BYTES = 48_000;
const MAX_CACHE_SIZE = 8 * 1024 * 1024;
const CONCURRENCY = 4;

type Job = { origin: string; page: string; liveIcon?: string };

/** Cache image data, so inactive and restored tabs need neither a live page nor a network request. */
export class SiteIcons {
  private icons = new Map<string, string>();
  private missed = new Map<string, number>();
  private queue = new Map<string, Job>();
  private active = new Set<string>();
  private liveSources = new Map<string, string>();
  private loaded: Promise<void>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private size = 0;

  constructor(private onFound: (icons: Record<string, string>) => void) {
    // Extension storage is shared across profiles; private windows use only their own memory.
    this.loaded = incognito ? Promise.resolve() : chrome.storage.local.get(STORAGE_KEY).then((saved) => {
      for (const [key, entry] of Object.entries((saved[STORAGE_KEY] ?? {}) as Record<string, { url?: string }>)) {
        // Older installs used bare hostnames and assumed HTTPS. Discard their negative entries.
        const origin = siteOrigin(key.includes('://') ? key : 'https://' + key);
        if (origin && entry.url?.startsWith('data:image/')) this.put(origin, entry.url);
      }
    }).catch(() => undefined);
  }

  async all(): Promise<Record<string, string>> {
    await this.loaded;
    return Object.fromEntries(this.icons);
  }

  async want(pages: Iterable<string>) {
    await this.loaded;
    const now = Date.now();
    for (const page of pages) {
      const origin = siteOrigin(page);
      if (!origin || this.icons.has(origin) || this.active.has(origin) || this.queue.has(origin)) continue;
      if (now - (this.missed.get(origin) ?? 0) < RETRY_MS) continue;
      this.queue.set(origin, { origin, page });
    }
    this.pump();
  }

  /** A loaded tab can supply an icon even if the origin lookup previously missed. */
  async remember(page: string, liveIcon: string) {
    await this.loaded;
    const origin = siteOrigin(page);
    if (!origin || this.liveSources.get(origin) === liveIcon) return;
    this.liveSources.set(origin, liveIcon);
    this.queue.set(origin, { origin, page, liveIcon });
    this.pump();
  }

  private pump() {
    for (const [origin, job] of this.queue) {
      if (this.active.size >= CONCURRENCY) break;
      if (this.active.has(origin)) continue;
      this.queue.delete(origin);
      this.active.add(origin);
      void resolveIcon(job, this.icons.has(origin)).catch(() => undefined).then((url) => {
        if (url) {
          this.missed.delete(origin);
          if (this.icons.get(origin) === url) return;
          this.put(origin, url);
          this.scheduleSave();
          this.onFound({ [origin]: url });
        } else {
          if (!this.icons.has(origin)) this.missed.set(origin, Date.now());
          if (job.liveIcon && this.liveSources.get(origin) === job.liveIcon) this.liveSources.delete(origin);
        }
      }).finally(() => {
        this.active.delete(origin);
        this.pump();
      });
    }
  }

  private put(origin: string, url: string) {
    this.size -= this.icons.get(origin)?.length ?? 0;
    this.icons.delete(origin);
    this.icons.set(origin, url);
    this.size += url.length;
    while (this.size > MAX_CACHE_SIZE) {
      const oldest = this.icons.keys().next().value!;
      this.size -= this.icons.get(oldest)!.length;
      this.icons.delete(oldest);
      this.liveSources.delete(oldest);
    }
  }

  private scheduleSave() {
    if (incognito || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const saved = Object.fromEntries([...this.icons].map(([key, url]) => [key, { url }]));
      void chrome.storage.local.set({ [STORAGE_KEY]: saved }).catch(() => undefined);
    }, 250);
  }
}

async function resolveIcon({ origin, page, liveIcon }: Job, hasIcon: boolean): Promise<string | undefined> {
  // A tab's declared icon may be newer than Chromium's database or live in an isolated Space.
  if (liveIcon) {
    const icon = await downloadIcon(liveIcon, true);
    if (icon) return icon;
  }
  if (!incognito) {
    const stored = await chromiumIcon(page);
    if (stored) return dataUrl(stored);
  }
  if (hasIcon) return;

  const candidates: string[] = [];
  try {
    const response = await fetch(origin + '/', { credentials: 'omit', signal: AbortSignal.timeout(3500) });
    const html = await readLimited(response, 200_000, true);
    if (html) candidates.push(...declaredIcons(new TextDecoder().decode(html), response.url).slice(0, 5));
  } catch {
    // The root page may be unavailable while /favicon.ico still works.
  }
  candidates.push(origin + '/favicon.ico');
  const signal = AbortSignal.timeout(5000);
  for (const url of new Set(candidates)) {
    const icon = await downloadIcon(url, false, signal);
    if (icon) return icon;
  }
}

async function downloadIcon(address: string, allowData: boolean, signal = AbortSignal.timeout(5000)) {
  try {
    const url = new URL(address);
    if (!siteOrigin(address) && !(allowData && /^data:image\//i.test(address) && address.length <= MAX_BYTES * 2)) return;
    if (url.username || url.password) return;
    const response = await fetch(url, { credentials: 'omit', signal });
    const bytes = await readLimited(response, MAX_BYTES);
    if (!bytes?.length) return;
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type === 'image/svg+xml') {
      if (bytes.length <= MAX_SVG_BYTES && /<svg[\s>]/i.test(new TextDecoder().decode(bytes))) {
        return dataUrl(new Blob([bytes], { type }));
      }
      return;
    }
    // Decode instead of trusting the MIME type (some /favicon.ico URLs return an HTML error).
    const bitmap = await createImageBitmap(new Blob([bytes], { type: type?.startsWith('image/') ? type : 'image/x-icon' }));
    try {
      const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return dataUrl(await canvas.convertToBlob());
    } finally {
      bitmap.close();
    }
  } catch {
    // Missing, invalid, or unavailable icons fall through to the next source.
  }
}

async function readLimited(response: Response, max: number, allowPrefix = false) {
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max || !allowPrefix) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.length > max && !allowPrefix) return;
      const chunk = value.subarray(0, max - size);
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function dataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
