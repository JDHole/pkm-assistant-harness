/**
 * 01_smoke_loop — najprostszy szczęśliwy przebieg: read notatki + odpowiedź.
 *
 * Co realnie sprawdza: pętla agenta domyka się NATURALNIE (model sam kończy), wykonuje ≥1 iterację,
 * narzędzie `read` przechodzi (tool.post ok), a finalText jest niepusty. To „dymny" test, że cały
 * łańcuch (fake-serwer SSE → adapter → parser → pętla → egzekutor → trace) żyje.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { loopEnd, assertToolPost, assertToolOk, assertFinalText, assert } from './_asserts.js';

export default ({
  file: '01_smoke_loop',
  name: 'smoke loop',
  opis: 'read notatki + odpowiedź → stop natural, ≥1 iteracja, finalText, tool.post ok',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  livePrompt: 'Przeczytaj Notatki/powitanie.md narzędziem read i streść ją w jednym zdaniu.',

  offlineScript: [
    toolCallTurn('read', { path: 'Notatki/powitanie.md' }),
    textTurn('Notatka „Powitanie" opisuje testowy vault harnessa i listę zadań do wykonania.'),
  ],

  asserts({ result, trace }) {
    assertToolPost(trace, 'read', 'ok');
    assertToolOk(result, 'read');
    const end = loopEnd(trace);
    assert(end, 'Brak zdarzenia loop.end w trace.');
    assert(end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
    assert(end.iters! >= 1, `Oczekiwano ≥1 iteracji, jest ${end?.iters}.`);
    assertFinalText(result);
  },
} satisfies import('./_asserts.js').Scenario);
