/**
 * app.test.ts — strażnik atomowości `vault.process` w atrapie `app` (`mock/app.ts`).
 *
 * Kontekst: kontrakt Obsidiana obiecuje `vault.process` jako "Atomically read, modify, and
 * save the contents" - produkcyjny `modules/tools/WriteTool.ts` pluginu liczy patch/append/
 * prepend WEWNĄTRZ callbacka `process` właśnie na tej obietnicy. Do naprawy 2026-09-22 atrapa
 * robiła gołe `read -> await -> write` bez żadnego szeregowania: trzy równoległe `process()` na
 * JEDNYM pliku czytały tę samą, nieaktualną treść i nadpisywały się nawzajem (lost update) -
 * harness na tej atrapie nie mógł tego potwierdzić, mimo że produkcja jest już naprawiona.
 *
 * Test niżej sprawdza dokładnie to, co obiecuje naprawiony `processFile` w `mock/app.ts`: każde
 * kolejne wywołanie na tej samej ścieżce dostaje AKTUALNĄ (już zmienioną przez poprzednie)
 * treść, więc końcowa treść niesie WSZYSTKIE trzy znaczniki, w kolejności wywołania (łańcuch
 * budowany SYNCHRONICZNIE w momencie wywołania `process()`, zanim jakikolwiek callback zdąży
 * dokończyć swoje I/O) - asercja na LITERALNEJ wartości końcowej, nie na samym "zawiera 3 razy".
 */
import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockApp } from './app.js';

function tempVault(tag: string): string {
    const dir = path.join(os.tmpdir(), `pkm-harness-mock-app-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

test('vault.process: trzy wywołania RÓWNOLEGŁE na jednym pliku - żadne nie gubi cudzej zmiany (lost update)', async t => {
    const vaultRoot = tempVault('parallel');
    t.teardown(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

    fs.writeFileSync(path.join(vaultRoot, 'note.md'), 'START\n');
    const app = createMockApp(vaultRoot);

    const [r1, r2, r3] = await Promise.all([
        app.vault.process('note.md', (content: string) => `${content}A\n`),
        app.vault.process('note.md', (content: string) => `${content}B\n`),
        app.vault.process('note.md', (content: string) => `${content}C\n`),
    ]);

    const finalContent = fs.readFileSync(path.join(vaultRoot, 'note.md'), 'utf8');

    // Każde wywołanie widziało dokładnie to, co poprzednie zapisało - żadne nie startowało od
    // "START\n" gołego (co by się stało z gołym read/write bez szeregowania).
    t.is(finalContent, 'START\nA\nB\nC\n');
    // Wartość zwrócona przez KAŻDE wywołanie `process()` to to, co ono samo zapisało (kontrakt
    // Obsidiana: `process()` zwraca nową treść), nie treść jakiegoś innego wywołania.
    t.is(r1, 'START\nA\n');
    t.is(r2, 'START\nA\nB\n');
    t.is(r3, 'START\nA\nB\nC\n');
});

test('vault.process: dwie ścieżki RÓŻNE nie blokują się nawzajem (zamek jest PER ŚCIEŻKA)', async t => {
    const vaultRoot = tempVault('per-path');
    t.teardown(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

    fs.writeFileSync(path.join(vaultRoot, 'a.md'), 'A0\n');
    fs.writeFileSync(path.join(vaultRoot, 'b.md'), 'B0\n');
    const app = createMockApp(vaultRoot);

    const [a1, b1] = await Promise.all([
        app.vault.process('a.md', (content: string) => `${content}A1\n`),
        app.vault.process('b.md', (content: string) => `${content}B1\n`),
    ]);

    t.is(a1, 'A0\nA1\n');
    t.is(b1, 'B0\nB1\n');
});

test('vault.process: gdy JEDEN callback rzuca, kolejne wywołanie na tej samej ścieżce nie zostaje zablokowane na zawsze', async t => {
    const vaultRoot = tempVault('reject');
    t.teardown(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));

    fs.writeFileSync(path.join(vaultRoot, 'note.md'), 'START\n');
    const app = createMockApp(vaultRoot);

    const failing = app.vault.process('note.md', () => { throw new Error('boom'); });
    const following = app.vault.process('note.md', (content: string) => `${content}OK\n`);

    await t.throwsAsync(failing, { message: 'boom' });
    t.is(await following, 'START\nOK\n');
});
