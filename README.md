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

## Sprint 2 – egna bevakningar

Via dashboarden kan du nu skapa upp till **åtta individuella bevakningar** med:

- Spelnamn, t.ex. `Terraforming Mars` (matchas skiftläges- och accentokänsligt i annonsrubriken).
- Valfritt maxpris i hela kronor. En annons matchar om budpriset **eller** köp-nu-priset är inom gränsen. Annonser utan pris matchar inte en prisbegränsad bevakning.
- Pausa/återaktivera och ta bort bevakningar.
- Visa samtliga eller enbart nytillkomna träffar för en enskild bevakning.

Varje bevakning använder en **egen Tradera-sökning** inom `TRADERA_CATEGORY_ID`, så smalare sökningar kan hitta spel som ligger utanför de första sidorna i kategorins allmänna sökresultat. Första lyckade sökningen ger bevakningens baslinje och markerar inte dåvarande träffar som nya. Matchningar på följande sökningar registreras utan dubbletter.

**Observera:** "Nya" betyder nya *för vår bevakning*, inte nödvändigtvis publicerade just då. Traderas v4-`GET /search` dokumenterar inte en sortering efter publiceringsdatum. `/search/by-fixed-criteria` omnämner nypublicerade annonser, men specifikationen saknar dess requestfält. Vi använder därför endast det verifierade GET-anropet; inga garantier om att varje nypublicerad annons hittas.

**API-budget:** En standardskanning med 8 aktiva bevakningar och `MAX_PAGES=3` kan göra upp till 27 sökanrop. Med fem minuters intervall blir det maximalt 7776 anrop per dygn. Sänk inte `POLL_INTERVAL_SECONDS` eller höj `MAX_PAGES` utan att kontrollera aktuell API-kvot.

API för bevakningar:

| Metod | URL | Funktion |
|---|---|---|
| GET | `/api/watches` | Lista bevakningar, antal träffar och status |
| POST | `/api/watches` | Skapa: `{"term":"Azul","maxPrice":200}` |
| PATCH | `/api/watches/:id` | Pausa/återuppta: `{"enabled":false}` |
| DELETE | `/api/watches/:id` | Ta bort bevakning och matchhistorik |
| GET | `/api/items?watchId=1&newOnly=1` | Filtrera annonser per bevakning |

Du kan inte redigera sökordet i en befintlig bevakning i Sprint 2. Ta bort och skapa en ny för att byta sökord eller prisgräns. Databasen migreras automatiskt – dina tidigare annonser ligger kvar.

## Sprint 3 – Pushover-notiser

**Valfritt:** Pushover kan skicka en notis för **nya matchningar i en aktiv individuell spelbevakning**. Kategoriskanningen ger inga notiser.

1. Hitta din **User Key** på [pushover.net](https://pushover.net/).
2. Skapa gärna en egen applikation för Tradera Watch på [pushover.net/apps/build](https://pushover.net/apps/build) och kopiera dess **API Token/Key**.
3. Lägg till följande i din **lokala** `.env` (ersätt platshållarna, dela inte nycklarna i chatten eller GitHub):

```dotenv
PUSHOVER_APP_TOKEN=din_app_token
PUSHOVER_USER_KEY=din_user_key
```

4. Starta om med `docker compose up -d --build`, gå till **Pushover** på startsidan och klicka **Skicka testnotis**. Du får en separat Pushover-status med väntande/skickade notiser och eventuella fel.

**Hur det fungerar:** Första lyckade skanningen av varje bevakning etablerar baslinjen och skickar ingenting. Vid senare skanningar sparas en köpost per ny matchande annons och bevakning. Köposten och matchningen skrivs i **samma SQLite-transaktion**. En arbetare skickar upp till tio notiser åt gången, direkt efter skanning och därefter en gång per minut. Misslyckade skickningar provas igen med ökande fördröjning (upp till en timme eller längre om Pushover ger `Retry-After`). En pausad bevakning skickar inga väntande notiser förrän den återaktiveras, och borttagna bevakningar tappar sin notiskö.

Vid lyckat Pushover-svar med `status:1` markeras köposten skickad. Utskick görs **inte** för nya matchningar medan nycklarna saknas: du slipper en flod av gamla notiser när Pushover aktiveras. Om en annons matchar flera bevakningar kan du få en notis per bevakning.

**Leveransgaranti:** Persistensen skyddar mot förlorade notiser vid vanliga nätfel och omstarter. Ett nätfel efter att Pushover tagit emot meddelandet men innan appen fått kvittens kan dock ge **dubbletter** vid ett senare försök (at-least-once). API- och användarnycklar skrivs aldrig till loggen eller skickas till frontend.

Testnotisen kan skickas högst en gång per minut via `POST /api/notifications/test`. Status med skickat/väntande antal finns på `GET /api/status` under `pushover`.

## Sprint 4A – upptäckt, sökstrategi och statistik

**Varför:** Tradera `GET /v4/search` erbjuder sluttidssortering men inte verifierad sortering på publiceringsdatum. `POST /v4/search/by-fixed-criteria` nämner *newly listed*, men dess [offentliga OpenAPI-schema](https://api.tradera.com/v4/swagger/v4/swagger.json) för `SearchByFixedCriteriaRequest` har **inga dokumenterade egenskaper**. Vi anropar därför **inte** detta endpoint med påhittade parametrar. Be gärna Tradera (`apiadmin@tradera.com`) dokumentera hur det ska användas.

Vi breddar i stället täckningen säkert:

- Den befintliga, fungerande `EndDateDescending`-sökningen fortsätter vid **varje skanning** för kategorin och varje aktiv spelbevakning.
- Som standard görs var **tredje** skanning en extra `EndDateAscending`-sökning på **en** resultatsida per kategori/bevakning. Om primär ordning är stigande blir extra ordning fallande.
- Resultat från båda ordningarna slås samman på Tradera-ID **innan** lagring och Pushover. Primär sökning måste lyckas för att skanningen ska registreras som lyckad; om enbart extrasökningen misslyckas används de primära resultaten och ett synligt varningsfält lagras.
- Extrakörningar stängs automatiskt av om **beräknat maximalt antal API-anrop** skulle överstiga **9 000/dygn** med nuvarande antal aktiva bevakningar, intervall och sidgränser. Primärsökningen fortsätter då som tidigare. Det är en uppskattning, inte en serverstyrd kvot; återförsök, andra applikationer och ändringar i Traderas regler kan påverka faktiskt förbrukning.

**Skillnaden mellan nyupptäckt och nyligen startad:** För en post som vi först såg efter en bevaknings baslinje är den `NYLIGEN STARTAD` om Traderas `startDate` ligger **0–24 timmar före upptäcktstidpunkten**. Om startdatumet är äldre står `NYUPPTÄCKT`, och om datumet är okänt/felaktigt behandlas det som okänt. `startDate` är inte oberoende verifierat som publiceringsdatum vid återpublicering. Bedömningen baseras på **första upptäckten**, inte på när du öppnar dashboarden. Pushover skickas fortsatt för nya **matchningar**, även om startdatum är äldre/okänt.

**Sökstatistik:** Dashboarden har nu en översikt med sökanrop, antal besökta resultatsidor, nyupptäckta med nyligt startdatum, äldre/okända och en utfällbar lista över de senaste tolv sökningarna (inklusive extra sortering, varningar och sidgräns). `GET /api/discovery` visar rådata och senaste 24 timmarnas summeringar. Anrop räknas även när Tradera svarar med fel. Statistiklagringen startar först vid uppgraderingen och ändrar **inte** tidigare SQLite-historik eller Pushover-kön.

```dotenv
SECONDARY_SEARCH_EVERY=3   # var tredje skanning (0 = avstängd)
SECONDARY_SEARCH_PAGES=1   # 1–3 resultatsidor vid extra sökning
```

De här inställningarna är **valfria**, standarderna gäller även med befintlig `.env`. Med 8 aktiva bevakningar, 5-minutersintervall och 3 primära resultatsidor blir den uppskattade övre gränsen **8 640 sökanrop per dygn**, förutsatt att alla resultatsidor faktiskt hämtas.

**Begränsning:** Fler sorteringsordningar minskar blinda fläckar men garanterar inte att alla annonser hittas. Måtten avser **nyupptäckta matchningar per sökning** (samma annons kan räknas i flera bevakningar), inte unika annonser eller försäljningar.

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
| `SECONDARY_SEARCH_EVERY` | `3` | Extra motsatt sluttidssortering var N:e skanning, 0 = av |
| `SECONDARY_SEARCH_PAGES` | `1` | Max antal extra resultatsidor (1–3) |
| `DATA_DIR` | `./data` | Databasens mapp |
| `PORT` | `3001` | API-port; Docker ändrar till 3000 |
| `PUSHOVER_APP_TOKEN` | tom | Valfri app-token från Pushover |
| `PUSHOVER_USER_KEY` | tom | Valfri mottagarnyckel från Pushover |

### Hur säkert upptäcks nya annonser?

**Best effort, inte ett komplett realtidsflöde.** Tradera v4 exponerar `GET /v4/search`, men den offentliga OpenAPI-specifikationen beskriver inte fälten i `SearchResult` och anger inget verifierat publiceringsdatum-sorteringsvärde för denna metod. Vi söker därför med dokumenterad sortering `EndDateDescending`, kontrollerar de första `MAX_PAGES` sidorna och markerar annons-ID som inte synts tidigare. Äldre annonser som kommer in i sökfönstret senare kan därför märkas som nya, och annonser utanför det genomsökta fönstret kan missas.

Efter att du lagt in egna nycklar: följ `docker compose logs -f` vid första skanningen och bekräfta att sökresultatet från v4 passar parsern. Vid schemaändring ger appen ett synligt fel i stället för att tolka det som noll annonser. `/v4/search/by-fixed-criteria` finns, men dess request/response-modeller saknar fält i publicerad specifikation; vi har därför **inte** gissat på dessa parametrar.

Den första skanningen kan hämta äldre annonser. Den aktuella kategorin täcker inte nödvändigtvis alla relaterade underkategorier.

## Säkerhet och drift

- API-nycklar skickas endast server-till-server i `X-App-Id` och `X-App-Key`.
- Webbgränssnittet behöver ingen Tradera-inloggning.
- Appens egna `/api/*`-endpoints saknar inloggning i Sprint 1–3 och ska **inte** publiceras oskyddat på internet.
- Avslutade annonser behålls som historik; appen garanterar inte att deras status är aktuell.
- Anropstakten påverkas av `MAX_PAGES` × antal kontroller. Respektera Traderas anropsgränser och användarvillkor.

API-dokumentation: [Traderas REST v4](https://api.tradera.com/documentation/rest-getting-started) · [Swagger](https://api.tradera.com/v4/swagger/index.html).

## Kommande sprintar

Verklig publiceringsdatum-sortering om Tradera dokumenterar ett stött anrop, redigering av befintliga bevakningar och eventuellt Telegram-notiser.
