/**
 * 31_sub_szablon_fallback — `delegate` BEZ `aspect`: szablon → fail-soft `pkm-sub` → timeout.
 *
 * Trzy zachowania jednej gałęzi (`DelegateTool.resolveGenericWorkerConfig`, S27 D2 + S33 A2),
 * każde na ŻYWYM pluginie i produkcyjnej pętli:
 *
 *   FAZA 1 — user wyznaczył globalny szablon suba (`settings.pkmAssistant.globalSubTemplate`).
 *            Worker bierze config Z SZABLONU: nazwa, opis, narzędzia, limity.
 *            Dowód: byt w rejestrze pod `task_id` ze zwrotki + etykieta trace `sub/<nazwa szablonu>`.
 *   FAZA 2 — ten sam przełącznik wskazuje szablon NIE DO ODCZYTANIA (zepsuty YAML: `loadAll`
 *            pomija folder, `get()` zwraca null). To jest cała idea „odwrotu do pkm-sub”:
 *            zła decyzja usera NIGDY nie wywala delegacji — leci fabryczny worker + warn.
 *            Dowód: byt nazwany `pkm-sub` + trace `sub/pkm-sub`.
 *   FAZA 3 — `timeout_ms` per wywołanie wygrywa wyścig (`_withTimeout` = Promise.race).
 *            Dowód: `{success:false}` z komunikatem o timeout.
 *
 * ⚠️ F2 (2026-08-15): `delegate` domyślnie startuje suba W TLE, więc zwrotka to pokwitowanie
 * `{started:true, task_id}`, a nie wynik. Fazy 1 i 2 sprawdzają więc TOŻSAMOŚĆ workera przez
 * REJESTR biegów (`plugin.subTaskRegistry.getTask(task_id)`) i przez trace — intencja bez zmian,
 * źródło dowodu przeniesione tam, gdzie po F2 mieszka prawda.
 *
 * ⚠️ Runda 3 (2026-08-17): z głównego czatu tło jest PRZYMUSOWE (`background` wyleciał ze
 * schematu; jawnie podany — ignorowany). Faza 3 testuje więc, że `timeout_ms` per wywołanie
 * NADAL pilnuje biegu, tylko dowód mieszka w rejestrze: zwrotka to pokwitowanie `started`,
 * a karta biegu kończy jako `aborted` (budzik ubił bieg w tle). Kontrakt zwrotki ścieżki
 * BLOKUJĄCEJ (błąd w turze) ma testy jednostkowe na depth 1 (`DelegateTool.test.ts`).
 *
 * ⚠️ PRZEGRANA GAŁĄŹ NIE JEST ANULOWANA — po timeoucie sub biegnie dalej. Scenariusz skryptuje
 * go tak, żeby domknął się natychmiast (`textTurn`); domknięcia pilnuje `awaitBackgroundSubTasks`
 * wbudowane w `runExploratoryTurn` plus jawne czekanie na `loop.end` niżej. Bez tego sprzątanie
 * temp-vaulta ścigałoby się z żywym zapisem sub-agenta.
 *
 * Fazy 2 i 3 odpalane są RĘCZNIE w `asserts` (runner robi jedną turę na scenariusz), więc
 * kolejne tury konsumują dalszą część globalnej kolejki fake-serwera.
 */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { PKM_SUB_NAME } from '../../modules/sub-agents/index.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { assert, assertFinalText, subTraceEvents, toolPosts, toolResult } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SZABLON_DOBRY = 'poligon-worker';
const SZABLON_ZEPSUTY = 'poligon-zepsuty';

/**
 * Limit fazy 3. Fake-serwer PRZYTRZYMUJE odpowiedź dla suba w fazie 3 (`PRZYTRZYMANIE_MS`,
 * czterokrotnie dłużej), więc timeout wygrywa wyścig Z KONSTRUKCJI — żądanie zawsze zdąży
 * dotrzeć do serwera (licznik `odpowiedziSuba` = 3), a odpowiedź zawsze przyjdzie za późno.
 * Dawne 1 ms wygrywało z SAMYM WYSŁANIEM żądania: na szybkiej maszynie fetch zdążył wyjść
 * z procesu, na wolniejszym runnerze CI — nie, i asercja „3 żądania" była loterią.
 */
const TIMEOUT_MS = 100;
const PRZYTRZYMANIE_MS = 400;

function poczekaj(ms: number): Promise<void> {
  return new Promise<void>((r) => { const t = setTimeout(r, ms); t?.unref?.(); });
}

const ZADANIE = 'Zerknij do notatek i oddaj jedno zdanie.';

/** Stan biegu: numer fazy głównej pętli + licznik obsłużonych subów (diagnostyka przy RED). */
const stan = { faza: 0, odpowiedziSuba: 0 };

/**
 * Czy to żądanie SUB-AGENTA? Sub dostaje wąską whitelistę (szablon: 2 narzędzia, `pkm-sub`:
 * 5), agent główny — komplet built-inów (>20). Rozróżniamy po liczbie narzędzi, bo żądania
 * suba i pętli głównej lecą do TEGO SAMEGO fake-serwera i przeplatają się (wzór z 11).
 */
function jestPodzapytaniem(request: FixturePayload): boolean {
  const nazwy = (request?.tools || [])
    .map((td: FixturePayload) => td?.function?.name)
    .filter(Boolean);
  return nazwy.length > 0 && nazwy.length <= 8;
}

/**
 * Nazwa workera, który realnie ruszył — czytana Z REJESTRU po `task_id` z pokwitowania
 * delegacji w tle (F2). Dawniej stało tu dopasowanie `"aspect":"…"` w tool-resulcie;
 * po F2 zwrotka nie niesie już wyniku suba, więc tożsamość bierzemy stamtąd, gdzie
 * mieszka prawda o biegu. `null` = brak pokwitowania albo brak bytu.
 */
function nazwaWorkera(plugin: FixturePayload, resultPreview: string | undefined): string | null {
  const dopasowanie = /"task_id"\s*:\s*"([^"]+)"/.exec(resultPreview || '');
  if (!dopasowanie) return null;
  return plugin?.subTaskRegistry?.getTask?.(dopasowanie[1])?.name ?? null;
}

/** Czekaj (bounded), aż pod etykietą suba pojawi się `ile` domknięć pętli. −1 = nie doczekano. */
async function poczekajNaDomkniecie(
  ctx: FixturePayload, subName: string, ile: number, limitMs = 8000,
): Promise<number> {
  const start = Date.now();
  for (;;) {
    const n = (await subTraceEvents(ctx, subName)).filter((e) => e.type === 'loop.end').length;
    if (n >= ile) return n;
    if (Date.now() - start > limitMs) return -1;
    await new Promise<void>((r) => { const t = setTimeout(r, 40); t?.unref?.(); });
  }
}

export default ({
  file: '31_sub_szablon_fallback',
  name: 'sub szablon fallback',
  opis: 'delegate bez aspect: config z globalnego szablonu → fail-soft pkm-sub przy zepsutym szablonie → timeout_ms ucina wyścig',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  liveSkip: 'wymaga wymuszenia konkretnych wywołań delegate (szablon/fallback/timeout_ms) — niedeterministyczne na żywym modelu',

  fixtures: [
    {
      // DOBRY szablon — kompletny (name + description są wymagane przez `_loadFromFolder`).
      path: `.pkm-assistant/templates/sub-agents/${SZABLON_DOBRY}/SUB_AGENT.yaml`,
      content: [
        `name: ${SZABLON_DOBRY}`,
        'description: Szablon workera Poligonu — sprawdza sciezke globalnego szablonu suba.',
        'role: researcher',
        'tools:',
        '  - read',
        '  - list',
        'max_iterations: 3',
        'min_iterations: 1',
        'enabled: true',
        'version: 1',
        '',
      ].join('\n'),
    },
    {
      // ZEPSUTY szablon — to nie jest YAML z `name`/`description`, więc `loadAll` pomija folder,
      // a `get(slug)` zwraca null. Dokładnie ta ścieżka ma spaść na fabryczny `pkm-sub`.
      path: `.pkm-assistant/templates/sub-agents/${SZABLON_ZEPSUTY}/SUB_AGENT.yaml`,
      content: [
        '>>> to nie jest YAML <<<',
        '\t- [name: "urwany cudzyslow',
        '  : : :',
        '',
      ].join('\n'),
    },
  ],

  /** Wyznacz globalny szablon suba. Zapis do SUROWEGO worka — proxy zaplanowałoby zapis na dysk. */
  async setup({ plugin }) {
    stan.faza = 0;
    stan.odpowiedziSuba = 0;
    const worek = plugin?.env?.settingsStore.raw as FixturePayload;
    assert(worek?.pkmAssistant, 'Brak settingsStore.raw.pkmAssistant — bootstrap ustawień nieukończony?');
    worek.pkmAssistant.globalSubTemplate = SZABLON_DOBRY;

    const store = plugin?.agentManager?.subAgentTemplateStore;
    assert(store, 'Brak agentManager.subAgentTemplateStore — magazyn szablonów subów się przesunął.');
    assert(
      store.get(SZABLON_DOBRY),
      `Dobry szablon „${SZABLON_DOBRY}" nie wczytał się z fixture — scenariusz sprawdzałby co innego niż deklaruje.`,
    );
    assert(
      !store.get(SZABLON_ZEPSUTY),
      `Zepsuty szablon „${SZABLON_ZEPSUTY}" JEDNAK się wczytał — fixture przestał być niepoprawny, `
      + 'więc faza 2 nie testowałaby fail-softu.',
    );
  },

  offlineScript: async (ctx: FixturePayload) => {
    if (jestPodzapytaniem(ctx.request)) {
      stan.odpowiedziSuba += 1;
      // Faza 3: odpowiedź PRZYTRZYMANA dłużej niż `timeout_ms` — budzik ubija bieg w tle,
      // a spóźniona odpowiedź trafia w zerwane połączenie (fake-serwer to łyka).
      if (stan.faza === 3) await poczekaj(PRZYTRZYMANIE_MS);
      return textTurn('Sub oddaje krótki wynik.');
    }
    // Pętla główna: pierwsze żądanie tury (brak wyników narzędzi) = start kolejnej fazy.
    if (lastToolResults(ctx.request).length === 0) {
      stan.faza += 1;
      if (stan.faza === 3) {
        // Runda 3: tło przymusowe — budzik rozstrzyga o LOSIE BIEGU (karta w rejestrze),
        // nie o zwrotce do modelu (ta jest pokwitowaniem).
        return toolCallTurn('delegate', { task: ZADANIE, timeout_ms: TIMEOUT_MS });
      }
      return toolCallTurn('delegate', { task: ZADANIE });
    }
    return textTurn('Delegacja rozstrzygnięta — kończę turę.');
  },

  async asserts(ctx) {
    const { result, trace, plugin } = ctx;
    const worek = plugin?.env?.settingsStore.raw as FixturePayload;

    // ══ FAZA 1 — worker z globalnego SZABLONU ══
    const delegacje1 = toolPosts(trace).filter((p) => p.tool === 'delegate');
    assert(delegacje1.length === 1, `Faza 1: oczekiwano 1 wywołania delegate, jest ${delegacje1.length}.`);

    const wynik1 = toolResult(result, 'delegate');
    assert(wynik1, 'Faza 1: brak wyniku delegate w toolCallDetails.');
    assert(
      nazwaWorkera(plugin, wynik1.resultPreview) === SZABLON_DOBRY,
      `Faza 1: worker NIE wziął configu z globalnego szablonu „${SZABLON_DOBRY}". `
      + `Wynik: ${(wynik1.resultPreview || '(brak)').slice(0, 300)}`,
    );
    const petleSzablonu = (await subTraceEvents(ctx, SZABLON_DOBRY))
      .filter((e) => e.type === 'loop.start');
    assert(
      petleSzablonu.length === 1,
      `Faza 1: oczekiwano DOKŁADNIE 1 pętli pod etykietą „sub/${SZABLON_DOBRY}", jest ${petleSzablonu.length}.`,
    );
    assertFinalText(result, 'Faza 1: pętla główna nie zwróciła odpowiedzi.');

    // ══ FAZA 2 — zepsuty szablon → fail-soft na fabryczny pkm-sub ══
    worek.pkmAssistant.globalSubTemplate = SZABLON_ZEPSUTY;

    const tura2 = await runExploratoryTurn(plugin, {
      agentName: 'Tester',
      prompt: 'Zleć to workerowi.',
      autonomy: 'edge',
      approve: 'auto',
      maxIterations: 4,
      runId: 'fallback',
    });
    const wynik2 = toolResult(tura2.result, 'delegate');
    assert(wynik2, 'Faza 2: brak wyniku delegate — delegacja w ogóle nie poszła.');
    assert(
      nazwaWorkera(plugin, wynik2.resultPreview) === PKM_SUB_NAME,
      `Faza 2: zepsuty szablon miał spaść na fabryczny „${PKM_SUB_NAME}" (fail-soft S27 D2). `
      + `Wynik: ${(wynik2.resultPreview || '(brak)').slice(0, 300)}`,
    );
    assert(
      /"success"\s*:\s*true/.test(wynik2.resultPreview || ''),
      `Faza 2: zła decyzja usera WYWALIŁA delegację zamiast spaść na ${PKM_SUB_NAME}. `
      + `Wynik: ${(wynik2.resultPreview || '(brak)').slice(0, 300)}`,
    );
    const petleWorkera = (await subTraceEvents(ctx, PKM_SUB_NAME))
      .filter((e) => e.type === 'loop.start');
    assert(
      petleWorkera.length === 1,
      `Faza 2: oczekiwano 1 pętli pod etykietą „sub/${PKM_SUB_NAME}", jest ${petleWorkera.length}.`,
    );

    // ══ FAZA 3 — timeout_ms per wywołanie ucina wyścig ══
    const tura3 = await runExploratoryTurn(plugin, {
      agentName: 'Tester',
      prompt: 'Zleć to workerowi z krótkim limitem czasu.',
      autonomy: 'edge',
      approve: 'auto',
      maxIterations: 4,
      runId: 'timeout',
    });
    const wynik3 = toolResult(tura3.result, 'delegate');
    assert(wynik3, 'Faza 3: brak wyniku delegate.');
    const podglad3 = wynik3.resultPreview || '';
    // Runda 3: zwrotka z czatu to ZAWSZE pokwitowanie — o losie biegu mówi karta w rejestrze.
    const dopasowanie3 = /"task_id"\s*:\s*"([^"]+)"/.exec(podglad3);
    assert(
      /"started"\s*:\s*true/.test(podglad3) && dopasowanie3,
      `Faza 3: delegacja z czatu miała wrócić pokwitowaniem started+task_id (runda 3). `
      + `Wynik: ${podglad3.slice(0, 300) || '(brak)'}`,
    );
    // Budzik dalej pilnuje biegu — tyle że W TLE: karta ma skończyć jako ubita, nie done.
    const start3 = Date.now();
    let status3 = '';
    for (;;) {
      status3 = plugin?.subTaskRegistry?.getTask?.(dopasowanie3![1])?.status || '';
      if (status3 && status3 !== 'running') break;
      if (Date.now() - start3 > 8000) break;
      await new Promise<void>((r) => { const t = setTimeout(r, 40); t?.unref?.(); });
    }
    assert(
      status3 === 'aborted' || status3 === 'error',
      `Faza 3: timeout_ms=${TIMEOUT_MS} miał ubić bieg w tle — karta ma status "${status3 || '(brak)'}", `
      + 'oczekiwano aborted/error.',
    );

    // ⚠️ Dangling sub z fazy 3 dalej biegnie — poczekaj na JEGO `loop.end`, zanim scenariusz
    // odda kontrolę runnerowi (cleanup kasuje temp-vault).
    const domkniete = await poczekajNaDomkniecie(ctx, PKM_SUB_NAME, 2);
    assert(
      domkniete >= 2,
      `Faza 3: sub porzucony po timeoucie NIE domknął się w limicie — sprzątanie temp-vaulta `
      + `ścigałoby się z jego zapisem (loop.end pod „sub/${PKM_SUB_NAME}": ${domkniete}).`,
    );
    assert(
      stan.odpowiedziSuba === 3,
      `Fake-serwer obsłużył ${stan.odpowiedziSuba} żądań sub-agenta, oczekiwano 3 (po jednym na fazę).`,
    );
  },
} satisfies Scenario);
