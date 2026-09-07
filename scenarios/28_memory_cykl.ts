/**
 * 28_memory_cykl — PEŁNY cykl Memory v3 na żywym pluginie, bez Obsidiana i bez UI.
 *
 * Do dziś każdy kawałek tego łańcucha miał własne testy jednostkowe na atrapach vaulta
 * (`AgentMemory.test.ts`, `ArchiveWorkflowRun.test.ts`), ale NIKT nie przeszedł go od początku
 * do końca na PRAWDZIWYM systemie plików, prawdziwym `AgentMemory` wyprodukowanym przez
 * `AgentManager` i modelu wchodzącym tą samą drogą co czat. A to właśnie na stykach mieszkały
 * wtopy kubełka 2 (stempel `covered_by_l1` pisany pod złą ścieżkę → 12 duplikatów L1 u Kuby).
 *
 * Przebieg (wszystko po zwykłej turze, wzorem 14 — silnik wołany BEZPOŚREDNIO):
 *   1. żywa sesja: `appendToActiveSession` × 4 → `archiveActiveSession` — plik przeprowadza się
 *      z `sessions/active/` do `sessions/archive/`, a `.state.json` podbija licznik konsolidacji,
 *   2. materiał na paczkę: 4 sesje-fixture wprost w `sessions/archive/` (razem 5 = jedna paczka),
 *   3. plan: `archiveCount` liczony z `listUncoveredArchiveSessions()` (NIE z gołego listingu!)
 *      → `buildConsolidationPlan` → dokładnie JEDEN krok L1,
 *   4. generacja: `ArchiveWorkflow.runWithRun` z modelem z `createModelForRole` (offline trafia
 *      w fake-SSE) → krok `awaiting_review`, NIC na dysku,
 *   5. zatwierdzenie: `applyStepDecision(accepted:true)` → plik `summaries/L1/*_l1.md`,
 *      stempel `covered_by_l1` na KAŻDEJ z 5 sesji, licznik w `.state.json` wyzerowany,
 *   6. brak duplikatów: lista niepokrytych pusta, świeży plan nie proponuje już żadnego L1.
 *
 * ⚠️ KOLEJKA TUR FAKE-SERWERA JEST GLOBALNA dla całego scenariusza: tura 0 idzie do pętli
 * eksploracyjnej (zwykła odpowiedź czatu), tura 1 do strzału konsolidacji. Poza zakresem tablicy
 * serwer powtarza OSTATNIĄ turę — dlatego L1 stoi na końcu i ewentualna powtórka jest nieszkodliwa.
 * Treść L1 jest wyraźnie inna niż odpowiedź czatowa, żeby pomyłka w kolejce była widoczna od razu.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  ArchiveWorkflow,
  ConsolidationRun,
  buildConsolidationPlan,
  STEP_STATUS,
} from '../../modules/memory/index.js';
import { createModelForRole } from '../../modules/models/index.js';
import { assert, assertFinalText, listVaultFiles, readVaultFile } from './_asserts.js';

import type { StreamChatModelLike } from '../../modules/memory/index.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const AGENT = 'Tester';
const MEM = '.pkm-assistant/agents/tester/memory';
const ACTIVE_DIR = `${MEM}/sessions/active`;
const ARCHIVE_DIR = `${MEM}/sessions/archive`;
const L1_DIR = `${MEM}/summaries/L1`;
const STATE_REL = `${MEM}/.state.json`;

const PROMPT = 'Powiedz jednym zdaniem, po co jest ten testowy vault.';
const ODPOWIEDZ = 'Ten vault to rekwizyt harnessa — trzy notatki i jeden folder no-go.';
/** Treść, którą „model" oddaje przy strzale konsolidacji. Celowo NIE do pomylenia z odpowiedzią czatu. */
const L1_BODY = 'PODSUMOWANIE-L1-HARNESS: pięć rozmów o rekwizytach vaulta, planach i notatkach.';

/** Ile sesji wchodzi w jedną paczkę L1 (i ile paczek L1 w L2). */
const BATCH = 5;

/** Sesje-fixture w formacie transkryptu — tym samym, który produkuje `archiveActiveSession`. */
const FIXTURE_SESSIONS = ['2026-07-20_09-00-00.md', '2026-07-21_09-00-00.md', '2026-07-22_09-00-00.md', '2026-07-23_09-00-00.md'];

function fixtureSession(name: string, nr: number): string {
  const created = `${name.slice(0, 10)}T09:00:00.000Z`;
  return [
    '---',
    'type: archived_session',
    `agent: ${AGENT}`,
    `created: ${created}`,
    'messageCount: 2',
    '---',
    '## User',
    `Rozmowa numer ${nr}: o czym są notatki w tym vaulcie?`,
    '## Assistant',
    `Odpowiedź numer ${nr}: o rekwizytach harnessa i zadaniach do wykonania.`,
    '',
  ].join('\n');
}

/** Wartość skalarnego pola frontmattera z surowej treści pliku ('' gdy brak). */
function frontmatterField(raw: string, key: string): string {
  const match = raw.replace(/\r\n/g, '\n').match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

/** Pozycje listy YAML pod danym kluczem blokowym (`sessions:` + wcięte `  - nazwa`). */
function frontmatterList(raw: string, key: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `${key}:`);
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+(.*)$/);
    if (!m) break;
    out.push(m[1].trim());
  }
  return out;
}

export default ({
  file: '28_memory_cykl',
  name: 'cykl Memory v3',
  opis: 'sesja → archiwum → paczka L1 → stempel covered_by_l1 → zero duplikatów przy kolejnym planie',
  agent: AGENT,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  livePrompt: PROMPT,
  evidenceFiles: [STATE_REL, ARCHIVE_DIR, L1_DIR],
  // Sekwencja jest ZAPROJEKTOWANA: dokładnie jedna tura czatu, a potem JEDEN strzał konsolidacji,
  // którego treść musi być rozpoznawalna. Żywy model nie odtworzy tego deterministycznie, a bez
  // deterministycznej treści L1 nie da się dowieść, że paczka powstała z właściwego strzału.
  liveSkip: 'wymaga deterministycznej sekwencji tur (czat + strzał konsolidacji o rozpoznawalnej treści) — sens ma wyłącznie offline',

  fixtures: FIXTURE_SESSIONS.map((name, i) => ({
    path: `${ARCHIVE_DIR}/${name}`,
    content: fixtureSession(name, i + 1),
  })),

  offlineScript: [
    textTurn(ODPOWIEDZ),
    // OSTATNIA pozycja = strzał konsolidacji (patrz nagłówek: powtórka poza zakresem tablicy).
    textTurn(L1_BODY),
  ],

  async asserts({ result, vaultRoot, plugin }: FixturePayload) {
    // ── 0. Tura przeszła (bez tego reszta nie ma sensu) ──
    assertFinalText(result);

    const memory = plugin?.agentManager?.getActiveMemory?.();
    assert(memory, 'Brak AgentMemory aktywnego agenta — bootstrap pluginu nieukończony?');
    assert(memory.agentName === AGENT, `Pamięć należy do "${memory.agentName}", oczekiwano "${AGENT}".`);

    // ═══ 1. ŻYWA SESJA → ARCHIWUM ═══
    // Pisarzem zdarzeń jest w produkcji `modules/chat/chat/chat_streaming.js`, a harness nie
    // stawia warstwy czatu — scenariusz odgrywa tę rolę PRODUKCYJNĄ metodą (wzór 14).
    await memory.appendToActiveSession({ type: 'user_message', agentName: AGENT, content: PROMPT });
    await memory.appendToActiveSession({
      type: 'agent_message', agentName: AGENT, content: result.finalText, model: 'harness-offline',
    });
    await memory.appendToActiveSession({ type: 'user_message', agentName: AGENT, content: 'A co jest w folderze Sekrety?' });
    await memory.appendToActiveSession({
      type: 'agent_message', agentName: AGENT, content: 'To folder no-go — nie zaglądam tam.', model: 'harness-offline',
    });

    const activePath: string = memory.activeSessionPath;
    assert(activePath, 'Po appendach `activeSessionPath` jest pusty — sesja w ogóle nie powstała.');
    const sessionName = activePath.split('/').pop() as string;

    const stanPrzed = await memory.stateManager.read();
    const licznikPrzed = Number(stanPrzed.archived_since_last_consolidation || 0);

    const archivedPath = await memory.archiveActiveSession();
    assert(
      archivedPath === `${ARCHIVE_DIR}/${sessionName}`,
      `archiveActiveSession zwrócił "${archivedPath}", oczekiwano "${ARCHIVE_DIR}/${sessionName}".`,
    );

    // Plik przeprowadził się: nie ma go w `active/`, jest w `archive/`.
    const zostaloWActive = listVaultFiles(vaultRoot, ACTIVE_DIR).filter((p) => p.endsWith('.md'));
    assert(
      zostaloWActive.length === 0,
      `Po archiwizacji w ${ACTIVE_DIR} nadal leżą pliki: ${zostaloWActive.join(', ')} (sesja miała się PRZEPROWADZIĆ, nie skopiować).`,
    );
    const zarchiwizowana = readVaultFile(vaultRoot, `${ARCHIVE_DIR}/${sessionName}`);
    assert(
      zarchiwizowana.includes(PROMPT),
      'Zarchiwizowana sesja nie niesie treści rozmowy — konwersja event-log → transkrypt zgubiła wiadomości.',
    );

    // Licznik konsolidacji podbity DOKŁADNIE o jeden (to on decyduje o progu w produkcji).
    const stanPoArchiwizacji = await memory.stateManager.read();
    assert(
      Number(stanPoArchiwizacji.archived_since_last_consolidation) === licznikPrzed + 1,
      `markArchived nie podbił licznika: ${licznikPrzed} → ${stanPoArchiwizacji.archived_since_last_consolidation} (oczekiwano ${licznikPrzed + 1}).`,
    );
    assert(
      !(stanPoArchiwizacji.active_sessions || []).includes(sessionName),
      `Zarchiwizowana sesja "${sessionName}" nadal figuruje w active_sessions w .state.json.`,
    );

    // ═══ 2-3. MATERIAŁ NA PACZKĘ → PLAN ═══
    // `archiveCount` MUSI iść z listy NIEPOKRYTYCH (S30 Z7): gdyby plan liczył po gołym listingu
    // archiwum, obiecywałby paczki na sesjach, które generator odrzuci jako już podsumowane.
    const niepokryte = await memory.listUncoveredArchiveSessions();
    assert(
      niepokryte.length === BATCH,
      `Materiał na paczkę: oczekiwano ${BATCH} niepokrytych sesji, jest ${niepokryte.length} (${niepokryte.map((s: FixturePayload) => s.name).join(', ') || 'brak'}).`,
    );

    const steps = buildConsolidationPlan({
      archiveCount: niepokryte.length,
      batchSize: BATCH,
      brainNotesCount: 0,
      l1Count: 0,
      l2Count: 0,
    });
    assert(steps.length === 1, `Plan miał mieć DOKŁADNIE 1 krok, ma ${steps.length}: ${steps.map((s) => s.id).join(', ')}`);
    assert(steps[0].kind === 'l1', `Jedyny krok planu ma rodzaj "${steps[0].kind}", oczekiwano "l1".`);
    const stepId = steps[0].id;

    // ═══ 4. GENERACJA PRZEZ FAKE MODEL ═══
    const agent = plugin.agentManager.getActiveAgent();
    const model = createModelForRole(plugin, 'main', agent);
    assert(model?.stream, 'createModelForRole nie oddał modelu ze `stream` — ta sama ścieżka co czat jest zerwana.');

    const run = new ConsolidationRun({ steps, agentName: AGENT });
    const workflow = new ArchiveWorkflow(memory, {
      settings: plugin.env?.settings,
      // Ten sam gest co `harness/lib/runTurn.ts`: to JEST obiekt, którym mieli czat, ale
      // `ChatModel` deklaruje WĘŻSZY typ treści wiadomości niż strukturalny kontrakt
      // `StreamChatModelLike` w memory — statycznie nie da się ich pogodzić, runtime jest ten sam.
      model: model as unknown as StreamChatModelLike,
      agent,
      batchSize: BATCH,
      archiveSessions: niepokryte,
    });

    const outcome = await workflow.runWithRun(run);
    assert(
      outcome.generated.length === 1 && outcome.generated[0] === stepId,
      `Generacja: oczekiwano propozycji dla "${stepId}", wynik: ${JSON.stringify(outcome)}`,
    );

    const step = run.getStep(stepId);
    assert(step, `Przebieg zgubił krok "${stepId}".`);
    assert(
      step!.status === STEP_STATUS.AWAITING_REVIEW,
      `Krok po generacji ma status "${step!.status}", oczekiwano "${STEP_STATUS.AWAITING_REVIEW}" (generacja NIE zapisuje).`,
    );
    assert(
      String(step!.result?.body || '').includes('PODSUMOWANIE-L1-HARNESS'),
      `Propozycja L1 nie niesie treści ze strzału konsolidacji (kolejka tur fake-serwera się rozjechała?). Body: ${String(step!.result?.body || '').slice(0, 200)}`,
    );
    assert(
      step!.result?.llmDriven === true,
      'Propozycja L1 poleciała deterministycznym fallbackiem (llmDriven=false) — model NIE został użyty.',
    );
    assert(
      (step!.result?.sessions || []).length === BATCH,
      `Paczka objęła ${(step!.result?.sessions || []).length} sesji, oczekiwano ${BATCH}: ${JSON.stringify(step!.result?.sessions)}`,
    );
    assert(
      listVaultFiles(vaultRoot, L1_DIR).filter((p) => p.endsWith('.md')).length === 0,
      'Generacja ZAPISAŁA plik L1 — a miała tylko zaproponować (zapis dzieje się dopiero po decyzji usera).',
    );

    // ═══ 5. ZATWIERDZENIE ═══
    const applied = await workflow.applyStepDecision(run, stepId, { accepted: true });
    assert(applied.applied === true, `applyStepDecision nie zapisał kroku: ${JSON.stringify(applied)}`);
    assert(
      run.getStep(stepId)!.status === STEP_STATUS.DONE,
      `Krok po zapisie ma status "${run.getStep(stepId)!.status}", oczekiwano "${STEP_STATUS.DONE}".`,
    );

    const l1Files = listVaultFiles(vaultRoot, L1_DIR).filter((p) => p.endsWith('.md'));
    assert(l1Files.length === 1, `Oczekiwano DOKŁADNIE jednego pliku L1, jest ${l1Files.length}: ${l1Files.join(', ') || 'brak'}`);
    const l1Rel = l1Files[0];
    const l1Name = l1Rel.split('/').pop() as string;
    assert(/_l1(_\d+)?\.md$/.test(l1Name), `Nazwa pliku L1 ("${l1Name}") nie pasuje do konwencji *_l1.md.`);

    const l1Raw = readVaultFile(vaultRoot, l1Rel);
    assert(frontmatterField(l1Raw, 'level') === 'L1', `Frontmatter L1 ma level="${frontmatterField(l1Raw, 'level')}", oczekiwano "L1".`);
    const wypisaneSesje = frontmatterList(l1Raw, 'sessions');
    assert(
      wypisaneSesje.length === BATCH,
      `Frontmatter L1 wypisuje ${wypisaneSesje.length} sesji, oczekiwano ${BATCH}: ${wypisaneSesje.join(', ')}`,
    );
    assert(
      wypisaneSesje.includes(sessionName),
      `Sesja z ŻYWEJ rozmowy ("${sessionName}") nie weszła do paczki L1: ${wypisaneSesje.join(', ')}`,
    );
    assert(l1Raw.includes(L1_BODY), 'Treść pliku L1 nie zawiera podsumowania ze strzału konsolidacji.');

    // Stempel `covered_by_l1` na KAŻDEJ sesji paczki — bez niego kolejny przebieg zrobiłby
    // z tych samych sesji drugą paczkę (wtopa kubełka 2: 12 duplikatów L1).
    for (const name of wypisaneSesje) {
      const raw = readVaultFile(vaultRoot, `${ARCHIVE_DIR}/${name}`);
      const stempel = frontmatterField(raw, 'covered_by_l1');
      assert(
        stempel === l1Name,
        `Sesja "${name}" ma covered_by_l1="${stempel}", oczekiwano "${l1Name}" (stempel nie powstał → duplikaty L1 wracają).`,
      );
    }

    const stanPoL1 = await memory.stateManager.read();
    assert(
      Number(stanPoL1.archived_since_last_consolidation) === 0,
      `Licznik konsolidacji po zapisaniu paczki wynosi ${stanPoL1.archived_since_last_consolidation}, oczekiwano 0.`,
    );

    // ═══ 6. BRAK DUPLIKATÓW ═══
    const niepokryteTeraz = await memory.listUncoveredArchiveSessions();
    assert(
      niepokryteTeraz.length === 0,
      `Po zatwierdzeniu paczki lista niepokrytych sesji ma nadal ${niepokryteTeraz.length} pozycji: ${niepokryteTeraz.map((s: FixturePayload) => s.name).join(', ')}`,
    );

    const swiezyPlan = buildConsolidationPlan({
      archiveCount: niepokryteTeraz.length,
      batchSize: BATCH,
      brainNotesCount: 0,
      l1Count: l1Files.length,
      l2Count: 0,
    });
    assert(
      swiezyPlan.filter((s) => s.kind === 'l1').length === 0,
      `Świeży plan wciąż proponuje paczki L1: ${swiezyPlan.map((s) => s.id).join(', ')} (te same sesje poszłyby drugi raz).`,
    );
  },
} satisfies Scenario);
