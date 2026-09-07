/**
 * 09_todo — narzędzie `todo` (gatunek 2): create + check.
 *
 * Co realnie sprawdza: `todo` pisze jednorazowy plik do ukrytego `.pkm-assistant/artifacts/todo/`
 * (przez adapter — Vault API go nie widzi), a odhaczenie po block-id faktycznie zmienia checkbox.
 * Block-idy są DETERMINISTYCZNE (`nextBlockId` → k1, k2, … wg kolejności add_item), więc
 * odhaczamy `k1` bez czytania runtime'u.
 *
 * Inwariant: plik todo powstał, pierwszy element jest odhaczony (`- [x] … ^k1`), drugi wciąż
 * pusty (`- [ ] … ^k2`).
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { listVaultFiles, readVaultFile, assertToolOk, assert } from './_asserts.js';

const TODO_DIR = '.pkm-assistant/artifacts/todo';

export default ({
  file: '09_todo',
  name: 'todo',
  opis: 'todo create + check → plik w .pkm-assistant/artifacts/todo/, checkbox odhaczony',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  evidenceFiles: [TODO_DIR],
  livePrompt: 'Zrób listę todo z dwoma zadaniami: „zadanie A" i „zadanie B". Potem odhacz pierwsze (blockId k1).',

  offlineScript: [
    toolCallTurn('todo', { action: 'create', items: ['zadanie A', 'zadanie B'] }),
    toolCallTurn('todo', { action: 'check', blockId: 'k1' }),
    textTurn('Lista gotowa, pierwsze zadanie odhaczone.'),
  ],

  asserts({ result, vaultRoot }) {
    assertToolOk(result, 'todo');

    const files = listVaultFiles(vaultRoot, TODO_DIR).filter((p) => p.endsWith('.md'));
    assert(files.length >= 1, `Brak pliku todo w ${TODO_DIR} (znaleziono: ${files.length}).`);
    const body = readVaultFile(vaultRoot, files[0]);

    // k1 odhaczone, k2 nie.
    assert(/- \[x\][^\n]*\^k1\b/i.test(body), `Element ^k1 NIE został odhaczony. Treść:\n${body}`);
    assert(/- \[ \][^\n]*\^k2\b/.test(body), `Element ^k2 nie jest już „pusty" (a powinien). Treść:\n${body}`);
  },
} satisfies import('./_asserts.js').Scenario);
