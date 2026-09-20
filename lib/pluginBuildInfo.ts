/**
 * pluginBuildInfo.ts — znacznik "z jakiego stanu repo pluginu zbudowano companion" (K3,
 * poprawki po recenzji adwersaryjnej).
 *
 * PO CO: `companion/memoryStatus.ts` importuje runtime'owo progi konsolidacji i plan wprost ze
 * ŹRÓDEŁ pluginu (`@plugin/modules/memory/consolidationStatus.js`, `ConsolidationRun.js`), a
 * `main.ts` woła `buildSelfTestReport` też ze źródeł (`@plugin/core/selftest.js`) - ale to, co
 * WCHODZI do `dist/companion/main.js`, jest wkompilowane w chwili `npm run build:companion`.
 * Jeśli plugin zostanie przebudowany PÓŹNIEJ (nowa formuła progów, nowy kształt raportu), ta
 * wtyczka o tym nie wie - dalej liczy WEDŁUG STAREGO stanu źródeł, wkompilowanego przy jej
 * WŁASNYM, wcześniejszym buildzie. Znacznik (`resolvePluginGitInfo` + `builtAt` w `esbuild.harness.ts`)
 * pozwala `StatusData.companionStale` (`commands.ts`) ostrzec o tym rozjeździe - patrz
 * `companion/CLAUDE.md`, gotcha "dwa bundle - jedno liczydło".
 */
import { execFileSync } from 'node:child_process';

export interface PluginGitInfo {
    /** Krótki hash `HEAD` repo pluginu w chwili builda, albo `'unknown'`, gdy `git` niedostępny
     *  (nie zainstalowany, katalog nie jest repo, itp. - fail-soft, nigdy nie wywraca builda). */
    commit: string;
    /** `true`, gdy drzewo robocze repo pluginu miało niezacommitowane zmiany w chwili builda.
     *  Gdy nie da się ustalić (git niedostępny) - `false`: NIE oznaczamy fałszywie brudnego
     *  drzewa, kiedy po prostu nie umiemy sprawdzić. */
    dirty: boolean;
}

/**
 * `git rev-parse --short HEAD` + `git status --porcelain` w katalogu pluginu. Fail-soft na
 * KAŻDYM kroku (repo pluginu jest CUDZYM repo z punktu widzenia tego builda - awaria odczytu
 * jego stanu gita nie ma prawa wywrócić `npm run build:companion`).
 */
export function resolvePluginGitInfo(pluginRootDir: string): PluginGitInfo {
    // stdio: stderr wyciszone ('pipe', nie odziedziczone) - repo pluginu bywa "nie-repo" z
    // premedytacji (test tej gałęzi, harness bez klonu gita) i `git` krzyczy na stderr za
    // każdym razem; to jest oczekiwana, obsłużona gałąź, nie awaria warta hałasu w konsoli.
    let commit: string;
    try {
        commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: pluginRootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (!commit) commit = 'unknown';
    } catch {
        return { commit: 'unknown', dirty: false };
    }

    let dirty = false;
    try {
        const status = execFileSync('git', ['status', '--porcelain'], { cwd: pluginRootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        dirty = status.trim().length > 0;
    } catch {
        // Commit się odczytał, ale status już nie (bardzo mało prawdopodobne w tym samym repo) -
        // fail-soft: nie umiemy stwierdzić brudu, więc NIE twierdzimy że jest brudno.
        dirty = false;
    }

    return { commit, dirty };
}
