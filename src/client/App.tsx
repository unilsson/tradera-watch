import { useEffect, useState, type FormEvent } from 'react';
import { largeImageUrl, listingUrl } from '../shared/tradera-media';

type Listing = {
  id:number; categoryId:number; title:string; price:number|null; buyNowPrice:number|null;
  imageUrl:string|null; url:string; startsAt:string|null; endsAt:string|null;
  firstSeenAt:string; isNew:boolean; discoveryAge?:'recent'|'older'|'unknown';
};
type Scan = {finishedAt:string; fetched:number; added:number; baseline:boolean};
type Status = {
  configured:boolean; scanning:boolean; total:number; newItems:number;
  lastScan:Scan|null; lastError:string|null; lastAttempt:string|null;
  categoryId:number; query:string; intervalSeconds:number; maxPages:number;
  pushover?:{configured:boolean;pending:number;sent:number;lastError:string|null};
  discovery?:{
    last:SearchRun|null;
    last24h:{apiCalls:number;pages:number;newCount:number;recentCount:number;
      olderCount:number;unknownCount:number;failures:number;scans:number};
    recentRuns:SearchRun[];
    strategy:{primaryOrderBy:string;secondaryEnabled:boolean;secondaryEvery:number;
      secondaryPages:number;estimatedCallsPerDay:number;warning:string|null};
  };

};
type SearchRun = {
  scope:'category'|'watch';watchId:number|null;query:string;finishedAt:string;
  apiCalls:number;pages:number;resultCount:number;newCount:number;
  recentCount:number;olderCount:number;unknownCount:number;
  secondaryUsed:boolean;secondaryError:string|null;limitedByMaxPages:boolean;error:string|null;
};
type Watch = {
  id:number; term:string; minPrice:number|null; maxPrice:number|null;
  excludeWords:string[]; listingType:'all'|'auction'|'buy_now'; enabled:boolean;
  initialized:boolean; createdAt:string; lastScannedAt:string|null;
  lastError:string|null; matchedCount:number; newCount:number;
};
type Page = {items:Listing[]; total:number};
const money = (amount:number|null) => amount == null ? '–' :
  new Intl.NumberFormat('sv-SE',{style:'currency',currency:'SEK',maximumFractionDigits:0}).format(amount);
const date = (iso:string|null) => iso ? new Date(iso).toLocaleString('sv-SE',{dateStyle:'short',timeStyle:'short'}) : '–';

async function sendChange(path:string,method:'POST'|'PATCH'|'DELETE',body?:object):Promise<void> {
  const response = await fetch(path,{
    method, headers:body ? {'Content-Type':'application/json'} : {},
    body:body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    let message = 'HTTP ' + response.status;
    try { message = (await response.json() as {error?:string}).error || message; } catch { /* Keep HTTP status */ }
    throw new Error(message);
  }
}

export default function App() {
  const [status,setStatus] = useState<Status|null>(null);
  const [data,setData] = useState<Page>({items:[],total:0});
  const [watches,setWatches] = useState<Watch[]>([]);
  const [watchId,setWatchId] = useState<number|null>(null);
  const [newOnly,setNewOnly] = useState(false);
  const [page,setPage] = useState(1);
  const [error,setError] = useState<string|null>(null);
  const [actionError,setActionError] = useState<string|null>(null);
  const [loading,setLoading] = useState(false);
  const [saving,setSaving] = useState(false);
  const [testingPushover,setTestingPushover] = useState(false);
  const [pushoverFeedback,setPushoverFeedback] = useState<string|null>(null);
  const [term,setTerm] = useState('');
  const [price,setPrice] = useState('');
  const [minPrice,setMinPrice] = useState('');
  const [excluded,setExcluded] = useState('');
  const [listingType,setListingType] = useState<'all'|'auction'|'buy_now'>('all');
  const [editingId,setEditingId] = useState<number|null>(null);
  const [revision,setRevision] = useState(0);
  const selected = watches.find(w => w.id === watchId);
  useEffect(()=>{setPage(1);},[newOnly,watchId]);
  useEffect(()=>{
    let cancelled = false;
    async function reload() {
      setLoading(true);
      try {
        const params = new URLSearchParams({page:String(page),limit:'48',newOnly:newOnly?'1':'0'});
        if (watchId !== null) params.set('watchId',String(watchId));
        const [sr,lr,wr] = await Promise.all([
          fetch('/api/status',{cache:'no-store'}),
          fetch('/api/items?' + params.toString(),{cache:'no-store'}),
          fetch('/api/watches',{cache:'no-store'})
        ]);
        if (!sr.ok || !lr.ok || !wr.ok) throw new Error('Kunde inte hämta annonser eller bevakningar');
        const [s,l,w] = await Promise.all([
          sr.json() as Promise<Status>,lr.json() as Promise<Page>,
          wr.json() as Promise<{watches:Watch[]}>
        ]);
        if (!cancelled) {setStatus(s);setData(l);setWatches(w.watches);setError(null);}
      } catch(e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (!cancelled) setLoading(false); }
    }
    void reload();
    const timer = window.setInterval(()=>{void reload();},30000);
    return ()=>{cancelled=true;window.clearInterval(timer);};
  },[page,newOnly,watchId,revision]);

  async function testPushover() {
    setTestingPushover(true);setPushoverFeedback(null);
    try {
      await sendChange('/api/notifications/test','POST');
      setPushoverFeedback('Testnotisen skickades till Pushover.');
    } catch(e) {
      setPushoverFeedback(e instanceof Error ? 'Pushover: '+e.message : 'Testnotisen misslyckades');
    } finally {setTestingPushover(false);}
  }
  function resetWatchForm(){
    setEditingId(null);setTerm('');setPrice('');setMinPrice('');
    setExcluded('');setListingType('all');
  }
  function editWatch(watch:Watch){
    setEditingId(watch.id);setTerm(watch.term);
    setPrice(watch.maxPrice===null?'':String(watch.maxPrice));
    setMinPrice(watch.minPrice===null?'':String(watch.minPrice));
    setExcluded(watch.excludeWords.join(', '));
    setListingType(watch.listingType);
    setActionError(null);
    document.getElementById('watch-form')?.scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function createWatch(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);setActionError(null);
    try {
      const payload={
        term,minPrice:minPrice.trim()?Number(minPrice):null,
        maxPrice:price.trim()?Number(price):null,
        excludeWords:excluded.split(',').map(word=>word.trim()).filter(Boolean),
        listingType
      };
      await sendChange(editingId===null?'/api/watches':'/api/watches/'+editingId,
        editingId===null?'POST':'PATCH',payload);
      resetWatchForm();setRevision(r=>r+1);
    } catch(e) {setActionError(e instanceof Error ? e.message : String(e));}
    finally {setSaving(false);}
  }
  async function toggleWatch(watch:Watch) {
    setSaving(true);setActionError(null);
    try {await sendChange('/api/watches/'+watch.id,'PATCH',{enabled:!watch.enabled});setRevision(r=>r+1);}
    catch(e) {setActionError(e instanceof Error ? e.message : String(e));}
    finally {setSaving(false);}
  }
  async function removeWatch(watch:Watch) {
    if (!window.confirm('Ta bort bevakningen "' + watch.term + '" och dess träffhistorik?')) return;
    setSaving(true);setActionError(null);
    try {
      await sendChange('/api/watches/'+watch.id,'DELETE');
      if (watchId===watch.id) setWatchId(null);
      if (editingId===watch.id) resetWatchForm();
      setRevision(r=>r+1);
    } catch(e) {setActionError(e instanceof Error ? e.message : String(e));}
    finally {setSaving(false);}
  }
  const maxPage=Math.max(1,Math.ceil(data.total/48));
  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="dice">🎲</span><div><h1>Tradera Watch</h1><p>Bevakning av brädspel på Tradera</p></div></div>
      <span className={'pill '+(status?.configured && !status.lastError?'online':'offline')}>
        <span className="dot"/> {status?.scanning?'Skannar …':status?.configured && !status.lastError?'Bevakning aktiv':'Behöver åtgärd'}
      </span>
    </header>
    <main>
      <section className="hero">
        <div><div className="eyebrow">ANNONSBEVAKNING · SPRINT 4B</div>
          <h2>Hitta nästa spel till samlingen.</h2>
          <p>Bevaka dina favoritspel med prisintervall, exkluderade ord och annonstyp. Varje bevakning har egen sökning.</p></div>
        <div className="hero-symbol" aria-hidden="true">♟</div>
      </section>
      <section className="metrics" aria-label="Statistik">
        <div className="metric"><span>Observerade annonser</span><strong>{status?.total??'–'}</strong></div>
        <div className="metric"><span>Upptäckta efter baslinjen</span><strong>{status?.newItems??'–'}</strong></div>
        <div className="metric"><span>Senaste kategoriskanning</span><strong className="small">{date(status?.lastScan?.finishedAt??null)}</strong></div>
        <div className="metric"><span>Kontrollintervall</span><strong className="small">{status?Math.round(status.intervalSeconds/60)+' minuter':'–'}</strong></div>
      </section>
      <section className="discovery-section" aria-label="Sökstatistik">
        <div className="discovery-heading">
          <div><div className="eyebrow">SÖKMOTOR · SPRINT 4A</div><h3>Upptäckta annonser</h3>
            <p>Summering senaste 24 timmarna. Startdatum är Traderas uppgift, inte verifierad publiceringstid.</p></div>
          <a href="/api/discovery" target="_blank" rel="noopener noreferrer">Detaljerad JSON ↗</a>
        </div>
        <div className="discovery-metrics">
          <div><span>API-anrop</span><strong>{status?.discovery?.last24h.apiCalls??'–'}</strong></div>
          <div><span>Kontrollerade resultatsidor</span><strong>{status?.discovery?.last24h.pages??'–'}</strong></div>
          <div><span>Nyligen startade (≤24 h)</span><strong>{status?.discovery?.last24h.recentCount??'–'}</strong></div>
          <div><span>Äldre / okänt startdatum</span><strong>{status?.discovery
            ? status.discovery.last24h.olderCount+status.discovery.last24h.unknownCount:'–'}</strong></div>
        </div>
        <p className="strategy-note">Primär sökning: {status?.discovery?.strategy.primaryOrderBy??'–'}.
          Kompletterande sortering: {status?.discovery?.strategy.secondaryEnabled
            ? 'var '+status.discovery.strategy.secondaryEvery+':e skanning':'avstängd'}.
          {' '}Beräknat max {status?.discovery?.strategy.estimatedCallsPerDay??'–'} anrop/dygn.
          {status?.discovery?.strategy.warning?' ⚠️ '+status.discovery.strategy.warning:''}
        </p>
        {!!status?.discovery?.recentRuns.length && <details className="discovery-details">
          <summary>Visa senaste sökningar ({status.discovery.recentRuns.length})</summary>
          <div className="discovery-table-scroll">
            <table><thead><tr><th>Tid</th><th>Bevakning</th><th>API</th><th>Resultat</th>
              <th>Nyupptäckta</th><th>Ytterligare sortering</th></tr></thead>
              <tbody>{status.discovery.recentRuns.map((run,index)=><tr key={index}>
                <td>{date(run.finishedAt)}</td>
                <td>{run.scope==='category'?'Brädspel':run.query}</td>
                <td>{run.apiCalls}</td><td>{run.resultCount}</td><td>{run.newCount}</td>
                <td>{run.secondaryError?'Fel: '+run.secondaryError:
                  run.secondaryUsed?'Ja':'Nej'}{run.limitedByMaxPages?' · sidgräns':''}
                  {run.error?' · Fel: '+run.error:''}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>}
      </section>
      <section className="pushover-section" aria-label="Pushover-notiser">
        <div>
          <div className="eyebrow">NOTISER</div>
          <h3>Pushover <span className={'push-state '+(status?.pushover?.configured?'enabled':'disabled')}>
            {status?.pushover?.configured?'Aktiverat':'Inte konfigurerat'}</span></h3>
          <p>{status?.pushover?.configured
            ? 'Nya träffar i aktiva spelbevakningar skickas automatiskt.'
            : 'Lägg till PUSHOVER_APP_TOKEN och PUSHOVER_USER_KEY i .env för att aktivera notiser.'}</p>
          {status?.pushover?.configured && <p>
            {status.pushover.pending} väntande · {status.pushover.sent} skickade
            {status.pushover.lastError?' · Senaste fel: '+status.pushover.lastError:''}
          </p>}
          {pushoverFeedback && <p role="status" className="push-feedback">{pushoverFeedback}</p>}
        </div>
        <button type="button" disabled={!status?.pushover?.configured||testingPushover}
          onClick={()=>{void testPushover();}}>{testingPushover?'Skickar …':'Skicka testnotis'}</button>
      </section>
      {!status?.configured && status && <div className="notice">⚠️ API-nycklar saknas. Lägg in TRADERA_APP_ID och TRADERA_APP_KEY i .env.</div>}
      {status?.lastError && <div className="notice">⚠️ {status.lastError}</div>}
      {error && <div className="notice">Kunde inte uppdatera sidan: {error}</div>}

      <section className="watch-section" aria-labelledby="watches-title">
        <div className="watch-heading">
          <div><div className="eyebrow">MINA SPEL</div><h3 id="watches-title">Bevakningar <span>({watches.length}/8)</span></h3>
            <p>Varje bevakning har en egen baslinje. Sökningen görs var {status?Math.round(status.intervalSeconds/60):5}:e minut.</p></div>
        </div>
        <form id="watch-form" className="watch-form watch-form-advanced" onSubmit={event=>{void createWatch(event);}}>
          <div className="watch-form-heading">
            <strong>{editingId===null?'Ny spelbevakning':'Redigera bevakning'}</strong>
            {editingId!==null && <button className="form-cancel" type="button"
              onClick={resetWatchForm}>Avbryt redigering</button>}
          </div>
          <label>Spelnamn
            <input type="text" placeholder="T.ex. Catan" value={term}
              onChange={event=>setTerm(event.target.value)} minLength={2} maxLength={80} required/>
          </label>
          <label>Exkludera ord/fraser (kommatecken)
            <input type="text" placeholder="expansion, tillägg, reservdelar" value={excluded}
              onChange={event=>setExcluded(event.target.value)} maxLength={620}/>
          </label>
          <label>Minpris (kr)
            <input type="number" placeholder="Valfritt" value={minPrice} min={1} max={500000} step={1}
              onChange={event=>setMinPrice(event.target.value)}/>
          </label>
          <label>Maxpris (kr)
            <input type="number" placeholder="Valfritt" value={price} min={1} max={500000} step={1}
              onChange={event=>setPrice(event.target.value)}/>
          </label>
          <label>Annonstyp
            <select value={listingType} onChange={event=>setListingType(event.target.value as typeof listingType)}>
              <option value="all">Alla annonser</option>
              <option value="auction">Auktioner (bekräftad typ)</option>
              <option value="buy_now">Har Köp nu</option>
            </select>
          </label>
          <button className="primary" type="submit"
            disabled={saving||(editingId===null&&watches.length>=8)}>
            {saving?'Sparar …':editingId===null?'+ Lägg till':'Spara ändringar'}
          </button>
          <p className="form-help">Auktion + Köp nu kan matcha båda valen. Saknas verifierad annonstyp
            kan vi inte klassificera en auktion. Ändrade filter får en ny baslinje utan gamla Pushover-notiser.</p>
        </form>
        {actionError && <div className="notice">{actionError}</div>}
        <div className="watch-grid">
          <button type="button" className={'watch-card all '+(watchId===null?'selected':'')}
            onClick={()=>setWatchId(null)}>
            <strong>🎲 Alla annonser</strong><span>Hela kategorin · {status?.total??0} sparade</span>
            <em>Visa annonser →</em>
          </button>
          {watches.map(watch=><article key={watch.id} className={'watch-card '+(watchId===watch.id?'selected':'')}>
            <div className="watch-card-top"><h4>{watch.term}</h4>
              <span className={'watch-state '+(watch.enabled?'active':'paused')}>{watch.enabled?'Aktiv':'Pausad'}</span></div>
            <p>{watch.minPrice!==null&&watch.maxPrice!==null
              ? money(watch.minPrice)+'–'+money(watch.maxPrice)
              : watch.minPrice!==null?'Från '+money(watch.minPrice)
              : watch.maxPrice!==null?'Högst '+money(watch.maxPrice):'Alla priser'}
              {' · '}{watch.listingType==='auction'?'Auktioner':
                watch.listingType==='buy_now'?'Har Köp nu':'Alla typer'}</p>
            {watch.excludeWords.length>0 && <p>Utesluter: {watch.excludeWords.join(', ')}</p>}
            <p>{watch.matchedCount} träffar · {watch.newCount} nya</p>
            <small>{watch.lastError?'Fel: '+watch.lastError:!watch.initialized?'Väntar på första skanning': 'Senast sökt '+date(watch.lastScannedAt)}</small>
            <div className="watch-actions">
              <button type="button" onClick={()=>setWatchId(watch.id)}>Visa träffar</button>
              <button type="button" disabled={saving} onClick={()=>editWatch(watch)}>Redigera</button>
              <button type="button" disabled={saving} onClick={()=>{void toggleWatch(watch);}}>{watch.enabled?'Pausa':'Aktivera'}</button>
              <button className="danger" type="button" disabled={saving}
                onClick={()=>{void removeWatch(watch);}} aria-label={'Ta bort '+watch.term}>Ta bort</button>
            </div>
          </article>)}
        </div>
      </section>

      <section className="listing-header">
        <div><div className="eyebrow">SENASTE FYNDEN</div>
          <h3>{selected?selected.term:'Annonser'} <span>({data.total})</span></h3>
          <p>{selected?'Individuell bevakning · '+(selected.minPrice!==null?'min '+money(selected.minPrice)+' · ':'')+
            (selected.maxPrice!==null?'max '+money(selected.maxPrice):'alla priser'):
            'Kategori '+(status?.categoryId??181806)+(status?.query?' · Sökord: '+status.query:'')}</p>
        </div>
        <label className="toggle"><input type="checkbox" checked={newOnly}
          onChange={event=>setNewOnly(event.target.checked)}/>Visa endast nytillkomna</label>
      </section>
      {data.items.length ? <div className="grid">{data.items.map(item=>
        <a className="card" key={item.id} href={listingUrl(item)} target="_blank" rel="noopener noreferrer">
          <div className="image">{item.imageUrl ? <img src={largeImageUrl(item.imageUrl)||item.imageUrl}
            alt="" loading="lazy" onError={event=>{
              const img=event.currentTarget;
              if(img.dataset.fallback!=='1'){img.dataset.fallback='1';img.src=item.imageUrl!;}
              else img.style.display='none';
            }}/> : <span aria-hidden="true">🎲</span>}
            {item.isNew && <span className="new-tag">{item.discoveryAge==='recent'
              ? 'NYLIGEN STARTAD' : 'NYUPPTÄCKT'}</span>}</div>
          <div className="card-body"><h4>{item.title}</h4>
            <div className="prices"><strong>{money(item.price)}</strong>
              {item.buyNowPrice!==null && <span>Köp nu {money(item.buyNowPrice)}</span>}</div>
            <div className="card-foot"><span>Upptäckt {date(item.firstSeenAt)}</span><span>↗</span></div>
          </div>
        </a>)}</div>
        : <div className="empty">{loading?'Laddar annonser …':
          newOnly?'Inga nytillkomna annonser ännu.':
          selected&&!selected.initialized?'Bevakningen väntar på sin första skanning.':
          selected?'Inga matchande annonser hittade ännu.':'Inga annonser ännu. Kontrollera API-nycklarna.'}</div>}
      <nav className="pagination" aria-label="Sidnavigering">
        <button disabled={page===1} onClick={()=>setPage(p=>p-1)}>← Föregående</button>
        <span>Sida {page} av {maxPage}</span>
        <button disabled={page>=maxPage} onClick={()=>setPage(p=>p+1)}>Nästa →</button>
      </nav>
      <footer>Bevakning är skrivskyddad. Bud och köp sker på Tradera. · <a href="https://api.tradera.com/documentation"
        target="_blank" rel="noreferrer">Tradera API</a></footer>
    </main>
  </div>;
}
