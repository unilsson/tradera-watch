import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { Monitor } from './monitor.js';
import { NotificationWorker } from './notifications.js';
import { parseWatchInput } from './watch-rules.js';

const config = loadConfig();
const store = new Store(resolve(config.dataDir, 'tradera-watch.sqlite'));
const notifications = new NotificationWorker(config, store);
const monitor = new Monitor(config, store, undefined, notifications);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

function json(response: import('node:http').ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
const mime: Record<string,string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png'
};
class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function jsonBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new RequestError(415,'Skicka JSON med Content-Type: application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 4096) throw new RequestError(413,'JSON-innehållet är för stort');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400,'Ogiltig JSON'); }
}
function verifyOrigin(request: import('node:http').IncomingMessage): void {
  if (!request.headers.origin) return;
  try {
    const origin = new URL(request.headers.origin);
    if (!['http:','https:'].includes(origin.protocol) || origin.host !== request.headers.host)
      throw new RequestError(403,'Begäran från en annan webbplats nekades');
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(403,'Ogiltig Origin');
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/notifications/test' && request.method === 'POST') {
      verifyOrigin(request);
      if (!notifications.enabled) throw new RequestError(409,'Pushover är inte konfigurerat');
      try {
        await notifications.sendTest();
        return json(response,200,{ok:true});
      } catch(error) {
        throw new RequestError(502,error instanceof Error ? error.message : 'Pushover kunde inte nås');
      }
    }
    if (url.pathname === '/api/watches' && request.method === 'GET')
      return json(response, 200, {watches:store.listWatches(), limit:8});
    if (url.pathname === '/api/watches' && request.method === 'POST') {
      verifyOrigin(request);
      const input = parseWatchInput(await jsonBody(request));
      try { return json(response, 201, store.createWatch(input)); }
      catch (error) { throw new RequestError(409,error instanceof Error ? error.message : String(error)); }
    }
    const watchPath = /^\/api\/watches\/(\d+)$/.exec(url.pathname);
    if (watchPath && (request.method === 'PATCH' || request.method === 'DELETE')) {
      verifyOrigin(request);
      const id = Number(watchPath[1]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new RequestError(400,'Ogiltigt bevaknings-ID');
      if (request.method === 'DELETE') {
        if (!store.deleteWatch(id)) throw new RequestError(404,'Bevakningen finns inte');
        return json(response,200,{deleted:true});
      }
      const data = await jsonBody(request) as Record<string,unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.enabled !== 'boolean')
        throw new RequestError(400,'enabled måste vara true eller false');
      const watch = store.setWatchEnabled(id,data.enabled);
      if (!watch) throw new RequestError(404,'Bevakningen finns inte');
      return json(response,200,watch);
    }
    if (request.method !== 'GET') return json(response, 405, {error:'Metoden stöds inte'});
    if (url.pathname === '/api/health') return json(response, 200, {ok:true, configured:monitor.configured});
    if (url.pathname === '/api/status') return json(response, 200, {
      ...store.stats(), scanning:monitor.scanning, configured:monitor.configured,
      lastError:monitor.lastError, lastAttempt:monitor.lastAttempt,
      categoryId:config.categoryId, query:config.query, intervalSeconds:config.intervalSeconds,
      maxPages:config.maxPages, orderBy:config.orderBy,
      pushover:{configured:notifications.enabled,...store.notificationStats(),
        lastError:notifications.lastError || store.notificationStats().lastError}
    });
    if (url.pathname === '/api/items') {
      const page = Number(url.searchParams.get('page') || '1');
      const limit = Number(url.searchParams.get('limit') || '48');
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return json(response, 400, {error:'Ogiltig sidnumrering'});
      const watchParam = url.searchParams.get('watchId');
      const watchId = watchParam === null ? undefined : Number(watchParam);
      if (watchId !== undefined && (!Number.isSafeInteger(watchId) || watchId <= 0))
        throw new RequestError(400,'Ogiltigt bevaknings-ID');
      if (watchId !== undefined && !store.getWatch(watchId))
        throw new RequestError(404,'Bevakningen finns inte');
      return json(response, 200, store.list(page,limit,url.searchParams.get('newOnly') === '1',watchId));
    }
    if (url.pathname.startsWith('/api/')) return json(response, 404, {error:'Okänt API'});
    // I utvecklingsläge serverar Vite frontend på port 5173.
    const path = resolve(webDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (path !== webDir && !path.startsWith(webDir + sep))
      return json(response, 403, {error:'Ogiltig sökväg'});
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream',
        'X-Content-Type-Options':'nosniff' });
      response.end(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return json(response, 404, {error:'Sidan saknas – kör npm run dev:web i utvecklingsläge'});
      throw error;
    }
  } catch (error) {
    if (error instanceof RequestError) {
      return json(response,error.status,{error:error.message});
    }
    if (error instanceof Error && /Spelnamnet|Maxpriset|Ange ett spelnamn|Förväntade ett JSON-objekt/.test(error.message))
      return json(response,400,{error:error.message});
    console.error(error);
    json(response, 500, {error:'Internt serverfel'});
  }
});
server.listen(config.port, '0.0.0.0', () => {
  console.log('Tradera Watch API: http://localhost:' + config.port);
  notifications.start();
  monitor.start();
});
function shutdown(): void {
  monitor.stop();
  notifications.stop();
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
