/**
 * 11_delegacja_glebia — sub-agent na limicie głębokości NIE WIDZI `delegate`, a wymuszone wywołanie
 * po samej nazwie i tak się odbija; drugi runner nie startuje (S33 Z1, Subagenci 2.4 sekcja 5).
 *
 * Co realnie sprawdza: łańcuch `MCPClient` → `SubAgentRunner` → `MCPClient` → `DelegateTool`
 * niesie zaufany znacznik `_invocationDelegationDepth`. Delegacja z GŁÓWNEGO czatu (piętro 0)
 * przechodzi i odpala runnera. Na piętrze 1 sub jest już na limicie
 * `getLimits().max_delegation_depth` (default 1), więc od 2.4:
 * - `delegate` znika z definicji narzędzi suba (nie traci kroku na próbę skazaną na odmowę),
 * - rama suba mówi wprost, że dalej delegować nie wolno (`subagent.frame.no_further_delegation`),
 * - wywołanie `delegate` podane przez model z pamięci odbija whitelista runnera
 *   (`subagent.tool_not_allowed`), a bramka głębokości w `DelegateTool` zostaje jako obrona w głąb.
 *
 * SETUP: sub ma `delegate` we własnym `tools:` w SUB_AGENT.yaml, żeby sprawdzić, że runner chowa je
 * mimo jawnego wpisu. `extra_tools` z `delegate` w wywołaniu agenta głównego zostaje (martwy
 * parametr, patrz znalezisko niżej) - nie zmienia wyniku.
 *
 * ⚠️ ZNALEZISKO (produkcja, NIE naprawiane w harnessie): `DelegateTool` woła
 * `runTask(..., { extraTools: args.extra_tools })`, ale `SubAgentRunner._resolveToolNames`
 * dokłada `extraTools` TYLKO gdy `allowExtraTools === true` - a tej flagi nikt nie podaje.
 *
 * Inwarianty: (1) delegacja piętra 1 wykonała się (tool.post delegate + success:true),
 * (2) definicje narzędzi suba nie mają `delegate`, a mają `read`, (3) rama suba zawiera zdanie
 * o zakazie dalszej delegacji, (4) wymuszone `delegate` dostało odmowę whitelisty po ludzku
 * (nie goły klucz), (5) w trace.log jest DOKŁADNIE JEDNA pętla sub-agenta i ZERO pętli workera
 * `pkm-sub` (drugi runner nigdy nie wystartował), (6) pętla główna kończy się naturalnie.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { t } from '@plugin/core/i18n/index.js';
import {
  parseTrace, readVaultFile, toolPosts, toolResult, assertFinalText, loopEnd, assert,
} from './_asserts.js';

const SUB_NAME = 'tester-kret';
const TRACE_REL = '.pkm-assistant/logs/trace.log';

/** Dowód zebrany W BIEGU: co fake-serwer zobaczył w żądaniach suba. */
const seen: { subTools: string[] | null; subSystem: string | null; refusal: string | null } = {
  subTools: null, subSystem: null, refusal: null,
};

function toolNames(request: import('./_asserts.js').FixturePayload): string[] {
  return (request?.tools || []).map((td: import('./_asserts.js').FixturePayload) => td?.function?.name).filter(Boolean);
}

/**
 * Czy to żądanie sub-agenta? Sub dostaje whitelistę z `tools:` (po schowaniu `delegate` zostaje
 * samo `read`), agent główny - kilkanaście built-inów. Rozróżniamy po liczbie narzędzi, a nie po
 * numerze tury: requesty suba i agenta głównego lecą do TEGO SAMEGO fake-serwera i przeplatają się.
 */
function isSubRequest(request: import('./_asserts.js').FixturePayload) {
  const names = toolNames(request);
  return names.length > 0 && names.length <= 4 && names.includes('read');
}

function systemText(request: import('./_asserts.js').FixturePayload): string {
  const first = (request?.messages || [])[0];
  if (!first || first.role !== 'system') return '';
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '');
}

export default ({
  file: '11_delegacja_glebia',
  name: 'delegacja glebia',
  opis: 'sub na limicie głębokości nie widzi delegate; wymuszone wywołanie odbite; drugi runner NIE startuje',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 6,
  // Żywy model nie da się deterministycznie zmusić, żeby sub-agent (osobna instancja z własnym
  // promptem) zawołał narzędzia, którego nie ma na liście - scenariusz jest offline-only.
  liveSkip: 'wymaga WYMUSZENIA wywołania `delegate` z wnętrza sub-agenta - żywy model decyduje o tym sam, więc scenariusz jest offline-only',

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
        'description: Sub testowy — ma delegate w whiteliscie, zeby sprawdzic granice glebi.',
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
        // Sub, pierwsza tura: zapisz, co dostał, i spróbuj delegować po samej nazwie.
        seen.subTools = toolNames(ctx.request);
        seen.subSystem = systemText(ctx.request);
        return toolCallTurn('delegate', { task: 'Zleć to jeszcze niżej — niech ktoś inny to zrobi.' });
      }
      // Sub, druga tura: dostał odpowiedź na wymuszone wywołanie - ZAPISZ ją jako dowód.
      seen.refusal = results.join('\n');
      return textTurn('Nie mogę zlecać dalej, więc robię to sam i oddaję wynik.');
    }
    // Agent główny.
    if (lastToolResults(ctx.request).length === 0) {
      seen.subTools = null; seen.subSystem = null; seen.refusal = null; // start biegu
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

    // ── 2. Sub NIE dostał `delegate` w definicjach narzędzi, ale ma `read` ──
    const subTools = seen.subTools;
    assert(Array.isArray(subTools), 'Fake-serwer nie zobaczył żadnego żądania sub-agenta.');
    assert(!subTools.includes('delegate'),
      `Sub na limicie głębokości dostał delegate w definicjach narzędzi: ${JSON.stringify(subTools)}`);
    assert(subTools.includes('read'), `Sub stracił read: ${JSON.stringify(subTools)}`);

    // ── 3. Rama suba mówi wprost, że dalej delegować nie wolno ──
    const noFurther = t('subagent.frame.no_further_delegation');
    assert(typeof seen.subSystem === 'string' && seen.subSystem.includes(noFurther),
      `Rama suba nie zawiera zdania o zakazie dalszej delegacji (${noFurther}).`);

    // ── 4. Wymuszone `delegate` odbite przez whitelistę, po ludzku ──
    const refusal = seen.refusal;
    assert(typeof refusal === 'string' && refusal.length > 0,
      'Sub nigdy nie dostał odpowiedzi na wymuszone wywołanie delegate.');
    assert(refusal.includes(t('subagent.tool_not_allowed', { name: 'delegate' })),
      `Wymuszone delegate nie dostało odmowy whitelisty. Wynik: ${refusal.slice(0, 300)}`);
    assert(!/subagent\.tool_not_allowed/.test(refusal),
      `Do modelu poszedł GOŁY KLUCZ i18n zamiast komunikatu: ${refusal.slice(0, 300)}`);

    // ── 5. Drugi runner NIGDY nie wystartował ──
    const traceRaw = readVaultFile(vaultRoot, TRACE_REL);
    const subLoops = parseTrace(traceRaw, `sub/${SUB_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(subLoops.length === 1,
      `Oczekiwano DOKŁADNIE 1 pętli sub-agenta „${SUB_NAME}", jest ${subLoops.length}.`);
    const workerLoops = parseTrace(traceRaw, 'sub/pkm-sub', { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(workerLoops.length === 0,
      `Wymuszone delegate ODPALIŁO runnera (${workerLoops.length}× pętla „sub/pkm-sub").`);

    // ── 6. Pętla główna domknęła się naturalnie ──
    assertFinalText(result);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies import('./_asserts.js').Scenario);
