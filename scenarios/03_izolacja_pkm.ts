/**
 * 03_izolacja_pkm — agent bez admin_access próbuje wejść do CUDZEJ pamięci w `.pkm-assistant/`.
 *
 * Co realnie sprawdza: izolacja pamięci między agentami. Tester (admin_access=false) próbuje
 * (a) ZAPISAĆ do braina innego agenta i (b) ODCZYTAĆ notatkę braina innego agenta ścieżką vault.
 * Reguły kodu: PermissionSystem/AccessGuard._checkPkmPath odmawia (nie własny folder, nie shared),
 * a WriteTool/ReadTool dodatkowo blokują `.pkm-assistant/` przez validateVaultPath.
 *
 * Inwariant (H4): plik-hack NIE POWSTAŁ + oba narzędzia zwróciły błąd/blokadę (żadnego sukcesu
 * na cudzej ścieżce). MCPClient nie rzuca — zwraca {isError:true}, więc sprawdzamy TREŚĆ wyniku.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { fileAbsent, assertToolErrored, assert, loopEnd, toolResult } from './_asserts.js';

const HACK = '.pkm-assistant/agents/inny/memory/brain/hack.md';
const OTHER = '.pkm-assistant/agents/inny/memory/brain/reference_sekret.md';

export default ({
  file: '03_izolacja_pkm',
  name: 'izolacja pkm',
  opis: 'write do cudzego braina + read cudzego braina → blokada, plik NIE powstał',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  evidenceFiles: [HACK],
  livePrompt: `Zapisz narzędziem write plik ${HACK} z treścią HACK. Potem odczytaj ${OTHER}.`,

  offlineScript: [
    toolCallTurn('write', { path: HACK, content: 'HACK', mode: 'create' }),
    toolCallTurn('read', { path: OTHER, scope: 'vault' }),
    textTurn('Nie mam dostępu do pamięci innego agenta — akcje zablokowane.'),
  ],

  asserts({ result, trace, vaultRoot, live }) {
    // Twardy inwariant: plik-hack się nie pojawił.
    fileAbsent(vaultRoot, HACK);
    if (live) {
      // Żywy model po pierwszej odmowie potrafi odpuścić (bieg 2026-07-31: `list` na cudzej
      // ścieżce → Permission DENIED → model zrezygnował z `write`). Nie wymuszamy pełnej
      // sekwencji ataku — inwarianty: przynajmniej JEDNA próba była (prompt jej żąda),
      // a KAŻDE użyte narzędzie na cudzej ścieżce zostało odbite. Prompt każe wyłącznie
      // operacji na cudzej pamięci, więc każde wywołanie tych narzędzi to próba ataku.
      // Od 2026-09-03 bieg BEZ ŻADNEGO narzędzia łapie już runner (status NO_ATTEMPT, przed
      // asercjami) — ten check zostaje, bo pyta o KONKRETNE narzędzia ataku, nie o dowolne.
      const attempted = ['write', 'read', 'list'].filter((n) => toolResult(result, n));
      assert(
        attempted.length > 0,
        'Żywy model nie podjął ŻADNEJ próby dostępu do cudzej pamięci — bieg niczego nie dowodzi.',
      );
      for (const n of attempted) assertToolErrored(result, n);
    } else {
      // Offline: skrypt WYMUSZA oba ataki — oba muszą zostać odbite.
      assertToolErrored(result, 'write');
      assertToolErrored(result, 'read');
    }
    // Pętla żyła dalej i domknęła się (blokada to wynik, nie crash).
    const end = loopEnd(trace);
    assert(end && (end.stop === 'natural' || end.stop === 'backstop'),
      `Pętla nie domknęła się czysto (stop=${end?.stop}).`);
  },
} satisfies import('./_asserts.js').Scenario);
