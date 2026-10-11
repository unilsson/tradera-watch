import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/server/db.js';
import {DiscordWorker} from '../src/server/discord-worker.js';
import {DiscordDeliveryError} from '../src/server/discord.js';
import type {Config} from '../src/server/config.js';
import type {Listing} from '../src/server/tradera.js';

const webhook='https://discord.com/api/webhooks/123456789012345678/secret-ABcd_123';
const cfg:Config={appId:'1',appKey:'key',categoryId:181806,query:'',
  orderBy:'EndDateDescending',maxPages:1,intervalSeconds:300,
  dataDir:'.',port:3001,discordWebhookUrl:webhook};
const item=(id:number):Listing=>({
  id,categoryId:181806,title:'Azul spel '+id,price:100,
  buyNowPrice:null,imageUrl:null,
  url:'https://www.tradera.com/item/181806/'+id+'/azul',
  startsAt:null,endsAt:null
});

test('Discord queue is independent, ignores baseline, and does not flood on first enable',()=>{
  const store=new Store(':memory:');
  try{
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[item(1)],'2026-10-11T12:00:00Z',false,true);
    assert.equal(store.discordStats().pending,0);
    store.saveWatchScan(watch.id,[item(1),item(2)],'2026-10-11T12:05:00Z',false,false);
    assert.equal(store.discordStats().pending,0);
    // Enabling Discord later does not backfill past matches.
    store.saveWatchScan(watch.id,[item(1),item(2),item(3)],'2026-10-11T12:10:00Z',false,true);
    assert.equal(store.discordStats().pending,1);
    assert.equal(store.notificationStats().pending,0);
    store.saveWatchScan(watch.id,[item(3)],'2026-10-11T12:15:00Z',false,true);
    assert.equal(store.discordStats().pending,1);
    store.saveWatchScan(watch.id,[item(4)],'2026-10-11T12:20:00Z',true,true);
    assert.equal(store.discordStats().pending,2);
    assert.equal(store.notificationStats().pending,1);
    store.setWatchEnabled(watch.id,false);
    assert.equal(store.nextDiscordNotification('2026-10-12T12:00:00Z'),null);
    store.setWatchEnabled(watch.id,true);
    assert.ok(store.nextDiscordNotification('2026-10-12T12:00:00Z'));
    store.deleteWatch(watch.id);
    assert.equal(store.discordStats().pending,0);
    assert.equal(store.notificationStats().pending,0);
    assert.equal(store.list().total,4);
  }finally{store.close();}
});

test('persistent Discord queue survives restarts and is delivered only once when acknowledged',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tradera-discord-'));
  const path=join(dir,'app.sqlite');
  try {
    let store=new Store(path);
    const watch=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(watch.id,[],'2026-10-11T12:00:00Z',false,true);
    store.saveWatchScan(watch.id,[item(2)],'2026-10-11T12:05:00Z',false,true);
    store.close();
    store=new Store(path);
    try{
      const messages:string[]=[];
      const worker=new DiscordWorker(cfg,store,async(_url,msg)=>{messages.push(msg.title);});
      await worker.flush();
      assert.deepEqual(messages,['Azul spel 2']);
      assert.deepEqual(store.discordStats(),{pending:0,sent:1,lastError:null});
      await worker.flush();
      assert.equal(messages.length,1);
      assert.equal(store.notificationStats().sent,0);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Discord rate limiting is retried and stops the current dispatch batch',async()=>{
  const store=new Store(':memory:');
  try {
    const w=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(w.id,[],'2026-10-11T12:00:00Z',false,true);
    const prior=new Date(Date.now()-3000).toISOString();
    store.saveWatchScan(w.id,[item(1),item(2)],prior,false,true);
    let attempts=0;
    const worker=new DiscordWorker(cfg,store,async()=>{
      attempts++;
      if(attempts===1)throw new DiscordDeliveryError(429,'Discord HTTP 429',120);
    });
    await worker.flush();
    assert.equal(attempts,1);
    assert.equal(store.discordStats().pending,2);
    assert.match(store.discordStats().lastError??'',/429/);
    // The other queued item is still immediately due, but the rate-limited
    // one must wait. They are therefore recovered in two separate flushes.
    await worker.flush();
    assert.equal(attempts,2);
    assert.equal(store.discordStats().pending,1);
    const delayed=store.nextDiscordNotification(new Date(Date.now()+125000).toISOString());
    assert.ok(delayed);
    store.discordFailed(delayed.id,'resume',new Date(Date.now()-1000).toISOString());
    await worker.flush();
    assert.equal(attempts,3);
    assert.equal(store.discordStats().pending,0);
    assert.equal(store.discordStats().sent,2);
  }finally{store.close();}
});

test('editing a watch clears Discord and Pushover queues while retaining global listings',()=>{
  const store=new Store(':memory:');
  try{
    const w=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(w.id,[],'2026-10-11T12:00:00Z',true,true);
    store.saveWatchScan(w.id,[item(1)],'2026-10-11T12:05:00Z',true,true);
    assert.equal(store.discordStats().pending,1);
    assert.equal(store.notificationStats().pending,1);
    const edited=store.updateWatch(w.id,{term:'Azul',maxPrice:150,excludeWords:['expansion']});
    assert.equal(edited?.initialized,false);
    assert.equal(store.discordStats().pending,0);
    assert.equal(store.notificationStats().pending,0);
    assert.equal(store.list().total,1);
    store.saveWatchScan(w.id,[item(1)],'2026-10-11T12:10:00Z',true,true);
    assert.equal(store.discordStats().pending,0);
  }finally{store.close();}
});

test('migrates an older SQLite database without Discord table without disturbing Pushover',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tradera-discord-migrate-'));
  const path=join(dir,'app.sqlite');
  try{
    let store=new Store(path);
    const w=store.createWatch({term:'Azul',maxPrice:null});
    store.saveWatchScan(w.id,[],'2026-10-11T12:00:00Z',true,false);
    store.saveWatchScan(w.id,[item(1)],'2026-10-11T12:05:00Z',true,false);
    store.close();
    const old=new DatabaseSync(path);
    old.exec('DROP TABLE discord_outbox');
    old.close();
    store=new Store(path);
    try{
      assert.equal(store.notificationStats().pending,1);
      assert.equal(store.discordStats().pending,0);
      assert.equal(store.list().total,1);
      assert.equal(store.getWatch(w.id)?.initialized,true);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Discord test message and configuration are independent of Pushover',async()=>{
  const store=new Store(':memory:');
  try{
    let sent=0;
    const worker=new DiscordWorker(cfg,store,async()=>{sent++;});
    assert.equal(worker.enabled,true);
    await worker.sendTest();
    assert.equal(sent,1);
    await assert.rejects(()=>worker.sendTest(),/Vänta en minut/);
    const disabled=new DiscordWorker({...cfg,discordWebhookUrl:''},store,async()=>{});
    assert.equal(disabled.enabled,false);
    await assert.rejects(()=>disabled.sendTest(),/inte konfigurerat/);
    const invalid=new DiscordWorker({...cfg,discordWebhookUrl:'https://example.org/secret'},store,async()=>{});
    assert.equal(invalid.enabled,false);
    assert.match(invalid.configurationError??'',/ogiltig/);
  }finally{store.close();}
});
