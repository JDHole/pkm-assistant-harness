/**
 * 06_edge_deny — autonomia `edge` + user ODMAWIA zgody na `delete`.
 *
 * Co realnie sprawdza: ścieżka approval → deny. `delete` jest RED (klasyfikacja ryzyka), więc
 * w edge WYMAGA zgody. Handler zgód scenariusza odmawia. MCPClient zapamiętuje odmowę i zwraca
 * wynik-odmowę do modelu; narzędzie NIE jest wykonane. Model dostaje odmowę jako wynik i pętla
 * leci dalej (kolejny model.done), kończąc naturalnie.
 *
 * Inwariant: plik NADAL istnieje (nie skasowany), delete zwrócił odmowę, w przebiegu była
 * decyzja deny, po odmowie odbył się kolejny obrót modelu, a pętla skończyła się natural.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { fileExists, assertToolErrored, loopEnd, assert } from './_asserts.js';

const TARGET = 'Notatki/projekt.md';

export default ({
  file: '06_edge_deny',
  name: 'edge deny',
  opis: 'edge + approve=deny + delete → narzędzie NIE wykonane, plik istnieje, pętla żyje dalej',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'deny',
  snapshotFiles: [TARGET],
  evidenceFiles: [TARGET],
  livePrompt: `Usuń plik ${TARGET} narzędziem delete.`,

  offlineScript: [
    toolCallTurn('delete', { path: TARGET }),
    textTurn('Rozumiem — nie usuwam pliku.'),
  ],

  asserts({ result, trace, vaultRoot, approvals }) {
    // Plik przeżył — delete nie zostało wykonane.
    fileExists(vaultRoot, TARGET, `Plik ${TARGET} został USUNIĘTY mimo odmowy zgody.`);
    // Wynik narzędzia to odmowa.
    assertToolErrored(result, 'delete', /odmów|denied|nie ponawiaj/i);
    // Handler zgód dostał żądanie i odmówił.
    assert(Array.isArray(approvals) && approvals.some((a) => a.decision === 'deny'),
      `Oczekiwano decyzji deny w handlerze zgód, jest: ${JSON.stringify(approvals)}`);
    // Po odmowie pętla zrobiła kolejny obrót modelu (≥2 model.done) i skończyła naturalnie.
    const modelDones = trace.filter((e: import('./_asserts.js').TraceEvent) => e.type === 'model.done').length;
    assert(modelDones >= 2, `Oczekiwano ≥2 model.done (pętla żyła po odmowie), jest ${modelDones}.`);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies import('./_asserts.js').Scenario);
