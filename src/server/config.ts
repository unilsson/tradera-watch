import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

export interface Config {
  appId: string; appKey: string; categoryId: number; query: string;
  orderBy: string; intervalSeconds: number; maxPages: number;
  dataDir: string; port: number;
  secondaryEvery?: number; secondaryPages?: number;
  pushoverToken?: string; pushoverUser?: string;
  discordWebhookUrl?: string;
  statusChecksPerScan?: number; statusRecheckHours?: number;
  listingRetentionDays?: number; staleListingDays?: number;
  searchHistoryDays?: number; scanHistoryDays?: number; notificationHistoryDays?: number;
}
function num(name: string, fallback: number, min: number, max: number): number {
  const input = process.env[name];
  const value = input ? Number(input) : fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(name + ' måste vara ett heltal mellan ' + min + ' och ' + max);
  return value;
}
export function loadConfig(): Config {
  if (existsSync('.env')) loadEnvFile('.env');
  return {
    appId: (process.env.TRADERA_APP_ID || '').trim(),
    appKey: (process.env.TRADERA_APP_KEY || '').trim(),
    categoryId: num('TRADERA_CATEGORY_ID', 181806, 1, 2147483647),
    query: (process.env.TRADERA_QUERY || '').trim(),
    orderBy: (process.env.TRADERA_ORDER_BY || 'EndDateDescending').trim(),
    intervalSeconds: num('POLL_INTERVAL_SECONDS', 300, 60, 86400),
    maxPages: num('MAX_PAGES', 3, 1, 20),
    secondaryEvery: num('SECONDARY_SEARCH_EVERY', 3, 0, 1440),
    secondaryPages: num('SECONDARY_SEARCH_PAGES', 1, 1, 3),
    dataDir: resolve(process.env.DATA_DIR || './data'),
    port: num('PORT', 3001, 1, 65535),
    pushoverToken: (process.env.PUSHOVER_APP_TOKEN || '').trim(),
    pushoverUser: (process.env.PUSHOVER_USER_KEY || '').trim(),
    discordWebhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
    statusChecksPerScan: num('STATUS_CHECKS_PER_SCAN',3,0,10),
    statusRecheckHours: num('STATUS_RECHECK_HOURS',24,1,168),
    listingRetentionDays: num('LISTING_RETENTION_DAYS',90,1,3650),
    staleListingDays: num('STALE_LISTING_DAYS',180,30,3650),
    searchHistoryDays: num('SEARCH_HISTORY_DAYS',30,1,3650),
    scanHistoryDays: num('SCAN_HISTORY_DAYS',30,1,3650),
    notificationHistoryDays: num('NOTIFICATION_HISTORY_DAYS',30,1,3650)
  };
}
