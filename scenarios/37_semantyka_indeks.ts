/**
 * 37_semantyka_indeks — semantyka NA ŻYWO: własny indeks Oramy + `search` w trybie wektorowym.
 *
 * PO CO: do Poligonu harness nie dotknął ANI RAZU warstwy semantycznej — fixture nie ma providera
 * embeddingów, więc produkcyjny `plugin.vaultIndexer` degraduje do `no_provider`, a `search`
 * cicho spada na keyword. Ten scenariusz stawia PRAWDZIWY `VaultIndexer` (ten sam kod, który
 * `src/main.ts` odpala u usera) na deterministycznym, fałszywym embedderze i sprawdza, że:
 *
 *   1. indeks się buduje i publikuje jako `plugin.oramaDb` (kontrakt, na którym stoi `SearchTool`),
 *   2. `search {mode:'semantic'}` FAKTYCZNIE idzie przez wektory — poznajemy to po `mode_used`,
 *      które przy pustym rankingu wektorowym spadłoby na `'keyword'` (fallback z `RetrievalEngine`),
 *   3. indeks NIE zawiera pamięci agentów (`.pkm-assistant/`) ani folderów No-Go — to twarda
 *      granica z E1.4, nie optymalizacja,
 *   4. `scope:'memory'` NIGDY nie używa semantyki (izolacja pamięci od indeksu vaulta) i mówi
 *      o tym wprost notą degradacji. **To jest zachowanie KONTRAKTOWE, nie luka** — dokumenty
 *      vaulta nie mają prawa wypłynąć jako „pamięć agenta".
 *
 * FAŁSZYWY EMBEDDER: worek słów zahaszowany do `DIM` wymiarów + normalizacja L2. Determinizm bez
 * sieci i bez modelu; dokumenty o wspólnym słownictwie mają wysoki cosinus, o rozłącznym — niski.
 * Wchodzi PRODUKCYJNĄ drogą: podstawiamy model pod `env.embeddings.default` (ten sam getter,
 * który w produkcji rozstrzyga rejestr z ustawień usera), więc i indeksowanie, i embedding
 * ZAPYTANIA biegną przez ten sam, prawdziwy `EmbeddingHelper` — dokładnie jak w `src/main.ts`.
 * `VaultIndexer` dostaje fasadę przez `createEmbedderFacade()` — tę samą drogę co produkcja,
 * nie ręcznie sklejone metody.
 *
 * Bieg jest offline-only: żywa semantyka wymaga prawdziwego providera embeddingów (Faza 2).
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { VaultIndexer, countDocs, searchVectorTopK, createEmbedderFacade } from '@plugin/modules/embedding/index.js';
// Deep-import świadomy (trzeci taki w tym repo, po 33_skill_marker i 35_artefakt_approval —
// patrz README, sekcja "Jak kod pluginu wchodzi do harnessu"): kroki C/D budują PRAWDZIWY dump
// Oramy v1, a `createEmbeddingDb`/`insertVectorLean`/`serialize` NIE wychodzą z barrela
// `modules/embedding/index.js` (nie są publicznym API modułu - `VaultIndexer` jest jedynym
// produkcyjnym wołaczem). Alternatywa ze SPEC_H37 ("create/insert/save z @orama/orama wprost")
// nie działa STĄD: `@orama/orama` siedzi wyłącznie w node_modules REPO PLUGINU (rozwiązywanego
// przez alias `@plugin/`), a pliki TEGO repo (harnessu) rozwiązują bare importy z WŁASNEGO
// node_modules, gdzie tej paczki nie ma [measured: `ls node_modules/@orama` w tym repo - brak].
import { createEmbeddingDb, insertVectorLean, serialize } from '@plugin/modules/embedding/orama_engine.js';
import { EmbeddingHelper } from '@plugin/modules/memory/index.js';
import { assert, assertFinalText, assertToolOk } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';
import type { EmbedderFacade, IndexerNotice } from '@plugin/modules/embedding/index.js';

const NOTATKA_IGLA = 'Notatki/zeglarstwo.md';
const NOTATKA_ODWRACAJACA = 'Notatki/kuchnia.md';
const NOTATKA_BRAIN = '.pkm-assistant/agents/tester/memory/brain/reference_igla_pamieci.md';

/**
 * Fraza wektorowa: same słowa WYSTĘPUJĄCE DOSŁOWNIE w notatce-igle i w żadnej innej.
 * Atrapa embeddera jest workiem słów, więc odmiana („trymowanie" vs „trymowania") to dla niej
 * dwa różne tokeny — fraza celowo omija formy odmienione.
 */
const ZAPYTANIE_SEMANTYCZNE = 'regaty grota sternik spinaker bojka';
/** Fraza pamięci — `_keywordRank` szuka CAŁEJ frazy jako podciągu, więc musi być dosłowna. */
const FRAZA_PAMIECI = 'znacznik pamieci harnessu';
/** Słowa z notatki No-Go i z pamięci — żadne z nich nie ma prawa być w indeksie vaulta. */
const ZAPYTANIE_ZAKAZANE = 'sekret rekwizytowy znacznik pamieci harnessu tajne';

const ODPOWIEDZ = 'Semantyka odnalazla notatke o zeglarstwie.';

/**
 * Wymiar wektora atrapy. 256, nie 32 — przy ciasnym worku kolizje haszy dawały wysoki cosinus
 * krótkim notatkom o ZEROWYM wspólnym słownictwie (pierwszy bieg scenariusza wypchnął na szczyt
 * `Notatki/referencje.md`). To nie był błąd produkcji, tylko za słaba atrapa embeddera.
 */
const DIM = 256;

/** Klucz modelu atrapy embeddera — wspólny dla WSZYSTKICH indekserów w tym scenariuszu (główny
 *  z `setup()` + drugorzędne z kroków B-E), bo `VaultIndexer._restoreFromV2`/`_migrateV1` robi
 *  pełny rebuild zamiast restore/migracji, gdy `meta.model_key` różni się od żywego adaptera. */
const FAKE_MODEL_KEY = 'harness:fake-hash-embed';

/** Uchwyt na indekser scenariusza (asercje czytają, co realnie weszło do indeksu). */
const stan: { indexer: FixturePayload } = { indexer: null };

/** Tokenizacja pod atrapę embeddera: małe litery, polskie znaki, słowa dłuższe niż 3 znaki. */
function tokeny(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-ząćęłńóśźż0-9]+/)
    .filter((t) => t.length > 3);
}

/** Worek słów zahaszowany do DIM wymiarów + normalizacja L2 (deterministyczne, bez sieci). */
function wektor(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of tokeny(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    v[Math.abs(h) % DIM] += 1;
  }
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norma === 0) return v;
  return v.map((x) => x / norma);
}

export default ({
  file: '37_semantyka_indeks',
  name: 'semantyka indeks',
  opis: 'VaultIndexer na wstrzykniętym embedderze: search mode=semantic trafia w notatkę-igłę, indeks omija No-Go i pamięć, scope=memory zostaje bez semantyki',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 3,
  liveSkip: 'semantyka stoi na wstrzykniętym, deterministycznym embedderze — bieg z prawdziwym providerem to Faza 2',

  fixtures: [
    {
      // Notatka-igła: słownictwo rozłączne z resztą fixture'u (harness/projekt/powitanie).
      path: NOTATKA_IGLA,
      content: [
        '---',
        'tytul: Żeglarstwo śródlądowe',
        'tagi: [harness, semantyka]',
        '---',
        '',
        '# Żeglarstwo śródlądowe',
        '',
        'Regaty na jeziorze wymagają trymowania grota i foka. Sternik pilnuje halsu,',
        'a załoga balastuje burtę przy każdym nawrocie. Bojka wyznacza zwrot, bezwietrzna',
        'cisza kończy wyścig, a spinaker rozwija się dopiero na baksztagu.',
        '',
      ].join('\n'),
    },
    {
      // Notatka odwracająca uwagę: inne słownictwo, ta sama długość rzędu wielkości.
      path: NOTATKA_ODWRACAJACA,
      content: [
        '---',
        'tytul: Kuchnia domowa',
        'tagi: [harness, semantyka]',
        '---',
        '',
        '# Kuchnia domowa',
        '',
        'Zakwas na żurek dojrzewa tydzień w kamionce. Piekarnik nagrzewamy do dwustu',
        'stopni, ciasto drożdżowe wyrasta pod ściereczką, a bulion gotujemy na wolnym',
        'ogniu razem z warzywami i przyprawami.',
        '',
      ].join('\n'),
    },
    {
      // Notatka pamięci Testera — materiał na scope=memory (i dowód, że NIE wchodzi do indeksu).
      path: NOTATKA_BRAIN,
      content: [
        '---',
        'name: "igla pamieci"',
        'description: "rekwizyt scenariusza semantyki"',
        'type: reference',
        'created: 2026-07-31',
        '---',
        `To jest ${FRAZA_PAMIECI} — notatka trwała agenta Tester.`,
        '',
        '**Why:** pamięć agenta ma być znajdowana po słowie kluczowym, ale NIGDY przez indeks vaulta.',
        '',
      ].join('\n'),
    },
  ],

  /**
   * Postawienie ŻYWEGO indeksu semantycznego na atrapie embeddera.
   *
   * Kolejność ma znaczenie: produkcyjny `plugin.vaultIndexer` zdążył się już (w `initialize()`
   * pluginu) rozstrzygnąć na `no_provider` i zwrócić — dlatego podmiana adaptera TERAZ niczego
   * mu nie odpala. Budujemy własny indekser tymi samymi zależnościami co `src/main.ts`
   * i podstawiamy go pod `plugin.vaultIndexer`, żeby ewentualne noty degradacji mówiły prawdę.
   */
  async setup({ plugin }) {
    stan.indexer = null;

    const rejestr = plugin?.env?.embeddings as FixturePayload;
    if (!rejestr) throw new Error('Brak env.embeddings — bootstrap rejestru nieukończony?');

    // Atrapa modelu embeddingu w kontrakcie `EmbeddingModelLike` (`embed(texts) => [{vector}]`).
    // `default` jest getterem na rejestrze i bez skonfigurowanego providera oddaje `null`
    // (R7 — fail-closed, zero sieci) — dlatego przesłaniamy go własnością własną instancji,
    // zamiast podmieniać cały rejestr. Reszta rejestru zostaje nietknięta.
    Object.defineProperty(rejestr, 'default', {
      configurable: true,
      get: () => ({
        modelKey: FAKE_MODEL_KEY,
        dims: DIM,
        async embed(texts: string[]) {
          return texts.map((t) => ({ vector: wektor(t) }));
        },
      }),
    });

    const helper = new EmbeddingHelper(plugin.env);
    if (!helper.isReady()) {
      throw new Error('EmbeddingHelper nie widzi wstrzykniętego modelu — ścieżka env.embeddings.default się rozjechała.');
    }

    const indexer = new VaultIndexer({
      plugin,
      vault: plugin.app.vault,
      // Ta sama droga co `src/main.ts` — fasada budowana nad rejestrem, nie ręcznie sklejana.
      embedder: createEmbedderFacade(rejestr),
      isMobile: false,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
    });
    await indexer.initialize();

    const status = indexer.getStatus();
    if (status.status !== 'ready') {
      throw new Error(`VaultIndexer nie doszedł do 'ready' (jest '${status.status}', błąd: ${status.lastError || '-'}).`);
    }
    plugin.vaultIndexer = indexer;
    stan.indexer = indexer;
  },

  offlineScript: [
    toolCallTurn('search', { query: ZAPYTANIE_SEMANTYCZNE, scope: 'vault', mode: 'semantic', limit: 3 }),
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, plugin }) {
    // ── 1. Indeks żyje i jest opublikowany tam, gdzie szuka go SearchTool ──
    assert(plugin?.oramaDb, 'VaultIndexer nie opublikował `plugin.oramaDb` — SearchTool nie miałby z czego czytać.');
    const liczbaDokumentow = countDocs(plugin.oramaDb);
    assert(
      liczbaDokumentow >= 5,
      `Indeks ma ${liczbaDokumentow} dokumentów, a fixture ma ich co najmniej 5 (3 rekwizyty + igła + odwracająca).`,
    );

    // ── 2. Twarda granica indeksu: żadnej pamięci agentów, żadnego No-Go ──
    const zaindeksowane = [...(stan.indexer?._mtimes?.keys?.() || [])] as string[];
    assert(
      zaindeksowane.includes(NOTATKA_IGLA),
      `Notatka-igła nie weszła do indeksu. Zaindeksowane: ${zaindeksowane.join(', ') || '(brak)'}`,
    );
    const przecieki = zaindeksowane.filter((p) => p.startsWith('.pkm-assistant/') || p.startsWith('Sekrety/'));
    assert(
      przecieki.length === 0,
      `Do indeksu semantycznego weszły ścieżki, których NIGDY tam być nie może (pamięć agentów / No-Go): ${przecieki.join(', ')}`,
    );
    // Ta sama granica sprawdzona od strony WYSZUKIWANIA, nie tylko listy plików.
    const zakazane = await searchVectorTopK(plugin.oramaDb, wektor(ZAPYTANIE_ZAKAZANE), { k: 20 });
    const trafieniaZakazane = (zakazane?.hits || [])
      .map((h: FixturePayload) => String(h?.document?.path || ''))
      .filter((p: string) => p.startsWith('.pkm-assistant/') || p.startsWith('Sekrety/'));
    assert(
      trafieniaZakazane.length === 0,
      `Wyszukiwanie wektorowe zwróciło ścieżki spoza dozwolonego zakresu: ${trafieniaZakazane.join(', ')}`,
    );

    // ── 3. `search mode=semantic` poszedł REALNIE przez wektory ──
    // `mode_used` jest jedynym uczciwym świadkiem: gdyby ranking wektorowy był pusty,
    // RetrievalEngine spadłby na `'keyword'` (ta sama gałąź co dawny vault_semantic).
    const szukanie = assertToolOk(result, 'search');
    const podglad = szukanie.resultPreview || '';
    assert(
      podglad.includes('"mode_used":"semantic"'),
      `search nie użył semantyki (spadł na keyword?). Podgląd: ${podglad.slice(0, 300)}`,
    );
    const pierwszy = /"results":\[\{"path":"([^"]+)"/.exec(podglad);
    assert(
      pierwszy && pierwszy[1] === NOTATKA_IGLA,
      `Najlepszym trafieniem semantycznym miała być „${NOTATKA_IGLA}", a jest „${pierwszy?.[1] ?? '(brak wyników)'}". `
      + `Podgląd: ${podglad.slice(0, 300)}`,
    );
    // Ranking wektorowy sprawdzony też WPROST (podgląd wyniku narzędzia jest ucinany do 500
    // znaków, więc dalsze pozycje i tak by się w nim nie zmieściły).
    const ranking = await searchVectorTopK(plugin.oramaDb, wektor(ZAPYTANIE_SEMANTYCZNE), { k: 10 });
    const trafienia = (ranking?.hits || []).map((h: FixturePayload) => String(h?.document?.path || ''));
    assert(
      trafienia[0] === NOTATKA_IGLA,
      `Ranking wektorowy nie stawia notatki-igły na pierwszym miejscu: ${trafienia.join(', ') || '(brak trafień)'}`,
    );
    assert(
      !trafienia.includes(NOTATKA_ODWRACAJACA),
      `Notatka o rozłącznym słownictwie („${NOTATKA_ODWRACAJACA}") przeszła próg podobieństwa — atrapa embeddera nie różnicuje dokumentów.`,
    );

    // ── 4. scope=memory: keyword TAK, semantyka NIGDY (zachowanie kontraktowe) ──
    // Drugie wywołanie idzie produkcyjnym egzekutorem (wzór `lib/runTurn.ts`), więc
    // przechodzi przez ten sam łańcuch uprawnień co wywołanie z pętli — tylko bez modelu.
    const pamiec = await plugin.mcpClient.executeToolCall(
      { id: 'harness-37-memory', name: 'search', arguments: { query: FRAZA_PAMIECI, scope: 'memory', limit: 5 } },
      'Tester',
      { autonomy: 'edge' },
    ) as FixturePayload;

    assert(pamiec?.success === true, `search scope=memory zwrócił błąd: ${JSON.stringify(pamiec).slice(0, 300)}`);
    const sciezki = (pamiec.results || []).map((r: FixturePayload) => String(r.path));
    assert(
      sciezki.some((p: string) => p.endsWith('reference_igla_pamieci.md')),
      `Notatka pamięci nie została znaleziona po słowie kluczowym. Wyniki: ${sciezki.join(', ') || '(brak)'}`,
    );
    assert(
      pamiec.mode_used === 'keyword',
      `scope=memory ma iść WYŁĄCZNIE keywordem (izolacja pamięci od indeksu vaulta), a mode_used=${pamiec.mode_used}.`,
    );
    assert(
      typeof pamiec.note === 'string' && pamiec.note.length > 0,
      'Brak noty degradacji przy scope=memory — model dostałby ciche wyniki keyword udające semantykę.',
    );

    // ── 4b. BEZ scope: agent główny z pamięcią szuka domyślnie we WŁASNEJ pamięci ──
    // Kontrakt `search` od frontu A „Indeks semantyczny i search v2": vault tylko na jawne
    // scope:"vault". Wynik musi mówić modelowi wprost, co przeszukano i jak poszerzyć zakres,
    // inaczej pusty wynik z pamięci udawałby „nie ma takiej notatki w vaultcie".
    const domyslny = await plugin.mcpClient.executeToolCall(
      { id: 'harness-37-default', name: 'search', arguments: { query: FRAZA_PAMIECI, limit: 5 } },
      'Tester',
      { autonomy: 'edge' },
    ) as FixturePayload;

    assert(domyslny?.success === true, `search bez scope zwrócił błąd: ${JSON.stringify(domyslny).slice(0, 300)}`);
    assert(
      domyslny.scope === 'memory',
      `search bez scope ma iść w pamięć agenta, a poszedł w scope=${domyslny.scope}.`,
    );
    const sciezkiDomyslne = (domyslny.results || []).map((r: FixturePayload) => String(r.path));
    assert(
      sciezkiDomyslne.some((p: string) => p.endsWith('reference_igla_pamieci.md')),
      `search bez scope nie znalazł notatki pamięci. Wyniki: ${sciezkiDomyslne.join(', ') || '(brak)'}`,
    );
    assert(
      typeof domyslny.scope_hint === 'string' && domyslny.scope_hint.includes('scope: "vault"'),
      `Brak podpowiedzi poszerzenia zakresu przy domyślnym scope=memory. scope_hint=${JSON.stringify(domyslny.scope_hint)}`,
    );
    assert(
      !('scope_hint' in pamiec),
      'Jawne scope=memory nie powinno nieść scope_hint — podpowiedź jest tylko dla zakresu DOMYŚLNEGO.',
    );

    // ── 5. Pętla domknęła się odpowiedzią ──
    const finalText = assertFinalText(result);
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );

    // ══════════════════════════════════════════════════════════════════════════════════
    // A-E (SPEC_H37) — format indeksu v2 na dysku: persist / restore bez embeddingu /
    // migracja v1→v2 (sukces i pad) / segment uszkodzony. Sekcje 1-5 wyżej sprawdzają tylko
    // żywe API (`search`, `plugin.oramaDb`) na indekserze z `setup()` — NIC z tego nie dotyka
    // fizycznego formatu `.pkm-assistant/index/**`, więc te kroki są czerwone na kodzie SPRZED
    // formatu v2 (patrz komentarz przy każdym kroku, co konkretnie nie istniałoby w v1).
    // ══════════════════════════════════════════════════════════════════════════════════

    // A. Persist v2 po skanie. `_fullScan()` (VaultIndexer.ts) woła `await this._persistNow()`
    // WPROST na końcu, nie przez `_schedulePersist()` — więc do czasu, gdy `setup()` domknęło
    // `await indexer.initialize()`, meta + segment JUŻ leżą na dysku (bez potrzeby zerowania
    // `persistDebounceMs`, które steruje TYLKO zapisem po zmianach na żywym indeksie).
    // Na kodzie v1 `vault-index.meta.json` nie miałaby pola `segments` (dopiero v2 dzieli
    // wektory na segmenty binarne) — ten fragment byłby czerwony na samym pierwszym `assert`.
    const DEFAULT_INDEX_DIR = '.pkm-assistant/index';
    const metaPathA = `${DEFAULT_INDEX_DIR}/vault-index.meta.json`;
    assert(
      await plugin.app.vault.adapter.exists(metaPathA),
      `Brak ${metaPathA} po initialize() — VaultIndexer nie spersystował indeksu v2 od razu po skanie.`,
    );
    const metaA = JSON.parse(await plugin.app.vault.adapter.read(metaPathA)) as FixturePayload;
    assert(metaA.version === 2, `meta.version powinno być 2, jest ${metaA.version}.`);
    assert(
      Array.isArray(metaA.segments) && metaA.segments.length === 1,
      `Po pierwszym skanie oczekiwano dokładnie 1 segmentu, jest ${metaA.segments?.length}.`,
    );
    const segPathA = `${DEFAULT_INDEX_DIR}/${metaA.segments[0].file}`;
    const segBufA: ArrayBuffer = await plugin.app.vault.adapter.readBinary(segPathA);
    const oczekiwaneBajtyA = 16 + metaA.segments[0].rows * metaA.dims * 4;
    assert(
      segBufA.byteLength === oczekiwaneBajtyA,
      `Segment ${metaA.segments[0].file} ma ${segBufA.byteLength} B, oczekiwano ${oczekiwaneBajtyA} `
      + `(16 + ${metaA.segments[0].rows}×${metaA.dims}×4).`,
    );
    assert(
      Object.keys(metaA.rows).length === liczbaDokumentow,
      `meta.rows ma ${Object.keys(metaA.rows).length} wpisów, a countDocs(plugin.oramaDb)=${liczbaDokumentow}.`,
    );

    // B. Restore v2 BEZ embeddingu: drugi VaultIndexer na TYM SAMYM vaultcie (te same pliki,
    // które właśnie zapisał krok A) ma odtworzyć indeks WYŁĄCZNIE z segmentów binarnych —
    // zero wywołań embeddera. Na kodzie v1 nie było segmentów do odtworzenia bez embeddingu:
    // `_tryRestore` w wersji v1 nie istniał w tej postaci, każdy restart re-embedowałby wszystko
    // (`wywolaniaEmbedderaB === 0` byłoby fałszywe).
    let wywolaniaEmbedderaB = 0;
    const embedderB: EmbedderFacade = {
      isReady: () => true,
      getModelKey: () => FAKE_MODEL_KEY,
      getDims: () => DIM,
      async embedBatch(texts: string[]) {
        wywolaniaEmbedderaB += texts.length;
        return texts.map((t) => wektor(t));
      },
    };
    const indexerB = new VaultIndexer({
      plugin: {},
      vault: plugin.app.vault,
      embedder: embedderB,
      isMobile: false,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
    });
    await indexerB.initialize();
    assert(
      indexerB.getStatus().status === 'ready',
      `Restore drugiego VaultIndexera nie doszedł do 'ready': ${JSON.stringify(indexerB.getStatus())}.`,
    );
    assert(
      wywolaniaEmbedderaB === 0,
      `Restore v2 wywołał embedder ${wywolaniaEmbedderaB} razy zamiast zera — indeks NIE został odtworzony z dysku.`,
    );
    assert(
      countDocs(indexerB.db) === liczbaDokumentow,
      `Po restore countDocs=${countDocs(indexerB.db)}, a przed restartem było ${liczbaDokumentow}.`,
    );
    const rankingB = await searchVectorTopK(indexerB.db!, wektor(ZAPYTANIE_SEMANTYCZNE), { k: 5 });
    const topB = (rankingB?.hits || [])[0]?.document?.path;
    assert(topB === NOTATKA_IGLA, `Po restore top-1 semantyczny to „${topB}", a powinna być igła.`);
    indexerB.dispose();

    // ── Materiał wspólny dla C/D/E: PRAWDZIWY dump v1 (Orama) tych samych notatek, które w TEJ
    // CHWILI widzi VaultIndexer (igła + odwracająca + 3 z fixture'u domyślnego = 5, Sekrety/
    // wykluczone jak w produkcji), z PRAWDZIWYMI mtime'ami (`Vault#getMarkdownFiles`) — pancerz
    // migracji wymaga, żeby te mtime zgadzały się z tym, co `_resync()` odczyta PO migracji,
    // inaczej resync re-embedowałby notatki, które migracja miała już przenieść.
    const notatkiWTejChwili = (plugin.app.vault.getMarkdownFiles() as FixturePayload[])
      .filter((f: FixturePayload) => !String(f.path).startsWith('Sekrety/'));
    assert(
      notatkiWTejChwili.length === liczbaDokumentow,
      `Do migracji spodziewano się ${liczbaDokumentow} notatek indeksowalnych, jest ${notatkiWTejChwili.length}.`,
    );
    const notatkiZTrescia = await Promise.all(notatkiWTejChwili.map(async (f: FixturePayload) => ({
      path: String(f.path),
      mtime: Number(f.stat.mtime),
      content: await plugin.app.vault.adapter.read(f.path) as string,
    })));
    const titleOf = (p: string): string => (p.split('/').pop() || p).replace(/\.md$/i, '');
    const schemaV1 = { id: 'string', path: 'string', title: 'string', mtime: 'number', embedding: `vector[${DIM}]` };
    const dbV1 = await createEmbeddingDb(schemaV1 as FixturePayload);
    for (const n of notatkiZTrescia) {
      await insertVectorLean(dbV1, {
        id: n.path, path: n.path, title: titleOf(n.path), mtime: n.mtime, embedding: wektor(n.content),
      });
    }
    const v1Text = JSON.stringify(await serialize(dbV1));
    const metaV1Text = JSON.stringify({
      version: 1,
      model_key: FAKE_MODEL_KEY,
      dims: DIM,
      mtimes: Object.fromEntries(notatkiZTrescia.map((n) => [n.path, n.mtime])),
    });

    // C. Migracja v1→v2 z pancerzem — ścieżka SUKCESU. Na kodzie v1 `vault-index.json` byłby
    // czytany bezpośrednio przez Oramę (`load()`), nie migrowany — `indexerC.db` istniałby, ale
    // `${INDEX_DIR_C}/vault-index.meta.json` nigdy nie dostałoby `version:2` ani `segments`,
    // więc `metaC.version === 2` byłoby czerwone na starym kodzie.
    const INDEX_DIR_C = '.pkm-assistant/index-migracja-ok';
    await plugin.app.vault.adapter.write(`${INDEX_DIR_C}/vault-index.json`, v1Text);
    await plugin.app.vault.adapter.write(`${INDEX_DIR_C}/vault-index.meta.json`, metaV1Text);
    const noticesC: IndexerNotice[] = [];
    const embedowaneTekstyC: string[] = [];
    const embedderC: EmbedderFacade = {
      isReady: () => true,
      getModelKey: () => FAKE_MODEL_KEY,
      getDims: () => DIM,
      async embedBatch(texts: string[]) {
        embedowaneTekstyC.push(...texts);
        return texts.map((t) => wektor(t));
      },
    };
    const indexerC = new VaultIndexer({
      plugin: {},
      vault: plugin.app.vault,
      embedder: embedderC,
      isMobile: false,
      indexDir: INDEX_DIR_C,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
      notify: (n) => noticesC.push(n),
    });
    await indexerC.initialize();
    assert(
      !(await plugin.app.vault.adapter.exists(`${INDEX_DIR_C}/vault-index.json`)),
      'Po udanej migracji stary vault-index.json nadal istnieje.',
    );
    const metaC = JSON.parse(await plugin.app.vault.adapter.read(`${INDEX_DIR_C}/vault-index.meta.json`)) as FixturePayload;
    assert(metaC.version === 2, `Po migracji meta.version powinno być 2, jest ${metaC.version}.`);
    assert(metaC.segments.length === 1, `Po migracji oczekiwano 1 segmentu, jest ${metaC.segments.length}.`);
    assert(
      embedowaneTekstyC.length === 0,
      `Migracja miała ominąć embedding zmigrowanych notatek, a embedder dostał ${embedowaneTekstyC.length} tekstów.`,
    );
    assert(
      noticesC.some((n) => n.kind === 'migrated'),
      `Brak powiadomienia 'migrated' po udanej migracji. Notices: ${JSON.stringify(noticesC)}.`,
    );
    const rankingC = await searchVectorTopK(indexerC.db!, wektor(ZAPYTANIE_SEMANTYCZNE), { k: 5 });
    const topC = (rankingC?.hits || [])[0]?.document?.path;
    assert(topC === NOTATKA_IGLA, `Po migracji top-1 semantyczny to „${topC}", a powinna być igła.`);
    indexerC.dispose();

    // D. Migracja PADA (writeBinary rzuca RAZ, przy zapisie segmentu bazowego) → stary plik
    // zostaje, dopóki nowy v2 nie jest zapisany z sukcesem; indeks idzie od zera (embedder
    // wywołany); po udanym persist v2 tego rebuildu stary plik znika. `throwOnceAdapter` rzuca
    // WYŁĄCZNIE przy pierwszym `writeBinary` — to jest DOKŁADNIE zapis segmentu migracji
    // (`_migrateV1`, jedyny `writeBinary` przed tym momentem); drugi `writeBinary` (segment
    // świeżego pełnego skanu, w `_persistNow` po `_fullScan`) przechodzi. Na kodzie v1 nie było
    // odróżnienia "migracja padła" od "zwykły błąd zapisu" — `notify('migration_failed')`
    // nie istniał, więc `noticesD.some(...)` byłoby zawsze fałszywe.
    const INDEX_DIR_D = '.pkm-assistant/index-migracja-fail';
    await plugin.app.vault.adapter.write(`${INDEX_DIR_D}/vault-index.json`, v1Text);
    await plugin.app.vault.adapter.write(`${INDEX_DIR_D}/vault-index.meta.json`, metaV1Text);
    const v1PathD = `${INDEX_DIR_D}/vault-index.json`;
    const realAdapterD = plugin.app.vault.adapter;
    let wolaniaWriteBinaryD = 0;
    let plikV1IstnialPrzyPierwszymPadzie: boolean | null = null;
    const throwOnceAdapter = {
      ...realAdapterD,
      async writeBinary(path: string, data: FixturePayload) {
        wolaniaWriteBinaryD += 1;
        if (wolaniaWriteBinaryD === 1) {
          plikV1IstnialPrzyPierwszymPadzie = await realAdapterD.exists(v1PathD);
          throw new Error('harness: symulowana awaria zapisu segmentu (throw-once, krok D)');
        }
        return realAdapterD.writeBinary(path, data);
      },
    };
    const noticesD: IndexerNotice[] = [];
    const embedowaneTekstyD: string[] = [];
    const embedderD: EmbedderFacade = {
      isReady: () => true,
      getModelKey: () => FAKE_MODEL_KEY,
      getDims: () => DIM,
      async embedBatch(texts: string[]) {
        embedowaneTekstyD.push(...texts);
        return texts.map((t) => wektor(t));
      },
    };
    const indexerD = new VaultIndexer({
      plugin: {},
      vault: { ...plugin.app.vault, adapter: throwOnceAdapter },
      embedder: embedderD,
      isMobile: false,
      indexDir: INDEX_DIR_D,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
      notify: (n) => noticesD.push(n),
    });
    await indexerD.initialize();
    assert(
      plikV1IstnialPrzyPierwszymPadzie === true,
      'Stary plik v1 zniknął PRZED nieudanym zapisem segmentu — pancerz migracji złamany.',
    );
    assert(
      noticesD.some((n) => n.kind === 'migration_failed'),
      `Brak powiadomienia 'migration_failed'. Notices: ${JSON.stringify(noticesD)}.`,
    );
    assert(
      embedowaneTekstyD.length > 0,
      'Po nieudanej migracji indeks powinien zbudować się OD ZERA (embedder nie został wywołany).',
    );
    assert(
      indexerD.getStatus().status === 'ready',
      `Po nieudanej migracji + rebuild indekser nie doszedł do 'ready': ${JSON.stringify(indexerD.getStatus())}.`,
    );
    assert(
      !(await plugin.app.vault.adapter.exists(v1PathD)),
      'Po udanym persist v2 (po nieudanej migracji) stary plik v1 nadal istnieje.',
    );
    const metaD = JSON.parse(await plugin.app.vault.adapter.read(`${INDEX_DIR_D}/vault-index.meta.json`)) as FixturePayload;
    assert(metaD.version === 2, `Po rebuildzie meta.version powinno być 2, jest ${metaD.version}.`);
    indexerD.dispose();

    // E. Segment uszkodzony (ucięty o 4 bajty) → notify index_corrupt, pełny rebuild, meta v2
    // spójna. Na kodzie v1 nie było segmentów binarnych do ucinania — ten krok w ogóle nie
    // miałby czego uszkodzić w opisany sposób (kod budowałby ścieżkę do pliku, który nigdy
    // by nie powstał, i padłby dużo wcześniej, przy odczycie `metaE1.segments[0].file`).
    const INDEX_DIR_E = '.pkm-assistant/index-uszkodzony';
    const embedderE: EmbedderFacade = {
      isReady: () => true,
      getModelKey: () => FAKE_MODEL_KEY,
      getDims: () => DIM,
      async embedBatch(texts: string[]) { return texts.map((t) => wektor(t)); },
    };
    const indexerE1 = new VaultIndexer({
      plugin: {},
      vault: plugin.app.vault,
      embedder: embedderE,
      isMobile: false,
      indexDir: INDEX_DIR_E,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
    });
    await indexerE1.initialize();
    assert(
      indexerE1.getStatus().status === 'ready',
      `Indekser E1 (przed uszkodzeniem) nie doszedł do 'ready': ${JSON.stringify(indexerE1.getStatus())}.`,
    );
    indexerE1.dispose();

    const metaE1 = JSON.parse(await plugin.app.vault.adapter.read(`${INDEX_DIR_E}/vault-index.meta.json`)) as FixturePayload;
    const segPathE = `${INDEX_DIR_E}/${metaE1.segments[0].file}`;
    const segBufE: ArrayBuffer = await plugin.app.vault.adapter.readBinary(segPathE);
    await plugin.app.vault.adapter.writeBinary(segPathE, segBufE.slice(0, segBufE.byteLength - 4));

    const noticesE: IndexerNotice[] = [];
    const indexerE2 = new VaultIndexer({
      plugin: {},
      vault: plugin.app.vault,
      embedder: embedderE,
      isMobile: false,
      indexDir: INDEX_DIR_E,
      noGoFolders: () => plugin.env?.settings?.pkmAssistant?.no_go_folders || [],
      notify: (n) => noticesE.push(n),
    });
    await indexerE2.initialize();
    assert(
      noticesE.some((n) => n.kind === 'index_corrupt'),
      `Brak powiadomienia 'index_corrupt' po ucięciu segmentu. Notices: ${JSON.stringify(noticesE)}.`,
    );
    assert(
      indexerE2.getStatus().status === 'ready',
      `Po uszkodzonym segmencie + rebuild indekser nie doszedł do 'ready': ${JSON.stringify(indexerE2.getStatus())}.`,
    );
    const metaE2 = JSON.parse(await plugin.app.vault.adapter.read(`${INDEX_DIR_E}/vault-index.meta.json`)) as FixturePayload;
    assert(
      metaE2.version === 2 && metaE2.segments.length === 1,
      `Meta po rebuildzie nie wygląda poprawnie: ${JSON.stringify(metaE2)}.`,
    );
    assert(
      countDocs(indexerE2.db) === liczbaDokumentow,
      `Po rebuildzie z uszkodzonego segmentu countDocs=${countDocs(indexerE2.db)}, oczekiwano ${liczbaDokumentow}.`,
    );
    indexerE2.dispose();
  },
} satisfies Scenario);
