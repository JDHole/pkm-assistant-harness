import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolvePluginGitInfo } from './pluginBuildInfo.ts';

/**
 * `resolvePluginGitInfo` (K3) — znacznik "z jakiego commita/stanu drzewa repo pluginu zbudowano
 * companion". Testy budują WŁASNE, tymczasowe repo git (nie ruszają prawdziwego repo pluginu -
 * jego commit/czystość zmieniają się w czasie, więc nie nadają się na literalne oczekiwane
 * wartości). Oczekiwany hash commita jest odczytany NIEZALEŻNIE, gołym `execFileSync('git', ...)`
 * poza `resolvePluginGitInfo` - to ziemia odniesienia z samego binarnego gita, nie wynik funkcji
 * pod testem (self-referential test byłby, gdyby oczekiwaną wartość liczyła TA SAMA funkcja).
 */

function tempDir(tag: string): string {
    const dir = path.join(os.tmpdir(), `pkm-harness-plugin-build-info-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepoWithOneCommit(dir: string): void {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-q', '-m', 'init']);
}

function headShort(dir: string): string {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('resolvePluginGitInfo: repo git CZYSTY -> commit = krótki hash HEAD (z gołego gita), dirty=false', t => {
    const dir = tempDir('clean');
    initRepoWithOneCommit(dir);
    const expectedCommit = headShort(dir);

    const info = resolvePluginGitInfo(dir);

    t.deepEqual(info, { commit: expectedCommit, dirty: false });
});

test('resolvePluginGitInfo: drzewo BRUDNE (niezacommitowana zmiana pliku) -> dirty=true, commit bez zmian', t => {
    const dir = tempDir('dirty-modified');
    initRepoWithOneCommit(dir);
    const expectedCommit = headShort(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'zmienione, niezacommitowane');

    const info = resolvePluginGitInfo(dir);

    t.deepEqual(info, { commit: expectedCommit, dirty: true });
});

test('resolvePluginGitInfo: drzewo BRUDNE (nowy nieśledzony plik) -> dirty=true', t => {
    const dir = tempDir('dirty-untracked');
    initRepoWithOneCommit(dir);
    fs.writeFileSync(path.join(dir, 'nowy.txt'), 'nieśledzony plik');

    const info = resolvePluginGitInfo(dir);

    t.true(info.dirty);
});

test('resolvePluginGitInfo: katalog NIE jest repo git -> commit="unknown", dirty=false', t => {
    const dir = tempDir('not-a-repo');

    const info = resolvePluginGitInfo(dir);

    t.deepEqual(info, { commit: 'unknown', dirty: false });
});

test('resolvePluginGitInfo: katalog nie istnieje -> commit="unknown", dirty=false, nie rzuca', t => {
    const dir = path.join(os.tmpdir(), `pkm-harness-plugin-build-info-test-nope-${Date.now()}`);

    const info = resolvePluginGitInfo(dir);

    t.deepEqual(info, { commit: 'unknown', dirty: false });
});
