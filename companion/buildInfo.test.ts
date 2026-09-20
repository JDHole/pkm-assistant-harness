import test from 'ava';
import { COMPANION_BUILT_AT, COMPANION_PLUGIN_COMMIT, COMPANION_PLUGIN_TREE_DIRTY } from './buildInfo.js';

/**
 * Pod AVA (`tsx`, bez przejścia przez `esbuild.harness.ts --companion`) `__COMPANION_BUILT_AT__`
 * i siostrzane identyfikatory NIE ISTNIEJĄ jako zmienne - `typeof` guard w `buildInfo.ts` ma
 * schodzić na fallback, nie rzucać `ReferenceError`. To jest jedyna gałąź, jaką da się sprawdzić
 * bez realnego przebiegu esbuilda (`npm run build:companion` jest bramką dla TEJ drugiej strony).
 */

test('COMPANION_BUILT_AT: poza buildem esbuilda (AVA/tsx) -> fallback "unknown", nie rzuca', t => {
    t.is(COMPANION_BUILT_AT, 'unknown');
});

test('COMPANION_PLUGIN_COMMIT: poza buildem esbuilda -> fallback "unknown"', t => {
    t.is(COMPANION_PLUGIN_COMMIT, 'unknown');
});

test('COMPANION_PLUGIN_TREE_DIRTY: poza buildem esbuilda -> fallback false', t => {
    t.is(COMPANION_PLUGIN_TREE_DIRTY, false);
});
