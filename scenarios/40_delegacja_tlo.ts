/**
 * 40_delegacja_tlo — `delegate` domyślnie startuje suba W TLE (F2 faza A).
 *
 * Co realnie sprawdza (na ŻYWYM pluginie i produkcyjnej pętli): tura NIE stoi pod
 * sub-agentem. Model dostaje pokwitowanie `{started:true, task_id}` zamiast wyniku,
 * kończy turę — a bieg suba toczy się dalej i domyka się w rejestrze, skąd wynik
 * przejmuje skrzynka powiadomień (`plugin.subTaskNotifier`).
 *
 * Dlaczego tak, a nie „wynik w transkrypcie": to jest CAŁA zmiana F2. Gdyby delegacja
 * dalej oddawała wynik w turze, ten scenariusz świeciłby na zielono bez powodu.
 *
 * Inwarianty:
 *   1. tool-result `delegate` w transkrypcie ma `started:true` + `task_id` i NIE ma wyniku suba,
 *   2. po `awaitBackgroundSubTasks` byt w rejestrze ma status TERMINALNY i niepusty `result.text`,
 *   3. byt niesie `background:true` (inaczej powiadomienia by go nie wzięły),
 *   4. skrzynka `subTaskNotifier.pending()` trzyma ten wynik — w harnessie NIE MA dostawcy
 *      (podłącza go dopiero faza B, czyli czat), więc wynik ma prawo czekać w kolejce,
 *   5. trace suba jest KOMPLETNY (`loop.start` + `loop.end`) mimo że tura skończyła się wcześniej,
 *   6. pętla główna domyka się naturalnie.
 */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { PKM_SUB_NAME } from '../../modules/sub-agents/index.js';
import { awaitBackgroundSubTasks } from '../lib/runTurn.js';
import { assert, assertFinalText, loopEnd, subTraceEvents, toolPosts, toolResult } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const ZADANIE = 'Zerknij do notatek i oddaj jedno zdanie o projekcie.';
const ODPOWIEDZ_SUBA = 'Sub oddaje wynik po zakończeniu tury głównej.';
const ODPOWIEDZ_GLOWNA = 'Zleciłem to w tle — dam znać, jak wróci wynik.';

/**
 * Czy to żądanie SUB-AGENTA? Sub dostaje wąską whitelistę (`pkm-sub`: 5 narzędzi), agent
 * główny — komplet built-inów (>20). Rozróżniamy po liczbie narzędzi, bo żądania suba
 * i pętli głównej lecą do TEGO SAMEGO fake-serwera i przeplatają się (wzór z 11 i 31).
 */
function jestPodzapytaniem(request: FixturePayload): boolean {
  const nazwy = (request?.tools || [])
    .map((td: FixturePayload) => td?.function?.name)
    .filter(Boolean);
  return nazwy.length > 0 && nazwy.length <= 8;
}

export default ({
  file: '40_delegacja_tlo',
  name: 'delegacja w tle',
  opis: 'delegate bez background: tura dostaje started+task_id, wynik suba domyka się w rejestrze po turze',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  liveSkip: 'wymaga wymuszenia konkretnego wywołania delegate — żywy model decyduje o tym sam',

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
    assert(plugin?.subTaskRegistry, 'Brak plugin.subTaskRegistry — bez rejestru delegacja w ogóle nie poszłaby w tło.');
    assert(plugin?.subTaskNotifier, 'Brak plugin.subTaskNotifier — composition root nie postawił skrzynki wyników (F2 A6).');
    assert(
      plugin.subTaskNotifier.pending().length === 0,
      'Skrzynka powiadomień nie jest pusta na starcie scenariusza.',
    );
  },

  offlineScript: (ctx: FixturePayload) => {
    if (jestPodzapytaniem(ctx.request)) return textTurn(ODPOWIEDZ_SUBA);
    // Pętla główna: najpierw delegacja (BEZ `background` — czyli domyślnie w tle), potem koniec.
    if (lastToolResults(ctx.request).length === 0) {
      return toolCallTurn('delegate', { task: ZADANIE });
    }
    return textTurn(ODPOWIEDZ_GLOWNA);
  },

  async asserts(ctx) {
    const { result, trace, plugin } = ctx;

    // ── 1. Tura dostała POKWITOWANIE, nie wynik ──
    const delegacje = toolPosts(trace).filter((p) => p.tool === 'delegate');
    assert(delegacje.length === 1, `Oczekiwano 1 wywołania delegate, jest ${delegacje.length}.`);

    const wynik = toolResult(result, 'delegate');
    assert(wynik, 'Brak wyniku delegate w toolCallDetails.');
    const podglad = wynik.resultPreview || '';
    assert(
      /"started"\s*:\s*true/.test(podglad),
      `Delegacja NIE poszła w tło (brak started:true). Wynik: ${podglad.slice(0, 300)}`,
    );
    const dopasowanie = /"task_id"\s*:\s*"([^"]+)"/.exec(podglad);
    assert(dopasowanie, `Zwrotka nie niesie task_id — model nie ma czym zaadresować biegu: ${podglad.slice(0, 300)}`);
    const taskId = dopasowanie[1];
    assert(
      !podglad.includes(ODPOWIEDZ_SUBA),
      `Wynik suba przeciekł do tury — to już nie jest tło: ${podglad.slice(0, 300)}`,
    );

    // ── 2 + 3. Byt w rejestrze domknięty, z treścią i znacznikiem tła ──
    // Bieg jest już domknięty (runExploratoryTurn czeka), ale wołamy jawnie — helper jest
    // idempotentny, a scenariusz ma pokazywać PEŁNĄ ścieżkę razem z czekaniem.
    await awaitBackgroundSubTasks(plugin, { timeoutMs: 15000 });
    const task = plugin.subTaskRegistry.getTask(taskId);
    assert(task, `Rejestr nie zna biegu ${taskId} — task_id ze zwrotki nie wskazuje na byt.`);
    assert(
      task.status !== 'running',
      `Bieg ${taskId} nadal ma status running po awaitBackgroundSubTasks.`,
    );
    assert(
      (task.result?.text || '').trim().length > 0,
      `Bieg ${taskId} domknął się bez treści wyniku (status ${task.status}).`,
    );
    assert(task.background === true, `Byt ${taskId} nie jest oznaczony jako bieg w tle (background=${task.background}).`);

    // ── 4. Wynik czeka w skrzynce (harness nie ma dostawcy — podłączy go faza B) ──
    const czekajace = plugin.subTaskNotifier.pending();
    assert(
      czekajace.some((x: FixturePayload) => x.id === taskId),
      `Skrzynka powiadomień nie ma wyniku ${taskId}. Czeka: ${czekajace.map((x: FixturePayload) => x.id).join(', ') || '(nic)'}`,
    );

    // ── 5. Trace suba KOMPLETNY mimo wcześniejszego końca tury ──
    const subTrace = await subTraceEvents(ctx, PKM_SUB_NAME);
    const starty = subTrace.filter((e) => e.type === 'loop.start');
    const konce = subTrace.filter((e) => e.type === 'loop.end');
    assert(starty.length === 1, `Oczekiwano 1 pętli sub-agenta „sub/${PKM_SUB_NAME}", jest ${starty.length}.`);
    assert(konce.length === 1, `Pętla suba nie domknęła się w trace (loop.end: ${konce.length}).`);

    // ── 6. Pętla główna skończyła się normalnie ──
    const finalText = assertFinalText(result);
    assert(finalText.includes(ODPOWIEDZ_GLOWNA), `Finalny tekst jest inny niż zaskryptowany: ${finalText.slice(0, 200)}`);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies Scenario);
