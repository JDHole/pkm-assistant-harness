/**
 * buildInfo.ts — znacznik "kiedy i z jakiego stanu repo pluginu zbudowano TĘ wtyczkę" (K3,
 * poprawki po recenzji adwersaryjnej). Konsument: `StatusData.companion` w `cli/commands.ts`
 * (`companionStale`, patrz `CLAUDE.md` tego folderu, gotcha "dwa bundle - jedno liczydło").
 *
 * Trzy stałe niżej są WSTRZYKIWANE przez esbuild `define` WYŁĄCZNIE w `buildCompanion()`
 * (`esbuild.harness.ts --companion`, patrz tam) - dosłowna podmiana tekstu identyfikatora na
 * literał w chwili builda `dist/companion/main.js`. Poza TYM JEDNYM buildem (testy AVA pod tsx,
 * scenariusze pod `buildHarness()` - INNY wpis esbuilda, bez tego `define`) te trzy
 * identyfikatory NIE ISTNIEJĄ jako prawdziwe zmienne w runtime - stąd odczyt przez `typeof`
 * (bezpieczny dla niezadeklarowanego globala, nie rzuca) z fallbackiem "nie da się ustalić".
 * To jest ten sam, dobrze znany wzorzec co `typeof __VERSION__ !== 'undefined'` w narzędziach
 * bundlujących - `declare const` niżej to WYŁĄCZNIE typy (zero emitu), esbuild podmienia
 * odwołania NA POZIOMIE AST (w tym wewnątrz `typeof`), więc w prawdziwym buildzie wtyczki obie
 * gałęzie warunku widzą już literał, a nie identyfikator.
 */

declare const __COMPANION_BUILT_AT__: string;
declare const __COMPANION_PLUGIN_COMMIT__: string;
declare const __COMPANION_PLUGIN_TREE_DIRTY__: boolean;

/** Znacznik ISO chwili, w której POWSTAŁ ten bundel (`dist/companion/main.js`). Poza tym
 *  buildem - `'unknown'` (harness własny bundle, testy AVA pod tsx). */
export const COMPANION_BUILT_AT: string =
    typeof __COMPANION_BUILT_AT__ !== 'undefined' ? __COMPANION_BUILT_AT__ : 'unknown';

/** Krótki hash `HEAD` repo pluginu w chwili TEGO builda (`git rev-parse --short HEAD` w
 *  `lib/pluginBuildInfo.ts`). `'unknown'`, gdy git był niedostępny przy buildzie ALBO poza nim. */
export const COMPANION_PLUGIN_COMMIT: string =
    typeof __COMPANION_PLUGIN_COMMIT__ !== 'undefined' ? __COMPANION_PLUGIN_COMMIT__ : 'unknown';

/** Czy drzewo robocze repo pluginu miało niezacommitowane zmiany w chwili TEGO builda.
 *  `false` poza tym buildem (nie da się ustalić - NIE oznaczamy fałszywie brudnego drzewa). */
export const COMPANION_PLUGIN_TREE_DIRTY: boolean =
    typeof __COMPANION_PLUGIN_TREE_DIRTY__ !== 'undefined' ? __COMPANION_PLUGIN_TREE_DIRTY__ : false;
