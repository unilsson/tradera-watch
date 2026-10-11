import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendPushover, PushoverError, notificationMessage } from '../src/server/pushover.js';
import type { Listing } from '../src/server/tradera.js';

const creds={token:'test-app-token',user:'test-user-key'};
test('Pushover sends HTTPS form POST with title, item price and clickable URL',async()=>{
  let calls=0;
  const request=(async (input:string|URL|Request, init?:RequestInit)=>{
    calls++;
    assert.equal(String(input),'https://api.pushover.net/1/messages.json');
    assert.equal(init?.method,'POST');
    const data=new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(data.get('token'),creds.token);
    assert.equal(data.get('user'),creds.user);
    assert.equal(data.get('title'),'🎲 Tradera Watch');
    assert.equal(data.get('url'),'https://www.tradera.com/item/181806/22/azul');
    assert.equal(data.get('url_title'),'Visa annons');
    return new Response(JSON.stringify({status:1,request:'1234'}),{status:200});
  }) as typeof fetch;
  await sendPushover(creds,{
    title:'🎲 Tradera Watch',message:'Azul 200 kr',
    url:'https://www.tradera.com/item/181806/22/azul',urlTitle:'Visa annons'
  },request);
  assert.equal(calls,1);
});
test('Pushover rejects transport failures and status=0 even on HTTP 200',async()=>{
  await assert.rejects(()=>sendPushover(creds,{title:'test',message:'message'},
    (async()=>new Response(JSON.stringify({status:0,errors:['token invalid']}),{status:200})) as typeof fetch),
    /bekräftade inte/);
  await assert.rejects(()=>sendPushover(creds,{title:'test',message:'message'},
    (async()=>new Response('Rate limited',{status:429,headers:{'retry-after':'120'}})) as typeof fetch),
    (error:unknown)=>{
      assert.ok(error instanceof PushoverError);
      assert.equal(error.httpStatus,429);
      assert.equal(error.retryAfter,120);
      assert.ok(!error.message.includes(creds.token));
      return true;
    });
});
test('notification includes watch term, listing prices and a clickable Tradera link',()=>{
  const item:Listing={
    id:22,categoryId:181806,title:'Azul – grundspel',price:150,buyNowPrice:220,
    imageUrl:null,url:'https://www.tradera.com/item/181806/22/azul',
    startsAt:null,endsAt:null
  };
  const m=notificationMessage('Azul',item);
  assert.match(m.title,/Azul/);
  assert.match(m.message,/150 kr/);
  assert.match(m.message,/220 kr/);
  assert.equal(m.url,item.url);
});
