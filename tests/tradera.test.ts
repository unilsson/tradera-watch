import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchListings, parseSearchResult } from '../src/server/tradera.js';
import type { Config } from '../src/server/config.js';

const config: Config = {
  appId:'123', appKey:'test-key', categoryId:181806, query:'',
  orderBy:'EndDateDescending', intervalSeconds:300, maxPages:3, dataDir:'.', port:3001
};
test('normalizes camelCase result fields and canonical links', () => {
  const {listings,totalPages} = parseSearchResult({
    items:[{id:123,categoryId:181806,shortDescription:'Catan',
      openingBid:100,buyItNowPrice:250,buyItNowPriceSpecified:true,
      thumbnailLink:'https://example.org/p.jpg',startDate:'2026-10-01T10:00:00Z'}],
    totalNumberOfPages:2
  });
  assert.equal(totalPages,2);
  assert.equal(listings[0].title,'Catan');
  assert.equal(listings[0].price,100);
  assert.equal(listings[0].buyNowPrice,250);
  assert.equal(listings[0].url,'https://www.tradera.com/item/181806/123/catan');
});
test('supports PascalCase and refuses unexpected search payloads', () => {
  assert.equal(parseSearchResult({SearchResult:{Items:[{Id:4,ShortDescription:'Risk'}]}}).listings[0].id,4);
  assert.throws(()=>parseSearchResult({foo:'bar'}),/items/);
});
test('paginates without duplicate entries and sends app headers', async () => {
  const pages:number[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('x-app-id'),'123');
    assert.equal(url.searchParams.get('categoryId'),'181806');
    const page = Number(url.searchParams.get('pageNumber'));
    pages.push(page);
    return new Response(JSON.stringify({items:page===1 ?
      [{id:1,shortDescription:'Spel 1'}] : [{id:1,shortDescription:'Spel 1'},{id:2,shortDescription:'Spel 2'}],
      totalNumberOfPages:2}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const items = await fetchListings(config,request);
  assert.deepEqual(pages,[1,2]);
  assert.deepEqual(items.map(i=>i.id),[1,2]);
});
test('API errors fail the scan instead of being interpreted as no listings', async () => {
  const request = (async () => new Response('{}',{status:429,headers:{'retry-after':'60'}})) as typeof fetch;
  await assert.rejects(()=>fetchListings(config,request),/429.*Retry-After/);
});

test('uses the best available image link before the low-resolution thumbnail', () => {
  const full = parseSearchResult({items:[{
    id:201,
    thumbnailLink:'https://img.example.org/thumb.jpg',
    imageLinks:['http://unsafe.example.org/file.jpg','https://img.example.org/full.jpg'],
    detailedImageLinks:[{url:'https://img.example.org/detail.jpg'}]
  }]}).listings[0];
  assert.equal(full.imageUrl,'https://img.example.org/full.jpg');

  const detailed = parseSearchResult({items:[{
    id:202,
    ThumbnailLink:'https://img.example.org/thumb.jpg',
    DetailedImageLinks:[{Url:'https://img.example.org/detail.jpg'}]
  }]}).listings[0];
  assert.equal(detailed.imageUrl,'https://img.example.org/detail.jpg');

  const thumbnailOnly = parseSearchResult({items:[{
    id:203, thumbnailLink:'https://img.example.org/thumb.jpg'
  }]}).listings[0];
  assert.equal(thumbnailOnly.imageUrl,'https://img.example.org/thumb.jpg');
});

test('search API partial item links are expanded with the title slug', () => {
  const { listings } = parseSearchResult({items:[{
    id:754678944,
    categoryId:181806,
    shortDescription:'Fia med knuff från Alga',
    itemLink:'https://www.tradera.com/item/181806/754678944',
    thumbnailLink:'https://img.tradera.net/small-3-2/198/662414198_3d2c7ce1-0fe9-402d-838b-33609cc4d025.jpg'
  }]});
  assert.equal(listings[0].url,
    'https://www.tradera.com/item/181806/754678944/fia-med-knuff-fran-alga');
  assert.equal(listings[0].imageUrl,
    'https://img.tradera.net/large-3-2/198/662414198_3d2c7ce1-0fe9-402d-838b-33609cc4d025.jpg');
});
