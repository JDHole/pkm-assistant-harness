/**
 * 43_tlo_po_turze — bieg w tle należy do TURY, która go zleciła, a nie do tego, co user
 * akurat ma na wierzchu (klaster K4: AUD-security-091 + AUD-security-050).
 *
 * Delegacja z głównego czatu jest od rundy 3 ZAWSZE w tle, więc bieg suba przeżywa turę
 * i normalnie dożywa chwili, w której user przełączył zakładkę na innego agenta. Do K4
 * runner czytał wtedy GLOBALNE lustra pluginu:
 *   • `agentManager.getActiveMemory()` → dziennik biegu (zlecenie + CAŁY wynik suba)
 *     lądował w `sessions/active/` obcego agenta,
 *   • `plugin.currentAutonomy` → sub dokańczał pracę w trybie nowej zakładki, więc
 *     zlecenie wydane w `edge` („pytaj przed zapisem") kończyło się w `yolo` (zero pytań).
 *
 * Scenariusz odgrywa dokładnie tę jedną akcję usera: w chwili `task:created` (bieg suba
 * właśnie ruszył, tura jeszcze trwa) przełącza aktywnego agenta na Podglądacza I zbija
 * lustro autonomii na `yolo` — tak jak zrobiłby to klik w drugą zakładkę czatu.
 *
 * Inwarianty:
 *   1. dziennik biegu (`subagent_call`) jest w `sessions/active/` TESTERA — właściciela zlecenia,
 *   2. Podglądacz nie ma ANI JEDNEGO pliku sesji (cudzy bieg go nie dotknął),
 *   3. `write` suba PYTAŁ o zgodę — czyli sub jechał autonomią `edge` zamrożoną przy zleceniu
 *      (gdyby czytał lustro, byłoby `yolo` = zero pytań),
 *   4. przełączenie naprawdę się odbyło (globalny aktywny agent to Podglądacz).
 *
 * `aspect: 'worker'` jest tu potrzebny, bo wbudowany worker dostaje pełną listę narzędzi
 * rodzica — a bez `write` (RED) nie byłoby o co pytać i inwariant 3 nie miałby dowodu.
 */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { awaitBackgroundSubTasks } from '../lib/runTurn.js';
import { assert, assertFinalText, listVaultFiles, readVaultFile } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const WLASCICIEL = 'Tester';
const PODGLADACZ = 'Podgladacz';
const ACTIVE_WLASCICIEL = '.pkm-assistant/agents/tester/memory/sessions/active';
const ACTIVE_PODGLADACZ = '.pkm-assistant/agents/podgladacz/memory/sessions/active';
const PLIK_SUBA = 'Notatki/od_suba.md';
const ZADANIE = 'Zapisz notatkę z ustaleniami i oddaj jedno zdanie.';
const ODPOWIEDZ_SUBA = 'Notatka zapisana, ustalenia w jednym zdaniu.';

/** Ile razy fake-serwer obsłużył żądanie suba (diagnostyka przy RED). */
const stan = { zadaniaSuba: 0, przelaczen: 0 };

/**
 * Czy to żądanie SUB-AGENTA? Zwykły rozróżniacz „mało narzędzi" tu NIE DZIAŁA — wbudowany
 * worker dostaje pełną listę rodzica. Rozpoznajemy po jego nazwie w promptcie systemowym
 * (rama suba wstawia `{{SUB_NAME}}`), której pętla główna nigdy nie niesie.
 */
function jestPodzapytaniem(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((m: FixturePayload) => m?.role === 'system');
  return typeof system?.content === 'string' && system.content.includes('pkm-worker');
}

function agentYaml(name: string, opis: string): string {
  return [
    `name: ${name}`,
    `description: ${opis}`,
    'personality: |',
    `  Jesteś ${name} — rzeczowy agent do smoke-testów pluginu. Odpowiadasz krótko.`,
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
  ].join('\n');
}

export default ({
  file: '43_tlo_po_turze',
  name: 'tlo po turze',
  opis: 'przełączenie agenta w trakcie biegu w tle nie przenosi ani dziennika biegu, ani trybu autonomii',
  agent: WLASCICIEL,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  evidenceFiles: [PLIK_SUBA],
  liveSkip: 'wymaga wymuszenia delegacji z aspektem worker i zapisu w subie — żywy model decyduje o tym sam',

  fixtures: [
    { path: '.pkm-assistant/agents/tester.yaml', content: agentYaml(WLASCICIEL, 'Agent testowy harnessa — właściciel zlecenia.') },
    { path: '.pkm-assistant/agents/podgladacz.yaml', content: agentYaml(PODGLADACZ, 'Agent testowy harnessa — przełączony w trakcie biegu.') },
  ],

  async setup({ plugin }) {
    assert(plugin?.subTaskRegistry, 'Brak plugin.subTaskRegistry — bez rejestru delegacja nie poszłaby w tło.');
    assert(
      plugin.agentManager?.getAgent?.(PODGLADACZ),
      `Agent ${PODGLADACZ} nie wstał z fixture — bez drugiego agenta nie ma czego przełączać.`,
    );
    // JEDNA akcja usera: klik w drugą zakładkę czatu w chwili, gdy sub właśnie ruszył.
    // Robimy ją produkcyjną drogą (`switchAgent` + lustro autonomii), przez szynę zdarzeń.
    plugin.subTaskRegistry.events.on('task:created', () => {
      plugin.agentManager.switchAgent(PODGLADACZ);
      plugin.currentAutonomy = 'yolo';
      stan.przelaczen += 1;
    });
  },

  offlineScript: (ctx: FixturePayload) => {
    if (jestPodzapytaniem(ctx.request)) {
      stan.zadaniaSuba += 1;
      // Pierwsza iteracja suba: zapis (RED → w `edge` MUSI zapytać o zgodę).
      if (lastToolResults(ctx.request).length === 0) {
        return toolCallTurn('write', { path: PLIK_SUBA, content: 'ustalenia suba', mode: 'create' });
      }
      return textTurn(ODPOWIEDZ_SUBA);
    }
    // Pętla główna: zlecenie, potem domknięcie tury na pokwitowaniu.
    if (lastToolResults(ctx.request).length === 0) {
      return toolCallTurn('delegate', { task: ZADANIE, aspect: 'worker' });
    }
    return textTurn('Zleciłem to w tle — dam znać, jak wróci wynik.');
  },

  async asserts(ctx) {
    const { result, vaultRoot, plugin, approvals } = ctx;
    assertFinalText(result, 'Pętla główna nie zwróciła odpowiedzi.');
    await awaitBackgroundSubTasks(plugin);

    assert(stan.przelaczen >= 1, 'Przełączenie agenta w trakcie biegu w ogóle się nie odbyło — scenariusz nic nie bada.');
    assert(
      plugin.agentManager.getActiveAgent()?.name === PODGLADACZ,
      `Globalny aktywny agent to "${plugin.agentManager.getActiveAgent()?.name}", oczekiwano "${PODGLADACZ}".`,
    );
    assert(stan.zadaniaSuba >= 2, `Fake-serwer obsłużył ${stan.zadaniaSuba} żądań suba, oczekiwano ≥2 (zapis + podsumowanie).`);

    // ── 1. Dziennik biegu u WŁAŚCICIELA zlecenia ──
    const pliki = listVaultFiles(vaultRoot, ACTIVE_WLASCICIEL).filter((p: string) => p.endsWith('.md'));
    assert(
      pliki.length === 1,
      `Oczekiwano jednego pliku aktywnej sesji w ${ACTIVE_WLASCICIEL}, jest ${pliki.length}: ${pliki.join(', ') || '(brak)'}`,
    );
    const dziennik = readVaultFile(vaultRoot, pliki[0]);
    // Nagłówek zdarzenia jest „uczłowieczony" przez formatSessionEvent (`subagent_call` → „subagent call").
    assert(
      /subagent[ _]call/.test(dziennik),
      'Brak zdarzenia subagent_call w sesji właściciela — dziennik biegu poszedł gdzie indziej.',
    );
    assert(
      dziennik.includes(ODPOWIEDZ_SUBA),
      'Wynik suba nie trafił do sesji właściciela (a to on zlecił bieg).',
    );

    // ── 2. Pamięć Podglądacza NIETKNIĘTA ──
    const obce = listVaultFiles(vaultRoot, ACTIVE_PODGLADACZ).filter((p: string) => p.endsWith('.md'));
    assert(
      obce.length === 0,
      `PRZECIEK MIĘDZY AGENTAMI: bieg Testera dopisał się do sesji Podglądacza (${obce.join(', ')}).`,
    );

    // ── 3. Autonomia zamrożona przy zleceniu (edge pyta, yolo nie) ──
    const pytania = (approvals || []).filter((a: FixturePayload) => /write/.test(String(a.tool || '')));
    assert(
      pytania.length >= 1,
      'Sub NIE zapytał o zgodę na write — czyli dokończył bieg w trybie `yolo` z globalnego lustra '
      + `zamiast w \`edge\` z tury zlecającej. Zarejestrowane pytania: ${JSON.stringify(approvals)}`,
    );
    assert(
      pytania.every((a: FixturePayload) => a.agent === WLASCICIEL),
      `Pytanie o zgodę przyszło w imieniu innego agenta niż właściciel biegu: ${JSON.stringify(pytania)}`,
    );
  },
} satisfies Scenario);
