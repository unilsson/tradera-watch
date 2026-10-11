import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { Monitor } from '../src/server/monitor.js';
import type { Listing } from '../src/server/tradera.js';
import type { Config } from '../src/server/config.js';

const item: Listing = {
  id:1,categoryId:181806,title:'Terraforming Mars – ny utgåva',price:250,
  buyNowPrice:null,imageUrl:null,
  url:'https://www.tradera.com/item/181806/1/terraforming-mars',
  startsAt:null,endsAt:null
};
test('watch baseline and newly observed matches are independent of category history',()=>{
  const store = new Store(':memory:');
  try {
    store.saveScan([item],'2026-10-11T12:00:00Z');
    const watch = store.createWatch({term:'Terraforming Mars',maxPrice:300});
    assert.equal(watch.initialized,false);
    const baseline = store.saveWatchScan(watch.id,[item],'2026-10-11T12:01:00Z');
    assert.deepEqual(baseline,{matched:1,added:1,baseline:true});
    assert.equal(store.getWatch(watch.id)?.newCount,0);
    const second = store.saveWatchScan(watch.id,[item,{...item,id:2,price:260}],
      '2026-10-11T12:06:00Z');
    assert.deepEqual(second,{matched:2,added:1,baseline:false});
    assert.deepEqual(store.list(1,10,true,watch.id).items.map(i=>i.id),[2]);
    assert.equal(store.list(1,10,false,watch.id).total,2);
    assert.equal(store.list(1,10).total,2);
    assert.equal(store.list(1,10,false,watch.id).items.find(i=>i.id===1)?.firstSeenAt,
      '2026-10-11T12:01:00Z');
    assert.equal(store.setWatchEnabled(watch.id,false)?.enabled,false);
    assert.equal(store.setWatchEnabled(watch.id,true)?.enabled,true);
    assert.equal(store.deleteWatch(watch.id),true);
    assert.equal(store.getWatch(watch.id),null);
    assert.equal(store.list(1,10).total,2); // Deleting a watch preserves listings.
  } finally {store.close();}
});
test('watch limit and identical criteria',()=>{
  const store=new Store(':memory:');
  try {
    store.createWatch({term:'Azul',maxPrice:null});
    assert.throws(()=>store.createWatch({term:'azul',maxPrice:null}),/identisk/);
    for (let i=1;i<8;i++) store.createWatch({term:'Spel'+i,maxPrice:50*i});
    assert.throws(()=>store.createWatch({term:'Spel 9',maxPrice:null}),/åtta/);
  } finally {store.close();}
});
test('monitor searches by watch term and only stores locally matching titles under budget',async()=>{
  const store=new Store(':memory:');
  try {
    const watch=store.createWatch({term:'Terraforming Mars',maxPrice:300});
    const calls:string[]=[];
    const config:Config={
      appId:'1',appKey:'key',categoryId:181806,query:'',orderBy:'EndDateDescending',
      intervalSeconds:300,maxPages:3,dataDir:'.',port:3001
    };
    const fetcher=async (cfg:Config):Promise<Listing[]>=>{
      calls.push(cfg.query);
      if (!cfg.query) return [];
      return [item,{...item,id:2,price:400},{...item,id:3,title:'Catan',price:100}];
    };
    const monitor=new Monitor(config,store,fetcher);
    await monitor.scan();
    assert.deepEqual(calls,['','Terraforming Mars']);
    assert.equal(store.getWatch(watch.id)?.matchedCount,1);
    assert.equal(store.getWatch(watch.id)?.newCount,0);
    await monitor.scan();
    assert.equal(store.getWatch(watch.id)?.matchedCount,1);
    assert.equal(monitor.lastError,null);
  } finally {store.close();}
});
test('failed watch polling does not initialize watch baseline',async()=>{
  const store=new Store(':memory:');
  try {
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    const config:Config={appId:'1',appKey:'key',categoryId:181806,query:'',
      orderBy:'EndDateDescending',intervalSeconds:300,maxPages:3,dataDir:'.',port:3001};
    const monitor=new Monitor(config,store,async cfg=>{
      if (cfg.query) throw new Error('HTTP 429');
      return [];
    });
    await monitor.scan();
    assert.equal(store.getWatch(watch.id)?.initialized,false);
    assert.match(store.getWatch(watch.id)?.lastError||'',/429/);
    assert.match(monitor.lastError||'',/429/);
  } finally {store.close();}
});
