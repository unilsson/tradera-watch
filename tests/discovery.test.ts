import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoveryAge,classifyDiscovered} from '../src/shared/discovery.js';
import {fetchListings,searchDiagnostics} from '../src/server/tradera.js';
import type {Config} from '../src/server/config.js';
const config:Config={
  appId:'123',appKey:'app-key',query:'Azul',categoryId:181806,
  orderBy:'EndDateDescending',maxPages:2,intervalSeconds:300,port:3001,dataDir:'.'
};
test('age is assessed at discovery time, never when dashboard opens',()=>{
  const seen='2026-10-11T15:00:00Z';
  assert.equal(discoveryAge('2026-10-10T15:00:00Z',seen),'recent');
  assert.equal(discoveryAge('2026-10-10T14:59:59Z',seen),'older');
  assert.equal(discoveryAge('2026-10-11T15:00:01Z',seen),'unknown');
  assert.equal(discoveryAge(null,seen),'unknown');
  assert.equal(discoveryAge('not a time',seen),'unknown');
  assert.deepEqual(classifyDiscovered([
    {startsAt:'2026-10-11T12:00:00Z'},
    {startsAt:'2026-10-01T12:00:00Z'},
    {startsAt:null}],seen),{recent:1,older:1,unknown:1});
});
test('dual sort adds IDs missed by primary, removes duplicates, counts requests',async()=>{
  const calls:string[]=[];
  const diag=searchDiagnostics();
  const request=(async(input:string|URL|Request)=>{
    const url=new URL(String(input));
    const sort=url.searchParams.get('orderBy')!;
    calls.push(sort+':'+url.searchParams.get('pageNumber'));
    assert.equal(url.searchParams.get('query'),'Azul');
    const id=sort==='EndDateDescending'?1:2;
    return new Response(JSON.stringify({items:[
      {id:1,shortDescription:'Azul original'},
      {id,shortDescription:'Azul second'}
    ],totalNumberOfPages:1}),{status:200});
  }) as typeof fetch;
  const rows=await fetchListings(config,request,{
    secondaryOrderBy:'EndDateAscending',secondaryMaxPages:1,diagnostics:diag
  });
  assert.deepEqual(calls,['EndDateDescending:1','EndDateAscending:1']);
  assert.deepEqual(rows.map(r=>r.id),[1,2]);
  assert.equal(diag.requests,2);
  assert.equal(diag.successfulPages,2);
  assert.equal(diag.secondaryRequests,1);
  assert.equal(diag.secondaryUsed,true);
});
test('supplementary API failure keeps valid primary results and reports warning',async()=>{
  const diag=searchDiagnostics();
  const request=(async(input:string|URL|Request)=>{
    if(new URL(String(input)).searchParams.get('orderBy')==='EndDateAscending')
      return new Response('Bad Request',{status:400});
    return new Response(JSON.stringify({items:[{id:40,title:'Azul'}],totalNumberOfPages:1}),
      {status:200});
  }) as typeof fetch;
  const rows=await fetchListings(config,request,{
    secondaryOrderBy:'EndDateAscending',secondaryMaxPages:1,diagnostics:diag
  });
  assert.deepEqual(rows.map(r=>r.id),[40]);
  assert.equal(diag.requests,2);
  assert.match(diag.secondaryError??'',/400/);
  assert.equal(diag.secondaryUsed,true);
});
test('primary search failure is fatal (no partial scan)',async()=>{
  await assert.rejects(()=>fetchListings(config,async()=>
    new Response('{}',{status:429})),/429/);
});
test('diagnostics distinguish API result-page limit from complete search',async()=>{
  const diag=searchDiagnostics();
  await fetchListings({...config,maxPages:1},
    (async()=>new Response(JSON.stringify({items:[{id:4,title:'Azul'}],
      totalNumberOfPages:4}),{status:200})) as typeof fetch,{diagnostics:diag});
  assert.equal(diag.limitedByMaxPages,true);
  assert.equal(diag.requests,1);
});
