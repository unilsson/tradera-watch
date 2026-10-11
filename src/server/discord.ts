import type { Listing } from './tradera.js';

export class DiscordDeliveryError extends Error {
  constructor(public readonly httpStatus: number, message: string,
    public readonly retryAfter: number | null = null) {
    super(message);
  }
}

/** Only Discord's canonical webhook endpoint is permitted. No arbitrary outbound URLs. */
export function discordWebhookEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'discord.com' ||
        url.username || url.password || url.port || url.hash || url.search ||
        !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname))
      return null;
    url.searchParams.set('wait', 'true'); // Require a message receipt on success.
    return url;
  } catch { return null; }
}

export interface DiscordMessage {
  title: string;
  description: string;
  url?: string;
  thumbnailUrl?: string | null;
}
export function discordListingMessage(term: string, item: Listing): DiscordMessage {
  const bid = item.price === null ? 'saknas' : item.price.toLocaleString('sv-SE') + ' kr';
  const buyNow = item.buyNowPrice === null ? '' :
    '\n**Köp nu:** ' + item.buyNowPrice.toLocaleString('sv-SE') + ' kr';
  const imageUrl = item.imageUrl;
  return {
    title: item.title.slice(0, 256),
    description: '**Bevakning:** ' + term.slice(0, 80) + '\n**Aktuellt pris:** ' + bid + buyNow,
    url: item.url,
    thumbnailUrl: imageUrl && imageUrl.startsWith('https://') ? imageUrl : null
  };
}
export async function sendDiscord(webhook: string, message: DiscordMessage,
  request: typeof fetch = fetch): Promise<void> {
  const url = discordWebhookEndpoint(webhook);
  if (!url) throw new DiscordDeliveryError(400, 'Ogiltig DISCORD_WEBHOOK_URL');
  const embed: Record<string,unknown> = {
    title: message.title.slice(0, 256),
    description: message.description.slice(0, 2048),
    color: 0xd7b36b
  };
  if (message.url) embed.url = message.url;
  if (message.thumbnailUrl) embed.thumbnail = {url:message.thumbnailUrl};
  let response: Response;
  try {
    response = await request(url, {
      method:'POST',
      headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({
        username:'Tradera Watch',
        allowed_mentions:{parse:[]},
        embeds:[embed]
      }),
      signal:AbortSignal.timeout(10000)
    });
  } catch {
    // Never include fetch's original message: it may contain the secret URL.
    throw new DiscordDeliveryError(503, 'Nätverksfel vid Discord-utskick');
  }
  if (!response.ok) {
    let retryAfter:number|null=null;
    const header=response.headers.get('retry-after');
    if(header!==null && Number.isFinite(Number(header)) && Number(header)>=0)
      retryAfter=Math.min(86400,Number(header));
    if(response.status===429 && retryAfter===null) {
      try {
        const data=await response.json() as {retry_after?:unknown};
        if(typeof data?.retry_after==='number' && Number.isFinite(data.retry_after))
          retryAfter=Math.max(0,Math.min(86400,data.retry_after));
      } catch { /* Discard error bodies, which may contain secrets. */ }
    }
    throw new DiscordDeliveryError(response.status,'Discord HTTP ' + response.status,retryAfter);
  }
  // The wait=true response is the created message object. Do not mark as sent
  // unless Discord supplies its ID (a plain 204 does not provide a receipt).
  let payload:unknown;
  try { payload=await response.json(); }
  catch {throw new DiscordDeliveryError(502,'Discord saknar meddelandekvittens');}
  if (!payload || typeof payload!=='object' ||
      typeof (payload as {id?:unknown}).id!=='string' ||
      !/^\d+$/.test((payload as {id:string}).id))
    throw new DiscordDeliveryError(502,'Discord saknar giltigt meddelande-ID');
}
