import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

export interface Config {
  appId: string; appKey: string; categoryId: number; query: string;
  orderBy: string; intervalSeconds: number; maxPages: number;
  dataDir: string; port: number;
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
    dataDir: resolve(process.env.DATA_DIR || './data'),
    port: num('PORT', 3001, 1, 65535)
  };
}
