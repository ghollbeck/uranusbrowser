/** The icons an HTML page declares in its <link> tags, best first: SVG, then apple-touch-icon, then the largest. */
export function declaredIcons(html: string, base: string) {
  const icons: Array<{ href: string; score: number }> = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => {
      const match = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i'));
      return (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/&amp;/gi, '&');
    };
    const rel = attr('rel')?.toLowerCase() ?? '';
    const href = attr('href');
    if (!href || !rel.includes('icon') || rel.includes('mask')) continue;
    const size = Number(attr('sizes')?.match(/(\d+)/)?.[1] ?? 0);
    const score = href.endsWith('.svg') || attr('type')?.includes('svg') ? 1000 : rel.includes('apple-touch') ? 500 : size;
    try {
      icons.push({ href: new URL(href, base).href, score });
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return icons.sort((a, b) => b.score - a.score).map((i) => i.href);
}
