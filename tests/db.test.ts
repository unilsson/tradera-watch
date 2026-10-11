import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import type { Listing } from '../src/server/tradera.js';

const listing: Listing = {
  id:1,categoryId:181806,title:'Carcassonne',price:100,
  buyNowPrice:null,imageUrl:null,url:'https://www.tradera.com/item/181806/1',
  startsAt:null,endsAt:null
};
test('first successful scan is a baseline; later discoveries are new', () => {
  const store = new Store(':memory:');
  try {
    const first = store.saveScan([listing],'2026-10-11T12:00:00Z');
    assert.equal(first.baseline,true);
    assert.equal(store.stats().newItems,0);
    const second = store.saveScan([{...listing,price:120}, {...listing,id:2,title:'Azul'}],
      '2026-10-11T12:05:00Z');
    assert.equal(second.added,1);
    assert.equal(second.baseline,false);
    assert.equal(store.stats().total,2);
    assert.equal(store.stats().newItems,1);
    assert.deepEqual(store.list(1,10,true).items.map(i=>i.id),[2]);
    assert.equal(store.list(1,10).items.find(i=>i.id===1)?.price,120);
    assert.equal(store.list(1,10).items.find(i=>i.id===1)?.firstSeenAt,'2026-10-11T12:00:00Z');
    const third = store.saveScan([listing],'2026-10-11T12:10:00Z');
    assert.equal(third.added,0);
  } finally {store.close();}
});
