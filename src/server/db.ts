import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Listing } from './tradera.js';
import type { Watch, WatchInput } from './watch-rules.js';
import { classifyDiscovered, discoveryAge, type DiscoveryAge } from '../shared/discovery.js';

export interface QueuedNotification {
  id: number; watchId: number; watchTerm: string; item: Listing; attempts: number;
}
export interface NotificationStats {pending: number; sent: number; lastError: string | null;}

export interface StoredListing extends Listing {
  firstSeenAt: string; lastSeenAt: string; isNew: boolean;
  discoveryAge?: DiscoveryAge;
}
export interface ScanResult {
  finishedAt: string; fetched: number; added: number; baseline: boolean;
}
export interface SearchRun {
  scope: 'category' | 'watch';
  watchId: number | null;
  query: string;
  finishedAt: string;
  apiCalls: number;
  pages: number;
  resultCount: number;
  newCount: number;
  recentCount: number;
  olderCount: number;
  unknownCount: number;
  secondaryUsed: boolean;
  secondaryError: string | null;
  limitedByMaxPages: boolean;
  error: string | null;
}
export interface SearchStats {
  last: SearchRun | null;
  last24h: {apiCalls:number;pages:number;newCount:number;recentCount:number;
    olderCount:number;unknownCount:number;failures:number;scans:number};
  recentRuns: SearchRun[];
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
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      created_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      sent_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      UNIQUE (watch_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS notification_outbox_pending
      ON notification_outbox(sent_at,next_attempt_at);
    CREATE TABLE IF NOT EXISTS search_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, watch_id INTEGER, query TEXT NOT NULL,
      finished_at TEXT NOT NULL, api_calls INTEGER NOT NULL,
      pages INTEGER NOT NULL, result_count INTEGER NOT NULL,
      new_count INTEGER NOT NULL, recent_count INTEGER NOT NULL,
      older_count INTEGER NOT NULL, unknown_count INTEGER NOT NULL,
      secondary_used INTEGER NOT NULL, secondary_error TEXT,
      limited_by_max_pages INTEGER NOT NULL, error TEXT
    );
    CREATE INDEX IF NOT EXISTS search_runs_date ON search_runs(finished_at);


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
    return { items: rows.map(item => ({...item, isNew: !!item.isNew,
      discoveryAge: discoveryAge(item.startsAt,item.firstSeenAt)})), total: total.n };
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
  saveWatchScan(watchId: number, items: Listing[], now = new Date().toISOString(),
    queueNotifications = false):
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
      const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
        (watch_id,item_id,created_at,next_attempt_at) VALUES (?,?,?,?)`);
      let added = 0;
      for (const item of items) {
        insert.run(item.id, item.categoryId, item.title, item.price, item.buyNowPrice,
          item.imageUrl, item.url, item.startsAt, item.endsAt,
          now, now, initialized && watch.initialized ? 1 : 0);
        update.run(item.categoryId, item.title, item.price, item.buyNowPrice,
          item.imageUrl, item.url, item.startsAt, item.endsAt, now, item.id);
        const newMatch = Number(match.run(watchId,item.id,now,watch.initialized ? 1 : 0).changes);
        added += newMatch;
        // Queue only genuinely newly found matches after this watch's baseline.
        // Both operations share the same transaction to survive restarts safely.
        if (newMatch && watch.initialized && queueNotifications) enqueue.run(watchId,item.id,now,now);
      }
      this.db.prepare(`UPDATE watches SET initialized=1,last_scanned_at=?,last_error=NULL WHERE id=?`)
        .run(now,watchId);
      this.db.exec('COMMIT');
      return {matched:items.length,added,baseline:!watch.initialized};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  nextNotification(now = new Date().toISOString()): QueuedNotification | null {
    const row = this.db.prepare(`SELECT n.id, n.watch_id AS watchId, w.term AS watchTerm, n.attempts,
        i.id AS itemId, i.category_id AS categoryId, i.title, i.price,
        i.buy_now_price AS buyNowPrice, i.image_url AS imageUrl, i.url,
        i.starts_at AS startsAt, i.ends_at AS endsAt
      FROM notification_outbox n
      JOIN watches w ON w.id=n.watch_id
      JOIN items i ON i.id=n.item_id
      WHERE n.sent_at IS NULL AND n.next_attempt_at <= ? AND w.enabled=1
      ORDER BY n.next_attempt_at,n.id LIMIT 1`)
      .get(now) as Record<string,unknown>|undefined;
    if (!row) return null;
    return {
      id:Number(row.id),watchId:Number(row.watchId),watchTerm:String(row.watchTerm),
      attempts:Number(row.attempts),
      item:{
        id:Number(row.itemId),categoryId:Number(row.categoryId),title:String(row.title),
        price: row.price === null ? null : Number(row.price),
        buyNowPrice:row.buyNowPrice === null ? null : Number(row.buyNowPrice),
        imageUrl:row.imageUrl === null ? null : String(row.imageUrl),url:String(row.url),
        startsAt:row.startsAt === null ? null : String(row.startsAt),
        endsAt:row.endsAt === null ? null : String(row.endsAt)
      }
    };
  }
  notificationSent(id: number, now = new Date().toISOString()): void {
    this.db.prepare(`UPDATE notification_outbox SET sent_at=?, attempts=attempts+1,last_error=NULL
      WHERE id=? AND sent_at IS NULL`).run(now,id);
  }
  notificationFailed(id: number, error: string, nextAttemptAt: string): void {
    this.db.prepare(`UPDATE notification_outbox
      SET attempts=attempts+1,last_error=?,next_attempt_at=?
      WHERE id=? AND sent_at IS NULL`).run(error.slice(0,250),nextAttemptAt,id);
  }
  notificationStats(): NotificationStats {
    const row=this.db.prepare(`SELECT
      count(*) FILTER (WHERE sent_at IS NULL) AS pending,
      count(*) FILTER (WHERE sent_at IS NOT NULL) AS sent
      FROM notification_outbox`).get() as {pending:number;sent:number};
    const error=this.db.prepare(`SELECT last_error AS lastError FROM notification_outbox
      WHERE sent_at IS NULL AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get() as {lastError:string}|undefined;
    return {pending:row.pending,sent:row.sent,lastError:error?.lastError??null};
  }
  /**
   * Counts only post-baseline matches first seen at this exact scan timestamp.
   * Existing tables are unchanged and the original Pushover enqueue rules stay intact.
   */
  discoveredCounts(scope:'category'|'watch', finishedAt:string, watchId?:number):
    {recent:number;older:number;unknown:number} {
    const sql = scope === 'category'
      ? 'SELECT starts_at AS startsAt FROM items WHERE first_seen_at=? AND is_new=1'
      : `SELECT i.starts_at AS startsAt FROM watch_matches m
          JOIN items i ON i.id=m.item_id
          WHERE m.first_seen_at=? AND m.is_new=1 AND m.watch_id=?`;
    const rows = (scope === 'category'
      ? this.db.prepare(sql).all(finishedAt)
      : this.db.prepare(sql).all(finishedAt,watchId ?? -1)) as {startsAt:string|null}[];
    return classifyDiscovered(rows,finishedAt);
  }
  recordSearchRun(run:SearchRun):void {
    this.db.prepare(`INSERT INTO search_runs
      (scope,watch_id,query,finished_at,api_calls,pages,result_count,
      new_count,recent_count,older_count,unknown_count,secondary_used,
      secondary_error,limited_by_max_pages,error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      run.scope,run.watchId,run.query,run.finishedAt,run.apiCalls,run.pages,
      run.resultCount,run.newCount,run.recentCount,run.olderCount,run.unknownCount,
      run.secondaryUsed?1:0,run.secondaryError,run.limitedByMaxPages?1:0,run.error);
  }
  searchStats(now=new Date().toISOString()):SearchStats {
    const start=new Date(Date.parse(now)-24*3600*1000).toISOString();
    const decode=(row:Record<string,unknown>):SearchRun=>({
      scope:row.scope as 'category'|'watch',
      watchId:row.watchId===null?null:Number(row.watchId),
      query:String(row.query),finishedAt:String(row.finishedAt),
      apiCalls:Number(row.apiCalls),pages:Number(row.pages),resultCount:Number(row.resultCount),
      newCount:Number(row.newCount),recentCount:Number(row.recentCount),
      olderCount:Number(row.olderCount),unknownCount:Number(row.unknownCount),
      secondaryUsed:!!row.secondaryUsed,
      secondaryError:row.secondaryError===null?null:String(row.secondaryError),
      limitedByMaxPages:!!row.limitedByMaxPages,
      error:row.error===null?null:String(row.error)
    });
    const rows=this.db.prepare(`SELECT scope,watch_id AS watchId,query,
      finished_at AS finishedAt,api_calls AS apiCalls,pages,result_count AS resultCount,
      new_count AS newCount,recent_count AS recentCount,older_count AS olderCount,
      unknown_count AS unknownCount,secondary_used AS secondaryUsed,
      secondary_error AS secondaryError,
      limited_by_max_pages AS limitedByMaxPages,error
      FROM search_runs ORDER BY id DESC LIMIT 12`).all() as Record<string,unknown>[];
    const sums=this.db.prepare(`SELECT
      COALESCE(sum(api_calls),0) AS apiCalls,
      COALESCE(sum(pages),0) AS pages,
      COALESCE(sum(new_count),0) AS newCount,
      COALESCE(sum(recent_count),0) AS recentCount,
      COALESCE(sum(older_count),0) AS olderCount,
      COALESCE(sum(unknown_count),0) AS unknownCount,
      COALESCE(sum(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END),0) AS failures,
      count(*) AS scans
      FROM search_runs WHERE finished_at >= ?`).get(start) as Record<string,number>;
    return {
      last:rows.length?decode(rows[0]):null,
      last24h:{
        apiCalls:sums.apiCalls,pages:sums.pages,newCount:sums.newCount,
        recentCount:sums.recentCount,olderCount:sums.olderCount,
        unknownCount:sums.unknownCount,failures:sums.failures,scans:sums.scans
      },
      recentRuns:rows.map(decode)
    };
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
