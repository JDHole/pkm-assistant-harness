/**
 * cliHandlerMock.test.ts — atrapa `Plugin#registerCliHandler` (`test-support/obsidian.ts`),
 * kontrakt CLI Obsidiana od 1.12.2 (`node_modules/obsidian/obsidian.d.ts` w repo pluginu,
 * linie 1593-1640 i 5035-5048).
 *
 * Ten plik testuje kod z `test-support/obsidian.ts`, a mieszka w `lib/` z tego samego powodu
 * co `assertToolErrored.test.ts` obok (patrz jego nagłówek): `package.json`'s `ava.files` bierze
 * WYŁĄCZNIE `lib/*.test.ts` i `scenarios/*.test.ts`, nie `test-support/**`. Import jest bezpieczny
 * pod gołym AVA/tsx (bez aliasu esbuilda `obsidian → test-support/obsidian.ts`, który istnieje
 * TYLKO w bundlu `dist/*.js`) — importujemy PLIK WPROST po ścieżce względnej, nie przez
 * specyfier `'obsidian'`.
 *
 * Co pina: `registerCliHandler` musi być wierny realnemu hostowi (cytat z `obsidian.d.ts`:
 * „Attempting to register a command that is already registered will throw an Error.") — bez tej
 * atrapy `modules/cli/register.ts` pluginu (który na duplikacie POLEGA — każda z czterech komend
 * fali 1 leci w OSOBNYM try/catch właśnie na tę okazję) nigdy nie widziałby żadnego rzutu pod
 * harnessem, a scenariusz end-to-end (`NN_cli_odczyt`) niczego by tu nie udowodnił.
 */
import test from 'ava';
import { Plugin } from '../test-support/obsidian.js';
import type { CliData } from '../test-support/obsidian.js';

test('registerCliHandler: zarejestrowany handler trafia do _registeredCliHandlers i da się wywołać', async t => {
    const plugin = new Plugin(undefined, { id: 'pkm-assistant' });
    const handler = async (params: CliData): Promise<string> => JSON.stringify({ echo: params.agent ?? null });

    plugin.registerCliHandler('pkm-assistant:status', 'Report plugin liveness.', { agent: { description: 'nazwa agenta' } }, handler);

    t.is(plugin._registeredCliHandlers.size, 1);
    const registered = plugin._registeredCliHandlers.get('pkm-assistant:status');
    t.truthy(registered, 'Komenda nie wylądowała w rejestrze pod swoim id.');
    t.is(registered!.description, 'Report plugin liveness.');
    t.deepEqual(registered!.flags, { agent: { description: 'nazwa agenta' } });

    const out = await registered!.handler({ agent: 'Tester' });
    t.is(out, JSON.stringify({ echo: 'Tester' }), 'Handler zarejestrowany w atrapie nie jest tym samym wywoływalnym handlerem, który dostał registerCliHandler.');
});

test('registerCliHandler: duplikat id RZUCA Error (kontrakt obsidian.d.ts), pierwsza rejestracja zostaje nietknięta', t => {
    const plugin = new Plugin(undefined, { id: 'pkm-assistant' });
    const pierwszy = async (): Promise<string> => 'pierwszy';
    const drugi = async (): Promise<string> => 'drugi';

    plugin.registerCliHandler('pkm-assistant:selftest', 'Run self-test.', null, pierwszy);

    const err = t.throws(() => plugin.registerCliHandler('pkm-assistant:selftest', 'Run self-test (duplikat).', null, drugi), { instanceOf: Error });
    t.truthy(err, 'Drugi registerCliHandler na tym samym id miał rzucić Error, a nie rzucił.');

    t.is(plugin._registeredCliHandlers.size, 1, 'Nieudana rejestracja duplikatu nie ma prawa nadpisać ani dołożyć wpisu.');
    t.is(plugin._registeredCliHandlers.get('pkm-assistant:selftest')!.handler, pierwszy, 'Duplikat NADPISAŁ pierwszą rejestrację zamiast rzucić przed zapisem.');
});

test('registerCliHandler: ODPIĘTY od `this` RZUCA TypeError, jak w realnym Obsidianie (atrapa nie maskuje błędu wołacza)', t => {
    // Realny `Plugin.prototype.registerCliHandler` czyta `this.app.cli` / `this.manifest.name`,
    // więc wołacz, który wyciąga metodę do lokalnej stałej i woła ją bez hosta, dostaje w apce
    // `TypeError` na każdej komendzie. Pierwsza wersja `modules/cli/register.ts` pluginu miała
    // dokładnie ten błąd; atrapa strzałkowa (z `this` zamkniętym leksykalnie) puściłaby go
    // zielono przez selftest i scenariusze. Ten test pilnuje, żeby atrapa została wierna hostowi.
    const plugin = new Plugin(undefined, { id: 'pkm-assistant' });
    const registerCliHandler = plugin.registerCliHandler;
    t.throws(() => registerCliHandler('pkm-assistant:agent-prompt', 'x', null, async () => 'x'), { instanceOf: TypeError });
    t.is(plugin._registeredCliHandlers.size, 0, 'Odpięte wywołanie nie ma prawa niczego zarejestrować.');
});

test('registerCliHandler: dwie RÓŻNE komendy współistnieją bez kolizji', t => {
    const plugin = new Plugin(undefined, { id: 'pkm-assistant' });
    plugin.registerCliHandler('pkm-assistant:status', 'a', null, async () => 'a');
    plugin.registerCliHandler('pkm-assistant:memory-status', 'b', null, async () => 'b');

    t.is(plugin._registeredCliHandlers.size, 2);
    t.deepEqual([...plugin._registeredCliHandlers.keys()].sort(), ['pkm-assistant:memory-status', 'pkm-assistant:status']);
});
