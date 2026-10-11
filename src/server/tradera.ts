import type { Config } from './config.js';

export interface Listing {
  id: number; categoryId: number; title: string; price: number | null;
  buyNowPrice: number | null; imageUrl: string | null; url: string;
  startsAt: string | null; endsAt: string | null;
}
type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : null;
function pick(o: ObjectValue, ...names: string[]): unknown {
  for (const key of names) if (o[key] !== undefined) return o[key];
  return null;
}
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function safeUrl(v: unknown, domain?: string): string | null {
  const text = str(v);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return null;
    if (domain && url.hostname !== domain && !url.hostname.endsWith('.' + domain)) return null;
    return url.toString();
  } catch { return null; }
}

// Sökresultatets properties saknas i v4 OpenAPI – acceptera både camelCase och PascalCase.
export function parseSearchResult(value: unknown): { listings: Listing[]; totalPages: number | null } {
  const root = obj(value);
  if (!root) throw new Error('Ogiltigt söksvar från Tradera');
  const result = obj(pick(root, 'searchResult', 'SearchResult')) || root;
  const items = pick(result, 'items', 'Items');
  if (!Array.isArray(items)) throw new Error('Tradera-söksvar saknar items (kontrollera API-versionen)');
  const pages = num(pick(result, 'totalNumberOfPages', 'TotalNumberOfPages'));
  const listings: Listing[] = [];
  for (const raw of items) {
    const item = obj(raw);
    if (!item) continue;
    const id = num(pick(item, 'id', 'itemId', 'Id', 'ItemId'));
    if (id === null || !Number.isSafeInteger(id) || id <= 0) continue;
    const cat = num(pick(item, 'categoryId', 'CategoryId')) || 181806;
    const images = pick(item, 'imageLinks', 'ImageLinks');
    const detailed = pick(item, 'detailedImageLinks', 'DetailedImageLinks');
    const firstFullImage = Array.isArray(images)
      ? images.map(link => safeUrl(link)).find((url): url is string => url !== null) || null
      : null;
    const firstDetailedImage = Array.isArray(detailed)
      ? detailed.map(link => safeUrl(pick(obj(link) || {}, 'url', 'Url')))
        .find((url): url is string => url !== null) || null
      : null;
    const currentBid = num(pick(item, 'maxBid', 'MaxBid', 'currentBid', 'CurrentBid'));
    const openingBid = num(pick(item, 'openingBid', 'OpeningBid', 'price', 'Price'));
    listings.push({
      id, categoryId: cat,
      title: str(pick(item, 'shortDescription', 'ShortDescription', 'title', 'Title')) || 'Annons ' + id,
      price: currentBid !== null && currentBid > 0 ? currentBid : openingBid,
      buyNowPrice: pick(item, 'buyItNowPriceSpecified', 'BuyItNowPriceSpecified') === false
        ? null : num(pick(item, 'buyItNowPrice', 'BuyItNowPrice')),
      // thumbnailLink is low-resolution. Prefer full image links when present.
      imageUrl: firstFullImage || firstDetailedImage || safeUrl(pick(item, 'thumbnailLink', 'ThumbnailLink')),
      url: safeUrl(pick(item, 'itemLink', 'ItemLink'), 'tradera.com')
        || 'https://www.tradera.com/item/' + cat + '/' + id,
      startsAt: str(pick(item, 'startDate', 'StartDate')),
      endsAt: str(pick(item, 'endDate', 'EndDate'))
    });
  }
  return { listings, totalPages: pages !== null && pages >= 1 ? pages : null };
}

export async function fetchListings(config: Config, request: typeof fetch = fetch): Promise<Listing[]> {
  if (!config.appId || !config.appKey) throw new Error('Tradera API-nycklar saknas');
  const found: Listing[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= config.maxPages; page++) {
    const url = new URL('https://api.tradera.com/v4/search');
    url.searchParams.set('query', config.query);
    url.searchParams.set('categoryId', String(config.categoryId));
    url.searchParams.set('pageNumber', String(page));
    url.searchParams.set('orderBy', config.orderBy);
    const response = await request(url, {
      headers: { 'X-App-Id': config.appId, 'X-App-Key': config.appKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Tradera HTTP ' + response.status +
      (response.headers.get('retry-after') ? ' (Retry-After: ' + response.headers.get('retry-after') + ')' : ''));
    const { listings, totalPages } = parseSearchResult(await response.json());
    let added = 0;
    for (const item of listings) {
      if (!seen.has(item.id)) { seen.add(item.id); found.push(item); added++; }
    }
    if (listings.length === 0 || added === 0 || (totalPages !== null && page >= totalPages)) break;
  }
  return found;
}
