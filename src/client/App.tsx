import { useEffect, useState } from 'react';

type Listing = {
  id:number; title:string; price:number|null; buyNowPrice:number|null;
  imageUrl:string|null; url:string; startsAt:string|null; endsAt:string|null;
  firstSeenAt:string; isNew:boolean;
};
type Scan = {finishedAt:string; fetched:number; added:number; baseline:boolean};
type Status = {
  configured:boolean; scanning:boolean; total:number; newItems:number;
  lastScan:Scan|null; lastError:string|null; lastAttempt:string|null;
  categoryId:number; query:string; intervalSeconds:number; maxPages:number;
};
type Page = {items:Listing[]; total:number};
const money = (amount: number | null) => amount == null ? '–' :
  new Intl.NumberFormat('sv-SE', { style:'currency', currency:'SEK', maximumFractionDigits:0 }).format(amount);
const date = (iso:string|null) => iso ? new Date(iso).toLocaleString('sv-SE', {dateStyle:'short',timeStyle:'short'}) : '–';

export default function App() {
  const [status, setStatus] = useState<Status|null>(null);
  const [data, setData] = useState<Page>({items:[],total:0});
  const [newOnly,setNewOnly] = useState(false);
  const [page,setPage] = useState(1);
  const [error,setError] = useState<string|null>(null);
  const [loading,setLoading] = useState(false);
  useEffect(() => { setPage(1); },[newOnly]);
  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      try {
        const [sr,lr] = await Promise.all([
          fetch('/api/status', {cache:'no-store'}),
          fetch('/api/items?page=' + page + '&limit=48&newOnly=' + (newOnly ? '1':'0'), {cache:'no-store'})
        ]);
        if (!sr.ok || !lr.ok) throw new Error('HTTP ' + (sr.ok ? lr.status : sr.status));
        const [s,l] = await Promise.all([sr.json() as Promise<Status>,lr.json() as Promise<Page>]);
        if (!cancelled) {setStatus(s);setData(l);setError(null);}
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {if (!cancelled) setLoading(false);}
    }
    void reload();
    const timer = window.setInterval(() => { void reload(); },30000);
    return () => {cancelled=true;window.clearInterval(timer);};
  },[page,newOnly]);
  const maxPage = Math.max(1,Math.ceil(data.total/48));
  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="dice">🎲</span><div><h1>Tradera Watch</h1><p>Bevakning av brädspel på Tradera</p></div></div>
      <span className={'pill ' + (status?.configured && !status.lastError ? 'online':'offline')}>
        <span className="dot" /> {status?.scanning ? 'Skannar …' : status?.configured && !status.lastError ? 'Bevakning aktiv' : 'Behöver åtgärd'}
      </span>
    </header>
    <main>
      <section className="hero">
        <div><div className="eyebrow">ANNONSBEVAKNING · SPRINT 1</div>
          <h2>Hitta nästa spel till samlingen.</h2>
          <p>Nya annonser sparas automatiskt. Första körningen bygger upp en baslinje.</p></div>
        <div className="hero-symbol" aria-hidden="true">♟</div>
      </section>
      <section className="metrics" aria-label="Statistik">
        <div className="metric"><span>Observerade annonser</span><strong>{status?.total ?? '–'}</strong></div>
        <div className="metric"><span>Upptäckta efter baslinjen</span><strong>{status?.newItems ?? '–'}</strong></div>
        <div className="metric"><span>Senaste skanning</span><strong className="small">{date(status?.lastScan?.finishedAt ?? null)}</strong></div>
        <div className="metric"><span>Kontrollintervall</span><strong className="small">{status ? Math.round(status.intervalSeconds/60) + ' minuter' : '–'}</strong></div>
      </section>
      {!status?.configured && status && <div className="notice">⚠️ API-nycklar saknas. Lägg in TRADERA_APP_ID och TRADERA_APP_KEY i din .env-fil.</div>}
      {status?.lastError && <div className="notice">⚠️ {status.lastError}</div>}
      {error && <div className="notice">Kunde inte uppdatera sidan: {error}</div>}
      <section className="listing-header">
        <div><div className="eyebrow">SENASTE FYNDEN</div><h3>Annonser <span>({data.total})</span></h3>
          <p>Kategori {status?.categoryId ?? 181806}{status?.query ? ' · Sökord: ' + status.query : ''}</p></div>
        <label className="toggle"><input type="checkbox" checked={newOnly} onChange={e=>setNewOnly(e.target.checked)}/>
          Visa endast nytillkomna</label>
      </section>
      {data.items.length ? <div className="grid">{data.items.map(item=>
        <a className="card" key={item.id} href={item.url} target="_blank" rel="noopener noreferrer">
          <div className="image">{item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : <span aria-hidden="true">🎲</span>}
            {item.isNew && <span className="new-tag">NY</span>}</div>
          <div className="card-body"><h4>{item.title}</h4>
            <div className="prices"><strong>{money(item.price)}</strong>
              {item.buyNowPrice !== null && <span>Köp nu {money(item.buyNowPrice)}</span>}</div>
            <div className="card-foot"><span>Upptäckt {date(item.firstSeenAt)}</span><span>↗</span></div>
          </div>
        </a>)}</div>
        : <div className="empty">{loading ? 'Laddar annonser …' :
            newOnly ? 'Inga nytillkomna annonser ännu.' : 'Inga annonser ännu. Kontrollera att API-nycklarna fungerar.'}</div>}
      <nav className="pagination" aria-label="Sidnavigering">
        <button disabled={page===1} onClick={()=>setPage(p=>p-1)}>← Föregående</button>
        <span>Sida {page} av {maxPage}</span>
        <button disabled={page>=maxPage} onClick={()=>setPage(p=>p+1)}>Nästa →</button>
      </nav>
      <footer>Endast annonsbevakning. Bud och köp sker på Tradera. · <a href="https://api.tradera.com/documentation" target="_blank" rel="noreferrer">Tradera API</a></footer>
    </main>
  </div>;
}
