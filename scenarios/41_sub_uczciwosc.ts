/**
 * 41_sub_uczciwosc — sub, który padł, MÓWI że padł; sub, który biegnie, DA SIĘ pokierować (F5).
 *
 * Dwa zachowania jednego kanału delegacji, oba na ŻYWYM pluginie i produkcyjnej pętli:
 *
 *   FAZA 1 — model sub-agenta ODMAWIA (HTTP 500 z fake-serwera, `errorTurn`).
 *            Do F5 taki bieg wracał do agenta zlecającego jako `success:true` z komunikatem
 *            błędu schowanym w polu `result` — model referował go userowi jako wykonane
 *            zadanie (bieg live 2026-08-15). Runda 3 (2026-08-17): z czatu tło jest
 *            PRZYMUSOWE, więc zwrotka to pokwitowanie `started` — a UCZCIWOŚĆ mieszka
 *            w karcie biegu: status `error` + zapisana treść błędu (to z niej powstaje
 *            powiadomienie o porażce). Kontrakt zwrotki BLOKUJĄCEJ (`success:false` +
 *            `stopped_by:"error"` w turze) ma testy jednostkowe na depth 1.
 *   FAZA 2 — user pisze do biegu, który TRWA (`registry.postMessage`, kanał agentowy F5).
 *            Dowód doręczenia: krok `user.message` w trace suba ORAZ
 *            odpowiedź suba, która potwierdza, że polecenie było w jego transkrypcie.
 *
 * ⚠️ OBIE fazy jadą w TLE (runda 3: innej drogi z czatu nie ma).
 *
 * Faza 2 odpalana jest RĘCZNIE w `asserts` (runner robi jedną turę na scenariusz), więc
 * konsumuje dalszą część globalnej kolejki fake-serwera.
 */
import { textTurn, toolCallTurn, errorTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { PKM_SUB_NAME } from '../../modules/sub-agents/index.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { assert, assertFinalText, subTraceEvents, toolPosts, toolResult } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

/** Polecenie dopisane do biegu w trakcie — sub ma je zobaczyć w SWOIM transkrypcie. */
const POLECENIE = 'ZMIANA PLANU: pomiń archiwum, zajmij się tylko notatkami biezacymi.';
/** Sub potwierdza doręczenie tym słowem — po nim poznajemy ślad dopisku w wyniku. */
const POTWIERDZENIE = 'POLECENIE-DORECZONE';

const ZADANIE_1 = 'Sprawdź notatki i oddaj jedno zdanie.';
const ZADANIE_2 = 'Przejrzyj vault i podsumuj.';

/** Stan przebiegu — licznik żądań suba per faza (diagnostyka przy RED). */
const stan = { faza: 0, zadaniaSuba: 0 };

/**
 * Czy to żądanie SUB-AGENTA? Sub dostaje wąską whitelistę (`pkm-sub`: 5 narzędzi), agent
 * główny — komplet built-inów (>20). Rozróżniamy po liczbie narzędzi, bo żądania suba
 * i pętli głównej lecą do TEGO SAMEGO fake-serwera i przeplatają się (wzór z 11, 31 i 40).
 */
function jestPodzapytaniem(request: FixturePayload): boolean {
  const nazwy = (request?.tools || [])
    .map((td: FixturePayload) => td?.function?.name)
    .filter(Boolean);
  return nazwy.length > 0 && nazwy.length <= 8;
}

/** Czy w transkrypcie tego żądania siedzi już dopisek od usera? */
function widziPolecenie(request: FixturePayload): boolean {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return messages.some((m: FixturePayload) => typeof m?.content === 'string' && m.content.includes(POLECENIE));
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
  file: '41_sub_uczciwosc',
  name: 'uczciwosc subow',
  opis: 'sub z padniętym modelem wraca jako success:false + stopped_by:error; wiadomość od usera dolatuje do biegu w trakcie',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  liveSkip: 'wymaga wymuszenia awarii modelu suba i konkretnego wywołania delegate — żywy model decyduje o tym sam',

  fixtures: [
    {
      path: '.pkm-assistant/agents/tester.yaml',
      content: [
        'name: Tester',
        'description: Agent testowy harnessa — pełen dostęp do zwykłego vaulta.',
        'personality: |',
        '  Jesteś Tester — rzeczowy agent do smoke-testów pluginu. Odpowiadasz krótko,',
        '  wykonujesz zadania wprost, nie owijasz w bawełnę.',
        'access_policy_version: 2',
        'admin_access: false',
        'default_permissions:',
        '  memory: true',
        '  guidance_mode: true',
        'disabled_tools: []',
        'default_autonomy: edge',
        'mcp_servers:',
        '  - vault',
        '  - memory',
        '  - core',
        '',
      ].join('\n'),
    },
  ],

  async setup({ plugin }) {
    assert(plugin?.subTaskRegistry, 'Brak plugin.subTaskRegistry — bez rejestru nie ma ani kart biegów, ani skrzynki na wiadomości.');
    assert(
      typeof plugin.subTaskRegistry.postMessage === 'function',
      'Rejestr biegów nie zna postMessage — kanał sterowania suba (F5 Z3) nie wstał.',
    );
    // Wiadomość wrzucamy DOKŁADNIE tak, jak zrobi to panel: po `task:created`, znając samo `id`.
    // Robi to sam plugin przez szynę zdarzeń — scenariusz nie sięga do wnętrza runnera.
    plugin.subTaskRegistry.events.on('task:created', (task: FixturePayload) => {
      if (stan.faza < 2) return; // faza 1 bada awarię, nie sterowanie
      plugin.subTaskRegistry.postMessage(task.id, POLECENIE);
    });
  },

  offlineScript: (ctx: FixturePayload) => {
    if (jestPodzapytaniem(ctx.request)) {
      stan.zadaniaSuba += 1;
      // FAZA 1: model suba PADA (HTTP 500) — nie ma takiego układu delt, który by to udał.
      if (stan.faza === 1) return errorTurn({ status: 500, message: 'Fake model down' });
      // FAZA 2: pierwsza iteracja suba sięga po narzędzie (żeby pętla poszła dalej i hak
      // `beforeContinue` w ogóle miał kiedy zadziałać), druga — raportuje, co zobaczyła.
      if (!widziPolecenie(ctx.request)) {
        return toolCallTurn('list', { path: '' });
      }
      return textTurn(`${POTWIERDZENIE} — dostosowuję zakres zgodnie z poleceniem użytkownika.`);
    }
    // Pętla główna: pierwsze żądanie tury (brak wyników narzędzi) = start kolejnej fazy.
    if (lastToolResults(ctx.request).length === 0) {
      stan.faza += 1;
      if (stan.faza === 1) return toolCallTurn('delegate', { task: ZADANIE_1 });
      return toolCallTurn('delegate', { task: ZADANIE_2 });
    }
    return textTurn('Delegacja rozstrzygnięta — kończę turę.');
  },

  async asserts(ctx) {
    const { result, trace, plugin } = ctx;

    // ══ FAZA 1 — padnięty sub NIE MOŻE udawać sukcesu ══
    const delegacje = toolPosts(trace).filter((p) => p.tool === 'delegate');
    assert(delegacje.length === 1, `Faza 1: oczekiwano 1 wywołania delegate, jest ${delegacje.length}.`);

    const wynik1 = toolResult(result, 'delegate');
    assert(wynik1, 'Faza 1: brak wyniku delegate w toolCallDetails.');
    const podglad = wynik1.resultPreview || '';
    // Runda 3: zwrotka z czatu to pokwitowanie — nie ma prawa udawać wyniku ani sukcesu biegu.
    assert(
      /"started"\s*:\s*true/.test(podglad),
      `Faza 1: delegacja z czatu miała wrócić pokwitowaniem started (runda 3). Wynik: ${podglad.slice(0, 300)}`,
    );

    // Bieg z padniętym modelem musi się domknąć, żeby karta niosła już werdykt.
    const domknietePo1 = await poczekajNaDomkniecie(ctx, PKM_SUB_NAME, 1);
    assert(domknietePo1 >= 1, `Faza 1: bieg suba nie domknął się w limicie (loop.end: ${domknietePo1}).`);

    // UCZCIWOŚĆ mieszka w karcie biegu (z niej powstaje powiadomienie o porażce) —
    // padnięty sub nie może zostawić karty "done" ani pustego błędu.
    const biegi1: FixturePayload[] = plugin.subTaskRegistry.list();
    assert(biegi1.length === 1, `Faza 1: oczekiwano 1 karty biegu w rejestrze, jest ${biegi1.length}.`);
    assert(
      biegi1[0].status === 'error',
      `Faza 1: karta biegu ma status "${biegi1[0].status}", oczekiwano "error".`,
    );
    assert(
      typeof biegi1[0].error === 'string' && biegi1[0].error.length > 0,
      'Faza 1: karta biegu nie zapisała treści błędu — panel pokaże pustą ramkę.',
    );
    assertFinalText(result, 'Faza 1: pętla główna nie zwróciła odpowiedzi.');

    // ══ FAZA 2 — wiadomość do biegu, który TRWA ══
    const tura2 = await runExploratoryTurn(plugin, {
      agentName: 'Tester',
      prompt: 'Zleć przegląd vaulta workerowi.',
      autonomy: 'edge',
      approve: 'auto',
      maxIterations: 4,
      runId: 'sterowanie',
    });
    const wynik2 = toolResult(tura2.result, 'delegate');
    assert(wynik2, 'Faza 2: brak wyniku delegate — delegacja w ogóle nie poszła.');
    const dopasowanie = /"task_id"\s*:\s*"([^"]+)"/.exec(wynik2.resultPreview || '');
    assert(dopasowanie, `Faza 2: brak pokwitowania z task_id: ${(wynik2.resultPreview || '(brak)').slice(0, 300)}`);
    const taskId = dopasowanie[1];

    // Bieg w tle domyka `runExploratoryTurn`, ale czekamy jawnie na ŚLAD w pliku trace —
    // scenariusz ma pokazywać pełną ścieżkę, a nie ufać, że ktoś poczekał za nas.
    // Runda 3: bieg fazy 1 też zostawił loop.end pod tą etykietą, stąd próg 2.
    const domkniete = await poczekajNaDomkniecie(ctx, PKM_SUB_NAME, 2);
    assert(domkniete >= 2, `Faza 2: bieg suba nie domknął się w limicie (loop.end: ${domkniete}).`);

    const subTrace = await subTraceEvents(ctx, PKM_SUB_NAME);
    const wiadomosci = subTrace.filter((e) => e.type === 'user.message');
    assert(
      wiadomosci.length === 1,
      `Faza 2: w trace suba nie ma DOKŁADNIE jednego kroku user.message (jest ${wiadomosci.length}). `
      + `Typy: ${subTrace.map((e) => e.type).join(', ')}`,
    );
    assert(
      Number(wiadomosci[0].fields.chars) === POLECENIE.length,
      `Faza 2: krok user.message podaje chars=${wiadomosci[0].fields.chars}, oczekiwano ${POLECENIE.length}. `
      + 'Do trace ma iść sama DŁUGOŚĆ — treść siedzi w transkrypcie suba.',
    );

    const task2: FixturePayload = plugin.subTaskRegistry.getTask(taskId);
    assert(task2, `Faza 2: rejestr nie zna biegu ${taskId}.`);
    assert(
      (task2.result?.text || '').includes(POTWIERDZENIE),
      `Faza 2: wynik suba nie niesie śladu dopisku — polecenie nie doleciało do jego transkryptu. `
      + `Wynik: ${(task2.result?.text || '(pusty)').slice(0, 300)}`,
    );
    assert(
      task2.status === 'done',
      `Faza 2: bieg ze sterowaniem miał się domknąć normalnie, a ma status "${task2.status}".`,
    );

    assert(
      stan.zadaniaSuba === 3,
      `Fake-serwer obsłużył ${stan.zadaniaSuba} żądań sub-agenta, oczekiwano 3 (1 padnięte + 2 iteracje sterowanego).`,
    );
  },
} satisfies Scenario);
