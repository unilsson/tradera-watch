import type { Config } from './config.js';
import { Store } from './db.js';
import { fetchListings } from './tradera.js';
import { matchesWatch } from './watch-rules.js';

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  lastError: string | null = null;
  lastAttempt: string | null = null;
  constructor(private config: Config, private store: Store,
    private fetcher: typeof fetchListings = fetchListings) {}
  get scanning(): boolean { return this.busy; }
  get configured(): boolean { return !!(this.config.appId && this.config.appKey); }
  async scan(): Promise<void> {
    if (this.busy || !this.configured) return;
    this.busy = true;
    this.lastAttempt = new Date().toISOString();
    const errors: string[] = [];
    try {
      // Keep the original category scan and its historic baseline intact.
      try {
        const listings = await this.fetcher(this.config);
        const result = this.store.saveScan(listings);
        console.log('Tradera category scan:', JSON.stringify(result));
      } catch (error) {
        errors.push('Kategori: ' + (error instanceof Error ? error.message : String(error)));
      }
      // Targeted searches reach game listings outside the main category scan's
      // first N result pages. Each watch has its own independent baseline.
      for (const watch of this.store.listWatches().filter(w => w.enabled)) {
        try {
          const listings = await this.fetcher({...this.config, query: watch.term});
          const matches = listings.filter(item => matchesWatch(item,watch));
          const result = this.store.saveWatchScan(watch.id,matches);
          console.log('Tradera watch:',watch.id,JSON.stringify(result));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.store.watchFailed(watch.id,message);
          errors.push('Bevakning ' + watch.term + ': ' + message);
        }
      }
      this.lastError = errors.length ? errors.join(' | ') : null;
      if (errors.length) console.error('Tradera polling errors:',this.lastError);
    } finally {
      this.busy = false;
    }
  }
  start(): void {
    if (!this.configured) {
      this.lastError = 'Ange TRADERA_APP_ID och TRADERA_APP_KEY i .env';
      console.warn(this.lastError);
      return;
    }
    void this.scan();
    this.timer = setInterval(() => { void this.scan(); }, this.config.intervalSeconds * 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
