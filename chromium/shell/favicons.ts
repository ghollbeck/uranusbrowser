/** Chromium's local favicon database returns a default globe when it has no icon. */
export async function chromiumIcon(page: string): Promise<Blob | undefined> {
  const read = async (url: string) => {
    const query = new URLSearchParams({ size: '32', pageUrl: url, fallbackToHost: '1' });
    const response = await fetch(chrome.runtime.getURL('/_favicon/?' + query), { cache: 'no-store' });
    if (!response.ok) throw new Error('Favicon lookup failed');
    return new Uint8Array(await response.arrayBuffer());
  };
  try {
    const [icon, globe] = await Promise.all([read(page), read('https://anus.invalid/')]);
    if (icon.length && (icon.length !== globe.length || icon.some((byte, i) => byte !== globe[i]))) {
      return new Blob([icon], { type: 'image/png' });
    }
  } catch {
    // A local lookup can fail; the site itself is the fallback.
  }
}
