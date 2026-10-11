import type { Config } from './config.js';
import { Store } from './db.js';
import { notificationMessage, PushoverError, sendPushover, type PushoverMessage } from './pushover.js';

type Sender = typeof sendPushover;
export class NotificationWorker {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastTestAt = 0;
  lastError: string | null = null;
  constructor(private config: Config, private store: Store, private sender: Sender = sendPushover) {}
  get enabled(): boolean {
    return !!(this.config.pushoverToken && this.config.pushoverUser);
  }
  private async send(message: PushoverMessage): Promise<void> {
    await this.sender({
      token: this.config.pushoverToken!,
      user: this.config.pushoverUser!
    }, message);
  }
  async flush(maxBatch = 10): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      for (let i=0; i<maxBatch; i++) {
        const item = this.store.nextNotification();
        if (!item) break;
        try {
          await this.send(notificationMessage(item.watchTerm,item.item));
          this.store.notificationSent(item.id);
          this.lastError = null;
          console.log('Pushover sent:', 'watch=' + item.watchId, 'item=' + item.item.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const permanent = error instanceof PushoverError &&
            error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429;
          const backoff = permanent ? 3600 : Math.min(3600,60 * 2 ** Math.min(item.attempts,6));
          const retryAfter = error instanceof PushoverError ? error.retryAfter ?? 0 : 0;
          const waitSeconds = Math.max(backoff,retryAfter);
          this.store.notificationFailed(item.id,message,
            new Date(Date.now() + waitSeconds * 1000).toISOString());
          this.lastError = message;
          console.warn('Pushover delivery failed:',message,'retry in',waitSeconds,'seconds');
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async sendTest(): Promise<void> {
    if (!this.enabled) throw new Error('Pushover är inte konfigurerat');
    if (Date.now() - this.lastTestAt < 60000)
      throw new Error('Vänta en minut innan nästa testnotis');
    this.lastTestAt = Date.now();
    await this.send({
      title:'🎲 Tradera Watch – testnotis',
      message:'Pushover fungerar! Du får notiser när nya annonser matchar dina spelbevakningar.',
      url:'https://www.tradera.com/',
      urlTitle:'Öppna Tradera'
    });
  }
  start(): void {
    if (!this.enabled) {
      console.log('Pushover: disabled (missing app token or user key)');
      return;
    }
    void this.flush();
    this.timer = setInterval(()=>{void this.flush();},60000);
    this.timer.unref();
    console.log('Pushover: enabled');
  }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=null; }
}
