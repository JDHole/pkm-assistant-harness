/**
 * 11_delegacja_glebia — domyślnie sub deleguje do wnuka, a wnuk na limicie
 * nie widzi delegate i jego wymuszone wywołanie odbija whitelista. Osobne
 * wywołanie z jawnym limitem 1 sprawdza to samo ograniczenie już na subie.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { t } from '@plugin/core/i18n/index.js';
import { getLimits } from '@plugin/config/limits.js';
import {
  parseTrace, readVaultFile, toolPosts, toolResult, assertFinalText, loopEnd, assert,
} from './_asserts.js';

const SUB_NAME = 'tester-kret';
const CHILD_NAME = 'tester-wnuk';
const ORIGIN = { agentName: 'Tester', sessionPath: 'Chats/glebia.md', sessionEpoch: 'glebia', tabKey: 'glebia' };
const TRACE_REL = '.pkm-assistant/logs/trace.log';

type Evidence = { tools: string[] | null; system: string | null; refusal: string | null };
const evidence = (): Evidence => ({ tools: null, system: null, refusal: null });
const seen = { phase: 'default', sub: evidence(), grandchild: evidence(), limited: evidence(), nestedResult: '' };

function toolNames(request: import('./_asserts.js').FixturePayload): string[] {
  return (request?.tools || []).map((td: import('./_asserts.js').FixturePayload) => td?.function?.name).filter(Boolean);
}

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
  opis: 'domyślnie sub deleguje do wnuka na limicie; jawny limit 1 blokuje już suba',
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
        `  - ${CHILD_NAME}`,
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
    {
      path: `.pkm-assistant/sub-agents/${CHILD_NAME}/SUB_AGENT.yaml`,
      content: [`name: ${CHILD_NAME}`, 'description: Wnuk testowy.', 'tools:', '  - read', '  - delegate', 'max_iterations: 3', 'min_iterations: 1', ''].join('\n'),
    },
  ],

  setup({ plugin }) {
    const execute = plugin.mcpClient.executeToolCall.bind(plugin.mcpClient);
    plugin.mcpClient.executeToolCall = (call, agent, options = {}) => execute(call, agent, { ...options, origin: options.origin ?? ORIGIN });
    seen.phase = 'default'; seen.sub = evidence(); seen.grandchild = evidence();
    seen.limited = evidence(); seen.nestedResult = '';
    // Usuń ewentualny nadpisany limit, aby pierwsza część sprawdzała rzeczywisty default.
    delete plugin.env.settingsStore.raw.pkmAssistant.limits?.max_delegation_depth;
    delete plugin.env.settings.pkmAssistant.limits?.max_delegation_depth;
    assert(getLimits(plugin.env.settings).max_delegation_depth === 2, 'Domyślny limit głębokości nie wynosi 2.');
  },

  offlineScript: (ctx: import('./_asserts.js').FixturePayload) => {
    if (isSubRequest(ctx.request)) {
      const tools = toolNames(ctx.request);
      const target = seen.phase === 'limited' ? seen.limited : tools.includes('delegate') ? seen.sub : seen.grandchild;
      const results = lastToolResults(ctx.request);
      if (results.length === 0) {
        target.tools = tools;
        target.system = systemText(ctx.request);
        return toolCallTurn('delegate', { task: 'Sprawdź notatki i przekaż wynik.', aspect: CHILD_NAME });
      }
      if (target === seen.sub) seen.nestedResult = results.join('\n');
      else target.refusal = results.join('\n');
      return textTurn('Zadanie zakończone.');
    }
    if (lastToolResults(ctx.request).length === 0) {
      return toolCallTurn('delegate', { task: 'Sprawdź notatki i zleć resztę dalej.', aspect: SUB_NAME, extra_tools: ['delegate'] });
    }
    return textTurn('Sub oddał wynik — kończę.');
  },

  async asserts({ result, trace, vaultRoot, plugin }) {
    const waitFor = async (ready: () => boolean) => {
      for (let i = 0; i < 200 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    };
    await waitFor(() => !!seen.sub.refusal || (!!seen.nestedResult && !!seen.grandchild.refusal));
    await waitFor(() => plugin.subTaskRegistry.list().every((task) => !['running', 'queued'].includes(task.status)));
    await plugin.traceLog?.sink?.flush?.();
    const posts = toolPosts(trace).filter((p) => p.tool === 'delegate');
    assert(posts.length === 1, `Oczekiwano 1 delegacji głównej, jest ${posts.length}.`);
    const lvl1 = toolResult(result, 'delegate');
    assert(lvl1 && /^\{"success":true/.test(lvl1.resultPreview || ''), `Delegacja suba nie powiodła się: ${lvl1?.resultPreview}`);
    assert(seen.sub.tools?.includes('read') && seen.sub.tools.includes('delegate'),
      `Sub domyślnie musi mieć read i delegate: ${JSON.stringify(seen.sub.tools)}`);
    assert(/"success"\s*:\s*true/.test(seen.nestedResult), `Delegacja do wnuka nie powiodła się: ${seen.nestedResult}`);

    function assertBlocked(e: Evidence, label: string) {
      assert(Array.isArray(e.tools) && e.tools.includes('read') && !e.tools.includes('delegate'),
        `${label}: oczekiwano read bez delegate: ${JSON.stringify(e.tools)}`);
      const noFurther = t('subagent.frame.no_further_delegation');
      assert(typeof e.system === 'string' && e.system.includes(noFurther), `${label}: brak zakazu dalszej delegacji w ramie.`);
      assert(typeof e.refusal === 'string' && e.refusal.includes(t('subagent.tool_not_allowed', { name: 'delegate' })),
        `${label}: brak odmowy whitelisty: ${e.refusal}`);
      assert(!/subagent\.tool_not_allowed/.test(e.refusal), `${label}: goły klucz i18n: ${e.refusal}`);
    }
    assertBlocked(seen.grandchild, 'Wnuk');
    let raw = readVaultFile(vaultRoot, TRACE_REL);
    let loops = parseTrace(raw, `sub/${SUB_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(loops.length === 1, `Oczekiwano jednej pętli suba, jest ${loops.length}.`);
    assert(parseTrace(raw, `sub/${CHILD_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start').length === 1, 'Oczekiwano jednej pętli wnuka.');
    assert(parseTrace(raw, 'sub/pkm-sub', { prefix: true }).filter((e) => e.type === 'loop.start').length === 0,
      'Wymuszone delegate wnuka uruchomiło dodatkowego workera.');
    assertFinalText(result);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);

    seen.phase = 'limited';
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 1;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
    assert(getLimits(plugin.env.settings).max_delegation_depth === 1, 'Jawny limit 1 nie został zastosowany.');
    const limitedResult = await plugin.mcpClient.executeToolCall(
      { id: 'depth-limit-one', name: 'delegate', arguments: { task: 'Sprawdź notatki.', aspect: SUB_NAME } },
      'Tester', { delegationDepth: 0, autonomy: 'yolo' },
    );
    assert(limitedResult.success === true, `Delegacja przy limicie 1 nie powiodła się: ${JSON.stringify(limitedResult)}`);
    await waitFor(() => !!seen.limited.refusal);
    await waitFor(() => plugin.subTaskRegistry.list().every((task) => !['running', 'queued'].includes(task.status)));
    await plugin.traceLog?.sink?.flush?.();
    assertBlocked(seen.limited, 'Sub przy limicie 1');
    raw = readVaultFile(vaultRoot, TRACE_REL);
    loops = parseTrace(raw, `sub/${SUB_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start');
    assert(loops.length === 2, `Limit 1 powinien uruchomić tylko jedną dodatkową pętlę, jest ${loops.length}.`);
    assert(parseTrace(raw, `sub/${CHILD_NAME}`, { prefix: true }).filter((e) => e.type === 'loop.start').length === 1, 'Przy limicie 1 nie może powstać kolejna pętla wnuka.');
    assert(parseTrace(raw, 'sub/pkm-sub', { prefix: true }).filter((e) => e.type === 'loop.start').length === 0,
      'Wymuszone delegate suba uruchomiło dodatkowego workera.');
  },
} satisfies import('./_asserts.js').Scenario);
