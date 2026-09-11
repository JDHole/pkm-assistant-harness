/**
 * pluginRoot.ts — JEDYNE miejsce, które wie, gdzie leży repo pluginu.
 *
 * PO CO: harness bootuje PRAWDZIWY plugin, ale od 2026-09-07 nie mieszka już w jego repo
 * (walidator katalogu Obsidiana lintuje CAŁE repo pluginu, a narzędzie testowe nie jest
 * jego częścią). Kod pluginu wchodzi tu przez alias `@plugin/...`. Atrapa `obsidian` mieszka
 * od 2026-09-11 w TYM repo (`test-support/`, patrz `esbuild.harness.ts`) — z tego samego powodu:
 * walidator flagował w niej rzeczy, których atrapa z definicji potrzebuje. Ten plik rozstrzyga
 * tylko, na jaki katalog wskazuje alias `@plugin/`.
 *
 * KOLEJNOŚĆ SZUKANIA:
 *   1. zmienna środowiskowa `PKM_ASSISTANT_ROOT` (tak robi CI: klonuje oba repo obok siebie
 *      i wskazuje harnessowi checkout pluginu),
 *   2. katalog-brat obok tego repo: `../pkm-assistant`, potem `../PKM Assistant`.
 * Kandydat liczy się, gdy ma `manifest.json`.
 *
 * Rozstrzygnięcie jest LENIWE i zapamiętywane: `esbuild.harness.ts` pyta o nie przy budowie
 * (alias), a `lib/boot.ts` przy biegu (ścieżka do `manifest.json` pluginu).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Nazwa zmiennej środowiskowej — wypisywana w komunikatach błędu, więc jedna stała. */
export const ENV_ROOT = 'PKM_ASSISTANT_ROOT';

/** Katalogi-bracia sprawdzane, gdy nie ma zmiennej środowiskowej. Kolejność ma znaczenie. */
const KANDYDACI = ['pkm-assistant', 'PKM Assistant'];

/** Plik, po którym poznajemy repo pluginu. */
const ZNACZNIK = 'manifest.json';

let zapamietanyKorzenHarnessu: string | null = null;
let zapamietanyKorzenPluginu: string | null = null;

/**
 * Korzeń TEGO repo. Działa w obu kontekstach, w których ten plik żyje: w źródłach
 * (`lib/pluginRoot.ts`, uruchamiane wprost przez Node) i w bundlu (`dist/run.js`,
 * `dist/scenarios.js`). Zamiast liczyć `..` na sztywno idziemy w górę, aż trafimy na
 * `package.json` z nazwą tego repo — `dist/package.json` (sam znacznik `"type": "module"`)
 * nie ma pola `name`, więc pętla przez niego przechodzi.
 */
export function harnessRoot(): string {
    if (zapamietanyKorzenHarnessu) return zapamietanyKorzenHarnessu;
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            try {
                const dane = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string };
                if (dane.name === 'pkm-assistant-harness') {
                    zapamietanyKorzenHarnessu = dir;
                    return dir;
                }
            } catch {
                // uszkodzony package.json po drodze nie może zatrzymać wspinaczki
            }
        }
        const wyzej = path.dirname(dir);
        if (wyzej === dir) break;
        dir = wyzej;
    }
    throw new Error(
        '[harness] Nie znalazłem korzenia repo harnessu (szukałem package.json z name="pkm-assistant-harness" '
        + 'idąc w górę od ' + path.dirname(fileURLToPath(import.meta.url)) + ').',
    );
}

function wygladaNaPlugin(kandydat: string): boolean {
    return fs.existsSync(path.join(kandydat, ZNACZNIK));
}

/**
 * Bezwzględna ścieżka do repo pluginu. Rzuca z instrukcją naprawy, gdy nie ma go gdzie wziąć.
 */
export function pluginRoot(): string {
    if (zapamietanyKorzenPluginu) return zapamietanyKorzenPluginu;

    const zEnv = process.env[ENV_ROOT];
    let wybrany: string | null = null;
    const sprawdzone: string[] = [];

    if (zEnv && zEnv.trim() !== '') {
        const kandydat = path.resolve(zEnv.trim());
        if (!wygladaNaPlugin(kandydat)) {
            throw new Error(
                `[harness] ${ENV_ROOT}=${zEnv} nie wygląda na repo pluginu — nie ma tam pliku ${ZNACZNIK}.`,
            );
        }
        wybrany = kandydat;
    } else {
        const obok = path.dirname(harnessRoot());
        for (const nazwa of KANDYDACI) {
            const kandydat = path.join(obok, nazwa);
            sprawdzone.push(kandydat);
            if (wygladaNaPlugin(kandydat)) { wybrany = kandydat; break; }
        }
    }

    if (!wybrany) {
        throw new Error(
            '[harness] Nie znalazłem repo pluginu PKM Assistant.\n'
            + '          Sprawdzone katalogi-bracia:\n'
            + sprawdzone.map(s => '            - ' + s).join('\n') + '\n'
            + '          Sklonuj plugin OBOK tego repo (https://github.com/JDHole/pkm-assistant)\n'
            + `          albo wskaż go zmienną środowiskową ${ENV_ROOT}=<ścieżka do repo pluginu>.`,
        );
    }

    zapamietanyKorzenPluginu = wybrany;
    return wybrany;
}
