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
import { VaultIndexer, countDocs, searchVectorTopK, createEmbedderFacade } from '../../modules/embedding/index.js';
import { EmbeddingHelper } from '../../modules/memory/index.js';
import { assert, assertFinalText, assertToolOk } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

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
        modelKey: 'harness:fake-hash-embed',
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
    // Drugie wywołanie idzie produkcyjnym egzekutorem (wzór `harness/lib/runTurn.ts`), więc
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

    // ── 5. Pętla domknęła się odpowiedzią ──
    const finalText = assertFinalText(result);
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );
  },
} satisfies Scenario);
