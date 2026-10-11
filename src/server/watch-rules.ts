import type { Listing } from './tradera.js';

export type ListingTypeFilter = 'all' | 'auction' | 'buy_now';
export interface WatchInput {
  term: string;
  minPrice?: number | null;
  maxPrice: number | null;
  excludeWords?: string[];
  listingType?: ListingTypeFilter;
}
export interface Watch extends WatchInput {
  minPrice: number | null;
  excludeWords: string[];
  listingType: ListingTypeFilter;
  id: number;
  enabled: boolean;
  initialized: boolean;
  createdAt: string;
  lastScannedAt: string | null;
  lastError: string | null;
  matchedCount: number;
  newCount: number;
}

function normalize(text:string):string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('sv-SE');
}
function optionalPrice(input:unknown,label:string):number|null {
  if(input===null || input===undefined || input==='') return null;
  // Do not silently convert booleans or malformed text to monetary values.
  if(typeof input!=='number' && typeof input!=='string')
    throw new Error(label+' måste vara ett heltal mellan 1 och 500000 kr');
  if(typeof input==='string' && !/^\d+$/.test(input.trim()))
    throw new Error(label+' måste vara ett heltal mellan 1 och 500000 kr');
  const value=Number(input);
  if(!Number.isSafeInteger(value) || value<1 || value>500000)
    throw new Error(label+' måste vara ett heltal mellan 1 och 500000 kr');
  return value;
}
export function parseWatchInput(payload:unknown):Required<WatchInput> {
  if(!payload || typeof payload!=='object' || Array.isArray(payload))
    throw new Error('Förväntade ett JSON-objekt');
  const data=payload as Record<string,unknown>;
  if(Object.keys(data).some(key=>!['term','minPrice','maxPrice','excludeWords','listingType'].includes(key)))
    throw new Error('Okända filterfält i bevakningen');
  if(typeof data.term!=='string') throw new Error('Ange ett spelnamn');
  const term=data.term.replace(/\s+/g,' ').trim();
  if(term.length<2 || term.length>80) throw new Error('Spelnamnet måste ha 2–80 tecken');
  const minPrice=optionalPrice(data.minPrice,'Minpriset');
  const maxPrice=optionalPrice(data.maxPrice,'Maxpriset');
  if(minPrice!==null && maxPrice!==null && minPrice>maxPrice)
    throw new Error('Minpriset får inte överstiga maxpriset');
  const raw=data.excludeWords??[];
  const parts=typeof raw==='string'?raw.split(','):raw;
  if(!Array.isArray(parts) || parts.some(word=>typeof word!=='string'))
    throw new Error('Exkluderade ord måste vara en lista eller kommaseparerad text');
  const words=parts.map((word:string)=>word.replace(/\s+/g,' ').trim()).filter(Boolean);
  if(words.length>10 || words.some(word=>word.length>60))
    throw new Error('Ange högst 10 exkluderade ord eller fraser (max 60 tecken)');
  const excludeWords=[...new Map(words.map(word=>[normalize(word),word] as const)).values()];
  const listingType=data.listingType??'all';
  if(listingType!=='all' && listingType!=='auction' && listingType!=='buy_now')
    throw new Error('Ogiltig annonstyp');
  return {term,minPrice,maxPrice,excludeWords,listingType};
}

/**
 * Both = choose any known valid price.
 * Auction = only listings explicitly typed as auction (type 1).
 * Buy now = listings with a positive Buy Now price or explicitly pure BIN (type 3).
 *
 * Auction + Buy Now hybrids can match both types. Unknown type does NOT
 * qualify as an auction; this avoids inventing metadata absent in search v4.
 */
export function matchesWatch(item:Listing,watch:WatchInput):boolean {
  const title=normalize(item.title);
  if(!title.includes(normalize(watch.term)))return false;
  if((watch.excludeWords??[]).some(word=>title.includes(normalize(word))))return false;
  const auction=item.itemType===1;
  const buyNow=(item.buyNowPrice!==null && item.buyNowPrice>0)||item.itemType===3;
  if(watch.listingType==='auction' && !auction)return false;
  if(watch.listingType==='buy_now' && !buyNow)return false;

  // Price filter semantics follow the chosen sale format.
  // For pure Buy Now, the current auction bid must not bypass the price range.
  const prices=watch.listingType==='auction'?[item.price]:
    watch.listingType==='buy_now'?[item.buyNowPrice]:
      [item.price,item.buyNowPrice];
  const valid=prices.filter((value):value is number=>
    value!==null && Number.isFinite(value) && value>0);
  const minPrice=watch.minPrice??null;
  if(minPrice===null && watch.maxPrice===null)return true;
  return valid.some(value=>(minPrice===null || value>=minPrice) &&
    (watch.maxPrice===null || value<=watch.maxPrice));
}
