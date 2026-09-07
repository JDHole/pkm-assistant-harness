/**
 * 11_delegacja_glebia — sub-agent próbuje delegować dalej → strażnik GŁĘBOKOŚCI odmawia (S33 Z1).
 *
 * Co realnie sprawdza: łańcuch `MCPClient` → `SubAgentRunner` → `MCPClient` → `DelegateTool`
 * niesie zaufany znacznik `_invocationDelegationDepth`. Delegacja z GŁÓWNEGO czatu (piętro 0)
 * przechodzi i odpala runnera. Delegacja z WNĘTRZA sub-agenta (piętro 1) odbija się o limit
 * `getLimits().max_delegation_depth` (default 1) i NIE odpala drugiego runnera — łańcuch
 * sub→sub→sub, który wykładniczo pali tokeny, urywa się na pierwszym piętrze.
 *
 * SETUP: `extra_tools` z `delegate` NIE działa (znalezisko — patrz nota niżej), więc `delegate`
 * dostaje sub przez własne `tools:` w SUB_AGENT.yaml. Przecięcie rodzic∩sub przepuszcza je,
 * bo Tester ma `delegate` widoczne.
 *
 * ⚠️ ZNALEZISKO (produkcja, NIE naprawiane w harnessie): `DelegateTool` woła
 * `runTask(..., { extraTools: args.extra_tools })`, ale `SubAgentRunner._resolveToolNames`
 * dokłada `extraTools` TYLKO gdy `allowExtraTools === true` — a tej flagi nikt nie podaje.
 * Parametr `extra_tools` jest więc martwy: model widzi go w schemacie, ustawia, i nic z tego
 * nie wynika. Scenariusz omija to fixture'em, żeby testować strażnika, a nie martwy parametr.
 *
 * Inwarianty: (1) delegacja piętra 1 wykonała się (tool.post delegate + success:true),
 * (2) sub DOSTAŁ odmowę głębi z czytelnym komunikatem i18n (nie gołym kluczem),
 * (3) w trace.log jest DOKŁADNIE JEDNA pętla sub-agenta i ZERO pętli workera `pkm-sub`
 *     (drugi runner nigdy nie wystartował), (4) pętla główna kończy się naturalnie.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import {
  parseTrace, readVaultFile, toolPosts, toolResult, assertFinalText, loopEnd, assert,
} from './_asserts.js';

const SUB_NAME = 'tester-kret';
const TRACE_REL = '.pkm-assistant/logs/trace.log';

/** Dowód zebrany W BIEGU: co fake-serwer zobaczył jako wynik delegacji 2. piętra. */
const seen: { depthRefusal: string | null } = { depthRefusal: null };

/**
 * Czy to żądanie sub-agenta? Sub dostaje whitelistę z `tools:` (read + delegate = 2 narzędzia),
 * agent główny — kilkanaście built-inów. Rozróżniamy po liczbie narzędzi, a nie po numerze tury:
 * requesty suba i agenta głównego lecą do TEGO SAMEGO fake-serwera i przeplatają się.
 */
function isSubRequest(request: import('./_asserts.js').FixturePayload) {
  const names = (request?.tools || []).map((td: import('./_asserts.js').FixturePayload) => td?.function?.name).filter(Boolean);
  return names.length > 0 && names.length <= 4 && names.includes('delegate');
}

export default ({
  file: '11_delegacja_glebia',
  name: 'delegacja glebia',
  opis: 'sub-agent woła delegate → odmowa strażnika głębi; drugi runner NIE startuje',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 6,
  // Żywy model nie da się deterministycznie zmusić, żeby sub-agent (osobna instancja z własnym
  // promptem) zawołał `delegate` — a bez tego wywołania nie ma czego odbijać strażnikiem.
  liveSkip: 'wymaga WYMUSZENIA wywołania `delegate` z wnętrza sub-agenta — żywy model decyduje o tym sam, więc scenariusz jest offline-only',

  fixtures: [
    {
      // Tester + jeden custom sub, który MA `delegate` w swojej whiteliście.
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
        'sub_agents:',
        `  - ${SUB_NAME}`,
        'mcp_servers:',
        '  - vault',
        '  - memory',
        '  - core',
        '',
      ].join('\n'),
    },
    {
      path: `.pkm-assistant/sub-agents/${SUB_NAME}/SUB_AGENT.yaml`,
      content: [
        `name: ${SUB_NAME}`,
        'description: Sub testowy — ma delegate w whiteliscie, zeby sprawdzic straznika glebi.',
        'tools:',
        '  - read',
        '  - delegate',
        'max_iterations: 3',
        'min_iterations: 1',
        '',
      ].join('\n'),
    },
  ],

  offlineScript: (ctx: import('./_asserts.js').FixturePayload) => {
    if (isSubRequest(ctx.request)) {
      const results = lastToolResults(ctx.request);
      if (results.length === 0) {
        // Sub, pierwsza tura: próbuje zlecić dalej (piętro 2).
        return toolCallTurn('delegate', { task: 'Zleć to jeszcze niżej — niech ktoś inny to zrobi.' });
      }
      // Sub, druga tura: dostał odpowiedź na swoją delegację — ZAPISZ ją jako materiał dowodowy.
      seen.depthRefusal = results.join('\n');
      return textTurn('Nie mogę zlecać dalej, więc robię to sam i oddaję wynik.');
    }
    // Agent główny.
    if (lastToolResults(ctx.request).length === 0) {
      seen.depthRefusal = null; // start biegu — wyczyść dowód z ewentualnego poprzedniego
      return toolCallTurn('delegate', {
        task: 'Sprawdź coś w notatkach i zlec resztę dalej.',
        aspect: SUB_NAME,
        extra_tools: ['delegate'],
      });
    }
    return textTurn('Sub oddał wynik — kończę.');
  },

  asserts({ result, trace, vaultRoot }) {
    // ── 1. Delegacja PIERWSZEGO piętra wykonała się ──
    const delegatePosts = toolPosts(trace).filter((p) => p.tool === 'delegate');
    assert(delegatePosts.length === 1,
      `Oczekiwano 1 wywołania delegate w pętli głównej, jest ${delegatePosts.length}.`);
    const lvl1 = toolResult(result, 'delegate');
    assert(lvl1 && /^\{"success":true/.test(lvl1.resultPreview || ''),
      `Delegacja 1. piętra miała się udać, a wynik to: ${(lvl1?.resultPreview || '(brak)').slice(0, 200)}`);

    // ── 2. Sub dostał ODMOWĘ GŁĘBI, czytelną i po ludzku (nie goły klucz i18n) ──
    const refusal = seen.depthRefusal;
    assert(typeof refusal === 'string' && refusal.length > 0,
      'Sub-agent nigdy nie dostał wyniku swojej delegacji — łańcuch nie doszedł do strażnika.');
    assert(/"success"\s*:\s*false/.test(refusal),
      `Delegacja 2. piętra NIE została odrzucona. Wynik: ${refusal.slice(0, 300)}`);
    assert(/limit głębokości delegacji|delegation depth limit/i.test(refusal),
      `Odmowa nie wygląda na strażnika głębi. Wynik: ${refusal.slice(0, 300)}`);
    assert(!/mcp\.delegate\.depth_limit/.test(refusal),
      `Do modelu poszedł GOŁY KLUCZ i18n zamiast komunikatu: ${refusal.slice(0, 300)}`);

    // ── 3. Drugi runner NIGDY nie wystartował ──
    // Każda pętla sub-agenta pisze do trace.log pod własną etykietą `sub/<nazwa>#<nr wywołania>`
    // (numer od Poligonu F2 — bez niego równoległe suby były nierozróżnialne; stąd `prefix: true`).
    // Jedno `loop.start` pod etykietą naszego suba = jedno piętro. Worker `pkm-sub` (tak nazywałaby
    // się delegacja BEZ aspect, czyli ta z wnętrza suba) nie ma w trace ŻADNEGO śladu.
    const traceRaw = readVaultFile(vaultRoot, TRACE_REL);
    const subLoops = parseTrace(traceRaw, `sub/${SUB_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(subLoops.length === 1,
      `Oczekiwano DOKŁADNIE 1 pętli sub-agenta „${SUB_NAME}", jest ${subLoops.length}.`);
    const workerLoops = parseTrace(traceRaw, 'sub/pkm-sub', { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(workerLoops.length === 0,
      `Delegacja 2. piętra ODPALIŁA runnera (${workerLoops.length}× pętla „sub/pkm-sub") — strażnik głębi nie zadziałał.`);

    // ── 4. Pętla główna domknęła się naturalnie ──
    assertFinalText(result);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies import('./_asserts.js').Scenario);
