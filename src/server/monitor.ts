import type { Config } from './config.js';
import { Store } from './db.js';
import { fetchListings } from './tradera.js';

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
    try {
      // Spara först när ALLA sidor hämtats utan fel. Delvis lyckade svar räknas inte.
      const listings = await this.fetcher(this.config);
      const result = this.store.saveScan(listings);
      this.lastError = null;
      console.log('Tradera scan:', JSON.stringify(result));
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('Tradera scan failed:', this.lastError);
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
