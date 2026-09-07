/**
 * `esbuild.harness.ts` — build bundla node'owego harnessu („Szklane Pudło").
 *
 * Uruchamiany wprost (`node esbuild.harness.ts`) pierwszym krokiem KAŻDEJ komendy tego repo,
 * więc każdy bieg testów integracyjnych jest przy okazji świeżym load-testem bundla pluginu —
 * to on łapie cykle importów w barrelach, których żaden test jednostkowy nie widzi.
 *
 * Dwa wejścia, jeden katalog wyjściowy:
 *   `run.ts`               → `dist/run.js`        (dry-boot i bieg eksploracyjny)
 *   `scenarios/_runner.ts` → `dist/scenarios.js`  (scenariusze-łamacze)
 *
 * SEDNO — dwa aliasy, obydwa liczone od korzenia repo PLUGINU (`lib/pluginRoot.ts`):
 *   `@plugin/<cokolwiek>` → `<plugin>/<cokolwiek>`             (kod wtyczki, przez barrele)
 *   `obsidian`            → `<plugin>/test-support/obsidian.ts` (atrapa hosta)
 * Bundlujemy DOKŁADNIE ten kod wtyczki, który dostaje użytkownik; podstawiamy tylko moduł,
 * którego poza Obsidianem fizycznie nie ma. Atrapa została w repo pluginu, bo bez niej nie
 * wstaje jego własne `npm test` — jedna atrapa, dwóch konsumentów.
 *
 * KONTRAKT SPECYFIERÓW (TS-0 pluginu): w kodzie importy kończą się na `.js`, a na dysku leżą
 * pliki `.ts`. Dla importów WEWNĄTRZ drzewa pluginu robi to esbuild sam (importer jest `.ts`),
 * ale ścieżki wchodzące przez alias omijają jego resolver — dlatego podmianę rozszerzenia
 * robimy tu, ręcznie, w `rozwiazWPluginie`.
 *
 * ⚠️ Ten plik ma WŁASNE, krótkie pluginy tekstowe (`.css`/`.md` jako moduł) — bliźniacze
 * siedzą w `esbuild.js` pluginu. Duplikacja jest tańsza niż wspólna zależność między repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import type { Plugin } from 'esbuild';
import { pluginRoot } from './lib/pluginRoot.ts';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Prefiks aliasu kodu wtyczki. Jedno miejsce — używa go i resolver, i komunikat błędu. */
const PREFIKS = '@plugin/';

/** Sposób, w jaki treść pliku tekstowego zamienia się w moduł JS. */
interface TextImportSpec {
    readonly name: string;
    readonly filter: RegExp;
    /** Wartość atrybutu `with { type: … }` obsługiwana przez ten plugin. */
    readonly attribute: string;
    readonly toModule: (raw: string) => string;
}

/**
 * Plik tekstowy jako moduł JS. Treść osadzana przez `JSON.stringify`, nie wklejana
 * w szablon — apostrof albo backtick w arkuszu czy notatkach wysadziłby bundle.
 */
function textImportPlugin(spec: TextImportSpec): Plugin {
    const namespace = `${spec.name}-tresc`;
    return {
        name: spec.name,
        setup(build) {
            build.onResolve({ filter: spec.filter }, args => {
                const declared = args.with?.type;
                if (declared && declared !== spec.attribute) return null;
                return { path: path.resolve(args.resolveDir, args.path), namespace };
            });
            build.onLoad({ filter: /.*/, namespace }, async args => ({
                contents: spec.toModule(await readFile(args.path, 'utf8')),
                loader: 'js' as const,
                watchFiles: [args.path],
            }));
        },
    };
}

const cssImportPlugin = textImportPlugin({
    name: 'import-css',
    filter: /\.css$/,
    attribute: 'css',
    toModule: css => [
        'const sheet = new CSSStyleSheet();',
        `sheet.replaceSync(${JSON.stringify(css)});`,
        'export default sheet;',
    ].join('\n'),
});

const markdownImportPlugin = textImportPlugin({
    name: 'import-markdown',
    filter: /\.md$/,
    attribute: 'markdown',
    toModule: markdown => `export default ${JSON.stringify(markdown)};\n`,
});

/**
 * Ścieżka względna w drzewie pluginu → plik na dysku, z podmianą `.js` → `.ts` (kontrakt TS-0).
 * Rzuca z pełną listą sprawdzonych ścieżek — pomyłka w aliasie ma być czytelna od razu.
 */
function rozwiazWPluginie(korzen: string, wzgledna: string): string {
    const abs = path.join(korzen, wzgledna);
    const kandydaci = abs.endsWith('.js')
        ? [abs.slice(0, -3) + '.ts', abs]
        : [abs, abs + '.ts', path.join(abs, 'index.ts')];
    for (const kandydat of kandydaci) {
        if (fs.existsSync(kandydat) && fs.statSync(kandydat).isFile()) return kandydat;
    }
    throw new Error(
        `[harness/build] Alias ${PREFIKS}${wzgledna} nie wskazuje na żaden plik.\n`
        + '                Sprawdzone:\n' + kandydaci.map(k => '                  - ' + k).join('\n'),
    );
}

/** Dwa aliasy do drzewa pluginu (patrz nagłówek). */
function pluginTreePlugin(korzen: string): Plugin {
    const atrapaObsidiana = path.join(korzen, 'test-support', 'obsidian.ts');
    return {
        name: 'plugin-tree',
        setup(build) {
            build.onResolve({ filter: /^@plugin\// }, args => ({
                path: rozwiazWPluginie(korzen, args.path.slice(PREFIKS.length)),
            }));
            build.onResolve({ filter: /^obsidian$/ }, () => ({ path: atrapaObsidiana }));
        },
    };
}

async function buildHarness(): Promise<void> {
    const korzenPluginu = pluginRoot();
    process.stdout.write(`[harness/build] plugin: ${korzenPluginu}\n`);

    await esbuild.build({
        entryPoints: {
            run: path.join(HARNESS_DIR, 'run.ts'),
            scenarios: path.join(HARNESS_DIR, 'scenarios', '_runner.ts'),
        },
        outdir: path.join(HARNESS_DIR, 'dist'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        charset: 'utf8',
        // Bez minifikacji i z zachowanymi nazwami: stos z padniętego scenariusza ma być
        // czytelny bez mapy źródeł, a asercje harnessu porównują nazwy funkcji i klas.
        minify: false,
        keepNames: true,
        sourcemap: false,
        logLevel: 'warning',
        // Wyjście jest ESM (repo ma `"type": "module"`, a bundle nazywa się `.js`), więc trzy
        // globale CommonJS trzeba dołożyć ręcznie: `require` dla paczek z nieanalizowalnym
        // `require(...)`, oraz `__filename`/`__dirname`, po których sięga kod harnessu.
        // Nazwy importów pomocniczych są celowo dziwaczne: banner jest dla esbuilda
        // nieprzezroczystym tekstem, więc nie może kolidować z symbolami bundla.
        banner: {
            js: [
                "import { createRequire as __harnessCreateRequire } from 'node:module';",
                "import { fileURLToPath as __harnessFileURLToPath } from 'node:url';",
                "import { dirname as __harnessDirname } from 'node:path';",
                'const require = __harnessCreateRequire(import.meta.url);',
                'const __filename = __harnessFileURLToPath(import.meta.url);',
                'const __dirname = __harnessDirname(__filename);',
            ].join('\n'),
        },
        plugins: [pluginTreePlugin(korzenPluginu), cssImportPlugin, markdownImportPlugin],
    });
    // Znacznik modułu obok bundli: wyjście jest ESM, więc `dist/package.json` MUSI mówić
    // `"type": "module"`. Katalog jest gitignorowany, więc stary klon mógłby odziedziczyć
    // znacznik `"commonjs"` i Node czytałby nowy bundle jako CJS. Zapis jest idempotentny.
    await writeFile(path.join(HARNESS_DIR, 'dist', 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');
}

buildHarness().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\n[harness/build] BLAD budowania bundla:\n${message}\n`);
    process.exit(1);
});
