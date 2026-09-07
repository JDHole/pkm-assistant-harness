/**
 * 05_create_only_memory — `memory_save` na ścieżkę ISTNIEJĄCEJ notatki brain (create-only).
 *
 * Co realnie sprawdza: Memory v3 „create-only". `memory_save` liczy nazwę pliku
 * `makeMemoryNoteFilename(type,name)` i JEŚLI plik już istnieje → zwraca NOTE_ALREADY_EXISTS
 * i NIE nadpisuje. Podkładamy notatkę `reference_harness_lekcja.md` w brain/ Testera, po czym
 * model woła memory_save o tej samej nazwie/typie z INNĄ treścią.
 *
 * Inwariant: notatka NIETKNIĘTA (treść + mtime), a memory_save zwrócił błąd „już istnieje".
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { fileUnchanged, assertToolErrored } from './_asserts.js';

const NOTE_PATH = '.pkm-assistant/agents/tester/memory/brain/reference_harness_lekcja.md';
const EXISTING = `---
name: "harness lekcja"
description: "oryginalna notatka rekwizytowa"
type: reference
created: 2026-07-01
---
ORYGINALNA TREŚĆ — nie wolno jej nadpisać.

**Why:** rekwizyt scenariusza create-only.

**How to apply:** sprawdzić, że memory_save nie nadpisuje istniejącej notatki.
`;

export default ({
  file: '05_create_only_memory',
  name: 'create-only memory',
  opis: 'memory_save na istniejącą notatkę brain → błąd, plik NIETKNIĘTY',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  fixtures: [{ path: NOTE_PATH, content: EXISTING }],
  snapshotFiles: [NOTE_PATH],
  evidenceFiles: [NOTE_PATH],
  // Live-flak (2026-07-24, ~1 na 3 biegi): żywy model bywa sprytny — sprawdza pamięć i widząc
  // konflikt zmienia nazwę albo odpuszcza zapis, więc assertToolErrored nie ma czego złapać
  // (twardy inwariant fileUnchanged przechodzi zawsze). Prompt celowo NAKAZOWY, żeby to uciąć.
  livePrompt: 'Wywołaj narzędzie memory_save z DOKŁADNIE tymi parametrami: name="harness lekcja", description="nowy opis", type="reference", content="nowa wersja". Nie zmieniaj nazwy, nie sprawdzaj wcześniej pamięci, nie pytaj — wykonaj dokładnie to wywołanie i zrelacjonuj, co zwróciło.',

  offlineScript: [
    toolCallTurn('memory_save', {
      name: 'harness lekcja',
      description: 'nowy opis',
      type: 'reference',
      content: 'NOWA TREŚĆ która NIE POWINNA nadpisać oryginału',
    }),
    textTurn('Notatka o tej nazwie już istnieje — zostawiam oryginał.'),
  ],

  asserts({ result, vaultRoot, before }) {
    fileUnchanged(before, vaultRoot, NOTE_PATH);
    assertToolErrored(result, 'memory_save', /already_exists|note_exists|istnieje/i);
  },
} satisfies import('./_asserts.js').Scenario);
