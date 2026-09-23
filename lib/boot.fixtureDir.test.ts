/**
 * boot.fixtureDir.test.ts — `--fixture <dir>` (prompt-eval adapter, impl_fixture 2026-09-23):
 * katalog fixture ma być wymienny z CLI, żeby dało się złożyć realny prompt persony zamiast
 * kopiować za każdym razem hard-coded `vault-fixture`.
 *
 * `bootPlugin()` sam jest za ciężki na dwa pełne boota w teście jednostkowym (robi PRAWDZIWY
 * `onload()+waitForReady()` na `PKMAssistantPlugin`) — testujemy więc wydzieloną, czystą funkcję
 * kopiowania fixture (`copyFixture`), którą `bootPlugin` woła 1:1 z `opts.fixtureDir` (patrz
 * `lib/boot.ts`). Ta sama ścieżka kodu, bez kosztu bootu całego pluginu.
 */
import test from 'ava';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { copyFixture } from './boot.js';

function freshTempRoot(tag: string): string {
    return path.join(os.tmpdir(), 'pkm-harness-test', `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

test('copyFixture: własny fixtureDir → temp-vault niesie notatkę Z NIEGO, nie plik z domyślnego fixture', async t => {
    const customFixture = freshTempRoot('custom-fixture');
    await fsp.mkdir(customFixture, { recursive: true });
    await fsp.writeFile(path.join(customFixture, 'wlasna-notatka.md'), '# Własna notatka testowa\n', 'utf8');

    const tempRoot = freshTempRoot('custom-temp');
    t.teardown(async () => {
        await fsp.rm(customFixture, { recursive: true, force: true }).catch(() => {});
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    });

    await copyFixture(tempRoot, customFixture);

    t.true(fs.existsSync(path.join(tempRoot, 'wlasna-notatka.md')), 'plik z własnego fixture nie trafił do temp-vaulta');
    t.false(fs.existsSync(path.join(tempRoot, 'Notatki', 'powitanie.md')), 'temp-vault niesie plik z DOMYŚLNEGO fixture, mimo podanego własnego katalogu — fixtureDir nie został użyty');
});

test('copyFixture: bez fixtureDir kopiowany jest domyślny vault-fixture (Notatki/powitanie.md)', async t => {
    const tempRoot = freshTempRoot('default-temp');
    t.teardown(async () => {
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    });

    await copyFixture(tempRoot);

    t.true(fs.existsSync(path.join(tempRoot, 'Notatki', 'powitanie.md')), 'domyślny fixture (vault-fixture/Notatki/powitanie.md) nie został skopiowany, gdy fixtureDir jest pominięty');
});

test('copyFixture: nieistniejący fixtureDir rzuca czytelny błąd zamiast surowego ENOENT z fsp.cp', async t => {
    const tempRoot = freshTempRoot('missing-temp');
    const missing = freshTempRoot('nie-istnieje');

    const err = await t.throwsAsync(() => copyFixture(tempRoot, missing));
    t.truthy(err, 'brakujący katalog fixture miał rzucić błąd, a nie rzucił');
    t.regex((err as Error).message, /nie istnieje/, 'komunikat błędu ma czytelnie nazwać przyczynę (katalog fixture nie istnieje), nie zostawiać gołego ENOENT');
    t.false(fs.existsSync(tempRoot), 'walidacja ma paść PRZED próbą kopiowania — tempRoot nie powinien w ogóle powstać');
});
