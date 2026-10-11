import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  discordWebhookEndpoint,discordListingMessage,sendDiscord,DiscordDeliveryError
} from '../src/server/discord.js';
import type {Listing} from '../src/server/tradera.js';

const url='https://discord.com/api/webhooks/123456789012345678/TESTsecret-ABCDE_123';
const listing:Listing={
  id:9,categoryId:181806,title:'Terraforming Mars – baslåda',price:195,
  buyNowPrice:275,imageUrl:'https://img.tradera.net/large-3-2/sample.jpg',
  url:'https://www.tradera.com/item/181806/9/terraforming-mars',
  startsAt:null,endsAt:null
};

test('Discord webhook URL restricts outbound delivery to canonical Discord HTTPS endpoint',()=>{
  assert.equal(discordWebhookEndpoint(url)?.searchParams.get('wait'),'true');
  for(const invalid of [
    'http://discord.com/api/webhooks/12/abc',
    'https://discord.com.evil.org/api/webhooks/12/abc',
    'https://discord.com@evil.org/api/webhooks/12/abc',
    'https://discord.com/api/webhooks/12/abc?wait=false',
    'https://discord.com/api/webhooks/12/abc#frag',
    'https://discord.com/api/users/12',
    'file:///etc/passwd',
    ''
  ])assert.equal(discordWebhookEndpoint(invalid),null,invalid);
});

test('sends confirmed Discord embed with listing URL, prices, thumbnail, no mentions',async()=>{
  let requests=0;
  const mock=(async(input:string|URL|Request,opts?:RequestInit)=>{
    requests++;
    const endpoint=new URL(String(input));
    assert.equal(endpoint.hostname,'discord.com');
    assert.equal(endpoint.searchParams.get('wait'),'true');
    assert.equal(opts?.method,'POST');
    const body=JSON.parse(String(opts?.body)) as {
      username:string; allowed_mentions:{parse:string[]};
      embeds:Array<{title:string;description:string;url:string;thumbnail:{url:string}}>
    };
    assert.equal(body.username,'Tradera Watch');
    assert.deepEqual(body.allowed_mentions,{parse:[]});
    assert.match(body.embeds[0].title,/Terraforming Mars/);
    assert.match(body.embeds[0].description,/195 kr/);
    assert.match(body.embeds[0].description,/275 kr/);
    assert.equal(body.embeds[0].url,listing.url);
    assert.equal(body.embeds[0].thumbnail.url,listing.imageUrl);
    return new Response(JSON.stringify({id:'123456789012345678'}),{status:200});
  }) as typeof fetch;
  await sendDiscord(url,discordListingMessage('Terraforming Mars',listing),mock);
  assert.equal(requests,1);
});

test('rejects HTTP error, missing receipt and sanitizes network failures',async()=>{
  await assert.rejects(
    ()=>sendDiscord(url,{title:'Test',description:'A'},
      (async()=>new Response('No permission',{status:403})) as typeof fetch),
    (error:unknown)=>{
      assert.ok(error instanceof DiscordDeliveryError);
      assert.equal(error.httpStatus,403);
      assert.doesNotMatch(error.message,/TESTsecret/);
      return true;
    });
  await assert.rejects(
    ()=>sendDiscord(url,{title:'Test',description:'A'},
      (async()=>new Response(null,{status:204})) as typeof fetch),
    /kvittens/);
  await assert.rejects(
    ()=>sendDiscord(url,{title:'Test',description:'A'},
      (async()=>{throw new Error('failed https://discord.com/api/webhooks/123/TESTsecret');}) as typeof fetch),
    (error:unknown)=>{
      assert.ok(error instanceof DiscordDeliveryError);
      assert.doesNotMatch(error.message,/TESTsecret/);
      return true;
    });
});
test('parses Discord rate limit backoff without echoing the private webhook',async()=>{
  await assert.rejects(
    ()=>sendDiscord(url,{title:'test',description:'body'},
      (async()=>new Response(JSON.stringify({retry_after:17}),
        {status:429,headers:{'content-type':'application/json'}})) as typeof fetch),
    (error:unknown)=>{
      assert.ok(error instanceof DiscordDeliveryError);
      assert.equal(error.httpStatus,429);
      assert.equal(error.retryAfter,17);
      assert.doesNotMatch(error.message,/TESTsecret/);
      return true;
    });
});
