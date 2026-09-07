/**
 * `harness/esbuild.harness.ts` — build bundla node'owego harnessu („Szklane Pudło").
 *
 * Uruchamiany wprost (`node harness/esbuild.harness.ts`) pierwszym krokiem KAŻDEJ
 * komendy `harness:*`, więc każdy bieg testów integracyjnych jest przy okazji świeżym
 * load-testem bundla — to on łapie cykle importów w barrelach, których żaden test
 * jednostkowy nie widzi.
 *
 * Dwa wejścia, jeden katalog wyjściowy:
 *   `harness/run.ts`              → `harness/dist/run.js`        (dry-boot i bieg eksploracyjny)
 *   `harness/scenarios/_runner.ts` → `harness/dist/scenarios.js`  (scenariusze-łamacze)
 *
 * Sedno: alias `obsidian` → `harness/mock/obsidian.ts`. Bundlujemy DOKŁADNIE ten kod
 * wtyczki, który dostaje użytkownik; podstawiamy tylko moduł, którego poza Obsidianem
 * fizycznie nie ma.
 *
 * ⚠️ Ten plik ma WŁASNE, krótkie pluginy tekstowe i świadomie nie importuje niczego
 * z `utils/`: leży w `tsconfig.include`, więc obowiązuje go kontrakt specyfierów `.js`,
 * a Node uruchamiający go wprost nie przepisuje rozszerzeń na pliki `.ts`. Bliźniacze
 * (ale nie wspólne) pluginy siedzą w `esbuild.js` — duplikacja jest tańsza niż wyjątek
 * w kontrakcie importów całego repo.
 */
import path from 'node:path';
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import type { Plugin } from 'esbuild';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

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

async function buildHarness(): Promise<void> {
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
        // Wyjście jest ESM (repo ma `"type": "module"`, a bundle nazywa się `.js`), więc
        // trzy globale CommonJS trzeba dołożyć ręcznie: `require` dla paczek z
        // nieanalizowalnym `require(...)`, oraz `__filename`/`__dirname`, po których
        // sięga kod harnessu (`harness/lib/boot.ts` liczy z nich korzeń harnessu —
        // bundle leży w `harness/dist/`, więc `..` trafia dokładnie w `harness/`).
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
        alias: {
            obsidian: path.join(HARNESS_DIR, 'mock', 'obsidian.ts'),
        },
        plugins: [cssImportPlugin, markdownImportPlugin],
    });
    // Znacznik modułu obok bundli: wyjście jest ESM, więc `harness/dist/package.json` MUSI mówić
    // `"type": "module"`. Poprzedni harness (sprzed clean-room) zostawiał tu `"commonjs"`,
    // a katalog jest gitignorowany — stary klon dziedziczył znacznik i Node czytał nowy bundle
    // jako CJS („Cannot use import statement outside a module"). Zapis jest idempotentny.
    await writeFile(path.join(HARNESS_DIR, 'dist', 'package.json'), '{\n  "type": "module"\n}\n', 'utf8');
}

buildHarness().catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\n[harness/build] BLAD budowania bundla:\n${message}\n`);
    process.exit(1);
});
