/**
 * assertToolErrored.test.ts — strażnik AUD-testy-028: `assertToolErrored`/`assertToolOk`
 * (`harness/scenarios/_asserts.ts`) muszą kluczować na TWARDYM sygnale (`isError:true`
 * w resultPreview), nie na SŁOWACH z treści wyniku.
 *
 * Ten plik testuje kod z `harness/scenarios/_asserts.ts`, a mieszka w `harness/lib/` z powodów
 * HISTORYCZNYCH: do 2026-09-03 `ava.files` brało wyłącznie `harness/lib/*.test.ts`. Od werdyktu
 * „harness pod testy" (2026-09-03) `npm test` zbiera `harness/**\/*.test.ts`, więc nowe testy
 * kładziemy obok testowanego kodu (np. `harness/scenarios/noAttempt.test.ts`). Ten zostaje tu,
 * żeby nie przepisywać historii bez potrzeby. Same scenariusze `NN_*.ts` dalej biegną WYŁĄCZNIE
 * przez `npm run harness:scenarios`, poza `npm test` — patrz `harness/README.md`.
 *
 * Dziura, którą ten plik pina: przed naprawą `ERROR_SIGNALS` dopuszczał alternatywy typu
 * `no-?go`/`workspace`/`outside`/`denied` gdziekolwiek w TREŚCI wyniku — więc UDANY odczyt
 * notatki, której treść przypadkiem zawiera jedno z tych słów (np. frontmatter
 * `tagi: [harness, no-go]` notatki-rekwizytu w `04_nogo`), przechodził `assertToolErrored`
 * za odmowę, a `assertToolOk` wywalał fałszywą czerwień na udanym wyniku ze słowem
 * "workspace"/"not_found" w treści (scenariusze 04 i 42 w findings audytu).
 */
import test from 'ava';
import { hasToolErrorSignal, assertToolErrored, assertToolOk, AssertionError } from '../scenarios/_asserts.js';
import type { FixturePayload } from '../scenarios/_asserts.js';

/** Wynik `runAgentLoop` atrapowy: JEDNO wywołanie `toolName` z danym `resultPreview`. */
function resultWith(toolName: string, resultPreview: string): FixturePayload {
    return { toolCallDetails: [{ name: toolName, resultPreview }] };
}

// ─── hasToolErrorSignal: sygnał strukturalny, nie leksykalny ─────────────────────────────

test('hasToolErrorSignal: rozpoznaje token JSON isError:true', t => {
    t.true(hasToolErrorSignal('{"isError":true,"error":"Permission denied: Invalid path"}'));
});

test('hasToolErrorSignal: udany wynik ze słowem "no-go" W TREŚCI nie jest błędem (AUD-testy-028 — dokładna reprodukcja fixture 04_nogo)', t => {
    const tresc = '{"success":true,"content":"---\\ntytul: Tajne\\ntagi: [harness, no-go]\\n---\\nSekret: X","path":"Sekrety/tajne.md"}';
    t.false(hasToolErrorSignal(tresc));
});

test('hasToolErrorSignal: udany wynik ze słowem "workspace"/"not_found" W TREŚCI nie jest błędem', t => {
    t.false(hasToolErrorSignal('{"success":true,"content":"Poza workspace jest jeszcze more not_found w tekście"}'));
});

test('hasToolErrorSignal: {"success":false} BEZ isError (kształt przed normalizacją MCPClient) — nie jest jeszcze twardym sygnałem', t => {
    // Świadomie: `_asserts.ts` czyta `resultPreview` PO tym, jak `MCPClient` przechodzi przez
    // klienta i dokłada `isError:true` (8b) — resultPreview zawsze niesie już ten znacznik dla
    // realnych porażek. Ten test pinuje, że hasToolErrorSignal NIE zgaduje po `success`, tylko
    // czeka na jawny `isError:true` — spójnie z tym, co faktycznie produkuje MCPClient.
    t.false(hasToolErrorSignal('{"success":false,"error":"coś nie wyszło"}'));
});

// ─── assertToolErrored: musi wymagać isError:true, needle jako DODATEK ───────────────────

test('assertToolErrored: PRZECHODZI, gdy wynik niesie isError:true', t => {
    const result = resultWith('read', '{"isError":true,"error":"Permission denied: No-Go zone"}');
    t.notThrows(() => assertToolErrored(result, 'read'));
});

test('AUD-testy-028: assertToolErrored PADA na udanym odczycie ze słowem "no-go" w treści (dawniej fałszywie przechodził)', t => {
    const result = resultWith('read', '{"success":true,"content":"tagi: [harness, no-go]\\nSekret: NIC-TU-NIE-MA"}');
    const err = t.throws(() => assertToolErrored(result, 'read'), { instanceOf: AssertionError });
    t.regex(err!.message, /NIE zwróciło błędu/);
});

test('assertToolErrored: needle jest DODATKOWYM warunkiem — isError:true, ale needle nie pasuje ⇒ dalej pada', t => {
    const result = resultWith('write', '{"isError":true,"error":"Permission denied: outside workspace"}');
    t.notThrows(() => assertToolErrored(result, 'write', /outside|workspace/i));
    t.throws(() => assertToolErrored(result, 'write', /coś zupełnie innego/i), { instanceOf: AssertionError });
});

// ─── assertToolOk: symetryczna naprawa — sukces ze słowem z listy nie ma być czerwienią ──

test('AUD-testy-028: assertToolOk PRZECHODZI na udanym wyniku, którego treść zawiera słowo "workspace" (dawniej fałszywa czerwień)', t => {
    const result = resultWith('read', '{"success":true,"content":"Poza workspace jest jeszcze notatka","path":"Notatki/a.md"}');
    t.notThrows(() => assertToolOk(result, 'read'));
});

test('assertToolOk: PADA, gdy wynik niesie isError:true', t => {
    const result = resultWith('read', '{"isError":true,"error":"not_found"}');
    const err = t.throws(() => assertToolOk(result, 'read'), { instanceOf: AssertionError });
    t.regex(err!.message, /zwróciło błąd/);
});

test('assertToolErrored/assertToolOk: brak wywołania narzędzia ⇒ pada z czytelnym powodem (bez zmian)', t => {
    const result: FixturePayload = { toolCallDetails: [] };
    t.throws(() => assertToolErrored(result, 'read'), { message: /Oczekiwano wywołania narzędzia "read"/ });
    t.throws(() => assertToolOk(result, 'read'), { message: /Oczekiwano wywołania narzędzia "read"/ });
});
