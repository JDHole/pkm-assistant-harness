import test from 'ava';
import { buildCliCommands, createInstanceTracker } from './commands.js';

import type { Agent } from '@plugin/modules/agents/index.js';
import type { AgentMemory } from '@plugin/modules/memory/index.js';
import type { ConsolidationStatus } from '../memoryStatus.js';
import type { CliAgentManager, CliIndexStatus, ResolvedHost } from '../hostPlugin.js';
import type { CliDeps } from './commands.js';

/**
 * PRZENIESIONE z `modules/cli/commands.test.ts` pluginu, z trzema różnicami wynikającymi ze
 * zmiany architektury (host rozwiązywany PRZY KAŻDYM wywołaniu, nie statyczne gettery):
 *
 *  1. id komend mają prefiks TEJ wtyczki (`pkm-assistant-dev`), nie hosta (`pkm-assistant`);
 *  2. zamiast `agentManager`/`indexStatus` osobno, fixture buduje `ResolvedHost` (albo `null` -
 *     "hosta nie ma") i wstrzykuje go przez `resolveHost`;
 *  3. `StatusData.plugin` niesie `instanceSince` zamiast `loadedAt` i doszło pole `companion` -
 *     nowe testy tej pary (P7 specyfikacji: pamięć OSTATNIO WIDZIANEJ instancji, per-referencja).
 *
 * Fejkowe `CliDeps`/`ResolvedHost` pisane ręcznie, NIGDY realny `AgentManager`/`AgentMemory` -
 * `@plugin/modules/agents/index.js` ciągnie transytywnie UI (profile_advanced.ts i inne) i
 * `AgentMemory`/`ConsolidationStatus`/`Agent` wchodzą tu WYŁĄCZNIE jako `import type`.
 */

interface FakePromptSection {
    key: string;
    label: string;
    tokens: number;
    enabled: boolean;
    required: boolean;
    category: string;
    content: string;
    editable: boolean;
}

interface FakePromptResult {
    sections: FakePromptSection[];
    breakdown: { total: number; sections: Array<{ key: string; label: string; tokens: number }> };
}

function fakeAgent(name: string): Agent {
    return { name } as unknown as Agent;
}

function fakeMemory(marker: string): AgentMemory {
    return { __fakeMarker: marker } as unknown as AgentMemory;
}

function markerOf(memory: AgentMemory): string {
    return (memory as unknown as { __fakeMarker: string }).__fakeMarker;
}

const FAKE_BRAIN_FILE = '.pkm-assistant/agents/jaskier/memory/brain.md';
const FAKE_BRAIN_DIR = '.pkm-assistant/agents/jaskier/memory/brain';

function fakeMemoryWithStat(
    stats: Array<{ mtime: number; size: number } | null>,
    dirs: boolean[] = [true, true],
): AgentMemory {
    let call = 0;
    return {
        paths: { brain: FAKE_BRAIN_FILE, brainNotes: FAKE_BRAIN_DIR },
        vault: {
            adapter: {
                stat: async (path: string) => {
                    const phase = Math.floor(call / 2);
                    call++;
                    if (path === FAKE_BRAIN_DIR) return dirs[Math.min(phase, dirs.length - 1)] ? { mtime: 1, size: 0 } : null;
                    return stats[Math.min(phase, stats.length - 1)];
                },
            },
        },
    } as unknown as AgentMemory;
}

function fakeMemoryWithThrowingStat(): AgentMemory {
    return {
        paths: { brain: FAKE_BRAIN_FILE, brainNotes: FAKE_BRAIN_DIR },
        vault: { adapter: { stat: async () => { throw new Error('stat padł'); } } },
    } as unknown as AgentMemory;
}

interface AgentManagerFixture {
    names: string[];
    active?: string | null;
    prompts?: Record<string, FakePromptResult>;
    memories?: Record<string, AgentMemory | null>;
}

function makeAgentManager(fixture: AgentManagerFixture): CliAgentManager {
    const emptyPrompt: FakePromptResult = { sections: [], breakdown: { total: 0, sections: [] } };
    return {
        getAllAgents: () => fixture.names.map(fakeAgent),
        getAgent: (name: string) => (fixture.names.includes(name) ? fakeAgent(name) : undefined),
        getActiveAgent: () => (fixture.active ? fakeAgent(fixture.active) : null),
        getAgentMemory: (name: string) => fixture.memories?.[name] ?? null,
        getPromptInspectorDataForAgent: async (name?: string) => fixture.prompts?.[name || ''] ?? emptyPrompt,
    };
}

function makeHost(overrides: Partial<ResolvedHost> = {}): ResolvedHost {
    return {
        raw: {},
        id: 'pkm-assistant',
        version: '2.2.8',
        isReady: true,
        agentManager: undefined,
        indexStatus: undefined,
        ...overrides,
    };
}

interface DepsFixture {
    /** Host stały, ALBO fabryka (dla testów `instanceSince`, gdzie host zmienia się MIĘDZY wywołaniami). */
    host?: ResolvedHost | null | (() => ResolvedHost | null);
    hostError?: Error;
    selfTestImpl?: (hostRaw: Record<string, unknown>) => Promise<object>;
    selfTestResult?: object;
    selfTestError?: Error;
    consolidationByMarker?: Record<string, ConsolidationStatus | Error>;
    companionVersion?: string;
    nowSequence?: Date[];
}

function makeDeps(fixture: DepsFixture = {}): CliDeps {
    // `const` local (nie `fixture.host` odczytywane wprost) - narrowing `typeof` na property
    // accessie NIE przeżywa domknięcia w gałęzi "else" (TS liczy tam z powrotem pełną unię).
    const hostField = fixture.host;
    const hostGetter: () => ResolvedHost | null = typeof hostField === 'function' ? hostField : () => hostField ?? null;
    let nowCallIndex = 0;
    return {
        companionId: 'pkm-assistant-dev',
        companionVersion: fixture.companionVersion ?? '0.1.0',
        resolveHost: () => {
            if (fixture.hostError) throw fixture.hostError;
            return hostGetter();
        },
        selfTest: fixture.selfTestImpl ?? (async () => {
            if (fixture.selfTestError) throw fixture.selfTestError;
            return fixture.selfTestResult ?? { ok: true };
        }),
        consolidationStatus: async (memory: AgentMemory) => {
            const marker = markerOf(memory);
            const result = fixture.consolidationByMarker?.[marker];
            if (result instanceof Error) throw result;
            if (!result) throw new Error(`no fixture for marker "${marker}"`);
            return result;
        },
        now: fixture.nowSequence
            ? () => fixture.nowSequence![Math.min(nowCallIndex++, fixture.nowSequence!.length - 1)]
            : () => new Date('2026-09-20T00:00:00.000Z'),
    };
}

function commandById(deps: CliDeps, id: string) {
    const found = buildCliCommands(deps).find(spec => spec.id === `pkm-assistant-dev:${id}`);
    if (!found) throw new Error(`command not found: ${id}`);
    return found;
}

async function run(deps: CliDeps, id: string, params: Record<string, string> = {}) {
    const spec = commandById(deps, id);
    const raw = await spec.run(params);
    return JSON.parse(raw);
}

function consolidationFixture(agent: string): ConsolidationStatus {
    return {
        agent,
        state: { source: 'file', lastArchiveAt: null },
        brainNotes: { count: 3, limit: 20, limitSource: 'default', overLimit: false },
        sessions: { archivedSinceLastConsolidation: 1, threshold: 10, overThreshold: false, uncoveredArchive: 1, activeFiles: 0, stateActive: 0 },
        summaries: { uncoveredL1: 0, uncoveredL2: 0, batchSize: 5 },
        wouldTrigger: false,
        plan: [],
    };
}

// ── status ──────────────────────────────────────────────────────────────────────────────

test('status: host nieobecny -> ready=false, agents=null, index=null, plugin=defaults, instanceSince=null', async t => {
    const deps = makeDeps({ host: null, companionVersion: '0.1.0' });
    const response = await run(deps, 'status');

    t.deepEqual(response, {
        ok: true,
        command: 'pkm-assistant-dev:status',
        verified: true,
        effect: 'unchanged',
        data: {
            plugin: { id: 'pkm-assistant', version: 'unknown', instanceSince: null },
            companion: { id: 'pkm-assistant-dev', version: '0.1.0' },
            ready: false,
            agents: null,
            index: null,
            commands: [
                'pkm-assistant-dev:status',
                'pkm-assistant-dev:selftest',
                'pkm-assistant-dev:agent-prompt',
                'pkm-assistant-dev:memory-status',
            ],
        },
    });
});

test('status: host obecny i gotowy -> agenci i indeks wypełnione, plugin.id/version z hosta', async t => {
    const am = makeAgentManager({ names: ['Jaskier', 'Atlas'], active: 'Jaskier' });
    const host = makeHost({
        id: 'pkm-assistant',
        version: '2.2.8',
        agentManager: am,
        indexStatus: { status: 'ready', progress: { indexed: 42, total: 42 }, modelKey: 'openai/text-embedding-3-small', lastError: null },
    });
    const deps = makeDeps({ host });
    const response = await run(deps, 'status');

    t.true(response.ok);
    t.is(response.data.plugin.id, 'pkm-assistant');
    t.is(response.data.plugin.version, '2.2.8');
    t.deepEqual(response.data.agents, { count: 2, active: 'Jaskier', names: ['Jaskier', 'Atlas'] });
    t.deepEqual(response.data.index, { status: 'ready', indexed: 42, total: 42, modelKey: 'openai/text-embedding-3-small', lastError: null });
    t.true(response.data.ready);
});

test('status: host obecny ale NIE gotowy (isReady:false) -> ready=false, ale agenci NADAL wypełnieni (agentManager niezależny od isReady)', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const host = makeHost({ isReady: false, agentManager: am });
    const deps = makeDeps({ host });
    const response = await run(deps, 'status');

    t.false(response.data.ready);
    t.deepEqual(response.data.agents, { count: 1, active: null, names: ['Jaskier'] });
});

test('status: lastError obiektem (nie stringiem) wychodzi jako String(...)', async t => {
    const host = makeHost({
        indexStatus: { status: 'error', progress: { indexed: 0, total: 0 }, modelKey: null, lastError: new Error('boom') } as CliIndexStatus,
    });
    const deps = makeDeps({ host });
    const response = await run(deps, 'status');

    t.is(response.data.index.lastError, 'Error: boom');
});

test('status: wyjątek rzucony przez resolveHost() -> internal, handler nie rzuca', async t => {
    const deps = makeDeps({ hostError: new Error('resolveHost padł') });
    const response = await run(deps, 'status');

    t.deepEqual(response, {
        ok: false,
        command: 'pkm-assistant-dev:status',
        verified: false,
        effect: 'unchanged',
        error: { code: 'internal', message: 'resolveHost padł' },
    });
});

// ── K2: tracker trzyma SŁABĄ referencję (WeakRef), nie twardą ─────────────────────────────

test('createInstanceTracker: nowa referencja hosta opakowana w (wstrzyknięty) WeakRef - tracker NIE trzyma jej wprost jako twardej referencji', t => {
    const created: unknown[] = [];
    class FakeWeakRef<T extends object> {
        private readonly target: T;
        constructor(target: T) {
            created.push(target);
            this.target = target;
        }
        deref(): T | undefined { return this.target; }
    }
    const hostA = { tag: 'A' };
    const hostB = { tag: 'B' };
    const track = createInstanceTracker(() => new Date('2026-09-20T00:00:00.000Z'), FakeWeakRef as unknown as typeof WeakRef);

    track(hostA);
    track(hostA); // ta sama referencja - NIE ma dostać drugiego opakowania
    track(hostB);

    t.deepEqual(created, [hostA, hostB], 'każda NOWA referencja hosta ma przejść przez (wstrzyknięty) WeakRef - dowód strukturalny, bez polegania na GC');
});

// ── P7: instanceSince - pamięć OSTATNIO WIDZIANEJ referencji hosta ────────────────────────

test('status: instanceSince - TA SAMA referencja hosta między wywołaniami nie dostaje nowego znacznika; NOWA referencja (reload hosta) dostaje', async t => {
    const hostRawA: Record<string, unknown> = { tag: 'A' };
    const hostRawB: Record<string, unknown> = { tag: 'B' };
    const am = makeAgentManager({ names: ['Jaskier'] });
    const d1 = new Date('2026-09-20T00:00:00.000Z');
    const d2 = new Date('2026-09-20T01:00:00.000Z');
    let currentRaw = hostRawA;

    const deps = makeDeps({
        host: () => makeHost({ raw: currentRaw, agentManager: am }),
        nowSequence: [d1, d2],
    });
    // buildCliCommands wołane RAZ - dokładnie jak w produkcji (registerCliCommands woła je
    // raz w onload()), żeby zamknięcie śledzące instancję przeżyło między wywołaniami.
    const commands = buildCliCommands(deps);
    const statusSpec = commands.find(c => c.id === 'pkm-assistant-dev:status');
    if (!statusSpec) throw new Error('status command not found');

    const r1 = JSON.parse(await statusSpec.run({}));
    const r2 = JSON.parse(await statusSpec.run({}));
    currentRaw = hostRawB;
    const r3 = JSON.parse(await statusSpec.run({}));

    t.is(r1.data.plugin.instanceSince, d1.toISOString());
    t.is(r2.data.plugin.instanceSince, d1.toISOString(), 'ta sama referencja hosta -> ten sam znacznik, mimo że now() dałby inną wartość');
    t.is(r3.data.plugin.instanceSince, d2.toISOString(), 'nowa referencja (np. po plugin:reload id=pkm-assistant) -> nowy znacznik');
});

test('status: instanceSince - hosta ZNIKA i WRACA (nowa referencja) -> null pomiędzy, nowy znacznik po powrocie', async t => {
    const hostRaw: Record<string, unknown> = {};
    const am = makeAgentManager({ names: ['Jaskier'] });
    const d1 = new Date('2026-09-20T00:00:00.000Z');
    const d2 = new Date('2026-09-20T02:00:00.000Z');
    let hostPresent = true;

    const deps = makeDeps({
        host: () => (hostPresent ? makeHost({ raw: hostRaw, agentManager: am }) : null),
        nowSequence: [d1, d2],
    });
    const commands = buildCliCommands(deps);
    const statusSpec = commands.find(c => c.id === 'pkm-assistant-dev:status');
    if (!statusSpec) throw new Error('status command not found');

    const r1 = JSON.parse(await statusSpec.run({}));
    hostPresent = false;
    const r2 = JSON.parse(await statusSpec.run({}));
    hostPresent = true;
    const r3 = JSON.parse(await statusSpec.run({}));

    t.is(r1.data.plugin.instanceSince, d1.toISOString());
    t.is(r2.data.plugin.instanceSince, null, 'hosta nie ma -> instanceSince null, nie stary znacznik');
    t.is(r3.data.plugin.instanceSince, d1.toISOString(), 'ta sama referencja obiektu wraca -> ten sam znacznik co za pierwszym razem (pamięć trwa mimo zniknięcia)');
});

// ── selftest ────────────────────────────────────────────────────────────────────────────

test('selftest: przekazuje raport z deps.selfTest(host.raw) bez zmian kształtu', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const hostRaw = { marker: 'HOST_RAW' };
    const host = makeHost({ agentManager: am, raw: hostRaw });
    const report = { passed: 12, failed: 0, findings: ['a', 'b'] };
    let received: unknown;
    const deps = makeDeps({ host, selfTestImpl: async raw => { received = raw; return report; } });

    const response = await run(deps, 'selftest');

    t.true(response.ok);
    t.deepEqual(response.data, report);
    t.is(received, hostRaw, 'selfTest dostaje DOKŁADNIE host.raw, nie kopię');
});

test('selftest: wyjatek z deps.selfTest() -> internal, handler nie rzuca', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const host = makeHost({ agentManager: am });
    const deps = makeDeps({ host, selfTestError: new Error('raport padl') });
    const response = await run(deps, 'selftest');

    t.deepEqual(response, {
        ok: false,
        command: 'pkm-assistant-dev:selftest',
        verified: false,
        effect: 'unknown',
        error: { code: 'internal', message: 'raport padl' },
    });
});

// ── agent-prompt ────────────────────────────────────────────────────────────────────────

const PROMPT_FIXTURE: FakePromptResult = {
    sections: [
        { key: 'identity', label: 'Identity', tokens: 120, enabled: true, required: true, category: 'core', content: 'You are Jaskier.', editable: false },
        { key: 'rules', label: 'Rules', tokens: 80, enabled: true, required: false, category: 'core', content: 'Follow these rules.', editable: true },
    ],
    breakdown: { total: 200, sections: [{ key: 'identity', label: 'Identity', tokens: 120 }, { key: 'rules', label: 'Rules', tokens: 80 }] },
};

test('agent-prompt: dokladne imie -> sekcje BEZ pola content/editable', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.deepEqual(response.data, {
        agent: 'Jaskier',
        totalTokens: 200,
        sections: [
            { key: 'identity', label: 'Identity', category: 'core', tokens: 120, enabled: true, required: true },
            { key: 'rules', label: 'Rules', category: 'core', tokens: 80, enabled: true, required: false },
        ],
    });
});

test('agent-prompt: imie inna wielkoscia liter, JEDNOZNACZNie -> rozwiazuje na kanoniczne imie', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'JASKIER' });

    t.true(response.ok);
    t.is(response.data.agent, 'Jaskier');
});

test('agent-prompt: nieznane imie -> agent_not_found z lista dostepnych imion', async t => {
    const am = makeAgentManager({ names: ['Jaskier', 'Atlas'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Nikt' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_not_found');
    t.true(response.error.message.includes('Jaskier'));
    t.true(response.error.message.includes('Atlas'));
});

test('agent-prompt: dwuznaczne dopasowanie bez wielkosci liter -> agent_ambiguous', async t => {
    const am = makeAgentManager({ names: ['Atlas', 'atlas'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'ATLAS' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_ambiguous');
    t.true(response.error.message.includes('Atlas'));
});

test('agent-prompt: section=<key> zwraca content TYLKO tej sekcji, obok pelnej listy sekcji', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: 'rules' });

    t.true(response.ok);
    t.deepEqual(response.data.section, { key: 'rules', label: 'Rules', tokens: 80, content: 'Follow these rules.' });
    t.is(response.data.sections.length, 2);
});

test('agent-prompt: nieznana sekcja -> section_not_found z lista dostepnych kluczy', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: 'nope' });

    t.false(response.ok);
    t.is(response.error.code, 'section_not_found');
    t.true(response.error.message.includes('identity'));
    t.true(response.error.message.includes('rules'));
});

// ── koperta agent-prompt - verified/effect ze stat brain.md przed/po ─────────────────────

test('agent-prompt: verified:true effect:unchanged, gdy stat brain.md IDENTYCZNY przed i po', async t => {
    const memory = fakeMemoryWithStat([{ mtime: 100, size: 10 }, { mtime: 100, size: 10 }]);
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE }, memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.true(response.ok);
    t.true(response.verified);
    t.is(response.effect, 'unchanged');
});

test('agent-prompt: verified:true effect:changed, gdy stat brain.md RÓŻNY przed i po (silnik dopisał/samonaprawił indeks)', async t => {
    const memory = fakeMemoryWithStat([{ mtime: 100, size: 10 }, { mtime: 200, size: 12 }]);
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE }, memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.true(response.ok);
    t.true(response.verified);
    t.is(response.effect, 'changed');
});

test('agent-prompt: verified:false effect:unknown, gdy stat brain.md rzuca (nie da się nawet spróbować)', async t => {
    const memory = fakeMemoryWithThrowingStat();
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE }, memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.true(response.ok);
    t.false(response.verified);
    t.is(response.effect, 'unknown');
});

test('agent-prompt: effect:changed, gdy brain.md IDENTYCZNY, ale silnik ZAŁOŻYŁ folder brain/ (listBrainNotes -> mkdir)', async t => {
    const memory = fakeMemoryWithStat([{ mtime: 100, size: 10 }, { mtime: 100, size: 10 }], [false, true]);
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE }, memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.true(response.ok);
    t.true(response.verified);
    t.is(response.effect, 'changed');
});

test('agent-prompt: section_not_found pada PO przejściu silnika - błąd niesie ZMIERZONY effect:changed, nie "unchanged" na wiarę', async t => {
    const memory = fakeMemoryWithStat([{ mtime: 100, size: 10 }, { mtime: 200, size: 12 }]);
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE }, memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: 'nie-ma-takiej' });

    t.false(response.ok);
    if (response.ok) return;
    t.is(response.error.code, 'section_not_found');
    t.true(response.verified);
    t.is(response.effect, 'changed');
});

test('internal: złapany wyjątek w komendzie wymagającej gotowości -> effect:unknown (nie wiadomo, gdzie padło), verified:false', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    am.getPromptInspectorDataForAgent = async () => { throw new Error('silnik padł w połowie'); };
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier' });

    t.false(response.ok);
    if (response.ok) return;
    t.is(response.error.code, 'internal');
    t.false(response.verified);
    t.is(response.effect, 'unknown');
});

// ── flagi agent/section/format - trim, wielkość liter, brak wartości ─────────────────────

test('agent: trim() - spacje wokół imienia nie przeszkadzają w dopasowaniu', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: '  Jaskier  ' });

    t.true(response.ok);
    t.is(response.data.agent, 'Jaskier');
});

test('memory-status: agent=all rozpoznawane bez względu na wielkość liter (ALL, All, otoczone spacjami)', async t => {
    const memory = fakeMemory('jaskier');
    const am = makeAgentManager({ names: ['Jaskier'], memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }), consolidationByMarker: { jaskier: consolidationFixture('Jaskier') } });

    for (const value of ['ALL', 'All', ' all ']) {
        const response = await run(deps, 'memory-status', { agent: value });
        t.true(response.ok, value);
        t.deepEqual(response.data.agents, [consolidationFixture('Jaskier')], value);
        t.deepEqual(response.data.errors, [], value);
    }
});

test('agent: brak flagi -> bad_flag, NIE agent_not_found (agent-prompt i memory-status)', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const id of ['agent-prompt', 'memory-status']) {
        const response = await run(deps, id, {});
        t.false(response.ok, id);
        t.is(response.error.code, 'bad_flag', id);
        t.true(response.error.message.includes('agent'), id);
    }
});

test('agent: pusty string po trim() -> bad_flag, NIE agent_not_found', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const id of ['agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: '   ' });
        t.false(response.ok, id);
        t.is(response.error.code, 'bad_flag', id);
    }
});

test('agent: literał "true" (flaga podana bez wartości) -> bad_flag, NIE agent_not_found', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const id of ['agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'true' });
        t.false(response.ok, id);
        t.is(response.error.code, 'bad_flag', id);
    }
});

test('format: bez wielkości liter i po trim() - "JSON"/" json " == "json"', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const value of ['JSON', ' json ', 'Json']) {
        const response = await run(deps, 'status', { format: value });
        t.true(response.ok, value);
    }
});

test('section: trim() - spacje wokół klucza nie przeszkadzają w dopasowaniu', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: '  rules  ' });

    t.true(response.ok);
    t.is(response.data.section.key, 'rules');
});

test('section: pusty string albo literał "true" -> bad_flag', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const value of ['', 'true']) {
        const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', section: value });
        t.false(response.ok, JSON.stringify(value));
        t.is(response.error.code, 'bad_flag', JSON.stringify(value));
    }
});

// ── memory-status ───────────────────────────────────────────────────────────────────────

test('memory-status: jeden agent -> agents=[status], errors=[]', async t => {
    const memory = fakeMemory('jaskier');
    const am = makeAgentManager({ names: ['Jaskier'], memories: { Jaskier: memory } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }), consolidationByMarker: { jaskier: consolidationFixture('Jaskier') } });
    const response = await run(deps, 'memory-status', { agent: 'Jaskier' });

    t.true(response.ok);
    t.deepEqual(response.data, { agents: [consolidationFixture('Jaskier')], errors: [] });
});

test('memory-status: all z jednym agentem rzucajacym -> reszta w agents, wtopa w errors', async t => {
    const jaskierMemory = fakeMemory('jaskier');
    const atlasMemory = fakeMemory('atlas');
    const am = makeAgentManager({
        names: ['Jaskier', 'Atlas'],
        memories: { Jaskier: jaskierMemory, Atlas: atlasMemory },
    });
    const deps = makeDeps({
        host: makeHost({ agentManager: am }),
        consolidationByMarker: {
            jaskier: consolidationFixture('Jaskier'),
            atlas: new Error('brain.md nie do odczytu'),
        },
    });
    const response = await run(deps, 'memory-status', { agent: 'all' });

    t.true(response.ok);
    t.deepEqual(response.data.agents, [consolidationFixture('Jaskier')]);
    t.deepEqual(response.data.errors, [{ agent: 'Atlas', message: 'brain.md nie do odczytu' }]);
});

test('memory-status: agent bez instancji pamieci (getAgentMemory -> null) -> wpis w errors', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], memories: { Jaskier: null } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'memory-status', { agent: 'Jaskier' });

    t.true(response.ok);
    t.deepEqual(response.data, { agents: [], errors: [{ agent: 'Jaskier', message: 'Agent has no memory instance yet.' }] });
});

test('memory-status: nieznane imie (nie "all") -> agent_not_found, nie wchodzi w petle', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'memory-status', { agent: 'Nikt' });

    t.false(response.ok);
    t.is(response.error.code, 'agent_not_found');
});

// ── wspolne zasady (format / not_ready / nieznane klucze / wyjatki) ────────────────────────

test('format=xml -> bad_flag (na kazdej z czterech komend)', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    for (const id of ['status', 'selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { format: 'xml', agent: 'Jaskier' });
        t.false(response.ok, `${id} powinno odmowic format=xml`);
        t.is(response.error.code, 'bad_flag', `${id}`);
    }
});

test('nieznany klucz w params jest ignorowany, nie wywala bad_flag', async t => {
    const am = makeAgentManager({ names: ['Jaskier'], prompts: { Jaskier: PROMPT_FIXTURE } });
    const deps = makeDeps({ host: makeHost({ agentManager: am }) });
    const response = await run(deps, 'agent-prompt', { agent: 'Jaskier', vault: 'MyVault' });

    t.true(response.ok);
});

test('not_ready dla trzech komend (nie status), gdy host obecny ale isReady()===false', async t => {
    const am = makeAgentManager({ names: ['Jaskier'] });
    const deps = makeDeps({ host: makeHost({ isReady: false, agentManager: am }) });
    for (const id of ['selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'Jaskier' });
        t.false(response.ok, id);
        t.is(response.error.code, 'not_ready', id);
    }
});

test('not_ready dla trzech komend, gdy brak agentManager (nawet jesli isReady()===true)', async t => {
    const deps = makeDeps({ host: makeHost({ isReady: true, agentManager: undefined }) });
    for (const id of ['selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'Jaskier' });
        t.false(response.ok, id);
        t.is(response.error.code, 'not_ready', id);
    }
});

test('not_ready dla trzech komend, gdy hosta W OGÓLE nie ma (resolveHost -> null)', async t => {
    const deps = makeDeps({ host: null });
    for (const id of ['selftest', 'agent-prompt', 'memory-status']) {
        const response = await run(deps, id, { agent: 'Jaskier' });
        t.false(response.ok, id);
        t.is(response.error.code, 'not_ready', id);
    }
});

test('status NIGDY nie oddaje not_ready, nawet bez hosta w ogóle', async t => {
    const deps = makeDeps({ host: null });
    const response = await run(deps, 'status');
    t.true(response.ok);
});

test('wyjątek rzucony przez resolveHost() w komendzie wymagającej gotowości (nie status) -> internal, handler nie rzuca', async t => {
    const deps = makeDeps({ hostError: new Error('resolveHost padł w środku runGuardedReady') });
    const response = await run(deps, 'selftest');

    t.deepEqual(response, {
        ok: false,
        command: 'pkm-assistant-dev:selftest',
        verified: false,
        effect: 'unknown',
        error: { code: 'internal', message: 'resolveHost padł w środku runGuardedReady' },
    });
});
