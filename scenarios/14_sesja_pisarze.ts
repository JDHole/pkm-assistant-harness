/**
 * 14_sesja_pisarze — dowód S36: event-log przeżywa autozapis i restart.
 *
 * KONTEKST (co S36 zmieniło): plik `sessions/active/*.md` jest append-only event-logiem
 * (`## <ISO> — <typ>` + pola `**content:**` / `**tool:**` / `**args:**` / `**seq:**`).
 * `AgentMemory.saveSession` (autozapis co N minut, idle, 💾, zamknięcie zakładki) NIE nadpisuje
 * już pliku transkryptem z okienka czatu — dopisuje najwyżej ogon, którego czytnik w pliku nie
 * widzi. Przed S36 autozapis ścinał telemetrię narzędzi, a po kompresji okna (która ZMNIEJSZA
 * `messages`) niszczył pełną historię rozmowy.
 *
 * ⚠️ SKĄD SIĘ BIERZE PLIK SESJI W HARNESSIE: bieg harnessa to `runExploratoryTurn` → `runAgentLoop`,
 * czyli PĘTLA BEZ CZATU. Pisarzem zdarzeń w produkcji jest `modules/chat/chat/chat_streaming.js`
 * (`appendToActiveSession` przy: wiadomości usera, każdym wywołaniu narzędzia, wyniku narzędzia,
 * odpowiedzi agenta) — a tej warstwy harness nie stawia. Scenariusz odgrywa więc rolę czatu:
 * po turze dopisuje te same cztery zdarzenia, w tych samych kształtach, PRODUKCYJNĄ metodą
 * `AgentMemory.appendToActiveSession` (zero forka formatu). Wszystko, co dzieje się DALEJ
 * (autozapis, restart, ponowny append) idzie już wyłącznie przez produkcyjne API.
 *
 * Co realnie sprawdza:
 *   (a) plik jest event-logiem: bloki z `**seq:**`, numery ściśle rosnące 1..N bez dziur,
 *   (b) jest telemetria narzędzi (`**tool:**` + `**args:**`),
 *   (c) jest wiadomość usera i odpowiedź agenta,
 *   (d) AUTOZAPIS na SKURCZONYM okienku (symulacja kompresji) NIE ścina telemetrii — sedno S36,
 *   (e) liczba wiadomości wg czytnika nie zmalała,
 *   (f) frontmatter ma `updated` i `messageCount`,
 *   (g) RESTART (świeża instancja `AgentMemory` + `restoreActiveSession`) odzyskuje wszystkie
 *       wiadomości — role i treści,
 *   (h) `seq` po restarcie jest nadal ciągły,
 *   (i) kolejny append po restarcie dostaje `seq = N+1` (skan pliku `maxSeq` działa mimo pustego
 *       cache licznika),
 *   (j) DRUGI autozapis (już po restarcie) nie skraca pliku — append-only.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { AgentMemory } from '../../modules/memory/index.js';
import {
  assert,
  assertToolPost,
  assertFinalText,
  readVaultFile,
  listVaultFiles,
} from './_asserts.js';

const AGENT = 'Tester';
const ACTIVE_DIR = '.pkm-assistant/agents/tester/memory/sessions/active';
const PROMPT = 'Przeczytaj Notatki/powitanie.md narzędziem read i streść ją w jednym zdaniu.';
const ANSWER = 'Notatka „Powitanie" opisuje testowy vault harnessa i listę zadań do wykonania.';

/** Wszystkie `**seq:**` z pliku, w kolejności występowania (kształt BLOKOWY: etykieta sama w linii). */
function seqNumbers(raw: string): number[] {
  const re = /^\*\*seq:\*\*[ \t]*\n\s*(\d+)/gm;
  const out = [];
  let m;
  while ((m = re.exec(raw.replace(/\r\n/g, '\n'))) !== null) out.push(Number(m[1]));
  return out;
}

/** Ile bloków `## ` (granic zdarzeń) jest w pliku — miara „plik się nie skrócił". */
function blockCount(raw: string): number {
  return (raw.replace(/\r\n/g, '\n').match(/(^|\n)## /g) || []).length;
}

/** Numery 1..N, ściśle rosnące, bez dziur. */
function assertSeqDense(seqs: number[], expectedN: number, label: string): void {
  assert(seqs.length === expectedN, `${label}: oczekiwano ${expectedN} bloków z **seq:**, jest ${seqs.length} (${seqs.join(', ')}).`);
  for (let i = 0; i < seqs.length; i++) {
    assert(seqs[i] === i + 1, `${label}: numeracja seq ma dziurę/przestawkę — oczekiwano ${i + 1}, jest ${seqs[i]} (cała lista: ${seqs.join(', ')}).`);
  }
}

export default ({
  file: '14_sesja_pisarze',
  name: 'pisarze sesji (S36)',
  opis: 'event-log sesji przeżywa autozapis i restart — telemetria narzędzi nietknięta, seq ciągły',
  agent: AGENT,
  autonomy: 'edge',
  approve: 'auto',
  livePrompt: PROMPT,

  offlineScript: [
    toolCallTurn('read', { path: 'Notatki/powitanie.md' }),
    textTurn(ANSWER),
  ],

  async asserts({ result, trace, vaultRoot, plugin }) {
    // ── 0. Tura przeszła (bez tego reszta nie ma sensu) ──
    assertToolPost(trace, 'read', 'ok');
    assertFinalText(result);

    const memory = plugin?.agentManager?.getActiveMemory?.();
    assert(memory, 'Brak AgentMemory aktywnego agenta — bootstrap pluginu nieukończony?');
    assert(memory.agentName === AGENT, `Pamięć należy do "${memory.agentName}", oczekiwano "${AGENT}".`);

    // ── 1. Odegranie PISARZA ZDARZEŃ (w produkcji robi to chat_streaming.js) ──
    // Kolejność i kształty 1:1 z czatem: user_message → mcp_call → tool_result → agent_message.
    const tool = (result.toolCallDetails || [])[0];
    assert(tool, 'Pętla nie zwróciła szczegółów wywołania narzędzia (toolCallDetails puste).');

    await memory.appendToActiveSession({ type: 'user_message', agentName: AGENT, content: PROMPT });
    await memory.appendToActiveSession({
      type: 'mcp_call',
      agentName: AGENT,
      tool: tool.name,
      args: tool.args ?? {},
      result: tool.resultPreview,
    });
    await memory.appendToActiveSession({
      type: 'tool_result',
      agentName: AGENT,
      tool: tool.name,
      result: tool.resultPreview,
    });
    await memory.appendToActiveSession({
      type: 'agent_message',
      agentName: AGENT,
      content: result.finalText,
      model: 'harness-offline',
      tokens: { input: 0, output: 0 },
    });
    const EVENTS = 4;

    // ── 2. Plik aktywnej sesji: jeden, w `sessions/active/`, zgodny ze wskaźnikiem pamięci ──
    const activeFiles = listVaultFiles(vaultRoot, ACTIVE_DIR).filter((p) => p.endsWith('.md'));
    assert(activeFiles.length === 1, `Oczekiwano DOKŁADNIE jednego pliku aktywnej sesji w ${ACTIVE_DIR}, jest ${activeFiles.length}: ${activeFiles.join(', ') || '(brak)'}`);
    const sessionRel = activeFiles[0];
    assert(
      memory.activeSessionPath === sessionRel,
      `activeSessionPath ("${memory.activeSessionPath}") nie wskazuje na plik na dysku ("${sessionRel}").`,
    );

    // ── 3. Asercje na SUROWYM pliku (przed autozapisem) ──
    const rawBefore = readVaultFile(vaultRoot, sessionRel);
    assertSeqDense(seqNumbers(rawBefore), EVENTS, 'plik po turze');
    assert(/^\*\*tool:\*\*/m.test(rawBefore), 'Brak pola **tool:** w pliku sesji — telemetria narzędzi nie została zapisana.');
    assert(/^\*\*args:\*\*/m.test(rawBefore), 'Brak pola **args:** w pliku sesji — telemetria narzędzi nie została zapisana.');
    assert(rawBefore.includes(PROMPT), 'Brak wiadomości usera w pliku sesji.');
    assert(rawBefore.includes(result.finalText.slice(0, 40)), 'Brak odpowiedzi agenta w pliku sesji.');

    const parsedBefore = await memory.loadActiveSession(sessionRel);
    assert(
      parsedBefore.messages.length === EVENTS,
      `Czytnik widzi ${parsedBefore.messages.length} wiadomości, oczekiwano ${EVENTS}.`,
    );

    // ── 4. AUTOZAPIS na SKURCZONYM okienku (sedno S36) ──
    // Okienko czatu po kompresji jest KRÓTSZE niż plik (2 pozycje vs 4 zdarzenia). Przed S36
    // `saveSession` nadpisywał tym plik i telemetria + historia znikały bezpowrotnie.
    const compressedWindow = [
      { role: 'user', content: PROMPT },
      { role: 'assistant', content: result.finalText },
    ];
    await memory.saveSession(compressedWindow, {});

    const rawAfterSave = readVaultFile(vaultRoot, sessionRel);
    assert(/^\*\*tool:\*\*/m.test(rawAfterSave), 'AUTOZAPIS ŚCIĄŁ TELEMETRIĘ: po saveSession nie ma już pola **tool:** (to jest dokładnie wtopa, którą S36 naprawiło).');
    assert(/^\*\*args:\*\*/m.test(rawAfterSave), 'AUTOZAPIS ŚCIĄŁ TELEMETRIĘ: po saveSession nie ma już pola **args:**.');
    assert(
      blockCount(rawAfterSave) >= blockCount(rawBefore),
      `Plik SKRÓCIŁ SIĘ po autozapisie: bloków ${blockCount(rawBefore)} → ${blockCount(rawAfterSave)} (event-log ma być append-only).`,
    );

    const parsedAfterSave = await memory.loadActiveSession(sessionRel);
    assert(
      parsedAfterSave.messages.length >= parsedBefore.messages.length,
      `Liczba wiadomości ZMALAŁA po autozapisie: ${parsedBefore.messages.length} → ${parsedAfterSave.messages.length}.`,
    );
    const meta = parsedAfterSave.metadata || {};
    assert(meta.updated, 'Frontmatter po autozapisie nie ma pola `updated`.');
    assert(
      Number(meta.messageCount) === parsedAfterSave.messages.length,
      `Frontmatter kłamie: messageCount=${meta.messageCount}, a czytnik widzi ${parsedAfterSave.messages.length} wiadomości.`,
    );

    // ── 5. RESTART: świeża instancja AgentMemory na tym samym vaulcie ──
    // Świeża = puste cache (`_sessionSeqCache`, `_sessionSavedCounts`, `activeSessionPath`),
    // dokładnie jak po restarcie Obsidiana. Ścieżkę odzyskuje produkcyjny `restoreActiveSession`.
    const restarted = new AgentMemory(memory.vault, AGENT, memory.settings);
    const restoredPath = await restarted.restoreActiveSession();
    assert(
      restoredPath === sessionRel,
      `Po „restarcie" restoreActiveSession zwrócił "${restoredPath}", oczekiwano "${sessionRel}".`,
    );

    const restored = await restarted.loadActiveSession(restoredPath);
    assert(
      restored.messages.length === parsedAfterSave.messages.length,
      `Restart zgubił wiadomości: ${parsedAfterSave.messages.length} → ${restored.messages.length}.`,
    );
    const roles = restored.messages.map((m) => m.role).join(',');
    assert(roles === 'user,tool,tool,assistant', `Role po restarcie: "${roles}", oczekiwano "user,tool,tool,assistant".`);
    assert(restored.messages[0].content.includes(PROMPT), 'Po restarcie treść wiadomości usera nie wróciła w całości.');
    assert(
      restored.messages[3].content.includes(result.finalText.slice(0, 40)),
      'Po restarcie treść odpowiedzi agenta nie wróciła w całości.',
    );
    assertSeqDense(restored.messages.map((m: import('./_asserts.js').FixturePayload) => m.seq) as number[], EVENTS, 'wiadomości po restarcie');

    // ── 6. Kolejny append PO restarcie: seq = N+1 (licznik odtworzony skanem pliku) ──
    await restarted.appendToActiveSession({ type: 'user_message', agentName: AGENT, content: 'A co dalej?' });
    const rawAfterRestart = readVaultFile(vaultRoot, sessionRel);
    assertSeqDense(seqNumbers(rawAfterRestart), EVENTS + 1, 'plik po appendzie z nowej instancji');

    // ── 7. Drugi autozapis (już z nowej instancji) — plik dalej nie maleje ──
    const blocksBeforeSecondSave = blockCount(rawAfterRestart);
    await restarted.saveSession(compressedWindow, {});
    const rawFinal = readVaultFile(vaultRoot, sessionRel);
    assert(
      blockCount(rawFinal) >= blocksBeforeSecondSave,
      `Drugi autozapis SKRÓCIŁ plik: bloków ${blocksBeforeSecondSave} → ${blockCount(rawFinal)}.`,
    );
    assert(/^\*\*tool:\*\*/m.test(rawFinal), 'Drugi autozapis ściął telemetrię (**tool:** zniknęło).');
    assertSeqDense(seqNumbers(rawFinal), EVENTS + 1, 'plik po drugim autozapisie');
  },
} satisfies import('./_asserts.js').Scenario);
