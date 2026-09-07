/**
 * 02_backstop — model, który NIGDY nie kończy (w każdej turze woła kolejne narzędzie).
 *
 * Co realnie sprawdza: siatka bezpieczeństwa pętli. Po wyczerpaniu maxIterations pętla robi
 * FINALNE zapytanie BEZ narzędzi (backstop), więc kończy się na tekście, nie w nieskończoność.
 * Inwarianty: stoppedBy=backstop, zdarzenie `backstop` w trace, a PO nim żadnego tool.post
 * (ostatnia runda jest bez narzędzi) — jest tylko model.done + loop.end.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { loopEnd, traceIndexOf, toolPosts, assertTraceHas, assert } from './_asserts.js';

const MAX = 3;

export default ({
  file: '02_backstop',
  name: 'backstop',
  opis: 'model woła narzędzie w każdej turze + maxIterations=3 → stop backstop, brak tool.post po backstop',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: MAX,
  livePrompt: 'Wylistuj folder Notatki narzędziem list. Po każdej liście wykonaj kolejną list. Nigdy nie odpowiadaj tekstem.',

  // Każda TURA W PĘTLI (turnIndex < MAX) = kolejne `list`. Backstop (turnIndex >= MAX) = tekst.
  offlineScript: (ctx: import('./_asserts.js').FixturePayload) => (ctx.turnIndex < MAX
    ? toolCallTurn('list', { folder: 'Notatki' })
    : textTurn('Zatrzymuję się po wyczerpaniu limitu iteracji.')),

  asserts({ trace }) {
    const end = loopEnd(trace);
    assert(end, 'Brak loop.end w trace.');
    assert(end.stop === 'backstop', `Oczekiwano stop=backstop, jest stop=${end?.stop}.`);
    assert(end.iters === MAX, `Oczekiwano iters=${MAX} (wyczerpane), jest ${end?.iters}.`);

    assertTraceHas(trace, 'backstop', (f) => Number(f.after) === MAX,
      `Brak zdarzenia backstop after=${MAX} w trace.`);

    // Po zdarzeniu backstop NIE MOŻE być żadnego tool.post (finalna runda jest bez narzędzi).
    const idx = traceIndexOf(trace, 'backstop');
    const after = trace.slice(idx + 1);
    const postsAfter = after.filter((e: import('./_asserts.js').TraceEvent) => e.type === 'tool.post');
    assert(postsAfter.length === 0,
      `Po backstop pojawił się tool.post (${postsAfter.length}) — finalna runda NIE była bez narzędzi.`);
    // …a jest tam model.done (backstop wykonał finalne zapytanie do modelu).
    assert(after.some((e: import('./_asserts.js').TraceEvent) => e.type === 'model.done'),
      'Po backstop brak model.done — finalne zapytanie modelu się nie odbyło.');

    // W pętli faktycznie leciały narzędzia (inaczej to nie byłby test backstopu).
    assert(toolPosts(trace).length >= 1, 'Oczekiwano ≥1 tool.post w pętli przed backstopem.');
  },
} satisfies import('./_asserts.js').Scenario);
