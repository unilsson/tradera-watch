import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/server/db.js';
import {Monitor} from '../src/server/monitor.js';
import {fetchListings} from '../src/server/tradera.js';
import type {Config} from '../src/server/config.js';
import type {Listing} from '../src/server/tradera.js';

const item=(id:number,startsAt:string|null):Listing=>({
  id,categoryId:181806,title:'Azul',price:125,buyNowPrice:null,imageUrl:null,
  url:'https://www.tradera.com/item/181806/'+id+'/azul',startsAt,endsAt:null
});
const env:Config={
  appId:'12',appKey:'test',categoryId:181806,query:'',
  orderBy:'EndDateDescending',intervalSeconds:3600,maxPages:1,
  secondaryEvery:1,secondaryPages:1,dataDir:'.',port:3001
};
test('search telemetry and start-age counts preserve watch baselines',()=>{
  const store=new Store(':memory:');
  try {
    const now='2026-10-11T12:00:00Z';
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    const baseline=store.saveWatchScan(watch.id,[item(1,now)],now);
    assert.equal(baseline.baseline,true);
    assert.deepEqual(store.discoveredCounts('watch',now,watch.id),
      {recent:0,older:0,unknown:0});
    const next='2026-10-11T13:00:00Z';
    store.saveWatchScan(watch.id,[
      item(1,now),item(2,'2026-10-11T12:00:00Z'),
      item(3,'2026-10-01T12:00:00Z'),item(4,null)
    ],next);
    assert.deepEqual(store.discoveredCounts('watch',next,watch.id),
      {recent:1,older:1,unknown:1});
    store.recordSearchRun({
      scope:'watch',watchId:watch.id,query:'Azul',
      finishedAt:next,apiCalls:2,pages:2,resultCount:4,
      newCount:3,recentCount:1,olderCount:1,unknownCount:1,
      secondaryUsed:true,secondaryError:null,limitedByMaxPages:false,error:null
    });
    const stats=store.searchStats('2026-10-11T13:30:00Z');
    assert.equal(stats.last24h.apiCalls,2);
    assert.equal(stats.last24h.recentCount,1);
    assert.equal(stats.last?.secondaryUsed,true);
    assert.equal(store.list(1,10,true,watch.id).total,3);
    assert.equal(store.list(1,10,true,watch.id).items.find(it=>it.id===3)?.discoveryAge,'older');
  } finally{store.close();}
});
test('Sprint 3 database migrates to telemetry with no loss of items or queued pushes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tradera-sprint4a-'));
  const path=join(dir,'test.sqlite');
  try {
    let store=new Store(path);
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveScan([item(1,'2026-10-10T12:00:00Z')],'2026-10-11T11:00:00Z');
    store.saveWatchScan(watch.id,[], '2026-10-11T11:00:00Z',true);
    store.saveWatchScan(watch.id,[item(1,'2026-10-10T12:00:00Z')],
      '2026-10-11T12:00:00Z',true);
    assert.equal(store.notificationStats().pending,1);
    store.close();
    store=new Store(path);
    try{
      assert.equal(store.list().total,1);
      assert.equal(store.notificationStats().pending,1);
      assert.equal(store.getWatch(watch.id)?.matchedCount,1);
      assert.equal(store.searchStats().recentRuns.length,0);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('monitor runs primary plus opposite sort, measures calls and protects Pushover watches',async()=>{
  const store=new Store(':memory:');
  try {
    store.createWatch({term:'Azul',maxPrice:null});
    const calls:string[]=[];
    const fake=(async(input:string|URL|Request)=>{
      const url=new URL(String(input));
      calls.push((url.searchParams.get('query')||'category')+':'+url.searchParams.get('orderBy'));
      const secondary=url.searchParams.get('orderBy')==='EndDateAscending';
      return new Response(JSON.stringify({items:secondary
        ? [{id:2,title:'Azul'}] : [{id:1,title:'Azul'}],totalNumberOfPages:1}),{status:200});
    }) as typeof fetch;
    const monitor=new Monitor(env,store,async(config,_,opts)=>fetchListings(config,fake,opts));
    await monitor.scan();
    assert.deepEqual(calls,[
      'category:EndDateDescending','category:EndDateAscending',
      'Azul:EndDateDescending','Azul:EndDateAscending'
    ]);
    assert.equal(store.list().total,2);
    assert.equal(store.getWatch(1)?.matchedCount,2);
    assert.equal(store.searchStats().last24h.apiCalls,4);
    assert.equal(store.searchStats().last24h.scans,2);
    assert.equal(store.notificationStats().pending,0);
  }finally{store.close();}
});
test('budget automatically skips secondary when estimated call volume is excessive',async()=>{
  const store=new Store(':memory:');
  try{
    const config={...env,intervalSeconds:60,maxPages:20};
    const monitor=new Monitor(config,store,async()=>[]);
    assert.ok(monitor.estimatedRequestsPerDay>9000);
    assert.equal(monitor.secondarySearchEnabled,false);
    assert.match(monitor.searchWarning??'',/avstängd/);
  }finally{store.close();}
});
