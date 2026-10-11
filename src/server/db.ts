import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Listing } from './tradera.js';

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
    );`);
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
  list(page = 1, limit = 48, onlyNew = false): { items: StoredListing[]; total: number } {
    const where = onlyNew ? ' WHERE is_new=1' : '';
    const total = this.db.prepare('SELECT count(*) AS n FROM items' + where).get() as { n: number };
    const rows = this.db.prepare(`SELECT id, category_id AS categoryId, title, price,
      buy_now_price AS buyNowPrice, image_url AS imageUrl, url,
      starts_at AS startsAt, ends_at AS endsAt, first_seen_at AS firstSeenAt,
      last_seen_at AS lastSeenAt, is_new AS isNew
      FROM items` + where + ' ORDER BY first_seen_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, (page - 1) * limit) as unknown as Array<Omit<StoredListing,'isNew'> & {isNew:number}>;
    return { items: rows.map(x => ({...x, isNew: !!x.isNew})), total: total.n };
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
