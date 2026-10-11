import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/server/db.js';
import type {Listing} from '../src/server/tradera.js';
const item=(id:number,title:string,price:number):Listing=>({
  id,categoryId:181806,title,price,buyNowPrice:null,
  imageUrl:null,url:'https://www.tradera.com/item/181806/'+id+'/spel',
  startsAt:null,endsAt:null,itemType:1
});

test('Sprint 4A SQLite watches migrate without changing existing criteria or Pushover queue',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tradera-4b-'));
  const path=join(dir,'old.sqlite');
  try {
    // Build a database with the same watches table shape as Sprint 4A.
    const db=new DatabaseSync(path);
    db.exec(`CREATE TABLE watches(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL COLLATE NOCASE,
      max_price INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      initialized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_scanned_at TEXT,last_error TEXT);
    INSERT INTO watches(id,term,max_price,initialized,created_at)
      VALUES(7,'Catan',300,1,'2026-10-11T12:00:00Z');`);
    db.close();
    const store=new Store(path);
    try {
      const watch=store.getWatch(7);
      assert.ok(watch);
      assert.equal(watch.minPrice,null);
      assert.equal(watch.maxPrice,300);
      assert.deepEqual(watch.excludeWords,[]);
      assert.equal(watch.listingType,'all');
      assert.equal(watch.initialized,true);
      assert.equal(store.getWatch(7)?.term,'Catan');
      store.createWatch({term:'Azul',maxPrice:200});
      assert.equal(store.listWatches().length,2);
    } finally {store.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('editing criteria resets watch baseline/outbox, not global items',()=>{
  const store=new Store(':memory:');
  try {
    const watch=store.createWatch({term:'Catan',maxPrice:300});
    store.saveWatchScan(watch.id,[item(1,'Catan grundspel',120)],
      '2026-10-11T12:00:00Z',true);
    store.saveWatchScan(watch.id,[item(1,'Catan grundspel',120),item(2,'Catan expansion',150)],
      '2026-10-11T12:05:00Z',true);
    assert.equal(store.notificationStats().pending,1);
    assert.equal(store.getWatch(watch.id)?.matchedCount,2);
    const edited=store.updateWatch(watch.id,{
      term:'Catan',minPrice:50,maxPrice:250,
      excludeWords:['expansion'],listingType:'auction'
    });
    assert.ok(edited);
    assert.equal(edited.initialized,false);
    assert.equal(store.getWatch(watch.id)?.matchedCount,0);
    assert.equal(store.notificationStats().pending,0);
    assert.equal(store.list().total,2);
    const fresh=store.saveWatchScan(watch.id,[item(1,'Catan grundspel',120),
      item(2,'Catan expansion',150)],'2026-10-11T12:10:00Z',true);
    assert.deepEqual(fresh,{matched:1,added:1,baseline:true});
    assert.equal(store.notificationStats().pending,0);
    const later=store.saveWatchScan(watch.id,[item(1,'Catan grundspel',120),
      item(3,'Catan grundspel',170)],'2026-10-11T12:15:00Z',true);
    assert.equal(later.added,1);
    assert.equal(store.notificationStats().pending,1);
    assert.equal(store.getWatch(watch.id)?.matchedCount,2);
    assert.equal(store.list().total,3);
  } finally {store.close();}
});
test('editing with same criteria does not reset the baseline',()=>{
  const store=new Store(':memory:');
  try{
    const watch=store.createWatch({term:'Azul',maxPrice:200});
    store.saveWatchScan(watch.id,[item(1,'Azul',100)],'2026-10-11T12:00:00Z',true);
    const original=store.updateWatch(watch.id,{term:'Azul',maxPrice:200});
    assert.equal(original?.initialized,true);
    assert.equal(original?.matchedCount,1);
  } finally {store.close();}
});
test('distinct watch filters coexist but identical filters are rejected',()=>{
  const store=new Store(':memory:');
  try{
    store.createWatch({term:'Catan',maxPrice:200,excludeWords:['expansion']});
    store.createWatch({term:'Catan',maxPrice:200,excludeWords:['reservdelar']});
    assert.throws(()=>store.createWatch({term:'CATAN',maxPrice:200,excludeWords:['EXPANSION']}),/identisk/);
  } finally {store.close();}
});
