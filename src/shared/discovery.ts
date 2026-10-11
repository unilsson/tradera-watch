/**
 * Best-effort classification using the listing start date provided by Tradera.
 * The date is not independently verified to mean first publication, especially
 * for relisted items. A missing, invalid or future date stays "unknown".
 *
 * Reference time must be the instant the listing was FIRST discovered in a
 * given scope, not the current wall-clock time when the page is viewed.
 */
export type DiscoveryAge = 'recent' | 'older' | 'unknown';
export const RECENT_HOURS = 24;

export function discoveryAge(startsAt: string | null, discoveredAt: string,
  maxAgeHours = RECENT_HOURS): DiscoveryAge {
  if (!startsAt) return 'unknown';
  const start = Date.parse(startsAt);
  const discovered = Date.parse(discoveredAt);
  if (!Number.isFinite(start) || !Number.isFinite(discovered)) return 'unknown';
  const ageMs = discovered - start;
  // Clock skew or future-dated/restarted listing: do not classify as new.
  if (ageMs < 0) return 'unknown';
  return ageMs <= maxAgeHours * 60 * 60 * 1000 ? 'recent' : 'older';
}

export function classifyDiscovered<T extends {startsAt:string|null}>(items: T[],
  discoveredAt: string): {recent:number;older:number;unknown:number} {
  const counts = {recent:0,older:0,unknown:0};
  for (const item of items) counts[discoveryAge(item.startsAt,discoveredAt)]++;
  return counts;
}
