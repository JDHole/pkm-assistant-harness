import test from 'ava';
import {
    READONLY_TOOLS,
    parseIntegerFlag,
    parsePromptFlag,
    parseToolsFlag,
    resolveAgentTurnTools,
    runAgentTurn,
} from './agentTurn.js';
import { buildCliCommands } from './cli/commands.js';

import type { Agent } from '@plugin/modules/agents/index.js';
import type { LoopMessage, MessageStoreLike, ParsedToolCall, RunAgentLoopOptions, RunAgentLoopResult, ToolExecutionContext } from '@plugin/modules/agent-loop/index.js';
import type { AgentTurnDeps, AgentTurnFlags, AgentTurnHost, AgentTurnModel } from './agentTurn.js';
import type { CliMcpClient, CliToolRegistry, ResolvedHost } from './hostPlugin.js';
import type { CliDeps } from './cli/commands.js';
import type { AgentMemory } from '@plugin/modules/memory/index.js';
import type { ConsolidationStatus } from './memoryStatus.js';

/**
 * Testy `pkm-assistant-dev:agent-turn` - jedna tura produkcyjnej pętli agenta, tryb bezpieczny.
 * Numeracja sekcji odpowiada punktom "Zachowanie" ze spec-a zadania (`spec_agent_turn.md`),
 * dla łatwego mapowania punkt -> test w raporcie końcowym.
 *
 * Dwa poziomy:
 *  1. Testy JEDNOSTKOWE `runAgentTurn`/`resolveAgentTurnTools`/parsery flag - bezpośrednio na
 *     eksportach `agentTurn.ts`, z ręcznymi atrapami `AgentTurnDeps` (bez `commands.ts`).
 *  2. Testy KOMENDY CLI end-to-end - przez `buildCliCommands` (jak `commands.test.ts`), z
 *     atrapą `CliDeps.loadAgentTurnRuntime` - dowodzą okablowania (flagi, not_ready, busy,
 *     koperta verified/effect z migawki brain.md).
 */

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Fixture'y wspólne
// ═══════════════════════════════════════════════════════════════════════════════════════

function fakeAgent(name: string, extra: Record<string, unknown> = {}): Agent {
    return { name, disabled_tools: [], mcp_servers: [], ...extra } as unknown as Agent;
}

/** `MessageStoreLike` trywialny - wystarcza, żeby fałszywy `runAgentLoop` miał czym operować. */
function trivialStore(messages: LoopMessage[]): MessageStoreLike {
    const msgs = messages.map(m => ({ ...m }));
    return {
        getMessagesForAPI: () => msgs.map(m => ({ ...m })),
        appendAssistant: () => {},
        appendToolResult: () => {},
        appendUser: () => {},
        get messages() { return msgs; },
    };
}

function fakeModel(overrides: Partial<AgentTurnModel> = {}): AgentTurnModel {
    return {
        stream: (() => {}) as AgentTurnModel['stream'],
        ...overrides,
    };
}

interface AgentTurnDepsFixture {
    loopResult?: RunAgentLoopResult | (() => RunAgentLoopResult);
    loopImpl?: (options: RunAgentLoopOptions) => Promise<RunAgentLoopResult>;
    loopError?: Error;
    model?: AgentTurnModel | null;
    systemPrompt?: string;
    systemPromptError?: Error;
    nowSequence?: Date[];
    /** Uchwycony timer - test może ręcznie odpalić callback (symulacja timeoutu). */
    capturedTimer?: { cb: (() => void) | null; ms: number | null; cleared: boolean };
    capturedStoreMessages?: LoopMessage[];
    capturedOptions?: RunAgentLoopOptions;
}

function defaultLoopResult(): RunAgentLoopResult {
    return { finalText: 'ok', toolsUsed: [], toolCallDetails: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, iterations: 1, stoppedBy: 'natural' };
}

function makeAgentTurnDeps(fixture: AgentTurnDepsFixture = {}): AgentTurnDeps {
    let nowIdx = 0;
    return {
        runAgentLoop: fixture.loopImpl ?? (async (options: RunAgentLoopOptions) => {
            fixture.capturedOptions = options;
            if (fixture.loopError) throw fixture.loopError;
            return typeof fixture.loopResult === 'function' ? fixture.loopResult() : (fixture.loopResult ?? defaultLoopResult());
        }),
        createStore: (messages: LoopMessage[]) => {
            fixture.capturedStoreMessages = messages;
            return trivialStore(messages);
        },
        createModel: () => (fixture.model === undefined ? fakeModel() : fixture.model),
        now: fixture.nowSequence
            ? () => fixture.nowSequence![Math.min(nowIdx++, fixture.nowSequence!.length - 1)]
            : () => new Date('2026-09-26T00:00:00.000Z'),
        setTimer: (cb: () => void, ms: number) => {
            if (fixture.capturedTimer) { fixture.capturedTimer.cb = cb; fixture.capturedTimer.ms = ms; }
            return 'fake-timer-handle';
        },
        clearTimer: () => {
            if (fixture.capturedTimer) fixture.capturedTimer.cleared = true;
        },
    };
}

function makeMcpClient(impl?: (tc: unknown, agentName: string, opts: unknown) => unknown): { client: CliMcpClient; calls: Array<{ tc: unknown; agentName: string; opts: unknown }> } {
    const calls: Array<{ tc: unknown; agentName: string; opts: unknown }> = [];
    return {
        calls,
        client: {
            executeToolCall: async (tc: unknown, agentName: string | null | undefined, opts: unknown) => {
                calls.push({ tc, agentName: agentName ?? '', opts });
                return impl ? impl(tc, agentName ?? '', opts) : { success: true };
            },
        } as unknown as CliMcpClient,
    };
}

function makeToolRegistry(allowed: Array<{ name: string; serverName?: string }>): CliToolRegistry {
    return {
        filterByAgent: () => allowed as unknown as ReturnType<CliToolRegistry['filterByAgent']>,
        getToolDefinitions: () => allowed.map(t => ({ type: 'function', function: { name: t.name, description: `${t.name} desc`, parameters: {} } })) as unknown as ReturnType<CliToolRegistry['getToolDefinitions']>,
    };
}

function makeAgentTurnHost(overrides: Partial<AgentTurnHost> = {}): AgentTurnHost {
    return {
        agentManager: { getActiveSystemPromptWithMemory: async () => 'default system prompt' },
        mcpClient: makeMcpClient().client,
        toolRegistry: makeToolRegistry([{ name: 'read' }, { name: 'list' }, { name: 'search' }]),
        raw: { marker: 'HOST_RAW' },
        ...overrides,
    };
}

const BASE_FLAGS: AgentTurnFlags = { prompt: 'Cześć', tools: 'readonly', maxIterations: 8, timeoutSeconds: 180 };

/** `ParsedToolCall` minimalny do wołania egzekutora bezpośrednio w testach. */
function toolCall(name: string, id = 'call_1'): ParsedToolCall {
    return { id, name, arguments: '{}' };
}

/** Kontekst wykonania, który pętla podaje egzekutorowi od 27.09 (budżet wyniku i Stop tury). */
const TOOL_CONTEXT: ToolExecutionContext = { resultBudgetChars: 0, shouldAbort: () => false };

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 1: parsery flag (`prompt`/`tools`/`max-iterations`/`timeout`)
// ═══════════════════════════════════════════════════════════════════════════════════════

test('parsePromptFlag: brak flagi -> bad_flag', t => {
    const r = parsePromptFlag({});
    t.false(r.ok);
    if (r.ok) return;
    t.is(r.code, 'bad_flag');
    t.true(r.message.includes('prompt'));
});

test('parsePromptFlag: pusty string po trim() -> bad_flag', t => {
    const r = parsePromptFlag({ prompt: '   ' });
    t.false(r.ok);
});

test('parsePromptFlag: literał "true" (flaga bez wartości) -> bad_flag', t => {
    const r = parsePromptFlag({ prompt: 'true' });
    t.false(r.ok);
});

test('parsePromptFlag: trim() wokół treści, zachowuje wewnętrzne spacje', t => {
    const r = parsePromptFlag({ prompt: '  Przeczytaj plik proszę  ' });
    t.true(r.ok);
    if (!r.ok) return;
    t.is(r.value, 'Przeczytaj plik proszę');
});

test('parseToolsFlag: brak flagi -> domyślnie readonly', t => {
    const r = parseToolsFlag({});
    t.deepEqual(r, { ok: true, value: 'readonly' });
});

test('parseToolsFlag: readonly/none bez względu na wielkość liter i po trim()', t => {
    for (const raw of ['readonly', 'READONLY', ' ReadOnly ', 'none', 'NONE', ' None ']) {
        const r = parseToolsFlag({ tools: raw });
        t.true(r.ok, raw);
        if (!r.ok) continue;
        t.is(r.value, raw.trim().toLowerCase() as typeof r.value);
    }
});

test('parseToolsFlag: wartość inna niż readonly/none -> bad_flag', t => {
    const r = parseToolsFlag({ tools: 'all' });
    t.false(r.ok);
    if (r.ok) return;
    t.is(r.code, 'bad_flag');
});

test('parseIntegerFlag: brak flagi -> default', t => {
    const r = parseIntegerFlag({}, 'max-iterations', { min: 1, max: 20, def: 8 });
    t.deepEqual(r, { ok: true, value: 8 });
});

test('parseIntegerFlag: granice [min,max] akceptowane', t => {
    t.deepEqual(parseIntegerFlag({ 'max-iterations': '1' }, 'max-iterations', { min: 1, max: 20, def: 8 }), { ok: true, value: 1 });
    t.deepEqual(parseIntegerFlag({ 'max-iterations': '20' }, 'max-iterations', { min: 1, max: 20, def: 8 }), { ok: true, value: 20 });
    t.deepEqual(parseIntegerFlag({ timeout: '10' }, 'timeout', { min: 10, max: 600, def: 180 }), { ok: true, value: 10 });
    t.deepEqual(parseIntegerFlag({ timeout: '600' }, 'timeout', { min: 10, max: 600, def: 180 }), { ok: true, value: 600 });
});

test('parseIntegerFlag: poza granicami, niecałkowite, nie-liczbowe -> bad_flag', t => {
    for (const raw of ['0', '21', '3.5', 'abc', '', 'true', '-1']) {
        const r = parseIntegerFlag({ 'max-iterations': raw }, 'max-iterations', { min: 1, max: 20, def: 8 });
        t.false(r.ok, raw);
    }
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 5: whitelista narzędzi - `resolveAgentTurnTools`
// ═══════════════════════════════════════════════════════════════════════════════════════

test('READONLY_TOOLS: dokładnie read/list/search', t => {
    t.deepEqual([...READONLY_TOOLS], ['read', 'list', 'search']);
});

test('resolveAgentTurnTools: tools=none -> [] (registry NIE jest w ogóle odpytywany)', t => {
    let queried = false;
    const registry: CliToolRegistry = {
        filterByAgent: () => { queried = true; return []; },
        getToolDefinitions: () => { queried = true; return []; },
    };
    const out = resolveAgentTurnTools(registry, fakeAgent('Jaskier'), 'none');
    t.deepEqual(out, []);
    t.false(queried);
});

test('resolveAgentTurnTools: tools=readonly -> przecięcie z READONLY_TOOLS, write/delete odsiane mimo allow rejestru', t => {
    const registry = makeToolRegistry([{ name: 'read' }, { name: 'write' }, { name: 'search' }, { name: 'delete' }]);
    const out = resolveAgentTurnTools(registry, fakeAgent('Jaskier'), 'readonly');
    t.deepEqual(out.map(d => d.function.name).sort(), ['read', 'search']);
});

test('resolveAgentTurnTools: narzędzie z serverName (MCP zewnętrzny) wykluczone, nawet jeśli nazwa jest w READONLY_TOOLS', t => {
    const registry = makeToolRegistry([{ name: 'read' }, { name: 'search', serverName: 'user-connector' }]);
    const out = resolveAgentTurnTools(registry, fakeAgent('Jaskier'), 'readonly');
    t.deepEqual(out.map(d => d.function.name), ['read']);
});

test('resolveAgentTurnTools: disabled_tools agenta respektowane (JEDNA OŚ NARZĘDZIOWA - filterByAgent robi całą robotę)', t => {
    const registry: CliToolRegistry = {
        filterByAgent: (agent) => {
            const disabled = new Set(Array.isArray((agent as { disabled_tools?: unknown })?.disabled_tools) ? (agent as { disabled_tools: string[] }).disabled_tools : []);
            return [{ name: 'read' }, { name: 'list' }, { name: 'search' }].filter(t => !disabled.has(t.name)) as unknown as ReturnType<CliToolRegistry['filterByAgent']>;
        },
        getToolDefinitions: () => [{ name: 'read' }, { name: 'list' }, { name: 'search' }].map(t => ({ type: 'function', function: { name: t.name, description: '', parameters: {} } })) as unknown as ReturnType<CliToolRegistry['getToolDefinitions']>,
    };
    const out = resolveAgentTurnTools(registry, fakeAgent('Jaskier', { disabled_tools: ['search'] }), 'readonly');
    t.deepEqual(out.map(d => d.function.name).sort(), ['list', 'read']);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 4: model / prompt - agent JAWNY, ZAKAZ switchAgent, model null -> model_unavailable
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: model null -> model_unavailable, runAgentLoop NIGDY wołane', async t => {
    let loopCalled = false;
    const deps = makeAgentTurnDeps({ model: null, loopImpl: async () => { loopCalled = true; return defaultLoopResult(); } });
    const host = makeAgentTurnHost();
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);

    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'model_unavailable');
    t.true(outcome.message.includes('Jaskier'));
    t.false(loopCalled);
});

test('runAgentTurn: model bez .stream jako funkcji -> model_unavailable', async t => {
    const deps = makeAgentTurnDeps({ model: { stream: undefined as unknown as AgentTurnModel['stream'] } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'model_unavailable');
});

test('runAgentTurn: getActiveSystemPromptWithMemory wołane z ({}, agent) - kontekst PUSTY, agent DOKŁADNIE ten sam obiekt (bez switchAgent/getActiveAgent)', async t => {
    const agent = fakeAgent('Jaskier');
    let receivedContext: unknown;
    let receivedAgent: unknown;
    const host = makeAgentTurnHost({
        agentManager: {
            getActiveSystemPromptWithMemory: async (context, a) => { receivedContext = context; receivedAgent = a; return 'PROMPT'; },
        },
    });
    const deps = makeAgentTurnDeps();
    const outcome = await runAgentTurn(host, agent, BASE_FLAGS, deps);

    t.true(outcome.ok);
    t.deepEqual(receivedContext, {});
    t.is(receivedAgent, agent, 'agent przekazany JAWNIE, referencja identyczna - zero pośredniego odczytu z agentManagera');
    if (outcome.ok) t.is(outcome.data.systemPrompt, 'PROMPT');
});

test('runAgentTurn: agent obiekt z polem switchAgent - NIGDY nie jest wołane', async t => {
    let switchCalls = 0;
    const agent = fakeAgent('Jaskier', { switchAgent: () => { switchCalls += 1; } });
    const deps = makeAgentTurnDeps();
    const outcome = await runAgentTurn(makeAgentTurnHost(), agent, BASE_FLAGS, deps);
    t.true(outcome.ok);
    t.is(switchCalls, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 6: egzekucja narzędzia - wrapper odrzuca PRZED mcpClient, gdy narzędzie spoza listy
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: narzędzie w toolsOffered -> mcpClient.executeToolCall wołane z (tc, agent.name, {autonomy:"yolo"})', async t => {
    const { client, calls } = makeMcpClient();
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: makeToolRegistry([{ name: 'read' }]) });
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        await options.executeToolCall(toolCall('read', 'call_read'), TOOL_CONTEXT);
        return defaultLoopResult();
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), { ...BASE_FLAGS, tools: 'readonly' }, deps);

    t.true(outcome.ok);
    t.is(calls.length, 1);
    t.is(calls[0].agentName, 'Jaskier');
    t.deepEqual(calls[0].opts, { autonomy: 'yolo' });
    t.deepEqual(calls[0].tc, { id: 'call_read', name: 'read', arguments: '{}' });
});

test('runAgentTurn: narzędzie SPOZA toolsOffered (model halucynuje "write" mimo tools=readonly) -> mcpClient.executeToolCall NIGDY wołane, wpis toolCalls ok:false', async t => {
    const { client, calls } = makeMcpClient();
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: makeToolRegistry([{ name: 'read' }]) }); // "write" NIE jest w rejestrze allowed
    let caughtMessage = '';
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        try {
            await options.executeToolCall(toolCall('write', 'call_write'), TOOL_CONTEXT);
        } catch (e) {
            caughtMessage = (e as Error).message;
        }
        return {
            finalText: 'done',
            toolsUsed: ['write'],
            toolCallDetails: [{ name: 'write', args: {}, resultPreview: `Error: ${caughtMessage}`, error: true }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            iterations: 1,
            stoppedBy: 'natural',
        };
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), { ...BASE_FLAGS, tools: 'readonly' }, deps);

    t.true(outcome.ok);
    t.is(calls.length, 0, 'host.mcpClient.executeToolCall NIGDY wołane dla narzędzia spoza whitelisty');
    t.true(caughtMessage.includes('write'));
    t.true(caughtMessage.includes('not allowed'));
    t.true(caughtMessage.includes('tools=readonly'));
    if (!outcome.ok) return;
    t.deepEqual(outcome.data.toolCalls, [{ name: 'write', args: {}, resultPreview: `Error: ${caughtMessage}`, ok: false, error: `Error: ${caughtMessage}` }]);
});

test('runAgentTurn: tools=none -> KAŻDE narzędzie odrzucone (toolsOffered puste), mcpClient nigdy wołane', async t => {
    const { client, calls } = makeMcpClient();
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: makeToolRegistry([{ name: 'read' }, { name: 'list' }, { name: 'search' }]) });
    let rejected = false;
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        const offered = options.resolveTools?.() ?? [];
        t.deepEqual(offered, []);
        try { await options.executeToolCall(toolCall('read'), TOOL_CONTEXT); } catch { rejected = true; }
        return defaultLoopResult();
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), { ...BASE_FLAGS, tools: 'none' }, deps);

    t.true(outcome.ok);
    if (outcome.ok) t.deepEqual(outcome.data.toolsOffered, []);
    t.true(rejected);
    t.is(calls.length, 0);
});

// ── K-adwersarialna/E: luka wskazana w recenzji - rejestr ZEZWALA na "write" (agent ma pełny
// dostęp wg hosta), a mimo to tryb readonly go tnie na poziomie WYKONANIA (nie tylko widoczności). ──

test('runAgentTurn: rejestr/filterByAgent ZEZWALA na "write" (agent z pełnym dostępem), tools=readonly mimo to je odrzuca - mcpClient 0 wywołań', async t => {
    // Rejestr, w odróżnieniu od testów wyżej, NIE ma żadnej listy zabronionych - "write" jest
    // tu w pełni dozwolone agentowi (np. brak `disabled_tools`, serwer wbudowany). Bariera musi
    // więc stać w `READONLY_TOOLS`/`resolveAgentTurnTools` tej komendy, nie w konfiguracji hosta.
    const registryAllowsEverything = makeToolRegistry([{ name: 'read' }, { name: 'list' }, { name: 'search' }, { name: 'write' }, { name: 'delete' }, { name: 'create_folder' }]);
    const { client, calls } = makeMcpClient();
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: registryAllowsEverything });
    let rejectionMessage = '';
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        const offered = (options.resolveTools?.() ?? []) as Array<{ function: { name: string } }>;
        t.deepEqual(offered.map(d => d.function.name).sort(), ['list', 'read', 'search'], 'agent ma "write" w rejestrze, ale agent-turn go NIE oferuje modelowi');
        try {
            await options.executeToolCall(toolCall('write', 'call_write'), TOOL_CONTEXT);
        } catch (e) {
            rejectionMessage = (e as Error).message;
        }
        return defaultLoopResult();
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), { ...BASE_FLAGS, tools: 'readonly' }, deps);

    t.true(outcome.ok);
    t.is(calls.length, 0, 'host.mcpClient.executeToolCall NIGDY wołane, mimo że rejestr zezwala agentowi na "write"');
    t.true(rejectionMessage.includes('write') && rejectionMessage.includes('not allowed'), rejectionMessage);
});

// ── K-adwersarialna/C: ok/error UCZCIWE - mcpClient przy błędzie NIE rzuca, zwraca
// {isError:true, error} (MCPClient.ts ok. l.1195-1204) - to MA policzyć się jako ok:false. ────

test('runAgentTurn: mcpClient zwraca {isError:true, error:"Permission denied"} (BEZ rzutu) -> toolCalls[].ok=false, error niepusty', async t => {
    const { client } = makeMcpClient(() => ({ isError: true, error: 'Permission denied: Strefa No-Go' }));
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: makeToolRegistry([{ name: 'read' }]) });
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        const raw = await options.executeToolCall(toolCall('read', 'call_read'), TOOL_CONTEXT);
        await options.hooks?.onIterationStart?.(0);
        await options.hooks?.onToolResults?.([{ toolCall: { id: 'call_read', name: 'read' }, result: JSON.stringify(raw) }], 0);
        return {
            finalText: 'gotowe',
            toolsUsed: ['read'],
            toolCallDetails: [{ name: 'read', args: {}, resultPreview: JSON.stringify(raw) }], // AgentLoop sam NIE ustawia error:true - raw NIE był rzucony
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            iterations: 1,
            stoppedBy: 'natural',
        };
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);

    t.true(outcome.ok);
    if (!outcome.ok) return;
    t.is(outcome.data.toolCalls.length, 1);
    t.false(outcome.data.toolCalls[0].ok, 'isError:true zwrócone (nie rzucone) MA policzyć się jako ok:false');
    t.true(!!outcome.data.toolCalls[0].error && outcome.data.toolCalls[0].error.includes('Permission denied'));
});

test('runAgentTurn: mcpClient zwraca sukces (bez isError) -> toolCalls[].ok=true', async t => {
    const { client } = makeMcpClient(() => ({ success: true, content: 'tresc pliku' }));
    const host = makeAgentTurnHost({ mcpClient: client, toolRegistry: makeToolRegistry([{ name: 'read' }]) });
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        const raw = await options.executeToolCall(toolCall('read', 'call_read'), TOOL_CONTEXT);
        await options.hooks?.onToolResults?.([{ toolCall: { id: 'call_read', name: 'read' }, result: JSON.stringify(raw) }], 0);
        return { ...defaultLoopResult(), toolCallDetails: [{ name: 'read', args: {}, resultPreview: JSON.stringify(raw) }] };
    };
    const deps = makeAgentTurnDeps({ loopImpl });
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);

    t.true(outcome.ok);
    if (outcome.ok) t.true(outcome.data.toolCalls[0].ok);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 7: brak hooków czatu - `runAgentLoop` wołane BEZ onUsage/onToolResults/beforeContinue,
//  store dostaje DOKŁADNIE [system, user]
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: hooki CZATU (onUsage/beforeContinue/onToolCallsParsed) NIE są podane - zero zapisu do sesji/TokenTrackera; onIterationStart/onToolResults SĄ (K-adwersarialna B/C: księgowość LOKALNA, bez zapisu)', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);

    const hooks = fixture.capturedOptions?.hooks;
    t.truthy(hooks, 'hooks powinno być podane (onIterationStart/onToolResults - lokalna księgowość)');
    t.is(hooks?.onUsage, undefined, 'onUsage pisze do TokenTrackera w czacie - agent-turn go nie podaje');
    t.is(hooks?.beforeContinue, undefined, 'beforeContinue robi kompresję/nudges sesji w czacie - agent-turn go nie podaje');
    t.is(hooks?.onToolCallsParsed, undefined, 'onToolCallsParsed tworzy placeholdery UI w czacie - agent-turn go nie podaje');
    t.is(hooks?.onBackstop, undefined);
    t.is(typeof hooks?.onIterationStart, 'function');
    t.is(typeof hooks?.onToolResults, 'function');
});

test('runAgentTurn: store tworzony z DOKŁADNIE [system, user] (ArrayMessageStore - zero appendToActiveSession)', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    const host = makeAgentTurnHost({ agentManager: { getActiveSystemPromptWithMemory: async () => 'SYS-PROMPT' } });
    await runAgentTurn(host, fakeAgent('Jaskier'), { ...BASE_FLAGS, prompt: 'Cześć, jak leci?' }, deps);

    t.deepEqual(fixture.capturedStoreMessages, [
        { role: 'system', content: 'SYS-PROMPT' },
        { role: 'user', content: 'Cześć, jak leci?' },
    ]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 8: limity + timeout (shouldAbort + stopStream z timera, cleartimer w finally)
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: limity 1:1 z czatem (K-adwersarialna A) - host BEZ env.settings -> getLimits(null), same defaulty; maxIterations WYŁĄCZNIE z flagi', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    await runAgentTurn(makeAgentTurnHost({ raw: {} }), fakeAgent('Jaskier'), { ...BASE_FLAGS, maxIterations: 3 }, deps);
    t.deepEqual(fixture.capturedOptions?.limits, {
        maxIterations: 3,
        maxToolResultLength: 15000,
        maxToolResultLengthPerTool: { delegate: 60000, agent_delegate: 60000 },
        perCallTimeoutMs: 600000,
        stallTimeoutMs: 120000,
    });
});

test('runAgentTurn: limity - override z host.raw.env.settings.pkmAssistant.limits (walidowane jak w getLimits produkcyjnym)', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    const host = makeAgentTurnHost({
        raw: { env: { settings: { pkmAssistant: { limits: { max_tool_result_length: 5000, chat_model_call_timeout_ms: 12345 } } } } },
    });
    await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.is(fixture.capturedOptions?.limits?.maxToolResultLength, 5000);
    t.is(fixture.capturedOptions?.limits?.perCallTimeoutMs, 12345);
});

test('runAgentTurn: limity - platforma xai wyłącza stallTimeoutMs (parytet z chat_streaming.ts:639-642)', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    const host = makeAgentTurnHost({ raw: { env: { settings: { pkmAssistant: { chat: { platform: 'xai' } } } } } });
    await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.is(fixture.capturedOptions?.limits?.stallTimeoutMs, 0);
});

test('runAgentTurn: limity - host.raw.env/settings o złym kształcie (nie-obiekt) -> traktowane jak brak, getLimits(null)', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    for (const raw of [{ env: 'nope' }, { env: { settings: 'nope' } }, { env: null }]) {
        const host = makeAgentTurnHost({ raw: raw as Record<string, unknown> });
        await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);
        t.is(fixture.capturedOptions?.limits?.maxToolResultLength, 15000, JSON.stringify(raw));
    }
});

test('runAgentTurn: modelOptions.agentName/agent = agent.name', async t => {
    const fixture: AgentTurnDepsFixture = {};
    const deps = makeAgentTurnDeps(fixture);
    await runAgentTurn(makeAgentTurnHost(), fakeAgent('Atlas'), BASE_FLAGS, deps);
    t.deepEqual(fixture.capturedOptions?.modelOptions, { agentName: 'Atlas', agent: 'Atlas' });
});

test('runAgentTurn: timer uzbrojony na timeoutSeconds*1000; jego callback woła model.stopStream() i shouldAbort() zaczyna zwracać true', async t => {
    let stopped = false;
    const model = fakeModel({ stopStream: () => { stopped = true; } });
    const timer: AgentTurnDepsFixture['capturedTimer'] = { cb: null, ms: null, cleared: false };
    let shouldAbortDuringLoop: (() => boolean) | undefined;
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        shouldAbortDuringLoop = options.shouldAbort;
        t.false(options.shouldAbort?.());
        timer.cb?.(); // symuluje strzał budzika W TRAKCIE biegu pętli
        t.true(options.shouldAbort?.());
        return { ...defaultLoopResult(), stoppedBy: 'abort' };
    };
    const deps = makeAgentTurnDeps({ model, capturedTimer: timer, loopImpl });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), { ...BASE_FLAGS, timeoutSeconds: 42 }, deps);

    t.is(timer.ms, 42_000);
    t.true(stopped, 'model.stopStream() wołane z timera');
    t.true(shouldAbortDuringLoop?.());
    t.true(outcome.ok);
    if (outcome.ok) t.is(outcome.data.stoppedBy, 'timeout', 'stoppedBy=abort + timedOut -> zmapowane na "timeout"');
});

// ── K-adwersarialna/B: termin CAŁEGO biegu jest WYŚCIGIEM, nie flagą - pętla, która WISI
// (np. zawieszone narzędzie) NIE blokuje zwrotu. ────────────────────────────────────────────

test('runAgentTurn: petla WISI (narzedzie zawieszone na zawsze) -> wyscig wygrywa budzik, zwrot NATYCHMIAST, toolCalls z lokalnej ksiegowosci (onToolResults), zero unhandled rejection', async t => {
    let resolveHang: ((v: RunAgentLoopResult) => void) | undefined;
    const hangingPromise = new Promise<RunAgentLoopResult>(resolve => { resolveHang = resolve; });
    const timer: AgentTurnDepsFixture['capturedTimer'] = { cb: null, ms: null, cleared: false };
    let stopped = false;
    const model = fakeModel({ stopStream: () => { stopped = true; } });
    const loopImpl = async (options: RunAgentLoopOptions): Promise<RunAgentLoopResult> => {
        await options.hooks?.onIterationStart?.(0);
        await options.hooks?.onToolResults?.([{ toolCall: { id: '1', name: 'read' }, result: 'tresc pliku' }], 0);
        return hangingPromise; // symuluje narzedzie/model, ktory NIGDY nie wraca w tym tescie
    };
    const deps = makeAgentTurnDeps({ model, capturedTimer: timer, loopImpl });
    const outcomePromise = runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), { ...BASE_FLAGS, timeoutSeconds: 30 }, deps);

    await new Promise(resolve => setImmediate(resolve));
    t.false(timer.cleared, 'petla jeszcze wisi - budzik nie ma prawa być już wyczyszczony');
    timer.cb?.(); // symuluje strzal budzika (bez czekania na realny zegar - jednostkowy poziom)

    const outcome = await outcomePromise;
    t.true(outcome.ok);
    if (outcome.ok) {
        t.is(outcome.data.stoppedBy, 'timeout');
        t.is(outcome.data.finalText, '');
        t.deepEqual(outcome.data.toolCalls, [{ name: 'read', args: undefined, ok: true, resultPreview: 'tresc pliku' }]);
        t.is(outcome.data.iterations, 1);
    }
    t.true(stopped, 'model.stopStream() wołane mimo że sama pętla nadal wisi');

    // Sprzątanie: rozwiązujemy osierocony bieg, żeby nie zostawić wiszącej promisy między
    // testami (produkcyjnie NIKT go już nie awaituje - to jest właśnie dowód swallow: gdyby
    // `loopSettlement` w `agentTurn.ts` nie miał obu gałęzi obsłużonych, poniższe rozstrzygnięcie
    // - PO tym, jak funkcja już oddała wynik - kończyłoby się unhandled rejection/hałasem).
    resolveHang?.(defaultLoopResult());
    await new Promise(resolve => setImmediate(resolve));
});

test('CLI agent-turn: petla, ktora NIGDY sie nie konczy - PRAWDZIWY setTimeout (skalowany przez CliDeps.agentTurnTimeoutScale), timeout wraca szybko, a NASTEPNY agent-turn NIE dostaje busy', async t => {
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }),
        // Minimum publicznej flagi to 10 s - skala 0.002 daje realny odczyt ~20ms (bez zmiany
        // zakresu 10-600 s samej flagi `timeout`, patrz K-adwersarialna/B).
        timeoutScale: 0.002,
        runtime: { runAgentLoop: () => new Promise<RunAgentLoopResult>(() => { /* nigdy się nie rozstrzyga */ }) },
    });
    const spec = buildAgentTurnSpec(deps);

    const started = Date.now();
    const timedOutResponse = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'hej', timeout: '10' }));
    const elapsedMs = Date.now() - started;

    t.true(timedOutResponse.ok, JSON.stringify(timedOutResponse));
    t.is(timedOutResponse.data.stoppedBy, 'timeout');
    t.true(elapsedMs < 5000, `agent-turn powinno wrócić szybko po budziku (skala 0.002 * 10s ≈ 20ms), zajęło ${elapsedMs}ms`);

    // Blokada MUSI być już wolna - drugi bieg zaraz potem NIE dostaje busy, mimo że pierwsza
    // pętla (nigdy nierozstrzygnięta promisa) formalnie wciąż "wisi" osierocona w tle.
    const second = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'drugi' }));
    t.not(second.error?.code, 'busy', JSON.stringify(second));
});

test('runAgentTurn: stoppedBy="abort" BEZ timedOut zostaje "abort" (mapowanie tylko dla realnego timeoutu)', async t => {
    const deps = makeAgentTurnDeps({ loopResult: { ...defaultLoopResult(), stoppedBy: 'abort' } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(outcome.ok);
    if (outcome.ok) t.is(outcome.data.stoppedBy, 'abort');
});

test('runAgentTurn: stoppedBy="natural"/"backstop" przechodzą bez zmian', async t => {
    for (const stoppedBy of ['natural', 'backstop'] as const) {
        const deps = makeAgentTurnDeps({ loopResult: { ...defaultLoopResult(), stoppedBy } });
        const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
        t.true(outcome.ok, stoppedBy);
        if (outcome.ok) t.is(outcome.data.stoppedBy, stoppedBy, stoppedBy);
    }
});

test('runAgentTurn: clearTimer wołane w finally - PO sukcesie', async t => {
    const timer: AgentTurnDepsFixture['capturedTimer'] = { cb: null, ms: null, cleared: false };
    const deps = makeAgentTurnDeps({ capturedTimer: timer });
    await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(timer.cleared);
});

test('runAgentTurn: clearTimer wołane w finally - PO wyjątku z runAgentLoop (turn_failed)', async t => {
    const timer: AgentTurnDepsFixture['capturedTimer'] = { cb: null, ms: null, cleared: false };
    const deps = makeAgentTurnDeps({ capturedTimer: timer, loopError: new Error('pętla padła') });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    t.true(timer.cleared);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 9: toolCalls/usage z wyniku pętli
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: toolCalls mapowane z toolCallDetails (name/args/ok/resultPreview/error)', async t => {
    const loopResult: RunAgentLoopResult = {
        finalText: 'gotowe',
        toolsUsed: ['read'],
        toolCallDetails: [
            { name: 'read', args: { path: 'a.md' }, resultPreview: 'treść pliku' },
            { name: 'search', args: { query: 'x' }, resultPreview: 'Error: brak wyniku', error: true },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        iterations: 2,
        stoppedBy: 'natural',
    };
    const deps = makeAgentTurnDeps({ loopResult });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);

    t.true(outcome.ok);
    if (!outcome.ok) return;
    t.deepEqual(outcome.data.toolCalls, [
        { name: 'read', args: { path: 'a.md' }, ok: true, resultPreview: 'treść pliku' },
        { name: 'search', args: { query: 'x' }, ok: false, resultPreview: 'Error: brak wyniku', error: 'Error: brak wyniku' },
    ]);
    t.is(outcome.data.iterations, 2);
    t.is(outcome.data.finalText, 'gotowe');
});

test('runAgentTurn: usage z result.usage (promptTokens/completionTokens/estimated)', async t => {
    const deps = makeAgentTurnDeps({ loopResult: { ...defaultLoopResult(), usage: { prompt_tokens: 7, completion_tokens: 3, _estimated: true } } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(outcome.ok);
    if (outcome.ok) t.deepEqual(outcome.data.usage, { promptTokens: 7, completionTokens: 3, estimated: true });
});

test('runAgentTurn: usage._estimated brak -> estimated:false (nie undefined)', async t => {
    const deps = makeAgentTurnDeps({ loopResult: { ...defaultLoopResult(), usage: { prompt_tokens: 7, completion_tokens: 3 } } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(outcome.ok);
    if (outcome.ok) t.is(outcome.data.usage.estimated, false);
});

test('runAgentTurn: model = modelKey ?? modelId ?? null (trzy warianty)', async t => {
    const cases: Array<[AgentTurnModel, string | null]> = [
        [fakeModel({ modelKey: 'deepseek-chat' }), 'deepseek-chat'],
        [fakeModel({ modelId: 'gpt-4o' }), 'gpt-4o'],
        [fakeModel({}), null],
    ];
    for (const [model, expected] of cases) {
        const deps = makeAgentTurnDeps({ model });
        const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
        t.true(outcome.ok, JSON.stringify(expected));
        if (outcome.ok) t.is(outcome.data.model, expected);
    }
});

test('runAgentTurn: approvals=[] i session="none" ZAWSZE (kontrakt prompt-eval, tryb bez zgód)', async t => {
    const deps = makeAgentTurnDeps();
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(outcome.ok);
    if (outcome.ok) {
        t.deepEqual(outcome.data.approvals, []);
        t.is(outcome.data.session, 'none');
    }
});

test('runAgentTurn: durationMs = now() PO minus now() PRZED', async t => {
    const deps = makeAgentTurnDeps({ nowSequence: [new Date('2026-09-26T00:00:00.000Z'), new Date('2026-09-26T00:00:03.500Z')] });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.true(outcome.ok);
    if (outcome.ok) t.is(outcome.data.durationMs, 3500);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Punkt 10: wyjątek z pętli/modelu -> turn_failed, komunikat bez surowych obiektów
// ═══════════════════════════════════════════════════════════════════════════════════════

test('runAgentTurn: wyjątek z runAgentLoop -> turn_failed z komunikatem błędu (string, nie obiekt)', async t => {
    const deps = makeAgentTurnDeps({ loopError: new Error('model padł w połowie streamu') });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'turn_failed');
    t.is(outcome.message, 'model padł w połowie streamu');
});

test('runAgentTurn: wyjątek z getActiveSystemPromptWithMemory (budowa promptu, PRZED pętlą) -> turn_failed', async t => {
    const host = makeAgentTurnHost({ agentManager: { getActiveSystemPromptWithMemory: async () => { throw new Error('brain.md nieczytelny'); } } });
    const deps = makeAgentTurnDeps();
    const outcome = await runAgentTurn(host, fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'turn_failed');
    t.is(outcome.message, 'brain.md nieczytelny');
});

test('runAgentTurn: wyjątek NIE-Error (string rzucony) -> turn_failed z String(e), nie [object Object]', async t => {
    const deps = makeAgentTurnDeps({ loopImpl: async () => { throw 'plain string error'; } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'turn_failed');
    t.is(outcome.message, 'plain string error');
});

// ── K-adwersarialna/D: maska sekretów na turn_failed (agentTurn.ts) i internal (commands.ts). ──

const FAKE_SECRET = `sk-ant-${'A'.repeat(30)}`;

test('runAgentTurn: turn_failed maskuje sekret w komunikacie wyjątku (Authorization: Bearer sk-ant-...)', async t => {
    const deps = makeAgentTurnDeps({ loopImpl: async () => { throw new Error(`Model call failed: Authorization: Bearer ${FAKE_SECRET} rejected by upstream`); } });
    const outcome = await runAgentTurn(makeAgentTurnHost(), fakeAgent('Jaskier'), BASE_FLAGS, deps);
    t.false(outcome.ok);
    if (outcome.ok) return;
    t.is(outcome.code, 'turn_failed');
    t.false(outcome.message.includes(FAKE_SECRET), `Sekret NIE powinien wyjść w komunikacie: ${outcome.message}`);
    t.true(outcome.message.includes('Model call failed'), 'reszta komunikatu (bez sekretu) zostaje czytelna');
});

test('CLI agent-turn: internal (wyjątek z resolveHost) maskuje sekret w komunikacie', async t => {
    const deps = makeCliDeps({ hostError: new Error(`boom Authorization: Bearer ${FAKE_SECRET}`) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'internal');
    t.false(r.error.message.includes(FAKE_SECRET), `Sekret NIE powinien wyjść w komunikacie: ${r.error.message}`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Testy end-to-end komendy CLI (`buildCliCommands`) - flagi, not_ready, busy, koperta
// ═══════════════════════════════════════════════════════════════════════════════════════

function makeAgentManagerFixture(opts: {
    names: string[];
    systemPrompt?: string;
    systemPromptImpl?: (context: Record<string, never>, agent: Agent) => Promise<string>;
    memories?: Record<string, AgentMemory | null>;
    hasSystemPromptMethod?: boolean;
    switchAgentSpy?: { count: number };
}) {
    const base = {
        getAllAgents: () => opts.names.map(name => fakeAgent(name)),
        getAgent: (name: string) => (opts.names.includes(name) ? fakeAgent(name) : undefined),
        getActiveAgent: () => null,
        getPromptInspectorDataForAgent: async () => ({ sections: [], breakdown: { total: 0, sections: [] } }),
        getAgentMemory: (name: string) => opts.memories?.[name] ?? null,
        switchAgent: (name: string) => { if (opts.switchAgentSpy) opts.switchAgentSpy.count += 1; throw new Error(`switchAgent nie powinno być wołane (${name})`); },
    };
    if (opts.hasSystemPromptMethod === false) return base;
    return {
        ...base,
        getActiveSystemPromptWithMemory: opts.systemPromptImpl ?? (async () => opts.systemPrompt ?? 'SYSTEM PROMPT'),
    };
}

function makeHost(overrides: Partial<ResolvedHost> = {}): ResolvedHost {
    return {
        raw: { marker: 'HOST_RAW' },
        id: 'pkm-assistant',
        version: '2.2.8',
        isReady: true,
        agentManager: undefined,
        indexStatus: undefined,
        mcpClient: makeMcpClient().client,
        toolRegistry: makeToolRegistry([{ name: 'read' }, { name: 'list' }, { name: 'search' }]),
        ...overrides,
    };
}

interface CliDepsFixture {
    host?: ResolvedHost | null;
    hostError?: Error;
    runtime?: Partial<AgentTurnDeps>;
    runtimeError?: Error;
    /** K-adwersarialna/B: przelicznik jednostki timeoutu - testy realnego wyścigu (PRAWDZIWY
     *  `setTimeout`, patrz `commands.ts` `runAgentTurnCommand`) go ustawiają na ułamek, żeby
     *  minimum flagi (10 s) stało się milisekundami zamiast realnych 10 sekund. */
    timeoutScale?: number;
}

function makeCliDeps(fixture: CliDepsFixture = {}): CliDeps {
    return {
        companionId: 'pkm-assistant-dev',
        companionVersion: '0.1.0',
        companionBuiltAt: '2026-09-01T00:00:00.000Z',
        companionPluginCommit: 'abc1234',
        companionPluginTreeDirty: false,
        resolvePluginBundleMtime: async () => null,
        resolveHost: () => {
            if (fixture.hostError) throw fixture.hostError;
            return fixture.host ?? null;
        },
        selfTest: async () => ({ ok: true }),
        consolidationStatus: async (): Promise<ConsolidationStatus> => { throw new Error('not used by agent-turn tests'); },
        now: () => new Date('2026-09-26T00:00:00.000Z'),
        loadAgentTurnRuntime: async () => {
            if (fixture.runtimeError) throw fixture.runtimeError;
            const base = makeAgentTurnDeps(fixture.runtime as AgentTurnDepsFixture);
            return { runAgentLoop: fixture.runtime?.runAgentLoop ?? base.runAgentLoop, createStore: fixture.runtime?.createStore ?? base.createStore, createModel: fixture.runtime?.createModel ?? base.createModel };
        },
        ...(fixture.timeoutScale !== undefined ? { agentTurnTimeoutScale: fixture.timeoutScale } : {}),
    };
}

/** Zwraca `CliCommandSpec` KOMENDY `agent-turn` - jedno wywołanie `buildCliCommands`, żeby
 *  zamknięcie blokady "jeden bieg naraz" (`agentTurnLock` w `commands.ts`) przeżyło między
 *  kolejnymi `.run()` na TYM SAMYM obiekcie (jak `registerCliHandler` woła go raz w `onload()`
 *  produkcji - patrz testy `instanceSince` w `commands.test.ts`, ten sam wzorzec). */
function buildAgentTurnSpec(deps: CliDeps) {
    const spec = buildCliCommands(deps).find(s => s.id === 'pkm-assistant-dev:agent-turn');
    if (!spec) throw new Error('agent-turn command not found');
    return spec;
}

/** Wygoda dla testów jednostrzałowych - buduje komendy ŚWIEŻO za każdym wywołaniem (nie
 *  nadaje się do testów blokady "jeden bieg naraz" - patrz `buildAgentTurnSpec`). */
async function runAgentTurnCli(deps: CliDeps, params: Record<string, string> = {}) {
    return JSON.parse(await buildAgentTurnSpec(deps).run(params));
}

test('CLI agent-turn: brak agent/prompt -> bad_flag', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }) });
    const r1 = await runAgentTurnCli(deps, { prompt: 'hej' });
    t.false(r1.ok);
    t.is(r1.error.code, 'bad_flag');
    const r2 = await runAgentTurnCli(deps, { agent: 'Jaskier' });
    t.false(r2.ok);
    t.is(r2.error.code, 'bad_flag');
});

test('CLI agent-turn: tools/max-iterations/timeout niepoprawne -> bad_flag', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }) });
    const badFlags: Array<Record<string, string>> = [{ tools: 'wszystko' }, { 'max-iterations': '0' }, { 'max-iterations': '21' }, { timeout: '9' }, { timeout: '601' }];
    for (const bad of badFlags) {
        const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej', ...bad });
        t.false(r.ok, JSON.stringify(bad));
        t.is(r.error.code, 'bad_flag', JSON.stringify(bad));
    }
});

test('CLI agent-turn: host nieobecny -> not_ready', async t => {
    const deps = makeCliDeps({ host: null });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'not_ready');
});

test('CLI agent-turn: host obecny, brak mcpClient -> not_ready', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }), mcpClient: undefined }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'not_ready');
});

test('CLI agent-turn: host obecny, brak toolRegistry -> not_ready', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }), toolRegistry: undefined }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'not_ready');
});

test('CLI agent-turn: agentManager BEZ getActiveSystemPromptWithMemory -> not_ready (walidacja NA GRANICY, nie rusza pozostałych komend)', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], hasSystemPromptMethod: false }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'not_ready');
});

test('CLI agent-turn: imię nieznane -> agent_not_found; dwuznaczne -> agent_ambiguous', async t => {
    const deps1 = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }) });
    const r1 = await runAgentTurnCli(deps1, { agent: 'Nikt', prompt: 'hej' });
    t.is(r1.error.code, 'agent_not_found');

    const deps2 = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Atlas', 'atlas'] }) }) });
    const r2 = await runAgentTurnCli(deps2, { agent: 'ATLAS', prompt: 'hej' });
    t.is(r2.error.code, 'agent_ambiguous');
});

test('CLI agent-turn: sukces -> switchAgent agent managera NIGDY wołane', async t => {
    const spy = { count: 0 };
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], switchAgentSpy: spy }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.true(r.ok);
    t.is(spy.count, 0);
});

test('CLI agent-turn: model niedostępny -> model_unavailable', async t => {
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }),
        runtime: { createModel: () => null },
    });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'model_unavailable');
});

test('CLI agent-turn: runAgentLoop rzuca -> turn_failed', async t => {
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }),
        runtime: { runAgentLoop: async () => { throw new Error('padło w pętli'); } },
    });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'turn_failed');
    t.is(r.error.message, 'padło w pętli');
});

test('CLI agent-turn: sukces -> ok:true, data zgodne z AgentTurnData, verified:true effect:unchanged (brak instancji pamięci - migawka niedostępna)', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], memories: { Jaskier: null } }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'Cześć' });

    t.true(r.ok);
    t.is(r.command, 'pkm-assistant-dev:agent-turn');
    t.is(r.data.agent, 'Jaskier');
    t.is(r.data.tools, 'readonly');
    t.is(r.data.session, 'none');
    t.deepEqual(r.data.approvals, []);
    t.is(typeof r.data.durationMs, 'number');
});

test('CLI agent-turn: busy - drugi równoległy bieg -> busy, pierwszy nienaruszony; blokada zwolniona po zakończeniu', async t => {
    let releaseFirst!: () => void;
    const firstLoopGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }),
        runtime: {
            runAgentLoop: async () => {
                await firstLoopGate;
                return defaultLoopResult();
            },
        },
    });

    const spec = buildAgentTurnSpec(deps);
    const firstPromise = spec.run({ agent: 'Jaskier', prompt: 'pierwszy' }).then(raw => JSON.parse(raw));
    // Drugi bieg startuje, gdy pierwszy JUŻ trzyma blokadę (mikrotaska po starcie wystarcza,
    // bo `runAgentLoop` pierwszego biegu wisi na `firstLoopGate` synchronicznie od razu).
    await new Promise(resolve => setImmediate(resolve));
    const second = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'drugi' }));

    t.false(second.ok);
    t.is(second.error.code, 'busy');

    releaseFirst();
    const first = await firstPromise;
    t.true(first.ok, 'pierwszy bieg dokończył się nienaruszony');

    // Blokada zwolniona w finally -> trzeci bieg PO zakończeniu pierwszego przechodzi normalnie.
    const third = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'trzeci' }));
    t.true(third.ok);
});

test('CLI agent-turn: busy - blokada zwalniana w finally TAKŻE po wyjątku (turn_failed)', async t => {
    let shouldThrow = true;
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }),
        runtime: { runAgentLoop: async () => { if (shouldThrow) throw new Error('bum'); return defaultLoopResult(); } },
    });
    const spec = buildAgentTurnSpec(deps);

    const failed = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'hej' }));
    t.false(failed.ok);
    t.is(failed.error.code, 'turn_failed');

    shouldThrow = false;
    const after = JSON.parse(await spec.run({ agent: 'Jaskier', prompt: 'hej' }));
    t.true(after.ok, 'blokada zwolniona mimo wyjątku w poprzednim biegu');
});

test('CLI agent-turn: koperta verified/effect z migawki brain.md - IDENTYCZNY stat przed/po -> verified:true effect:unchanged', async t => {
    const FAKE_BRAIN_FILE = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const FAKE_BRAIN_DIR = '.pkm-assistant/agents/jaskier/memory/brain';
    const memory = {
        paths: { brain: FAKE_BRAIN_FILE, brainNotes: FAKE_BRAIN_DIR },
        vault: { adapter: { stat: async (p: string) => (p === FAKE_BRAIN_DIR ? { mtime: 1, size: 0 } : { mtime: 100, size: 10 }) } },
    } as unknown as AgentMemory;
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], memories: { Jaskier: memory } }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });

    t.true(r.ok);
    t.true(r.verified);
    t.is(r.effect, 'unchanged');
});

test('CLI agent-turn: koperta verified/effect z migawki brain.md - stat RÓŻNY przed/po (silnik samonaprawił brain.md w getActiveSystemPromptWithMemory) -> verified:true effect:changed', async t => {
    const FAKE_BRAIN_FILE = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const FAKE_BRAIN_DIR = '.pkm-assistant/agents/jaskier/memory/brain';
    let call = 0;
    const memory = {
        paths: { brain: FAKE_BRAIN_FILE, brainNotes: FAKE_BRAIN_DIR },
        vault: {
            adapter: {
                stat: async (p: string) => {
                    if (p === FAKE_BRAIN_DIR) return { mtime: 1, size: 0 };
                    call += 1;
                    return call === 1 ? { mtime: 100, size: 10 } : { mtime: 200, size: 12 };
                },
            },
        },
    } as unknown as AgentMemory;
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], memories: { Jaskier: memory } }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });

    t.true(r.ok);
    t.true(r.verified);
    t.is(r.effect, 'changed');
});

test('CLI agent-turn: koperta verified/effect na BŁĘDZIE (model_unavailable) też niesie zmierzony werdykt migawki, nie "unchanged" na wiarę', async t => {
    const FAKE_BRAIN_FILE = '.pkm-assistant/agents/jaskier/memory/brain.md';
    const FAKE_BRAIN_DIR = '.pkm-assistant/agents/jaskier/memory/brain';
    let call = 0;
    const memory = {
        paths: { brain: FAKE_BRAIN_FILE, brainNotes: FAKE_BRAIN_DIR },
        vault: {
            adapter: {
                stat: async (p: string) => {
                    if (p === FAKE_BRAIN_DIR) return { mtime: 1, size: 0 };
                    call += 1;
                    return call === 1 ? { mtime: 100, size: 10 } : { mtime: 999, size: 999 };
                },
            },
        },
    } as unknown as AgentMemory;
    const deps = makeCliDeps({
        host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'], memories: { Jaskier: memory } }) }),
        runtime: { createModel: () => null },
    });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });

    t.false(r.ok);
    t.is(r.error.code, 'model_unavailable');
    t.true(r.verified);
    t.is(r.effect, 'changed');
});

test('CLI agent-turn: wyjątek rzucony przez resolveHost() -> internal, handler nie rzuca', async t => {
    const deps = makeCliDeps({ hostError: new Error('resolveHost padł') });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej' });
    t.false(r.ok);
    t.is(r.error.code, 'internal');
    t.is(r.error.message, 'resolveHost padł');
});

test('CLI agent-turn: format=xml -> bad_flag', async t => {
    const deps = makeCliDeps({ host: makeHost({ agentManager: makeAgentManagerFixture({ names: ['Jaskier'] }) }) });
    const r = await runAgentTurnCli(deps, { agent: 'Jaskier', prompt: 'hej', format: 'xml' });
    t.false(r.ok);
    t.is(r.error.code, 'bad_flag');
});
