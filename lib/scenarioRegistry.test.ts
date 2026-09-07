/**
 * scenarioRegistry.test.ts — AUD-testy-062: rejestr `SCENARIOS` (`harness/scenarios/index.ts`)
 * vs pliki scenariuszy NA DYSKU.
 *
 * `_runner.ts` iteruje po `SCENARIOS` (import statyczny, nie glob po katalogu — komentarz w
 * `index.ts`: "Statyczne importy (NIE glob)"). Plik `harness/scenarios/NN_x.ts` bez importu +
 * wpisu w tablicy `SCENARIOS` **nigdy nie biegnie** — `npm run harness:scenarios` mimo to
 * kończy się `N/N GREEN`, exit 0, bez ani jednej wzmianki o pominiętym pliku (N liczone z
 * REJESTRU, nie z dysku). Regresja, którą taki nowy scenariusz miał złapać, przechodzi więc
 * przez WSZYSTKIE bramki repo niezauważona.
 *
 * ⚠️ Ten plik testuje `harness/scenarios/index.ts`, ale mieszka w `harness/lib/` — z tego
 * samego powodu co `assertToolErrored.test.ts` obok: `package.json`'s `ava.files` bierze
 * WYŁĄCZNIE `harness/lib/*.test.{js,ts}` (nie `harness/scenarios/**`). Dzięki temu ta asercja
 * biegnie na KAŻDYM `npm test` — nie tylko wtedy, gdy ktoś akurat puści `harness:scenarios`.
 *
 * ⚠️ Świadomie NIE importuje `{ SCENARIOS }` z `../scenarios/index.js`: ten barrel importuje
 * WSZYSTKIE 34 scenariusze, a część z nich (np. `36_web_provenance.ts`) ciągnie transitywnie
 * moduły dotykające `obsidian` (`modules/web/WebSearchProvider.ts`) — pod gołym AVA/tsx, BEZ
 * aliasu esbuilda `obsidian → harness/mock/obsidian.ts` (ten alias istnieje TYLKO w bundlu
 * `harness/dist/*.js`), taki import wywraca się natychmiast (`Cannot find package 'obsidian'`,
 * zweryfikowane empirycznie). Więc — jak `core/PKMEnv.boot_timing.test.ts` (patrz `core/CLAUDE.md`,
 * ten sam wzór dla plików importujących `obsidian`) — czytamy ŹRÓDŁO `index.ts` jako TEKST
 * i parsujemy je regexami, zamiast wykonywać moduł.
 */
import test from 'ava';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, '..', 'scenarios');
const INDEX_PATH = path.join(SCENARIOS_DIR, 'index.ts');

/** Pliki scenariuszy na dysku: `[0-9]*.ts` — wzorzec z findings audytu — bez `.test.ts` i bez helperów `_*.ts`. */
function scenarioFilesOnDisk(): string[] {
    return fs.readdirSync(SCENARIOS_DIR)
        .filter((f) => /^\d/.test(f) && f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => f.replace(/\.ts$/, ''))
        .sort();
}

function readIndexSource(): string {
    return fs.readFileSync(INDEX_PATH, 'utf8');
}

/** `import s01 from './01_smoke_loop.js';` → `{ident:'s01', file:'01_smoke_loop'}`. */
function parseImports(src: string): Array<{ ident: string; file: string }> {
    const out: Array<{ ident: string; file: string }> = [];
    const re = /^import\s+(\w+)\s+from\s+'\.\/([^']+)\.js';/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push({ ident: m[1], file: m[2] });
    return out;
}

/** Zawartość `export const SCENARIOS = [ ... ];` → identyfikatory w kolejności (np. `['s01','s02',...]`). */
function parseRegisteredIdents(src: string): string[] {
    const m = src.match(/export const SCENARIOS\s*=\s*\[([\s\S]*?)\];/);
    if (!m) return [];
    return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

test('index.ts: KAŻDY zaimportowany scenariusz (sNN) trafia do tablicy SCENARIOS (import bez wpisu = plik nigdy nie biegnie)', t => {
    const src = readIndexSource();
    const imports = parseImports(src);
    t.true(imports.length > 0, 'Regex nie znalazł ANI JEDNEGO importu w index.ts — sam parser jest zepsuty, nie rejestr.');
    const registered = new Set(parseRegisteredIdents(src));
    const missing = imports.filter((i) => !registered.has(i.ident)).map((i) => `${i.ident} (${i.file}.ts)`);
    t.deepEqual(missing, [], `Zaimportowane, ale NIE dopisane do SCENARIOS: ${missing.join(', ')}`);
});

test('index.ts vs dysk: KAŻDY plik scenariusza [0-9]*.ts ma odpowiadający import w index.ts', t => {
    const src = readIndexSource();
    const importedFiles = new Set(parseImports(src).map((i) => i.file));
    const onDisk = scenarioFilesOnDisk();
    const orphaned = onDisk.filter((f) => !importedFiles.has(f));
    t.deepEqual(orphaned, [], `Plik(i) scenariusza BEZ importu w harness/scenarios/index.ts (nigdy nie biegną): ${orphaned.join(', ') || '(brak)'}`);
});

test('index.ts: KAŻDY import wskazuje plik, który realnie istnieje na dysku (martwy/przestarzały import)', t => {
    const src = readIndexSource();
    const importedFiles = parseImports(src).map((i) => i.file);
    const onDiskSet = new Set(scenarioFilesOnDisk());
    const ghost = importedFiles.filter((f) => !onDiskSet.has(f));
    t.deepEqual(ghost, [], `Import w index.ts bez odpowiadającego pliku na dysku: ${ghost.join(', ') || '(brak)'}`);
});

test('index.ts: liczba wpisów SCENARIOS == liczba plików scenariuszy na dysku', t => {
    const src = readIndexSource();
    const registeredCount = parseRegisteredIdents(src).length;
    const onDiskCount = scenarioFilesOnDisk().length;
    t.is(registeredCount, onDiskCount, `SCENARIOS ma ${registeredCount} wpisów, na dysku jest ${onDiskCount} plików scenariuszy.`);
});
