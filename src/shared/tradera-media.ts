/**
 * Tradera canonical item URLs contain the title slug after category and item ID.
 * Some API results omit this segment. Create it deterministically from the title,
 * including for items already persisted by older versions of Tradera Watch.
 */
export function listingUrl(item: {
  id: number; categoryId: number; title: string; url?: string | null;
}): string {
  const slug = item.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[åä]/gi, 'a')
    .replace(/ö/gi, 'o')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'annons';
  const canonical = 'https://www.tradera.com/item/' + item.categoryId + '/' + item.id + '/' + slug;
  // Trust complete HTTPS Tradera item links from the API; incomplete links
  // (without the title slug) are known to lead to a Tradera error page.
  if (item.url) {
    try {
      const original = new URL(item.url);
      if (
        original.protocol === 'https:' &&
        (original.hostname === 'tradera.com' || original.hostname === 'www.tradera.com') &&
        /^\/item\/\d+\/\d+\/[^/]+\/?$/.test(original.pathname) &&
        original.pathname.split('/')[3] === String(item.id)
      ) return original.toString();
    } catch { /* Fall back to canonical */ }
  }
  return canonical;
}

/**
 * The Tradera CDN publishes the same image asset in different size presets.
 * Its large-3-2 variant is present on actual listing pages.
 * Only rewrite recognized CDN asset paths, never arbitrary external URLs.
 */
export function largeImageUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'img.tradera.net') return url;
    const segments = u.pathname.split('/');
    if (
      segments.length >= 4 &&
      /^[a-z][a-z0-9-]*$/.test(segments[1]) &&
      /^\d+$/.test(segments[2]) &&
      /\.(?:jpe?g|png|webp)$/i.test(segments[segments.length - 1])
    ) {
      segments[1] = 'large-3-2';
      u.pathname = segments.join('/');
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}
