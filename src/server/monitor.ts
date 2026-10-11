import type { Config } from './config.js';
import { Store, type SearchRun } from './db.js';
import { fetchListings, searchDiagnostics } from './tradera.js';
import { matchesWatch } from './watch-rules.js';
import type { NotificationWorker } from './notifications.js';

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private cycles = 0;
  lastError: string | null = null;
  lastAttempt: string | null = null;
  constructor(private config: Config, private store: Store,
    private fetcher: typeof fetchListings = fetchListings,
    private notifications?: NotificationWorker) {}
  get scanning(): boolean { return this.busy; }
  get configured(): boolean { return !!(this.config.appId && this.config.appKey); }
  get estimatedRequestsPerDay(): number {
    const scopes=1+this.store.listWatches().filter(w=>w.enabled).length;
    const scans=Math.ceil(86400/this.config.intervalSeconds);
    const primary=scans*scopes*this.config.maxPages;
    const every=this.config.secondaryEvery??0;
    const secondary=every>0
      ? Math.ceil(scans/every)*scopes*Math.min(this.config.secondaryPages??1,this.config.maxPages)
      : 0;
    return primary+secondary;
  }
  get secondarySearchEnabled():boolean {
    return (this.config.secondaryEvery??0)>0 && this.estimatedRequestsPerDay<=9000;
  }
  get searchWarning():string|null {
    if((this.config.secondaryEvery??0)>0 && !this.secondarySearchEnabled)
      return 'Extra sökordning avstängd: beräknad anropsbudget över 9 000 per dygn.';
    return null;
  }

  async scan(): Promise<void> {
    if (this.busy || !this.configured) return;
    this.busy = true;
    this.lastAttempt = new Date().toISOString();
    this.cycles++;
    const errors: string[] = [];
    const extra=this.secondarySearchEnabled &&
      this.cycles%(this.config.secondaryEvery??3)===0;
    const extraOrder = this.config.orderBy==='EndDateAscending'
      ? 'EndDateDescending' : 'EndDateAscending';

    const search = async (scope:'category'|'watch',query:string,watchId?:number) => {
      const diagnostics=searchDiagnostics();
      let error:string|null=null;
      let found=0,added=0,recent=0,older=0,unknown=0;
      let baseline=false;
      try {
        const listings=await this.fetcher({...this.config,query},undefined,{
          diagnostics,
          secondaryOrderBy:extra?extraOrder:undefined,
          secondaryMaxPages:this.config.secondaryPages??1
        });
        found=listings.length;
        const now=new Date().toISOString();
        if (scope==='category') {
          const outcome=this.store.saveScan(listings,now);
          added=outcome.added;baseline=outcome.baseline;
        } else {
          // Pushover's existing transactional enqueue and watch baseline remain unchanged.
          const watch=this.store.getWatch(watchId!);
          if (!watch || !watch.enabled) return;
          const matched=listings.filter(item=>matchesWatch(item,watch));
          found=matched.length;
          const outcome=this.store.saveWatchScan(
            watchId!,matched,now,this.notifications?.enabled??false);
          added=outcome.added;baseline=outcome.baseline;
        }
        const ages=this.store.discoveredCounts(scope,now,watchId);
        recent=ages.recent;older=ages.older;unknown=ages.unknown;
        console.log('Tradera '+scope+' scan:',JSON.stringify({
          watchId:watchId??null,fetched:found,added,baseline,
          requests:diagnostics.requests,secondaryUsed:diagnostics.secondaryUsed,
          recentlyStarted:recent
        }));
        if (diagnostics.secondaryError)
          console.warn('Tradera supplementary search:',diagnostics.secondaryError);
      } catch(cause) {
        error=cause instanceof Error?cause.message:String(cause);
        errors.push((scope==='category'?'Kategori':'Bevakning '+query)+': '+error);
        if (watchId!==undefined)this.store.watchFailed(watchId,error);
      } finally {
        const run:SearchRun={
          scope,watchId:watchId??null,query,finishedAt:new Date().toISOString(),
          apiCalls:diagnostics.requests,pages:diagnostics.successfulPages,
          resultCount:found,newCount:baseline?0:added,
          recentCount:recent,olderCount:older,unknownCount:unknown,
          secondaryUsed:diagnostics.secondaryUsed,
          secondaryError:diagnostics.secondaryError,
          limitedByMaxPages:diagnostics.limitedByMaxPages,error
        };
        this.store.recordSearchRun(run);
      }
    };
    try {
      await search('category',this.config.query);
      for (const watch of this.store.listWatches().filter(w=>w.enabled)) {
        await search('watch',watch.term,watch.id);
      }
      this.lastError=errors.length?errors.join(' | '):null;
      if(errors.length) console.error('Tradera polling errors:',this.lastError);
    } finally {
      this.busy=false;
      void this.notifications?.flush();
    }
  }
  start():void {
    if(!this.configured){
      this.lastError='Ange TRADERA_APP_ID och TRADERA_APP_KEY i .env';
      console.warn(this.lastError);
      return;
    }
    if(this.searchWarning) console.warn('Tradera:',this.searchWarning);
    void this.scan();
    this.timer=setInterval(()=>{void this.scan();},this.config.intervalSeconds*1000);
    this.timer.unref();
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=null;}
}
