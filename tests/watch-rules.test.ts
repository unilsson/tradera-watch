import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchInput, matchesWatch } from '../src/server/watch-rules.js';
import type { Listing } from '../src/server/tradera.js';

const item: Listing = {
  id:1,categoryId:181806,title:'Terraforming Mars – Svensk utgåva',
  price:245,buyNowPrice:350,imageUrl:null,url:'https://www.tradera.com/item/181806/1/terraforming-mars',
  startsAt:null,endsAt:null
};
test('validates watch terms and max prices',()=>{
  assert.deepEqual(parseWatchInput({term:'  Terraforming    Mars ',maxPrice:'300'}),
    {term:'Terraforming Mars',minPrice:null,maxPrice:300,excludeWords:[],listingType:'all'});
  assert.deepEqual(parseWatchInput({term:'Azul',maxPrice:null}),
    {term:'Azul',minPrice:null,maxPrice:null,excludeWords:[],listingType:'all'});
  for (const payload of [{term:''},{term:'a'},{term:'X'.repeat(81)},{term:'Azul',maxPrice:-1},
    {term:'Azul',maxPrice:'abc'},{term:'Azul',maxPrice:1.2}]) {
    assert.throws(()=>parseWatchInput(payload));
  }
});
test('matches Swedish text ignoring case and diacritics and applies max price',()=>{
  assert.ok(matchesWatch(item,{term:'TERRAFORMING MARS',maxPrice:300}));
  assert.ok(matchesWatch({...item,title:'ÅÄÖ-spelet'}, {term:'aao',maxPrice:null}));
  assert.ok(!matchesWatch(item,{term:'Catan',maxPrice:null}));
  assert.ok(!matchesWatch(item,{term:'Terraforming Mars',maxPrice:200}));
  assert.ok(matchesWatch({...item,price:400,buyNowPrice:150},
    {term:'Terraforming Mars',maxPrice:200}));
  assert.ok(!matchesWatch({...item,price:null,buyNowPrice:null},
    {term:'Terraforming Mars',maxPrice:300}));
});

test('min and max prices must bracket the same available price',()=>{
  const watch={term:'Terraforming Mars',minPrice:200,maxPrice:300,
    excludeWords:[],listingType:'all' as const};
  assert.ok(matchesWatch(item,watch)); // 245 kr
  assert.ok(!matchesWatch({...item,price:100,buyNowPrice:500},watch));
  assert.ok(matchesWatch({...item,price:400,buyNowPrice:250},watch));
  assert.ok(!matchesWatch({...item,price:null,buyNowPrice:null},watch));
  assert.throws(()=>parseWatchInput({...watch,minPrice:301,maxPrice:300}),/Minpriset/);
});
test('excluded words/phrases ignore Swedish case and accents',()=>{
  const watch=parseWatchInput({
    term:'Terraforming Mars',maxPrice:500,
    excludeWords:' EXPANSIÓN ,  tillägg , expansion,  '
  });
  assert.deepEqual(watch.excludeWords,['expansion','tillägg']);
  assert.ok(!matchesWatch({...item,title:'Terraforming Mars – EXPANSIÓN'},watch));
  assert.ok(!matchesWatch({...item,title:'Terraforming Mars – TILLÄGG'},watch));
  assert.ok(matchesWatch(item,watch));
  const phrases=parseWatchInput({term:'Catan',excludeWords:['Sjöfarare', 'reserVdelar']});
  assert.ok(!matchesWatch({...item,title:'Catan med sjofArare'},phrases));
  assert.throws(()=>parseWatchInput({term:'Catan',excludeWords:Array(11).fill('x')}),/10/);
});
test('auction/BIN mode respects explicit type and ignores unrelated prices',()=>{
  const listing={...item,itemType:1};
  const basic={term:'Terraforming Mars',minPrice:200,maxPrice:300,excludeWords:[]};
  assert.ok(matchesWatch(listing,{...basic,listingType:'auction'}));
  assert.ok(!matchesWatch({...listing,itemType:null},{...basic,listingType:'auction'}));
  assert.ok(matchesWatch({...listing,buyNowPrice:250},{...basic,listingType:'buy_now'})); // Hybrid
  assert.ok(!matchesWatch({...listing,price:245,buyNowPrice:350},{...basic,listingType:'buy_now'}));
  assert.ok(matchesWatch({...listing,price:350,buyNowPrice:250},{...basic,listingType:'buy_now'}));
  assert.ok(!matchesWatch({...listing,price:350,buyNowPrice:250},{...basic,listingType:'auction'}));
  assert.ok(matchesWatch({...listing,itemType:3,price:null,buyNowPrice:250},
    {...basic,listingType:'buy_now'}));
  assert.throws(()=>parseWatchInput({term:'Catan',listingType:'wrong'}),/annonstyp/);
});
test('malformed filter payloads fail validation',()=>{
  for(const payload of [
    {term:'Catan',minPrice:-5},
    {term:'Catan',minPrice:true},
    {term:'Catan',excludeWords:123},
    {term:'Catan',excludeWords:[5]},
    {term:'Catan',excludeWords:['x'.repeat(61)]},
    {term:'Catan',listingType:42},
    {term:'Catan',injected:'abc'}
  ]) assert.throws(()=>parseWatchInput(payload));
});
