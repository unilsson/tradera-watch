import type { Config } from './config.js';
import { Store } from './db.js';
import {
  sendDiscord, discordWebhookEndpoint, discordListingMessage, DiscordDeliveryError,
  type DiscordMessage
} from './discord.js';

type Sender = typeof sendDiscord;

/** Delivers only Discord's own durable queue; cannot delay Pushover delivery. */
export class DiscordWorker {
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private lastTestAt = 0;
  lastError: string | null = null;
  constructor(private config: Config, private store: Store,
    private sender: Sender = sendDiscord) {}

  get enabled(): boolean {
    return !!(this.config.discordWebhookUrl &&
      discordWebhookEndpoint(this.config.discordWebhookUrl));
  }
  get configurationError(): string | null {
    return this.config.discordWebhookUrl && !this.enabled
      ? 'DISCORD_WEBHOOK_URL är ogiltig (kräver HTTPS-webhook på discord.com)' : null;
  }

  private send(message: DiscordMessage): Promise<void> {
    return this.sender(this.config.discordWebhookUrl!,message);
  }

  async flush(maxBatch = 10): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy=true;
    try {
      for(let i=0;i<maxBatch;i++){
        const item=this.store.nextDiscordNotification();
        if(!item)break;
        try {
          await this.send(discordListingMessage(item.watchTerm,item.item));
          this.store.discordSent(item.id);
          this.lastError=null;
          console.log('Discord sent:', 'watch='+item.watchId, 'item='+item.item.id);
        } catch(error) {
          // sendDiscord never includes the private URL in error messages.
          const message=error instanceof DiscordDeliveryError
            ?error.message:'Discord-utskick misslyckades';
          const permanent=error instanceof DiscordDeliveryError &&
            error.httpStatus>=400 && error.httpStatus<500 && error.httpStatus!==429;
          const backoff=permanent?3600:Math.min(3600,60*2**Math.min(item.attempts,6));
          const after=error instanceof DiscordDeliveryError?error.retryAfter??0:0;
          const waitSeconds=Math.max(backoff,after);
          this.store.discordFailed(item.id,message,
            new Date(Date.now()+waitSeconds*1000).toISOString());
          this.lastError=message;
          console.warn('Discord delivery failed:',message,'retry in',waitSeconds,'seconds');
          // Respect 429: leave the rest of the batch queued rather than
          // generating more requests against a rate-limited webhook.
          if(error instanceof DiscordDeliveryError && error.httpStatus===429)break;
        }
      }
    } finally {this.busy=false;}
  }

  async sendTest():Promise<void> {
    if(!this.enabled)throw new Error(this.configurationError || 'Discord är inte konfigurerat');
    if(Date.now()-this.lastTestAt<60000)
      throw new Error('Vänta en minut innan nästa Discord-test');
    this.lastTestAt=Date.now();
    await this.send({
      title:'🎲 Tradera Watch – testnotis',
      description:'Discord-webhooken fungerar! Nya spelträffar skickas hit automatiskt.',
      url:'https://www.tradera.com/'
    });
  }
  start():void {
    if(!this.enabled){
      console.log('Discord:',this.configurationError || 'disabled (no webhook configured)');
      return;
    }
    void this.flush();
    this.timer=setInterval(()=>{void this.flush();},60000);
    this.timer.unref();
    console.log('Discord: enabled');
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
