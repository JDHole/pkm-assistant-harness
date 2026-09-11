/**
 * Hak rozwiązywania modułów dla AVA: bare-specyfier `obsidian` → atrapa z `test-support/obsidian.ts`.
 *
 * PO CO: pakiet `obsidian` z npm to SAME TYPY — w `node_modules/obsidian` nie ma ani jednego
 * pliku wykonywalnego. Każdy test, który (choćby pośrednio) importuje plik produkcyjny
 * dotykający `obsidian` jako WARTOŚCI, wywracał się na `ERR_MODULE_NOT_FOUND` jeszcze przed
 * pierwszą asercją. Harness sam (przy własnym buildzie) rozwiązuje to aliasem esbuilda
 * (`esbuild.harness.ts`); AVA nie ma etapu builda, więc ten sam alias zakładamy hakiem ESM
 * Node'a (`node:module` → `register`).
 *
 * SKĄD PRZYCHODZI WYWOŁANIE (od 2026-09-11 ten plik mieszka TU, w repo harnessu, nie w repo
 * pluginu): walidator katalogu Obsidiana lintuje CAŁE repo pluginu i flagował w tej atrapie
 * rzeczy, których atrapa z definicji potrzebuje (`globalThis`, gołe timery). `npm test` pluginu
 * wpina przez `ava.nodeArguments` swój WŁASNY, lekki plik pod tą samą ścieżką
 * (`test-support/register-obsidian-for-ava.mjs` w repo pluginu) — to LOKATOR: ustawia
 * `PKM_ASSISTANT_ROOT`/`PKM_TEST_SUPPORT_DIR` i dynamicznie importuje TEN plik stąd. Ten plik
 * więc oczekuje, że `PKM_ASSISTANT_ROOT` jest już ustawiony, gdy zaczyna działać.
 *
 * KSZTAŁT: docelowo wpięty przez `ava.nodeArguments` (lokator, `--import`, ZA `--import=tsx`).
 * Sam hak (moduł `resolve`) siedzi w `data:`-URL-u poniżej, bo hak żyje w osobnym wątku
 * i nie ma prawa importować niczego względnego — cała jego wiedza to jeden adres atrapy,
 * wstrzyknięty tu jako literał.
 *
 * Rozwiązanie ODDAJE STER dalszym hakom (`next(...)` z adresem pliku atrapy) zamiast
 * zwracać wynik z `shortCircuit` — dzięki temu transpilacja `.ts` dalej należy do `tsx`.
 */
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Korzeń repo pluginu: ustawia go lokator z repo pluginu PRZED zaimportowaniem tego pliku
// (patrz nagłówek). Ten plik nie zgaduje sam — gdyby był importowany inną drogą (np. wprost
// przy pracy nad harnessem), brak zmiennej ma dać czytelny błąd, nie ciche `undefined`.
const KORZEN_PLUGINU = process.env.PKM_ASSISTANT_ROOT;
if (!KORZEN_PLUGINU) {
  throw new Error(
    '[harness/test-support] Brak PKM_ASSISTANT_ROOT. Ten plik oczekuje, że lokator w repo '
    + 'pluginu (test-support/register-obsidian-for-ava.mjs) ustawi tę zmienną przed importem.',
  );
}

// Testy AVA jadą w gołym Node, gdzie `window` nie istnieje, a kod pluginu sięga po timery,
// `fetch` i WebCrypto WYŁĄCZNIE przez `window` (`core/utils/hostWindow.ts`, reguły katalogu
// Obsidiana). Tu — w preloadzie testów, nie w kodzie pluginu — okno to globalny obiekt Node.
//
// KOLEJNOŚĆ JEST KRYTYCZNA — musi wykonać się PRZED jakimkolwiek (choćby pośrednim) importem
// modułu, który dotyka `core/utils/hostWindow.ts`: ten plik zamraża `typeof window` W CHWILI
// IMPORTU w stałą modułu (`export const hostWindow = typeof window !== 'undefined' ? window :
// undefined`). Statyczny `import` silnika YAML w tym pliku byłby HOISTED (ES moduły zawsze
// wykonują importy przed resztą ciała modułu, niezależnie od kolejności w tekście) — załadowałby
// `core/utils/yamlParser.ts` → `Logger.ts` → `LogFileSink.ts` → `hostWindow.ts` ZANIM linia
// niżej zdąży ustawić `window`, a zamrożone `undefined` zostałoby tak już do końca procesu
// (moduły ESM cache'ują się raz) — KAŻDY test dotykający timerów przez `hostWindow`
// (`LogFileSink`, bramka strumieniowania `ChatModel`) wywalałby się `Cannot read properties
// of undefined (reading 'setTimeout')`. Dlatego silnik jest importowany DYNAMICZNIE, PO
// ustawieniu okna — `import()` nie jest hoisted, wykonuje się dokładnie tam, gdzie stoi.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

// Silnik YAML dla WSZYSTKICH testów AVA (nie tylko tych importujących 'obsidian'): produkcyjny
// `core/utils/yamlParser.ts` NIE ma silnika, dopóki ktoś nie wywoła `setYamlEngine()` — poza
// Obsidianem robi to composition root (`src/main.ts`, tylko w harnessie) albo — dla testów
// jednostkowych, które w ogóle nie ładują `src/main.ts` — TEN preload. Import jest po ścieżce
// ABSOLUTNEJ do fizycznego pliku `.ts` w repo PLUGINU (ten plik mieszka w innym repo, więc nie
// ma tu żadnego względnego `../core`), ale tsx transpiluje go tak samo jak specyfier z barrela,
// więc to wciąż JEDEN moduł ze WSPÓLNYM stanem silnika (zweryfikowane testem
// `core/utils/yamlParser.test.ts`, który woła `parseYaml`/`stringifyYaml` przez specyfier `.js`
// z barrela). Pakiet `yaml` bierzemy jako devDependency PLUGINU (nie harnessu) przez
// `createRequire` liczone od JEGO `package.json` — z worktree'a agenta ta ścieżka wędruje w górę
// do `node_modules` repo głównego, dokładnie tak, jak dla zwykłego `npm install` w worktree.
// Opcje dumpu = dawne js-yaml (`noRefs: true, lineWidth: 120`): zero zawijania długich linii,
// zero kotwic `&`/`*`.
const { setYamlEngine } = await import(pathToFileURL(join(KORZEN_PLUGINU, 'core/utils/yamlParser.ts')).href);
const requireZPluginu = createRequire(join(KORZEN_PLUGINU, 'package.json'));
const YAML = requireZPluginu('yaml');
setYamlEngine({
  parse: (text) => YAML.parse(text),
  stringify: (value) => YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false, indent: 2 }),
});

const MOCK_URL = new URL('./obsidian.ts', import.meta.url).href;

const hookSource = `
const MOCK_URL = ${JSON.stringify(MOCK_URL)};

export async function resolve(specifier, context, next) {
  if (specifier === 'obsidian') return next(MOCK_URL, context);
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hookSource)}`);
