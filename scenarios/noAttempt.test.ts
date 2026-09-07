/**
 * noAttempt.test.ts — strażnik werdyktu Kuby 2026-09-02: runner scenariuszy rozpoznaje bieg
 * żywego modelu bez ANI JEDNEJ próby narzędzia (`isNoAttemptRun`, status `NO_ATTEMPT`).
 *
 * Testuje czystą funkcję z `_asserts.ts` — sam runner (`_runner.ts`) odpala `main()` przy
 * imporcie, więc jego nie da się zaimportować w AVA; kontrakt guarda żyje w funkcji.
 *
 * Plik mieszka w `harness/scenarios/` CELOWO: od 2026-09-03 `npm test` zbiera
 * `harness/**\/*.test.ts` (werdykt „harness pod testy"), a rejestr scenariuszy
 * (`scenarioRegistry.test.ts`) patrzy tylko na pliki `NN_*.ts`, więc test go nie myli.
 */
import test from 'ava';
import { isNoAttemptRun, NO_ATTEMPT_MESSAGE } from './_asserts.js';

test('isNoAttemptRun: brak toolsUsed i toolCallDetails = model nic nie sprobowal', (t) => {
  t.true(isNoAttemptRun({ finalText: 'Nie mogę tego zrobić.', toolsUsed: [], toolCallDetails: [], iterations: 1, stoppedBy: 'natural' }));
});

test('isNoAttemptRun: wynik bez pol (undefined/null) traktowany jak brak proby, nie jak crash', (t) => {
  t.true(isNoAttemptRun(undefined));
  t.true(isNoAttemptRun(null));
  t.true(isNoAttemptRun({}));
});

test('isNoAttemptRun: jedno wywolanie narzedzia (nawet odbite bledem) = proba byla', (t) => {
  t.false(isNoAttemptRun({
    toolsUsed: ['read'],
    toolCallDetails: [{ name: 'read', resultPreview: '{"isError":true,"content":"Permission DENIED"}', error: true }],
  }));
});

test('isNoAttemptRun: sygnal z KTOREGOKOLWIEK z dwoch pol wystarczy (toolsUsed bez details i odwrotnie)', (t) => {
  // toolsUsed dopisywane przy wywolaniu, toolCallDetails po wykonaniu — jesli petla urwala sie
  // miedzy nimi (abort), proba i tak BYLA.
  t.false(isNoAttemptRun({ toolsUsed: ['list'], toolCallDetails: [] }));
  t.false(isNoAttemptRun({ toolsUsed: [], toolCallDetails: [{ name: 'list', resultPreview: '[]' }] }));
});

test('NO_ATTEMPT_MESSAGE: komunikat mowi wprost, ze bieg niczego nie dowodzi', (t) => {
  t.regex(NO_ATTEMPT_MESSAGE, /niczego nie dowodzi/);
});
