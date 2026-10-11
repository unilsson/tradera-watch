import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingUrl, largeImageUrl } from '../src/shared/tradera-media.js';

test('builds a working canonical Tradera URL including a Swedish title slug', () => {
  const item = { id: 754678944, categoryId: 181806, title: 'Fia med knuff från Alga' };
  assert.equal(listingUrl(item),
    'https://www.tradera.com/item/181806/754678944/fia-med-knuff-fran-alga');
  assert.equal(listingUrl({ ...item, url: 'https://www.tradera.com/item/181806/754678944' }),
    'https://www.tradera.com/item/181806/754678944/fia-med-knuff-fran-alga');
});
test('preserves complete official links, rejecting external and mismatched item links', () => {
  const item = { id: 123, categoryId: 181806, title: 'Rock & Roll' };
  assert.equal(listingUrl({...item, url:'https://www.tradera.com/item/181806/123/official-slug'}),
    'https://www.tradera.com/item/181806/123/official-slug');
  assert.equal(listingUrl({...item, url:'https://example.org/item/181806/123/official-slug'}),
    'https://www.tradera.com/item/181806/123/rock-roll');
  assert.equal(listingUrl({...item, url:'https://www.tradera.com/item/181806/456/other'}),
    'https://www.tradera.com/item/181806/123/rock-roll');
});
test('uses confirmed Tradera image CDN large-3-2 preset and leaves external URLs intact', () => {
  const thumbnail = 'https://img.tradera.net/thumb-square/198/662414198_abc.jpg';
  assert.equal(largeImageUrl(thumbnail),
    'https://img.tradera.net/large-3-2/198/662414198_abc.jpg');
  assert.equal(largeImageUrl('https://cdn.example.org/thumb.jpg'),
    'https://cdn.example.org/thumb.jpg');
  assert.equal(largeImageUrl(null), null);
  assert.equal(largeImageUrl('https://img.tradera.net/large-3-2/198/abc.jpg'),
    'https://img.tradera.net/large-3-2/198/abc.jpg');
});
