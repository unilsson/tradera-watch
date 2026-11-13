import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchItemDetail,interpretItemDetail,ItemLookupError} from '../src/server/item-lifecycle.js';
import type {Config} from '../src/server/config.js';

const config:Config={appId:'123',appKey:'demo-key',categoryId:181806,
  query:'',orderBy:'EndDateDescending',maxPages:1,intervalSeconds:300,
  dataDir:'.',port:3001};
const detail=(ended:boolean,winner:boolean|null,type=1)=>({
  id:456, itemType:type,endDate:'2026-11-12T12:00:00Z',
  status:{ended,gotWinner:winner}
});
test('interprets explicit Tradera ended and winner flags conservatively',()=>{
  assert.equal(interpretItemDetail(detail(false,false),456).state,'active');
  assert.equal(interpretItemDetail(detail(true,true),456).state,'sold');
  assert.equal(interpretItemDetail(detail(true,false),456).state,'unsold');
  assert.equal(interpretItemDetail(detail(true,false,3),456).state,'ended');
  assert.equal(interpretItemDetail(detail(true,null),456).state,'ended');
  assert.equal(interpretItemDetail({Id:456,ItemType:1,Status:{Ended:true,GotWinner:true}},456).state,'sold');
  assert.throws(()=>interpretItemDetail(detail(true,true),22),/annons-ID/);
  assert.throws(()=>interpretItemDetail({id:456,status:{gotWinner:true}},456),/ended-status/);
  assert.throws(()=>interpretItemDetail({id:456},456),/statusinformation/);
});
test('GET detail uses only app credentials, reads status, and never needs a user token',async()=>{
  const calls:string[]=[];
  const request=(async(input:string|URL|Request,options?:RequestInit)=>{
    const url=String(input);
    calls.push(url);
    assert.equal(url,'https://api.tradera.com/v4/items/456');
    assert.equal((options?.headers as Record<string,string>)['X-App-Id'],'123');
    assert.equal((options?.headers as Record<string,string>)['X-App-Key'],'demo-key');
    assert.ok(!('X-User-Token' in (options?.headers as Record<string,string>)));
    return new Response(JSON.stringify(detail(true,true)),{status:200});
  }) as typeof fetch;
  assert.equal((await fetchItemDetail(config,456,request)).state,'sold');
  assert.equal(calls.length,1);
  await assert.rejects(()=>fetchItemDetail(config,456,
    (async()=>new Response(null,{status:429})) as typeof fetch),
    (error:unknown)=>{assert.ok(error instanceof ItemLookupError);
      assert.equal(error.httpStatus,429);return true;});
  await assert.rejects(()=>fetchItemDetail(config,456,
    (async()=>new Response(null,{status:404})) as typeof fetch),/404/);
  await assert.rejects(()=>fetchItemDetail(config,-1,request),/annons-ID/);
});
