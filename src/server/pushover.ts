import type { Listing } from './tradera.js';

export interface PushoverCredentials { token: string; user: string }
export interface PushoverMessage { title: string; message: string; url?: string; urlTitle?: string }

export class PushoverError extends Error {
  constructor(public readonly httpStatus: number, message: string, public readonly retryAfter: number | null = null) {
    super(message);
  }
}

// No secrets are included in exceptions or logs.
export async function sendPushover(
  credentials: PushoverCredentials,
  notification: PushoverMessage,
  request: typeof fetch = fetch
): Promise<void> {
  const params = new URLSearchParams({
    token: credentials.token,
    user: credentials.user,
    title: notification.title.slice(0, 250),
    message: notification.message.slice(0, 1024)
  });
  if (notification.url) params.set('url', notification.url);
  if (notification.urlTitle) params.set('url_title', notification.urlTitle);
  const response = await request('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
    signal: AbortSignal.timeout(10000)
  });
  const retryHeader = response.headers.get('retry-after');
  const retryAfter = retryHeader !== null && /^\d+$/.test(retryHeader)
    ? Math.min(86400, Number(retryHeader)) : null;
  if (!response.ok) {
    throw new PushoverError(response.status, 'Pushover HTTP ' + response.status, retryAfter);
  }
  // HTTP 200 on its own is insufficient: Pushover also returns status=1.
  let data: unknown;
  try { data = await response.json(); } catch {
    throw new PushoverError(502, 'Ogiltigt JSON-svar från Pushover');
  }
  if (!data || typeof data !== 'object' || (data as {status?:unknown}).status !== 1) {
    throw new PushoverError(502, 'Pushover bekräftade inte med status=1');
  }
}

export function notificationMessage(term: string, listing: Listing): PushoverMessage {
  const price = listing.price === null ? 'Pris saknas' : listing.price.toLocaleString('sv-SE') + ' kr';
  const buyNow = listing.buyNowPrice === null ? '' : ' · Köp nu ' + listing.buyNowPrice.toLocaleString('sv-SE') + ' kr';
  return {
    title: '🎲 Ny Tradera-träff: ' + term,
    message: listing.title + '\n' + price + buyNow,
    url: listing.url,
    urlTitle: 'Visa annons på Tradera'
  };
}
