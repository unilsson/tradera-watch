import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/server/db.js';
import {Monitor} from '../src/server/monitor.js';
import {ItemLookupError} from '../src/server/item-lifecycle.js';
import type {Listing} from '../src/server/tradera.js';
import type {Config} from '../src/server/config.js';

const now='2026-11-13T12:00:00.000Z';
const item=(id:number,endsAt:string|null=null):Listing=>({
  id,categoryId:181806,title:'Azul '+id,price:200,buyNowPrice:null,
  imageUrl:null,url:'https://www.tradera.com/item/181806/'+id+'/azul',
  startsAt:'2026-02-01T12:00:00.000Z',endsAt
});
const settings={listingRetentionDays:90,staleListingDays:180,
  searchHistoryDays:30,scanHistoryDays:30,notificationHistoryDays:30};

test('active default filters ended dates even before detail lookup; archive remains available',()=>{
  const store=new Store(':memory:');
  try{
    const past=item(1,'2026-11-11T10:00:00Z');
    const future=item(2,'2026-12-03T10:00:00Z');
    const noDate=item(3);
    store.saveScan([past,future,noDate],now);
    assert.deepEqual(store.list(1,10,false,undefined,'active',now).items.map(i=>i.id),[3,2]);
    assert.deepEqual(store.list(1,10,false,undefined,'ended',now).items.map(i=>i.id),[1]);
    assert.equal(store.list(1,10,false,undefined,'all',now).total,3);
    assert.deepEqual(store.statusCheckCandidates(5,now),[1]);
    store.applyItemDetail(1,{state:'sold',endsAt:past.endsAt,gotWinner:true},now);
    assert.equal(store.list(1,10,false,undefined,'ended',now).items[0].lifecycleStatus,'sold');
    assert.deepEqual(store.statusCheckCandidates(5,now),[]);
    assert.equal(store.stats(now).activeItems,2);
    assert.equal(store.stats(now).endedItems,1);
  }finally{store.close();}
});

test('404 means unavailable, transient failure remains unresolved and throttled',()=>{
  const store=new Store(':memory:');
  try {
    store.saveScan([item(1,'2026-11-11T12:00:00Z'),
      item(2,'2026-11-11T12:00:00Z')],now);
    store.itemStatusFailed(1,'Tradera detaljanrop HTTP 404',now,true);
    store.itemStatusFailed(2,'Tradera detaljanrop HTTP 429',now,false);
    assert.equal(store.list(1,10,false,undefined,'ended',now).total,2);
    assert.equal(store.list(1,10,false,undefined,'ended',now).items[1].lifecycleStatus,'unavailable');
    assert.deepEqual(store.statusCheckCandidates(2,now),[]);
    const later='2026-11-14T13:00:00.000Z';
    assert.deepEqual(store.statusCheckCandidates(2,later),[2]);
  }finally{store.close();}
});

test('daily cleanup removes old closed and stale unknown listings, but preserves future/known active',()=>{
  const store=new Store(':memory:');
  try{
    const past='2026-04-01T12:00:00.000Z';
    const future='2027-03-01T12:00:00.000Z';
    store.saveScan([item(1,past),item(2,past),item(3,future),item(4),item(5,past),
      item(6,'2026-11-12T12:00:00.000Z')],'2026-03-01T12:00:00.000Z');
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[],'2026-03-01T12:00:00.000Z',true,true);
    store.saveWatchScan(watch.id,[item(2,past)],'2026-03-03T12:00:00.000Z',true,true);
    assert.equal(store.notificationStats().pending,1);
    assert.equal(store.discordStats().pending,1);
    store.applyItemDetail(1,{state:'sold',endsAt:past,gotWinner:true},
      '2026-04-03T12:00:00.000Z');
    store.applyItemDetail(2,{state:'unsold',endsAt:past,gotWinner:false},
      '2026-04-03T12:00:00.000Z');
    // Item 5 was verified active despite its old end date. A refreshed later
    // endDate from the detail endpoint protects it from stale cleanup.
    store.applyItemDetail(5,{state:'active',endsAt:future,gotWinner:false},
      '2026-11-10T12:00:00.000Z');
    store.applyItemDetail(6,{state:'ended',endsAt:'2026-11-12T12:00:00.000Z',
      gotWinner:null},'2026-11-13T12:00:00.000Z');
    const result=store.maintain(now,settings);
    assert.ok(result);
    assert.equal(result.items,2); // Sold #1 and stale unknown #4.
    assert.deepEqual(store.list(1,20,false,undefined,'all',now).items.map(i=>i.id).sort((a,b)=>a-b),[2,3,5,6]);
    assert.equal(store.notificationStats().pending,1);
    assert.equal(store.discordStats().pending,1);
    assert.equal(store.maintain('2026-11-13T15:00:00.000Z',settings),null);
    const pendingPush=store.nextNotification(now);
    const pendingDiscord=store.nextDiscordNotification(now);
    assert.ok(pendingPush && pendingDiscord);
    store.notificationSent(pendingPush.id,'2026-04-03T12:00:00.000Z');
    store.discordSent(pendingDiscord.id,'2026-04-03T12:00:00.000Z');
    const again=store.maintain('2026-11-15T12:00:00.000Z',settings);
    assert.equal(again?.items,1); // #2 is no longer protected by pending pushes.
    assert.equal(store.getWatch(watch.id)?.initialized,true);
    assert.equal(store.list(1,20,false,undefined,'all',now).total,3);
  }finally{store.close();}
});

test('monitor details checks are capped and refresh listing states without extra search pagination',async()=>{
  const store=new Store(':memory:');
  try{
    const past=new Date(Date.now()-60000).toISOString();
    const calls:number[]=[];
    const cfg:Config={appId:'1',appKey:'key',categoryId:181806,query:'',
      orderBy:'EndDateDescending',maxPages:1,intervalSeconds:300,dataDir:'.',port:3001,
      statusChecksPerScan:1};
    const fetcher=async():Promise<Listing[]>=>[item(45,past),item(46,past)];
    const details=async (_cfg:Config,id:number)=>{
      calls.push(id);
      return {state:'sold' as const,gotWinner:true,endsAt:past};
    };
    const monitor=new Monitor(cfg,store,fetcher,undefined,undefined,details);
    await monitor.scan();
    assert.deepEqual(calls,[45]);
    assert.equal(store.stats().endedItems,2);
    assert.equal(monitor.checkedLastScan,1);
    await monitor.scan();
    assert.deepEqual(calls,[45,46]); // Already-confirmed item isn't checked again.
    assert.equal(store.list(1,10,false,undefined,'ended').items.filter(i=>i.lifecycleStatus==='sold').length,2);
  }finally{store.close();}
});

test('monitor stops lookups on 429 and reports safe error',async()=>{
  const store=new Store(':memory:');
  try{
    const past=new Date(Date.now()-60000).toISOString();
    const cfg:Config={appId:'1',appKey:'key',categoryId:181806,query:'',
      orderBy:'EndDateDescending',maxPages:1,intervalSeconds:300,dataDir:'.',port:3001,
      statusChecksPerScan:4};
    let attempts=0;
    const monitor=new Monitor(cfg,store,async()=>[item(1,past),item(2,past)],
      undefined,undefined,async()=>{
        attempts++;throw new ItemLookupError(429,'Tradera detaljanrop HTTP 429');
      });
    await monitor.scan();
    assert.equal(attempts,1);
    assert.equal(monitor.checkedLastScan,1);
    assert.match(monitor.lastStatusError??'',/429/);
    assert.deepEqual(store.statusCheckCandidates(4,new Date().toISOString(),24).length,1);
  }finally{store.close();}
});
