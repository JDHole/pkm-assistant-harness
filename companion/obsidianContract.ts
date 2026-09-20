/**
 * obsidianContract.ts — plik WYŁĄCZNIE typowy (K5, recenzja adwersaryjna), zero kodu runtime
 * (żadnej instrukcji wykonywalnej - same aliasy typów, w całości wycinane przez `tsc`).
 *
 * PO CO: `companion/cli/*.ts` importuje typy CLI (`CliData`/`CliFlag`/`CliFlags`/`CliHandler`) z
 * LOKALNEJ atrapy (`test-support/obsidian.ts`), nie z pakietu `obsidian` (patrz `CLAUDE.md` tego
 * folderu, gotcha "`companion/cli/*.ts` importuje typy CLI (...) z LOKALNEJ atrapy"). Nic w tym
 * repo do teraz nie porównywało tej atrapy z PRAWDZIWYM `obsidian.d.ts` pluginu - gdyby atrapa i
 * prawdziwy Obsidian się rozjechały (np. Obsidian dodałby piąty parametr do
 * `registerCliHandler`, albo zmienił kształt `CliFlag`), ten repo nadal by się kompilował i
 * testował zielono, mimo że produkcyjna wtyczka w PRAWDZIWYM Obsidianie już by nie pasowała.
 *
 * Ten plik importuje PRAWDZIWE typy z `node_modules/obsidian/obsidian.d.ts` REPO PLUGINU (nie
 * tego repo - `obsidian` nie jest tu zależnością, patrz ta sama gotcha) przez ISTNIEJĄCY alias
 * `@plugin/` (`esbuild.harness.ts`, `tsconfig.json` `paths`) - `@plugin/node_modules/obsidian/
 * obsidian.js` rozwiązuje się na `obsidian.d.ts` pluginu (moduł deklaracji bez `.js` na dysku;
 * `moduleResolution: "bundler"` w `tsconfig.json` tego repo próbuje `.d.ts` jako towarzysza
 * specyfiera `.js`, dokładnie tak jak TS-0 pluginu robi to dla WŁASNYCH plików `.ts` - zweryfikowane
 * ręcznie przed napisaniem tego pliku: `npm run typecheck` z celowo zepsutym importem tej ścieżki
 * daje czytelny `TS2305`, nie "nie mogę rozwiązać modułu"). I na poziomie TYPÓW wymusza OBUSTRONNĄ
 * przypisywalność z odpowiadającymi typami atrapy (`test-support/obsidian.ts`), plus zgodność
 * sygnatury `registerCliHandler`. Zmiana API po KTÓREJKOLWIEK stronie (Obsidian podniesie wersję
 * API, ktoś poprawi atrapę bez pilnowania kontraktu) wywala `npm run typecheck` W TYM MIEJSCU -
 * to jest cały sens tego pliku, nie runtime behavior.
 *
 * Dowód (K5): tymczasowo zepsuty typ w atrapie (`test-support/obsidian.ts`, np. dodane pole
 * required-bez-`?` do `CliFlag`) dał czerwony `npm run typecheck` z błędem WSKAZUJĄCYM na ten
 * plik i konkretną parę typów - przywrócono po potwierdzeniu (patrz raport zadania).
 */
import type {
    CliData as RealCliData,
    CliFlag as RealCliFlag,
    CliFlags as RealCliFlags,
    CliHandler as RealCliHandler,
    Plugin as RealPlugin,
} from '@plugin/node_modules/obsidian/obsidian.js';

import type {
    CliData as FakeCliData,
    CliFlag as FakeCliFlag,
    CliFlags as FakeCliFlags,
    CliHandler as FakeCliHandler,
} from '../test-support/obsidian.js';

/**
 * Obustronna przypisywalność: `A` musi dać się przypisać do `B` I `B` musi dać się przypisać do
 * `A`. `[A] extends [B]` (opakowanie w krotkę) zamiast gołego `A extends B` - ten drugi zapis
 * jest DYSTRYBUTYWNY na typach unijnych (rozbija unię członek po członku), co dla `CliData`
 * (worek indeksowany, nie unia) nie miałoby znaczenia, ale to standardowy, bezpieczny idiom przy
 * porównaniach strukturalnych ogólnego przeznaczenia - jedna forma dla wszystkich pięciu par niżej.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Bramka: instancjacja `Check<false>` narusza ograniczenie generyka (`T extends true`) i wywala
 * `tsc` W TYM MIEJSCU, z nazwą pary typów widoczną w stosie błędu - niezależnie od tego, czy
 * wynikowy alias jest później gdziekolwiek użyty (TS sprawdza ograniczenia generyków przy
 * INSTANCJACJI, nie leniwie przy użyciu).
 */
type Check<T extends true> = T;

/** Sygnatura METODY prawdziwego `Plugin` (indexed access na typie instancji - `import type`
 *  sprawia, że `RealPlugin` w pozycji typu to strona instancji, nie konstruktora). */
type RealRegisterCliHandler = RealPlugin['registerCliHandler'];
/** Kształt, jakiego oczekuje ten repo od hosta (`cli/register.ts`, `CliHost.registerCliHandler`
 *  - typy CLI atrapy, nie prawdziwego Obsidiana, patrz nagłówek). */
type FakeRegisterCliHandler = (command: string, description: string, flags: FakeCliFlags | null, handler: FakeCliHandler) => void;

/**
 * Jeden eksportowany typ trzymający WSZYSTKIE pięć sprawdzeń - eksport wystarcza, żeby żadne z
 * nich nie oberwało (kosmetycznego) `noUnusedLocals`, a każdy element krotki i tak jest
 * zweryfikowany W MIEJSCU SWOJEJ INSTANCJACJI, zanim krotka w ogóle powstanie.
 */
export type ObsidianCliContractHoldsBothWays = [
    Check<MutuallyAssignable<RealCliData, FakeCliData>>,
    Check<MutuallyAssignable<RealCliFlag, FakeCliFlag>>,
    Check<MutuallyAssignable<RealCliFlags, FakeCliFlags>>,
    Check<MutuallyAssignable<RealCliHandler, FakeCliHandler>>,
    Check<MutuallyAssignable<RealRegisterCliHandler, FakeRegisterCliHandler>>,
];
