import type { Listing } from './tradera.js';

export interface Watch {
  id: number;
  term: string;
  maxPrice: number | null;
  enabled: boolean;
  initialized: boolean;
  createdAt: string;
  lastScannedAt: string | null;
  lastError: string | null;
  matchedCount: number;
  newCount: number;
}

export interface WatchInput {
  term: string;
  maxPrice: number | null;
}

export function parseWatchInput(payload: unknown): WatchInput {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Förväntade ett JSON-objekt');
  }
  const data = payload as Record<string, unknown>;
  if (typeof data.term !== 'string') throw new Error('Ange ett spelnamn');
  const term = data.term.replace(/\s+/g, ' ').trim();
  if (term.length < 2 || term.length > 80) throw new Error('Spelnamnet måste ha 2–80 tecken');
  const input = data.maxPrice;
  const maxPrice = input === null || input === undefined || input === '' ? null : Number(input);
  if (maxPrice !== null && (!Number.isInteger(maxPrice) || maxPrice <= 0 || maxPrice > 500000)) {
    throw new Error('Maxpriset måste vara ett heltal mellan 1 och 500000 kr');
  }
  return { term, maxPrice };
}
function normalized(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sv-SE');
}
export function matchesWatch(item: Listing, watch: WatchInput): boolean {
  if (!normalized(item.title).includes(normalized(watch.term))) return false;
  if (watch.maxPrice === null) return true;
  const prices = [item.price, item.buyNowPrice].filter(
    (value): value is number => value !== null && Number.isFinite(value) && value > 0
  );
  return prices.length > 0 && Math.min(...prices) <= watch.maxPrice;
}
