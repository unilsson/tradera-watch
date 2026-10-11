import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { NotificationWorker } from '../src/server/notifications.js';
import { PushoverError } from '../src/server/pushover.js';
import type { Config } from '../src/server/config.js';
import type { Listing } from '../src/server/tradera.js';

const config:Config={
  appId:'1',appKey:'key',categoryId:181806,query:'',orderBy:'EndDateDescending',
  intervalSeconds:300,maxPages:3,dataDir:'.',port:3001,
  pushoverToken:'pushover-test-token',pushoverUser:'pushover-test-user'
};
const item:Listing={
  id:10,categoryId:181806,title:'Azul',price:100,buyNowPrice:null,
  imageUrl:null,url:'https://www.tradera.com/item/181806/10/azul',startsAt:null,endsAt:null
};
test('Pushover queue is added only for new post-baseline watch matches',()=>{
  const store=new Store(':memory:');
  try{
    const watch=store.createWatch({term:'Azul',maxPrice:200});
    store.saveWatchScan(watch.id,[item],'2026-10-11T10:00:00Z',true);
    assert.equal(store.notificationStats().pending,0); // No initial backlog!
    store.saveWatchScan(watch.id,[item,{...item,id:11}],
      '2026-10-11T10:05:00Z',true);
    assert.equal(store.notificationStats().pending,1);
    store.saveWatchScan(watch.id,[item,{...item,id:11}],
      '2026-10-11T10:10:00Z',true);
    assert.equal(store.notificationStats().pending,1); // No duplicates across scans.
    store.saveWatchScan(watch.id,[item,{...item,id:11},{...item,id:12}],
      '2026-10-11T10:15:00Z',false);
    assert.equal(store.notificationStats().pending,1); // Pushover disabled.
    store.deleteWatch(watch.id);
    assert.equal(store.notificationStats().pending,0); // Deleted watch cancels pending.
    assert.equal(store.list().total,3); // Existing listings are unaffected.
  } finally{store.close();}
});
test('pending pushes survive restart and each item is delivered once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tradera-push-'));
  const path=join(dir,'test.sqlite');
  try{
    let store=new Store(path);
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[item],'2026-10-11T10:00:00Z',true);
    const newItem={...item,id:11,title:'Azul Mini'};
    store.saveWatchScan(watch.id,[newItem],'2026-10-11T10:05:00Z',true);
    store.close();
    store=new Store(path);
    try{
      assert.equal(store.notificationStats().pending,1);
      const messages:string[]=[];
      const worker=new NotificationWorker(config,store,async (_credentials,message)=>{
        messages.push(message.message);
      });
      await worker.flush();
      assert.equal(messages.length,1);
      assert.match(messages[0],/Azul Mini/);
      assert.deepEqual(store.notificationStats(),{pending:0,sent:1,lastError:null});
      await worker.flush();
      assert.equal(messages.length,1);
      store.saveWatchScan(watch.id,[newItem],'2026-10-11T10:10:00Z',true);
      await worker.flush();
      assert.equal(messages.length,1);
    } finally{store.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('Pushover failure is persisted and backed off, then later retry succeeds',async()=>{
  const store=new Store(':memory:');
  try{
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[],'2026-10-11T10:00:00Z',true);
    store.saveWatchScan(watch.id,[item],new Date(Date.now()-5000).toISOString(),true);
    let attempts=0;
    const worker=new NotificationWorker(config,store,async()=>{
      attempts++;
      if(attempts===1)throw new PushoverError(429,'Pushover HTTP 429',120);
    });
    await worker.flush();
    assert.equal(attempts,1);
    assert.equal(store.notificationStats().pending,1);
    assert.match(store.notificationStats().lastError||'',/429/);
    assert.equal(store.nextNotification(),null); // Backoff is enforced.
    const due=store.nextNotification(new Date(Date.now()+125000).toISOString());
    assert.ok(due);
    store.notificationFailed(due.id,'reset retry',new Date(Date.now()-1000).toISOString());
    await worker.flush();
    assert.equal(attempts,2);
    assert.equal(store.notificationStats().sent,1);
  } finally{store.close();}
});
test('disabled watch is excluded from pending deliveries until reenabled',()=>{
  const store=new Store(':memory:');
  try{
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[],'2026-10-11T10:00:00Z',true);
    store.saveWatchScan(watch.id,[item],new Date(Date.now()-1000).toISOString(),true);
    assert.ok(store.nextNotification());
    store.setWatchEnabled(watch.id,false);
    assert.equal(store.nextNotification(),null);
    store.setWatchEnabled(watch.id,true);
    assert.ok(store.nextNotification());
  } finally{store.close();}
});
test('test push requires configuration and is rate-limited',async()=>{
  const store=new Store(':memory:');
  try{
    const worker=new NotificationWorker(config,store,async()=>{});
    await worker.sendTest();
    await assert.rejects(()=>worker.sendTest(),/Vänta en minut/);
    const disabled=new NotificationWorker({...config,pushoverToken:''},store,async()=>{});
    await assert.rejects(()=>disabled.sendTest(),/inte konfigurerat/);
  } finally{store.close();}
});
