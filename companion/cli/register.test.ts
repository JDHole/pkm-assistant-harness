import test from 'ava';
import { registerCliCommands } from './register.js';

import type { CliHandler, CliFlags } from '../../test-support/obsidian.js';
import type { CliDeps } from './commands.js';
import type { CliHost } from './register.js';

/**
 * PRZENIESIONE z `modules/cli/register.test.ts` pluginu - mechanika rejestracji (P1: wołane
 * NA hoście, nie odpięte; duplikat id; skipped:'unsupported') jest BEZ ZMIAN. Jedyna różnica:
 * `makeDeps()` niesie kształt `CliDeps` tej wtyczki (`companionId`/`companionVersion`/
 * `resolveHost`/`selfTest`/`consolidationStatus`), a oczekiwane id komend mają prefiks
 * `pkm-assistant-dev`, nie `pkm-assistant`.
 */

function makeDeps(): CliDeps {
    return {
        companionId: 'pkm-assistant-dev',
        companionVersion: '0.1.0',
        companionBuiltAt: '2026-09-01T00:00:00.000Z',
        companionPluginCommit: 'abc1234',
        companionPluginTreeDirty: false,
        resolvePluginBundleMtime: async () => null,
        resolveHost: () => null,
        selfTest: async () => ({ ok: true }),
        consolidationStatus: async () => {
            throw new Error('not used in this test file');
        },
        now: () => new Date('2026-09-20T00:00:00.000Z'),
    };
}

test('host bez registerCliHandler -> skipped=unsupported, nic nie rejestruje, nie rzuca', t => {
    const host: CliHost = {};
    const result = registerCliCommands(host, makeDeps());

    t.deepEqual(result, { registered: [], skipped: 'unsupported', failed: [] });
});

/**
 * P1 [BLOKER] (ze źródła): prawdziwa implementacja Obsidiana (`Plugin#registerCliHandler`) jest
 * metodą PROTOTYPU, która czyta `this` (`this.app.cli...`, `this.manifest.name`,
 * `this.register(...)`). Fejkowy host jako STRZAŁKA nie widziałby błędu, gdyby `register.ts`
 * odpiął referencję od hosta - ten host jest KLASĄ z metodą, żeby odróżnić "wołane jako
 * `host.registerCliHandler(...)`" od "wołane jako goła funkcja".
 */
class RealisticObsidianHost {
    manifest = { name: 'PKM Assistant Dev' };
    calls: Array<{ command: string; manifestName: string }> = [];

    registerCliHandler(command: string, description: string, flags: CliFlags | null, handler: CliHandler): void {
        void description; void flags; void handler;
        this.calls.push({ command, manifestName: this.manifest.name });
    }
}

test('P1: registerCliHandler wołany NA hoście (this działa) - realistyczna implementacja Obsidiana czyta `this.manifest`', t => {
    const host = new RealisticObsidianHost();
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);

    t.deepEqual(result.registered, [
        'pkm-assistant-dev:status',
        'pkm-assistant-dev:selftest',
        'pkm-assistant-dev:agent-prompt',
        'pkm-assistant-dev:memory-status',
    ]);
    t.deepEqual(result.failed, []);
    t.is(result.skipped, null);
    t.is(host.calls.length, 4);
    t.true(host.calls.every(call => call.manifestName === 'PKM Assistant Dev'));
});

test('rejestruje wszystkie cztery komendy z LITERALNYMI id/flagami przekazanymi do hosta (nie liczonymi przez buildCliCommands)', t => {
    const calls: Array<{ command: string; description: string; flags: CliFlags | null; handler: CliHandler }> = [];
    const host: CliHost = {
        registerCliHandler: (command, description, flags, handler) => {
            calls.push({ command, description, flags, handler });
        },
    };
    const deps = makeDeps();
    const result = registerCliCommands(host, deps);

    const expectedIds = [
        'pkm-assistant-dev:status',
        'pkm-assistant-dev:selftest',
        'pkm-assistant-dev:agent-prompt',
        'pkm-assistant-dev:memory-status',
    ];
    t.deepEqual(result, { registered: expectedIds, skipped: null, failed: [] });
    t.deepEqual(calls.map(c => c.command), expectedIds);

    for (const call of calls) {
        t.true(typeof call.description === 'string' && call.description.length > 0, call.command);
        t.is(typeof call.handler, 'function', call.command);
    }

    const flagNames = (flags: CliFlags | null): string[] => (flags ? Object.keys(flags) : []);
    t.deepEqual(flagNames(calls[0].flags), ['format'], 'status');
    t.deepEqual(flagNames(calls[1].flags), ['format'], 'selftest');
    t.deepEqual(flagNames(calls[2].flags), ['agent', 'section', 'format'], 'agent-prompt');
    t.deepEqual(flagNames(calls[3].flags), ['agent', 'format'], 'memory-status');

    t.is(calls[2].flags?.agent.required, true, 'agent-prompt: agent required');
    t.falsy(calls[2].flags?.section?.required, 'agent-prompt: section NIE required');
    t.falsy(calls[2].flags?.format?.required, 'agent-prompt: format NIE required');
    t.is(calls[3].flags?.agent.required, true, 'memory-status: agent required');
    t.falsy(calls[3].flags?.format?.required, 'memory-status: format NIE required');
    t.falsy(calls[0].flags?.format?.required, 'status: format NIE required');
    t.falsy(calls[1].flags?.format?.required, 'selftest: format NIE required');
});

test('host rzucajacy przy DRUGIEJ komendzie (duplikat) -> pozostale trzy zarejestrowane, jedna w failed', t => {
    let callIndex = 0;
    const host: CliHost = {
        registerCliHandler: () => {
            callIndex++;
            if (callIndex === 2) throw new Error('command already registered');
        },
    };
    const result = registerCliCommands(host, makeDeps());

    t.deepEqual(result.registered, ['pkm-assistant-dev:status', 'pkm-assistant-dev:agent-prompt', 'pkm-assistant-dev:memory-status']);
    t.deepEqual(result.failed, [{ id: 'pkm-assistant-dev:selftest', message: 'command already registered' }]);
    t.is(result.skipped, null);
});
