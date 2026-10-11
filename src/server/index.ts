import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { Monitor } from './monitor.js';

const config = loadConfig();
const store = new Store(resolve(config.dataDir, 'tradera-watch.sqlite'));
const monitor = new Monitor(config, store);
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
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method !== 'GET') return json(response, 405, {error:'Metoden stöds inte'});
    if (url.pathname === '/api/health') return json(response, 200, {ok:true, configured:monitor.configured});
    if (url.pathname === '/api/status') return json(response, 200, {
      ...store.stats(), scanning:monitor.scanning, configured:monitor.configured,
      lastError:monitor.lastError, lastAttempt:monitor.lastAttempt,
      categoryId:config.categoryId, query:config.query, intervalSeconds:config.intervalSeconds,
      maxPages:config.maxPages, orderBy:config.orderBy
    });
    if (url.pathname === '/api/items') {
      const page = Number(url.searchParams.get('page') || '1');
      const limit = Number(url.searchParams.get('limit') || '48');
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return json(response, 400, {error:'Ogiltig sidnumrering'});
      return json(response, 200, store.list(page, limit, url.searchParams.get('newOnly') === '1'));
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
    console.error(error);
    json(response, 500, {error:'Internt serverfel'});
  }
});
server.listen(config.port, '0.0.0.0', () => {
  console.log('Tradera Watch API: http://localhost:' + config.port);
  monitor.start();
});
function shutdown(): void {
  monitor.stop();
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
