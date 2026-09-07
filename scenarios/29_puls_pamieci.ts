/**
 * 29_puls_pamieci — pancerze PRZEBIEGU konsolidacji (S29 „Puls pamięci") na żywym pluginie.
 *
 * Sprint S29 powstał, bo cykl zapisu sesji potrafił strzelić 5× do LLM BEZ żadnego UI, a zdechły
 * stream wisiał do twardego timeoutu transportu (600 s) i po cichu spadał na deterministyczny fallback.
 * Silnik dostał wtedy trzy pancerze — i to one są tu sprawdzane, na PRAWDZIWEJ pamięci agenta
 * (`AgentManager.getActiveMemory()`, prawdziwy system plików), a nie na atrapie vaulta:
 *
 *   1. **ZWIS → auto-ponowienie 1×** — cisza dłuższa niż `stallTimeoutMs` ubija strzał, krok
 *      ponawia się DOKŁADNIE raz i kończy propozycją. Licznik `retryCount` jest dowodem.
 *   2. **ANULUJ w trakcie** — `AbortController` przerywa generację; krok kończy jako `failed`
 *      (nigdy nie zostaje w `running`, bo wtedy centrum operacji byłoby zajęte do restartu),
 *      a przerwanie NIE spala drugiego strzału do modelu.
 *   3. **Ręczne „Ponów"** — `retryStep` na padniętym kroku wskrzesza go z TYM SAMYM oknem paczki
 *      i świeżym budżetem auto-ponowień.
 *   4. **Nieblokowalność centrum** — drugi trigger przy zajętym `memoryOpsCenter` NIE startuje
 *      drugiego przebiegu (zwraca ten, który leci, i prosi o modal), a `finishRun` zwalnia centrum.
 *
 * MODEL: punkty 1-3 chodzą na ATRAPACH wstrzykniętych do `ArchiveWorkflow` (`{stream(req, handlers)}`),
 * nie na fake-SSE — bo cała rzecz polega na tym, żeby model NIC nie oddał, i to w kontrolowanym
 * momencie. Fake-serwer obsługuje wyłącznie turę czatu, którą wymusza kontrakt scenariusza.
 *
 * ⚠️ `memoryOpsCenter` jest SINGLETONEM modułu, a scenariusze biegną sekwencyjnie w JEDNYM
 * procesie — punkt 4 sprząta po sobie w `finally`, także na ścieżce błędu. Zostawione „zajęte"
 * centrum wywróciłoby dowolny późniejszy scenariusz dotykający konsolidacji.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  ArchiveWorkflow,
  ConsolidationRun,
  buildConsolidationPlan,
  memoryOpsCenter,
  OPS_EVENT,
  STEP_STATUS,
} from '../../modules/memory/index.js';
import { assert, assertFinalText, listVaultFiles } from './_asserts.js';

import type { StreamChatModelLike } from '../../modules/memory/index.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const AGENT = 'Tester';
const MEM = '.pkm-assistant/agents/tester/memory';
const ARCHIVE_DIR = `${MEM}/sessions/archive`;
const L1_DIR = `${MEM}/summaries/L1`;

const PROMPT = 'Odpowiedz jednym zdaniem: po co jest folder Notatki?';
const ODPOWIEDZ = 'Folder Notatki trzyma rekwizyty harnessa.';

const BATCH = 5;
/**
 * Cisza dłuższa niż to = zwis. Krótko, żeby scenariusz nie stał sekundami, ale z zapasem:
 * poprawny strzał atrapy wraca przez `setTimeout(0)`, a przy zajętej pętli zdarzeń zbyt ciasne
 * okno (20-40 ms) potrafiłoby uznać UDANY strzał za zwis i zrobić z tego migotliwe RED.
 */
const STALL_MS = 150;
/** Po tylu ms leci `abort()` w teście 2. Watchdog jest tam WYŁĄCZONY, więc może być krótko. */
const ABORT_PO_MS = 30;

const PO_PONOWIENIU = 'Streszczenie po automatycznym ponowieniu.';
const PO_RECZNYM_PONOW = 'Streszczenie po ręcznym Ponów.';

/** Sesje-fixture w archiwum: materiał na dokładnie jedną paczkę L1. */
const FIXTURE_SESSIONS = [
  '2026-07-20_08-00-00.md',
  '2026-07-21_08-00-00.md',
  '2026-07-22_08-00-00.md',
  '2026-07-23_08-00-00.md',
  '2026-07-24_08-00-00.md',
];

function fixtureSession(name: string, nr: number): string {
  return [
    '---',
    'type: archived_session',
    `agent: ${AGENT}`,
    `created: ${name.slice(0, 10)}T08:00:00.000Z`,
    'messageCount: 2',
    '---',
    '## User',
    `Rozmowa ${nr}: streść mi notatki.`,
    '## Assistant',
    `Odpowiedź ${nr}: notatki opisują rekwizyty testowego vaulta.`,
    '',
  ].join('\n');
}

/** Atrapa modelu w kontrakcie `streamToComplete` + liczniki dowodowe. */
interface AtrapaModelu extends StreamChatModelLike {
  /** ile razy model został w ogóle odpalony */
  calls: number;
  /** ile razy ktoś przerwał stream (`stopStream`) */
  stopped: number;
}

/**
 * Model sterowany skryptem — jeden wpis na wywołanie:
 *   `'ZWIS'` → nie oddaje ANI JEDNEGO chunka (watchdog musi go ubić),
 *   string   → `done()` z tą treścią.
 * Po wyczerpaniu skryptu powtarza ostatnią pozycję (albo zwisa, gdy skrypt pusty).
 */
function atrapaModelu(script: string[] = []): AtrapaModelu {
  const model: AtrapaModelu = {
    calls: 0,
    stopped: 0,
    stopStream() { model.stopped += 1; },
    stream(_req, handlers) {
      const akcja = script[model.calls] ?? script[script.length - 1] ?? 'ZWIS';
      model.calls += 1;
      if (akcja === 'ZWIS') return undefined; // cisza — nic nie wraca, nawet błąd
      const timer = setTimeout(() => handlers.done({
        choices: [{ message: { content: akcja } }],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      }), 0);
      (timer as { unref?: () => void })?.unref?.();
      return undefined;
    },
  };
  return model;
}

/** Świeży przebieg z planem na jedną paczkę L1 (te same 5 sesji za każdym razem). */
function swiezyPrzebieg(): ConsolidationRun {
  const steps = buildConsolidationPlan({
    archiveCount: FIXTURE_SESSIONS.length,
    batchSize: BATCH,
    brainNotesCount: 0,
    l1Count: 0,
    l2Count: 0,
  });
  return new ConsolidationRun({ steps, agentName: AGENT });
}

export default ({
  file: '29_puls_pamieci',
  name: 'puls pamieci',
  opis: 'konsolidacja: zwis → auto-ponów 1×, anulowanie kończy krok jako failed, ręczne Ponów wskrzesza, centrum operacji nie da się zablokować',
  agent: AGENT,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  livePrompt: PROMPT,
  evidenceFiles: [ARCHIVE_DIR, L1_DIR],
  // Cała rzecz polega na modelu, który NIC nie oddaje w kontrolowanym momencie — żywy DeepSeek
  // z definicji tego nie zrobi, a bez zwisu i abortu nie ma czego sprawdzać.
  liveSkip: 'wymaga atrap modelu symulujących zwis i przerwanie w trakcie — na żywym modelu niewymuszalne',

  fixtures: FIXTURE_SESSIONS.map((name, i) => ({
    path: `${ARCHIVE_DIR}/${name}`,
    content: fixtureSession(name, i + 1),
  })),

  // Kontrakt scenariusza wymaga skryptu offline; sam przebieg konsolidacji chodzi na atrapach.
  offlineScript: [textTurn(ODPOWIEDZ)],

  async asserts({ result, vaultRoot, plugin }: FixturePayload) {
    assertFinalText(result);

    const memory = plugin?.agentManager?.getActiveMemory?.();
    assert(memory, 'Brak AgentMemory aktywnego agenta — bootstrap pluginu nieukończony?');
    assert(memory.agentName === AGENT, `Pamięć należy do "${memory.agentName}", oczekiwano "${AGENT}".`);
    const agent = plugin.agentManager.getActiveAgent();

    const workflowZ = (model: AtrapaModelu) => new ArchiveWorkflow(memory, {
      settings: plugin.env?.settings,
      model,
      agent,
      batchSize: BATCH,
    });

    // ═══ 1. ZWIS → AUTO-PONOWIENIE 1× ═══
    const modelZwis = atrapaModelu(['ZWIS', PO_PONOWIENIU]);
    const przebieg1 = swiezyPrzebieg();
    const zwisy: Array<{ willRetry: boolean; retryCount: number }> = [];

    const wynik1 = await workflowZ(modelZwis).runWithRun(przebieg1, {
      stallTimeoutMs: STALL_MS,
      onStall: (info) => { zwisy.push({ willRetry: info.willRetry, retryCount: info.retryCount }); },
    });

    const krok1 = przebieg1.getStep('l1_batch_1');
    assert(krok1, 'Plan nie zawiera kroku "l1_batch_1" — zmienił się kształt buildConsolidationPlan?');
    assert(
      krok1!.status === STEP_STATUS.AWAITING_REVIEW,
      `Po zwisie i ponowieniu krok ma status "${krok1!.status}", oczekiwano "${STEP_STATUS.AWAITING_REVIEW}". Błąd: ${JSON.stringify(krok1!.error)}`,
    );
    assert(
      krok1!.retryCount === 1,
      `Licznik auto-ponowień wynosi ${krok1!.retryCount}, oczekiwano DOKŁADNIE 1 (zwis ma ponawiać raz, nie zero i nie w kółko).`,
    );
    assert(
      modelZwis.calls === 2,
      `Model odpalony ${modelZwis.calls}×, oczekiwano 2 (zwis + ponowienie).`,
    );
    assert(
      modelZwis.stopped >= 1,
      'Zwis NIE przerwał streamu (stopStream nie zawołany) — zdechły strzał wisiałby do twardego timeoutu transportu.',
    );
    assert(
      zwisy.length === 1 && zwisy[0].willRetry === true,
      `Callback onStall dostał ${JSON.stringify(zwisy)}, oczekiwano jednego zgłoszenia z willRetry=true.`,
    );
    assert(
      String(krok1!.result?.body || '') === PO_PONOWIENIU,
      `Propozycja po ponowieniu ma treść "${String(krok1!.result?.body || '').slice(0, 80)}", oczekiwano "${PO_PONOWIENIU}".`,
    );
    assert(wynik1.generated.includes('l1_batch_1'), `Wynik generacji: ${JSON.stringify(wynik1)}`);

    // ═══ 2. ANULUJ W TRAKCIE ═══
    // Watchdog WYŁĄCZONY (stallTimeoutMs: 0), więc jedynym, co może domknąć krok, jest abort.
    const modelNieskonczony = atrapaModelu(['ZWIS']);
    const przebieg2 = swiezyPrzebieg();
    const kontroler = new AbortController();
    const abort = setTimeout(() => kontroler.abort(), ABORT_PO_MS);
    (abort as { unref?: () => void })?.unref?.();

    const wynik2 = await workflowZ(modelNieskonczony).runWithRun(przebieg2, {
      stallTimeoutMs: 0,
      signal: kontroler.signal,
    });
    clearTimeout(abort);

    const krok2 = przebieg2.getStep('l1_batch_1')!;
    assert(
      krok2.status === STEP_STATUS.FAILED,
      `Po anulowaniu krok ma status "${krok2.status}", oczekiwano "${STEP_STATUS.FAILED}" — krok NIGDY nie może zostać w "running" (centrum operacji byłoby zajęte do restartu Obsidiana).`,
    );
    assert(wynik2.failed.includes('l1_batch_1'), `Wynik generacji po abort: ${JSON.stringify(wynik2)}`);
    // Kod błędu MUSI być abortem — anulowanie to decyzja usera, nie zwis streamu.
    // Regresja fixa z 2026-07-31: `_attemptWithStallRetry` wrzucał abort do polityki
    // ponowień zwisu (markStalled: retryCount 0→1, drugie podejście, komunikat
    // „Stream stalled twice" po własnoręcznym „Anuluj").
    const kod = krok2.error?.code;
    assert(
      kod === 'aborted',
      `Krok po anulowaniu ma kod błędu "${kod}", oczekiwano "aborted" — abort nie może udawać zwisu. Pełny błąd: ${JSON.stringify(krok2.error)}`,
    );
    assert(
      krok2.retryCount === 0,
      `Po anulowaniu licznik auto-ponowień wynosi ${krok2.retryCount}, oczekiwano 0 — abort nie wchodzi w politykę ponowień zwisu.`,
    );
    assert(
      modelNieskonczony.calls === 1,
      `Po anulowaniu model odpalono ${modelNieskonczony.calls}×, oczekiwano 1 — przerwanie nie ma prawa spalić kolejnego strzału.`,
    );
    assert(
      Array.isArray(krok2.meta?.sessions) && krok2.meta.sessions!.length === BATCH,
      `Padnięty krok zgubił ZAMROŻONE okno paczki (meta.sessions): ${JSON.stringify(krok2.meta?.sessions)} — „Ponów" ukradłby wtedy sesje innej paczki.`,
    );

    // ═══ 3. RĘCZNE „PONÓW" ═══
    const modelPonow = atrapaModelu([PO_RECZNYM_PONOW]);
    const wynik3 = await workflowZ(modelPonow).retryStep(przebieg2, 'l1_batch_1', { stallTimeoutMs: STALL_MS });

    const krok3 = przebieg2.getStep('l1_batch_1')!;
    assert(
      krok3.status === STEP_STATUS.AWAITING_REVIEW,
      `Po ręcznym „Ponów" krok ma status "${krok3.status}", oczekiwano "${STEP_STATUS.AWAITING_REVIEW}".`,
    );
    assert(wynik3.generated.includes('l1_batch_1'), `Wynik retryStep: ${JSON.stringify(wynik3)}`);
    assert(
      String(krok3.result?.body || '') === PO_RECZNYM_PONOW,
      `Propozycja po ręcznym „Ponów" ma treść "${String(krok3.result?.body || '').slice(0, 80)}", oczekiwano "${PO_RECZNYM_PONOW}".`,
    );
    assert(
      krok3.retryCount === 0,
      `Po ręcznym „Ponów" licznik auto-ponowień wynosi ${krok3.retryCount}, oczekiwano 0 (świeży budżet na zwisy).`,
    );
    assert(
      (krok3.result?.sessions || []).length === BATCH,
      `„Ponów" zbudował paczkę z ${(krok3.result?.sessions || []).length} sesji, oczekiwano ${BATCH} — z tego samego, zamrożonego okna.`,
    );

    // ═══ 4. NIEBLOKOWALNOŚĆ CENTRUM OPERACJI ═══
    const zdarzenia: string[] = [];
    let odepnij: (() => void) | null = null;
    try {
      assert(
        !memoryOpsCenter.isBusy(),
        'Centrum operacji jest ZAJĘTE jeszcze przed testem — poprzedni scenariusz (albo bootstrap) nie zwolnił singletonu.',
      );
      odepnij = memoryOpsCenter.subscribe((event) => { zdarzenia.push(event.type); });

      const runA = swiezyPrzebieg();
      const runB = swiezyPrzebieg();

      const pierwszy = memoryOpsCenter.startRun(runA);
      assert(pierwszy === runA, 'startRun na wolnym centrum nie zwrócił WŁASNEGO przebiegu.');
      assert(memoryOpsCenter.isBusy(), 'Po startRun centrum nie raportuje zajętości.');

      const drugi = memoryOpsCenter.startRun(runB);
      assert(
        drugi === runA,
        'Drugi trigger wystartował DRUGI przebieg — dwa przebiegi mieliłyby te same pliki pamięci równolegle.',
      );
      assert(
        memoryOpsCenter.getActiveRun() === runA,
        'Po odmowie centrum wskazuje inny przebieg niż ten, który faktycznie leci.',
      );
      assert(
        zdarzenia.filter((t) => t === OPS_EVENT.RUN_STARTED).length === 1,
        `Zdarzeń run_started: ${zdarzenia.filter((t) => t === OPS_EVENT.RUN_STARTED).length}, oczekiwano 1 (drugi trigger NIE startuje przebiegu). Ślad: ${zdarzenia.join(', ')}`,
      );
      assert(
        zdarzenia.includes(OPS_EVENT.OPEN_MODAL_REQUESTED),
        `Drugi trigger nie poprosił o pokazanie bieżącego przebiegu (brak open_modal_requested). Ślad: ${zdarzenia.join(', ')}`,
      );

      const zakonczony = memoryOpsCenter.finishRun();
      assert(zakonczony === runA, 'finishRun zwrócił inny przebieg niż aktywny.');
      assert(!memoryOpsCenter.isBusy(), 'Po finishRun centrum nadal raportuje zajętość — kolejna konsolidacja byłaby zablokowana na zawsze.');
      assert(
        zdarzenia.includes(OPS_EVENT.RUN_FINISHED),
        `Brak zdarzenia run_finished — pasek statusu nigdy by nie zgasł. Ślad: ${zdarzenia.join(', ')}`,
      );

      // Po zwolnieniu centrum kolejny przebieg wchodzi normalnie.
      const runC = swiezyPrzebieg();
      assert(memoryOpsCenter.startRun(runC) === runC, 'Po finishRun centrum nie przyjęło nowego przebiegu.');
    } finally {
      // Singleton przeżywa scenariusz — sprzątamy ZAWSZE, też gdy asercja wyżej rzuciła.
      try { odepnij?.(); } catch { /* best-effort */ }
      try { memoryOpsCenter.finishRun(); } catch { /* best-effort */ }
    }

    // ═══ Inwariant zbiorczy: przez cały scenariusz NIC nie zostało zapisane ═══
    // Żadna propozycja nie została zaakceptowana (`applyStepDecision` nie padło ani razu),
    // więc ani plik L1, ani stempel `covered_by_l1` nie mają prawa istnieć.
    const l1Files = listVaultFiles(vaultRoot, L1_DIR).filter((p) => p.endsWith('.md'));
    assert(l1Files.length === 0, `Sama GENERACJA zapisała pliki L1: ${l1Files.join(', ')} — propozycja nie może dotykać dysku.`);
    const niepokryte = await memory.listUncoveredArchiveSessions();
    assert(
      niepokryte.length === FIXTURE_SESSIONS.length,
      `Sesje archiwum zostały ostemplowane mimo braku decyzji usera: niepokrytych ${niepokryte.length}, oczekiwano ${FIXTURE_SESSIONS.length}.`,
    );
  },
} satisfies Scenario);
