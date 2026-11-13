import type { Config } from './config.js';

export type ListingState = 'unknown'|'active'|'sold'|'unsold'|'ended'|'unavailable';
export interface ItemDetail {
  state: Exclude<ListingState,'unknown'|'unavailable'>;
  endsAt: string | null;
  gotWinner: boolean | null;
}
export class ItemLookupError extends Error {
  constructor(public readonly httpStatus:number,message:string){super(message);}
}
export function interpretItemDetail(value:unknown,expectedId:number):ItemDetail {
  if(!value || typeof value!=='object' || Array.isArray(value))
    throw new Error('Ogiltig annonsinformation från Tradera');
  const row=value as Record<string,unknown>;
  const id=row.id??row.Id;
  if(id!==undefined && Number(id)!==expectedId)
    throw new Error('Tradera returnerade fel annons-ID');
  const status=row.status??row.Status;
  if(!status || typeof status!=='object' || Array.isArray(status))
    throw new Error('Annonsen saknar statusinformation');
  const data=status as Record<string,unknown>;
  const ended=data.ended??data.Ended;
  const winner=data.gotWinner??data.GotWinner;
  if(typeof ended!=='boolean')
    throw new Error('Annonsen saknar giltig ended-status');
  const gotWinner=typeof winner==='boolean'?winner:null;
  const type=Number(row.itemType??row.ItemType);
  const rawEnd=row.endDate??row.EndDate;
  const endsAt=typeof rawEnd==='string' && Number.isFinite(Date.parse(rawEnd))
    ? new Date(rawEnd).toISOString():null;
  let state:ItemDetail['state']='active';
  if(ended)state=gotWinner===true?'sold':gotWinner===false && type===1?'unsold':'ended';
  return {state,endsAt,gotWinner};
}
export async function fetchItemDetail(config:Config,itemId:number,
  request:typeof fetch=fetch):Promise<ItemDetail> {
  if(!config.appId || !config.appKey)throw new Error('Tradera API-nycklar saknas');
  if(!Number.isSafeInteger(itemId) || itemId<=0)throw new Error('Ogiltigt annons-ID');
  const response=await request('https://api.tradera.com/v4/items/'+itemId,{
    headers:{'X-App-Id':config.appId,'X-App-Key':config.appKey,Accept:'application/json'},
    signal:AbortSignal.timeout(15000)
  });
  if(!response.ok)throw new ItemLookupError(response.status,'Tradera detaljanrop HTTP '+response.status);
  return interpretItemDetail(await response.json(),itemId);
}
