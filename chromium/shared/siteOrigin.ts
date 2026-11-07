/** The cache key for web pages, including nonstandard ports. Internal pages have no site icon. */
export function siteOrigin(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {
    // An empty tab or a malformed address has no site icon.
  }
}
