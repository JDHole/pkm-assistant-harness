/**
 * 13_external_red — narzędzie CUDZEGO serwera MCP: RED + strip tożsamości na żywym łańcuchu (E3.1/S33 Z3).
 *
 * Co realnie sprawdza — na PEŁNYM łańcuchu (model → pętla → MCPClient → ExternalMcpManager →
 * klient MCP), a nie na atrapie w teście jednostkowym:
 *   1. Narzędzie zarejestrowane przez `ExternalMcpManager` ma `source:'user'` → `classifyToolRisk`
 *      daje RED bezwarunkowo → w autonomii `edge` pytanie o zgodę jest OBOWIĄZKOWE. Widać to
 *      jako wpis `external.call` w handlerze zgód (żadne inne narzędzie tej tury go nie generuje).
 *   2. Do cudzego serwera lecą argumenty MODELU, ale ŻADEN znacznik wewnętrzny `_invocation*`
 *      (w szczególności `_invocationAgentName` — tożsamość agenta). Filtr:
 *      `ExternalMcpManager.stripInternalArgs`, wołany przez `_stripInternal` w `callTool`.
 *
 * WYBÓR WARIANTU (A/B): scenariusz idzie ścieżką `approve:'auto'`, bo tylko wtedy wywołanie
 * DOCHODZI do cudzego serwera i da się sprawdzić, CO fizycznie wyszło z pluginu — a to jest
 * inwariant, którego test jednostkowy nie pokrywa end-to-end. Wariant „deny blokuje wykonanie"
 * jest już pokryty: mechanicznie przez `06_edge_deny` (ta sama bramka `ApprovalManager`), a dla
 * external dodatkowo przez testy jednostkowe `ExternalMcpManager.test.js` / `MCPClient`.
 * Fakt, że pytanie PADŁO (czyli RED zadziałał), sprawdzamy tu wprost — na liście zgód.
 *
 * ATRAPA SERWERA: przez `setup()` (hook runnera po boocie, przed turą modelu) podmieniamy
 * `externalMcpManager._clientFactory` na fake klienta w kontrakcie SDK (connect/listTools/
 * callTool/close) — dokładnie wzór DI z `ExternalMcpManager.test.js`. Zero sieci, zero procesów.
 *
 * Inwarianty: fake serwer dostał DOKŁADNIE jedno wywołanie, z argumentami modelu i BEZ
 * `_invocation*`; w przebiegu była zgoda typu `external.call`; pętla domknęła się naturalnie.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { assertFinalText, loopEnd, toolPosts, assert } from './_asserts.js';

const SERVER_ID = 'fejk';
const TOOL = `${SERVER_ID}__ping`;
const SEKRET = 'abc';

/** Co fake serwer MCP realnie dostał (wypełniane w biegu, czytane w asercjach). */
const odebrane: { calls: import('./_asserts.js').FixturePayload[] } = { calls: [] };

/** Klient w kontrakcie SDK MCP — ten sam kształt, którego używa `ExternalMcpManager`. */
function makeFakeMcpClient() {
  return {
    async connect() { /* handshake — nic nie robimy */ },
    async listTools() {
      return {
        tools: [{
          name: 'ping',
          description: 'Odbija piłeczkę i zwraca pong.',
          inputSchema: { type: 'object', properties: { sekret: { type: 'string' } }, required: ['sekret'] },
        }],
      };
    },
    async callTool(params: import('./_asserts.js').FixturePayload) {
      odebrane.calls.push(params);
      return { content: [{ type: 'text', text: 'pong' }] };
    },
    async close() { /* brak procesu do ubicia */ },
  };
}

export default ({
  file: '13_external_red',
  name: 'external red',
  opis: 'narzędzie cudzego serwera MCP = RED (obowiązkowa zgoda) + żaden znacznik _invocation* nie wychodzi na zewnątrz',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  // Żywy model dostałby to narzędzie w liście, ale nic nie gwarantuje, że je zawoła z tym
  // argumentem — a bez konkretnego wywołania nie ma czego sprawdzać przy strip-ie.
  liveSkip: 'wymaga atrapy zewnętrznego serwera MCP (DI klienta) i WYMUSZONEGO wywołania jego narzędzia — sens ma wyłącznie offline',

  fixtures: [
    {
      // Tester z konektorem `fejk` opt-in (`mcp_servers[]`) — tak jak user przypina konektor
      // w profilu agenta. Bez tego narzędzie external nie przeszłoby przez `filterByAgent`.
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
        `  - ${SERVER_ID}`,
        '',
      ].join('\n'),
    },
  ],

  /** Podłącz atrapę serwera MCP do ŻYWEGO pluginu, zanim model zdąży cokolwiek zawołać. */
  async setup({ plugin }) {
    odebrane.calls.length = 0; // start biegu — wyczyść dowód z ewentualnego poprzedniego
    const manager = plugin?.externalMcpManager;
    if (!manager) throw new Error('plugin.externalMcpManager nie istnieje — bootstrap MCP nie doszedł do E3.1?');
    // DI jak w testach jednostkowych: fabryka klienta zamiast prawdziwego SDK/transportu.
    manager._clientFactory = async () => ({ client: makeFakeMcpClient(), transport: { fake: true } });
    const res = await manager.connect({
      id: SERVER_ID,
      name: 'Fejk',
      transport: 'http',
      url: 'http://127.0.0.1:1/mcp', // nieużywane — fabryka i tak nie tworzy transportu
      enabled: true,
    });
    if (!res?.success || !res.tools?.includes(TOOL)) {
      throw new Error(`Atrapa serwera MCP nie zarejestrowała ${TOOL}: ${JSON.stringify(res)}`);
    }
  },

  offlineScript: [
    toolCallTurn(TOOL, { sekret: SEKRET }),
    textTurn('Serwer zewnętrzny odpowiedział.'),
  ],

  asserts({ result, trace, approvals }) {
    // ── 1. RED = pytanie padło (w edge nie ma opcji „po cichu") ──
    const external = (approvals || []).filter((a: import('./_asserts.js').FixturePayload) => a.tool === 'external.call');
    assert(external.length === 1,
      `Oczekiwano DOKŁADNIE 1 pytania o zgodę typu external.call, jest ${external.length}: ${JSON.stringify(approvals)}`);
    assert(external[0].decision === 'approve',
      `Handler zgód miał zatwierdzić (approve:auto), a zdecydował: ${external[0].decision}`);

    // ── 2. Narzędzie wykonało się, dokładnie raz ──
    const posts = toolPosts(trace).filter((p) => p.tool === TOOL);
    assert(posts.length === 1 && posts[0].status === 'ok',
      `Oczekiwano 1 udanego tool.post dla ${TOOL}, jest: ${JSON.stringify(posts)}`);
    assert(odebrane.calls.length === 1,
      `Fake serwer MCP miał dostać DOKŁADNIE 1 wywołanie, dostał ${odebrane.calls.length}.`);

    // ── 3. Do cudzego serwera poszły argumenty MODELU… ──
    const wyslane = odebrane.calls[0];
    assert(wyslane.name === 'ping',
      `Serwer dostał nazwę „${wyslane.name}", a miał „ping" (prefiks <serverId>__ zdejmuje routing).`);
    const args = wyslane.arguments || {};
    assert(args.sekret === SEKRET,
      `Argumenty modelu nie dotarły do serwera: ${JSON.stringify(args)}`);

    // ── 4. …ale ŻADEN znacznik wewnętrzny ──
    const przeciek = Object.keys(args).filter((k) => k.startsWith('_invocation'));
    assert(przeciek.length === 0,
      `Do CUDZEGO serwera wyciekły znaczniki wewnętrzne: [${przeciek.join(', ')}] — pełne argumenty: ${JSON.stringify(args)}`);
    assert(!('_invocationAgentName' in args),
      'Tożsamość agenta (_invocationAgentName) wyszła poza plugin.');

    // ── 5. Pętla domknięta naturalnie ──
    assertFinalText(result);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies import('./_asserts.js').Scenario);
