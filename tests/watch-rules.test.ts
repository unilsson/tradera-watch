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
    {term:'Terraforming Mars',maxPrice:300});
  assert.deepEqual(parseWatchInput({term:'Azul',maxPrice:null}),
    {term:'Azul',maxPrice:null});
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
