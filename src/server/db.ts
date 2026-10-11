import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Listing } from './tradera.js';
import type { Watch, WatchInput } from './watch-rules.js';

export interface StoredListing extends Listing {
  firstSeenAt: string; lastSeenAt: string; isNew: boolean;
}
export interface ScanResult {
  finishedAt: string; fetched: number; added: number; baseline: boolean;
}
export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, title TEXT NOT NULL,
      price REAL, buy_now_price REAL, image_url TEXT, url TEXT NOT NULL,
      starts_at TEXT, ends_at TEXT, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, is_new INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, finished_at TEXT NOT NULL,
      fetched INTEGER NOT NULL, added INTEGER NOT NULL, baseline INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL COLLATE NOCASE,
      max_price INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      initialized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_scanned_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS watch_matches (
      watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      first_seen_at TEXT NOT NULL,
      is_new INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watch_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS watch_matches_new ON watch_matches(watch_id, is_new, first_seen_at);
    `);
    this.db.exec('PRAGMA foreign_keys=ON;');
  }
  saveScan(items: Listing[], now = new Date().toISOString()): ScanResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const initialized = !!this.db.prepare("SELECT value FROM meta WHERE key='initialized'").get();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO items (
        id, category_id, title, price, buy_now_price, image_url, url,
        starts_at, ends_at, first_seen_at, last_seen_at, is_new
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const update = this.db.prepare(`UPDATE items SET category_id=?, title=?, price=?,
        buy_now_price=?, image_url=?, url=?, starts_at=?, ends_at=?, last_seen_at=?
        WHERE id=?`);
      let added = 0;
      for (const item of items) {
        const result = insert.run(item.id, item.categoryId, item.title, item.price,
          item.buyNowPrice, item.imageUrl, item.url, item.startsAt, item.endsAt,
          now, now, initialized ? 1 : 0);
        added += Number(result.changes);
        update.run(item.categoryId, item.title, item.price, item.buyNowPrice,
          item.imageUrl, item.url, item.startsAt, item.endsAt, now, item.id);
      }
      this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('initialized','1')").run();
      this.db.prepare('INSERT INTO scans(finished_at,fetched,added,baseline) VALUES (?,?,?,?)')
        .run(now, items.length, added, initialized ? 0 : 1);
      this.db.exec('COMMIT');
      return { finishedAt: now, fetched: items.length, added, baseline: !initialized };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  list(page = 1, limit = 48, onlyNew = false, watchId?: number): { items: StoredListing[]; total: number } {
    const scoped = watchId !== undefined;
    const from = scoped
      ? ' FROM items i JOIN watch_matches m ON m.item_id=i.id AND m.watch_id=?'
      : ' FROM items i';
    const where = onlyNew ? ' WHERE ' + (scoped ? 'm.is_new' : 'i.is_new') + '=1' : '';
    const params = scoped ? [watchId] : [];
    const total = this.db.prepare('SELECT count(*) AS n' + from + where)
      .get(...params) as { n: number };
    const rows = this.db.prepare(`SELECT i.id, i.category_id AS categoryId, i.title, i.price,
      i.buy_now_price AS buyNowPrice, i.image_url AS imageUrl, i.url,
      i.starts_at AS startsAt, i.ends_at AS endsAt,
      ${scoped ? 'm.first_seen_at' : 'i.first_seen_at'} AS firstSeenAt,
      i.last_seen_at AS lastSeenAt,
      ${scoped ? 'm.is_new' : 'i.is_new'} AS isNew`
      + from + where
      + ' ORDER BY ' + (scoped ? 'm.first_seen_at' : 'i.first_seen_at')
      + ' DESC, i.id DESC LIMIT ? OFFSET ?')
      .all(...params, limit, (page - 1) * limit) as unknown as Array<Omit<StoredListing, 'isNew'> & { isNew: number }>;
    return { items: rows.map(item => ({...item, isNew: !!item.isNew})), total: total.n };
  }

  private watchFromRow(row: Record<string, unknown>): Watch {
    return {
      id: Number(row.id), term: String(row.term),
      maxPrice: row.maxPrice === null ? null : Number(row.maxPrice),
      enabled: !!row.enabled, initialized: !!row.initialized,
      createdAt: String(row.createdAt),
      lastScannedAt: row.lastScannedAt === null ? null : String(row.lastScannedAt),
      lastError: row.lastError === null ? null : String(row.lastError),
      matchedCount: Number(row.matchedCount), newCount: Number(row.newCount)
    };
  }
  private watchQuery = `SELECT w.id, w.term, w.max_price AS maxPrice,
    w.enabled, w.initialized, w.created_at AS createdAt,
    w.last_scanned_at AS lastScannedAt, w.last_error AS lastError,
    (SELECT count(*) FROM watch_matches m WHERE m.watch_id=w.id) AS matchedCount,
    (SELECT count(*) FROM watch_matches m WHERE m.watch_id=w.id AND m.is_new=1) AS newCount
    FROM watches w`;

  listWatches(): Watch[] {
    return (this.db.prepare(this.watchQuery + ' ORDER BY w.created_at, w.id').all() as unknown as Record<string, unknown>[])
      .map(row => this.watchFromRow(row));
  }
  getWatch(id: number): Watch | null {
    const row = this.db.prepare(this.watchQuery + ' WHERE w.id=?')
      .get(id) as Record<string,unknown>|undefined;
    return row ? this.watchFromRow(row) : null;
  }
  createWatch(input: WatchInput): Watch {
    const count = this.db.prepare('SELECT count(*) AS n FROM watches').get() as {n:number};
    if (count.n >= 8) throw new Error('Högst åtta bevakningar stöds för att begränsa API-anrop');
    const existing = this.db.prepare('SELECT id FROM watches WHERE lower(term)=lower(?) AND max_price IS ?')
      .get(input.term,input.maxPrice);
    if (existing) throw new Error('En identisk bevakning finns redan');
    const result = this.db.prepare(`INSERT INTO watches
      (term,max_price,created_at) VALUES (?,?,?)`)
      .run(input.term,input.maxPrice,new Date().toISOString());
    return this.getWatch(Number(result.lastInsertRowid))!;
  }
  setWatchEnabled(id: number, enabled: boolean): Watch | null {
    const result = this.db.prepare('UPDATE watches SET enabled=? WHERE id=?').run(enabled ? 1 : 0,id);
    return result.changes ? this.getWatch(id) : null;
  }
  deleteWatch(id: number): boolean {
    return !!this.db.prepare('DELETE FROM watches WHERE id=?').run(id).changes;
  }
  watchFailed(id: number, error: string): void {
    this.db.prepare('UPDATE watches SET last_error=? WHERE id=?').run(error.slice(0,500),id);
  }
  saveWatchScan(watchId: number, items: Listing[], now = new Date().toISOString()):
    { matched: number; added: number; baseline: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const watch = this.getWatch(watchId);
      if (!watch || !watch.enabled) throw new Error('Bevakningen finns inte längre eller är pausad');
      const initialized = !!this.db.prepare("SELECT value FROM meta WHERE key='initialized'").get();
      const insert = this.db.prepare(`INSERT OR IGNORE INTO items (
        id, category_id, title, price, buy_now_price, image_url, url,
        starts_at, ends_at, first_seen_at, last_seen_at, is_new
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const update = this.db.prepare(`UPDATE items SET category_id=?, title=?, price=?,
        buy_now_price=?, image_url=?, url=?, starts_at=?, ends_at=?, last_seen_at=? WHERE id=?`);
      const match = this.db.prepare(`INSERT OR IGNORE INTO watch_matches
        (watch_id,item_id,first_seen_at,is_new) VALUES (?,?,?,?)`);
      let added = 0;
      for (const item of items) {
        insert.run(item.id, item.categoryId, item.title, item.price, item.buyNowPrice,
          item.imageUrl, item.url, item.startsAt, item.endsAt,
          now, now, initialized && watch.initialized ? 1 : 0);
        update.run(item.categoryId, item.title, item.price, item.buyNowPrice,
          item.imageUrl, item.url, item.startsAt, item.endsAt, now, item.id);
        added += Number(match.run(watchId,item.id,now,watch.initialized ? 1 : 0).changes);
      }
      this.db.prepare(`UPDATE watches SET initialized=1,last_scanned_at=?,last_error=NULL WHERE id=?`)
        .run(now,watchId);
      this.db.exec('COMMIT');
      return {matched:items.length,added,baseline:!watch.initialized};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  stats(): { total: number; newItems: number; lastScan: ScanResult | null } {
    const row = this.db.prepare('SELECT count(*) AS total, coalesce(sum(is_new),0) AS newItems FROM items')
      .get() as {total:number;newItems:number};
    const scan = this.db.prepare('SELECT finished_at AS finishedAt, fetched, added, baseline FROM scans ORDER BY id DESC LIMIT 1')
      .get() as {finishedAt:string;fetched:number;added:number;baseline:number}|undefined;
    return { total:row.total, newItems:row.newItems,
      lastScan: scan ? {...scan, baseline:!!scan.baseline} : null };
  }
  close(): void { this.db.close(); }
}
