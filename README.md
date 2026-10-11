# Tradera Watch 🎲

Liten, **skrivskyddad** bevakningsapp för annonser om brädspel på Tradera. Node.js 24, TypeScript, React/Vite och SQLite.

## Sprint 1

- Söker Tradera REST v4 i kategorin **Brädspel (181806)** var femte minut.
- Hämtar ett konfigurerbart antal sidor, deduplicerar på Tradera-ID och uppdaterar pris/uppgifter.
- Sparar annonser och framgångsrika skanningar i en beständig SQLite-databas.
- Första **lyckade** skanningen skapar en baslinje, utan att kalla befintliga annonser nya. Senare upptäckta annonser märks **NY**.
- Dashboard med bild, rubrik, pris, köp-nu-pris, länk, ny-filter och sidindelning. Uppdateras var 30:e sekund.
- Hälsokontroll och status på `/api/health`, `/api/status` och annonser på `/api/items`.
- Inga bud, köp eller modifieringar av Tradera-kontot.

## Förbered API-nycklar

1. Registrera en utvecklarapp på [api.tradera.com](https://api.tradera.com/register).
2. Kopiera `.env.example` till `.env`.
3. Fyll i `TRADERA_APP_ID` och `TRADERA_APP_KEY`. **Lägg inte upp .env på GitHub.**

Endast applikationsnycklar krävs; inga användartoken eller OAuth-flöden behövs för sökning.

## Starta lokalt (Node.js 24+)

```bash
git clone https://github.com/unilsson/tradera-watch.git
cd tradera-watch
cp .env.example .env
# Redigera .env
npm install
npm run dev:api
```

Starta separat terminal:

```bash
npm run dev:web
```

Öppna **http://localhost:5173**. API:et nås på port 3001; Vite proxyar `/api`.

För att kontrollera funktionaliteten:

```bash
npm run check
npm test
npm run build
```

Efter byggning kan `npm start` servera frontend och API på `PORT` (standard 3001).

## Docker Compose

```bash
cp .env.example .env
# Ange dina API-nycklar
docker compose up -d --build
docker compose logs -f
```

Öppna **http://localhost:3000** på värddatorn. Databasen lagras i `./data/tradera-watch.sqlite` och behålls vid omstart. Porten binds medvetet till `127.0.0.1`: använd autentiserad reverse proxy om du vill nå appen från andra enheter.

## Konfiguration

| Variabel | Standard | Beskrivning |
|---|---|---|
| `TRADERA_APP_ID` | – | Obligatoriskt applikations-ID |
| `TRADERA_APP_KEY` | – | Obligatorisk applikationsnyckel |
| `TRADERA_CATEGORY_ID` | `181806` | Tradera-kategori för brädspel |
| `TRADERA_QUERY` | tom | Valfritt sökord |
| `TRADERA_ORDER_BY` | `EndDateDescending` | Sökordning |
| `POLL_INTERVAL_SECONDS` | `300` | Kontrollintervall, minst 60 sekunder |
| `MAX_PAGES` | `3` | Max sökresultatsidor per kontroll |
| `DATA_DIR` | `./data` | Databasens mapp |
| `PORT` | `3001` | API-port; Docker ändrar till 3000 |

### Hur säkert upptäcks nya annonser?

**Best effort, inte ett komplett realtidsflöde.** Tradera v4 exponerar `GET /v4/search`, men den offentliga OpenAPI-specifikationen beskriver inte fälten i `SearchResult` och anger inget verifierat publiceringsdatum-sorteringsvärde för denna metod. Vi söker därför med dokumenterad sortering `EndDateDescending`, kontrollerar de första `MAX_PAGES` sidorna och markerar annons-ID som inte synts tidigare. Äldre annonser som kommer in i sökfönstret senare kan därför märkas som nya, och annonser utanför det genomsökta fönstret kan missas.

Efter att du lagt in egna nycklar: följ `docker compose logs -f` vid första skanningen och bekräfta att sökresultatet från v4 passar parsern. Vid schemaändring ger appen ett synligt fel i stället för att tolka det som noll annonser. `/v4/search/by-fixed-criteria` finns, men dess request/response-modeller saknar fält i publicerad specifikation; vi har därför **inte** gissat på dessa parametrar.

Den första skanningen kan hämta äldre annonser. Den aktuella kategorin täcker inte nödvändigtvis alla relaterade underkategorier.

## Säkerhet och drift

- API-nycklar skickas endast server-till-server i `X-App-Id` och `X-App-Key`.
- Webbgränssnittet behöver ingen Tradera-inloggning.
- Appens egna `/api/*`-endpoints saknar inloggning i Sprint 1 och ska **inte** publiceras oskyddat på internet.
- Avslutade annonser behålls som historik; appen garanterar inte att deras status är aktuell.
- Anropstakten påverkas av `MAX_PAGES` × antal kontroller. Respektera Traderas anropsgränser och användarvillkor.

API-dokumentation: [Traderas REST v4](https://api.tradera.com/documentation/rest-getting-started) · [Swagger](https://api.tradera.com/v4/swagger/index.html).

## Kommande sprintar

Anpassningsbara bevakningar för flera spel/kategorier, prisgränser och Pushover/Telegram-notiser.
