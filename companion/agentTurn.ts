/**
 * @module agentTurn
 * Logika `pkm-assistant-dev:agent-turn` - JEDNA tura PRODUKCYJNEJ pętli agenta
 * (`runAgentLoop` z `modules/agent-loop`) dla wskazanej persony na ŻYWYM hoście, w trybie
 * bezpiecznym (`autonomy:'yolo'` + whitelista narzędzi ograniczona do co najwyżej
 * `read`/`list`/`search`), zwracająca JSON dla narzędzia prompt-eval.
 *
 * RÓŻNICA względem `lib/runTurn.ts` harnessu (ten sam wzorzec tury headless, patrz jego
 * nagłówek): TA komenda NIE woła `agentManager.switchAgent` (efekt uboczny w UI usera na
 * żywym hoście - przełączyłby agenta widocznego w oknie czatu) i NIE podmienia
 * `approvalManager.setApprovalHandler`/`mcpClient.diffModalFactory` (współdzielone z żywym
 * czatem hosta - podmiana handlera zgód w trakcie rozmowy usera byłaby efektem ubocznym poza
 * zakresem tego wywołania CLI). Bezpieczeństwo bez zgód: `autonomy:'yolo'` sprawia, że
 * `PermissionSystem.requiresApproval` nigdy nie pyta (patrz `core/security/PermissionSystem.ts`),
 * więc żaden hak zgód/diffa nie jest w ogóle odpytywany - JEDYNA bariera to whitelista narzędzi
 * TEGO pliku (`READONLY_TOOLS`), egzekwowana PRZED `mcpClient.executeToolCall`.
 *
 * Wszystkie zależności produkcyjne (`runAgentLoop`, konstruktor store'a, resolver modelu,
 * zegar, timer) są WSTRZYKIWANE (`AgentTurnDeps`) - `companion/commands.ts` spina je z
 * prawdziwymi funkcjami pluginu (dynamiczny `import` z najwęższych plików - patrz
 * `companion/CLAUDE.md`), a testy (`agentTurn.test.ts`) podają atrapy.
 */
import type { Agent } from '@plugin/modules/agents/index.js';
import type { LoopMessage, MessageStoreLike, ParsedToolCall, RunAgentLoopOptions, RunAgentLoopResult } from '@plugin/modules/agent-loop/index.js';
import type { CliMcpClient, CliToolRegistry } from './hostPlugin.js';
import type { CliErrorCode } from './cli/response.js';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Kontrakty
// ═══════════════════════════════════════════════════════════════════════════════════════

/** `pkm-assistant-dev:agent-turn` - jedna tura produkcyjnej pętli agenta, tryb bezpieczny. */
export interface AgentTurnData {
    /** Kanoniczne imię (rozwiązane jak w `agent-prompt`/`memory-status`). */
    agent: string;
    model: string | null;
    tools: 'readonly' | 'none';
    /** Nazwy narzędzi REALNIE podanych modelowi (puste dla `tools=none`). */
    toolsOffered: string[];
    systemPrompt: string;
    finalText: string;
    toolCalls: Array<{ name: string; args: unknown; ok: boolean; resultPreview: string; error?: string }>;
    usage: { promptTokens: number; completionTokens: number; estimated: boolean };
    iterations: number;
    stoppedBy: 'natural' | 'backstop' | 'abort' | 'timeout';
    /** Zawsze pusta - tryb bez zgód (`yolo`); pole zostaje dla kontraktu prompt-eval. */
    approvals: [];
    /** Stała - nic nie zapisujemy do pamięci persony. */
    session: 'none';
    durationMs: number;
}

/** Widok agenta, jakiego potrzebuje `filterByAgent` (te same pola co `ToolVisibilityAgent`
 *  rejestru pluginu) - `Agent` produkcyjny je niesie; typ tu jest strukturalny, żeby ten plik
 *  nie musiał importować WARTOŚCIOWO żadnego modułu pluginu poza typami. */
interface AgentTurnToolVisibility {
    disabled_tools?: unknown;
    mcp_servers?: unknown;
    effective_mcp_servers?: unknown;
}

/** Widok agent managera, jakiego potrzebuje `agent-turn` - WYŁĄCZNIE budowa promptu.
 *  Rozwiązywanie imienia/pamięć zostają w `commands.ts` (ten sam mechanizm co `agent-prompt`). */
export interface AgentTurnAgentManager {
    getActiveSystemPromptWithMemory(context: Record<string, never>, agent: Agent): Promise<string>;
}

/** Host już zwalidowany przez `commands.ts` (`not_ready` odcina braki wcześniej). */
export interface AgentTurnHost {
    agentManager: AgentTurnAgentManager;
    mcpClient: CliMcpClient;
    toolRegistry: CliToolRegistry;
    /** Widok surowy hosta - jedyny konsument to `deps.createModel` (mirror `createModelForRole(hostRaw, ...)`). */
    raw: Record<string, unknown>;
}

export type AgentTurnToolsMode = 'readonly' | 'none';

/** Flagi już sparsowane/zwalidowane przez `commands.ts`. */
export interface AgentTurnFlags {
    prompt: string;
    tools: AgentTurnToolsMode;
    maxIterations: number;
    timeoutSeconds: number;
}

/** Minimalny widok modelu, jakiego potrzebuje ten plik (podzbiór `LoopModelLike`). */
export interface AgentTurnModel {
    stream: RunAgentLoopOptions['model']['stream'];
    stopStream?(): void;
    modelKey?: string;
    modelId?: string;
}

/** Uchwyt timera - nieprzezroczysty dla tego pliku (produkcja: `setTimeout`/`clearTimeout`). */
export type AgentTurnTimerHandle = unknown;

/**
 * Zależności wstrzykiwane - `companion/commands.ts` spina je z prawdziwymi
 * `runAgentLoop`/`ArrayMessageStore`/`createModelForRole` (dynamiczny import, patrz
 * `companion/CLAUDE.md`); testy podają atrapy.
 */
export interface AgentTurnDeps {
    runAgentLoop: (options: RunAgentLoopOptions) => Promise<RunAgentLoopResult>;
    /** Owija `new ArrayMessageStore(messages)`. */
    createStore: (messages: LoopMessage[]) => MessageStoreLike;
    /** Owija `createModelForRole(hostRaw, 'main', agent, null, true)` - rola/skipCache STAŁE
     *  (skipCache=true: świeża instancja, niewspółdzielona z otwartą rozmową - patrz punkt 4
     *  specyfikacji zadania). */
    createModel: (hostRaw: Record<string, unknown>, agent: Agent) => AgentTurnModel | null;
    now: () => Date;
    setTimer: (cb: () => void, ms: number) => AgentTurnTimerHandle;
    clearTimer: (handle: AgentTurnTimerHandle) => void;
}

export type AgentTurnRunResult =
    | { ok: true; data: AgentTurnData }
    | { ok: false; code: Extract<CliErrorCode, 'model_unavailable' | 'turn_failed'>; message: string };

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Flagi specyficzne dla `agent-turn` (`prompt`/`tools`/`max-iterations`/`timeout`)
// ═══════════════════════════════════════════════════════════════════════════════════════

type FlagParseResult<T> = { ok: true; value: T } | { ok: false; code: 'bad_flag'; message: string };

/** Worek parametrów CLI w zakresie, jakiego potrzebują parsery niżej (`CliData` bez importu
 *  atrapy Obsidiana - `string | 'true' | undefined` na dowolnym kluczu). */
export type AgentTurnRawParams = Record<string, string | 'true' | undefined>;

/** Flaga `prompt`: `trim()`, wymagana - pusty string po `trim()` albo literał `'true'`
 *  (flaga podana bez wartości) -> `bad_flag`. Ten sam wzorzec co `agent`/`section` w `commands.ts`. */
export function parsePromptFlag(params: AgentTurnRawParams): FlagParseResult<string> {
    const raw = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (raw === '' || raw === 'true') {
        return { ok: false, code: 'bad_flag', message: 'Flag "prompt" requires a value (the message to send to the agent).' };
    }
    return { ok: true, value: raw };
}

/** Flaga `tools`: `readonly` (domyślna) albo `none`, bez względu na wielkość liter, po `trim()`. */
export function parseToolsFlag(params: AgentTurnRawParams): FlagParseResult<AgentTurnToolsMode> {
    if (params.tools === undefined) return { ok: true, value: 'readonly' };
    const raw = params.tools.trim().toLowerCase();
    if (raw === 'readonly' || raw === 'none') return { ok: true, value: raw };
    return { ok: false, code: 'bad_flag', message: `Flag "tools" must be "readonly" or "none" (got "${params.tools}").` };
}

/** Parser wspólny `max-iterations`/`timeout`: liczba całkowita w [min, max], domyślna `def`. */
export function parseIntegerFlag(
    params: AgentTurnRawParams,
    key: string,
    { min, max, def }: { min: number; max: number; def: number },
): FlagParseResult<number> {
    const raw = params[key];
    if (raw === undefined) return { ok: true, value: def };
    const trimmed = raw.trim();
    const n = Number(trimmed);
    if (!/^-?\d+$/.test(trimmed) || !Number.isInteger(n) || n < min || n > max) {
        return { ok: false, code: 'bad_flag', message: `Flag "${key}" must be an integer between ${min} and ${max} (got "${raw}").` };
    }
    return { ok: true, value: n };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Whitelista narzędzi - `tools=readonly` PRZECIĘTA z `READONLY_TOOLS`, bez `serverName` (MCP)
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Narzędzia dopuszczone w `tools=readonly` - jedyna, zamknięta lista. `tools=none` nie woła
 * tego pliku wcale (`resolveAgentTurnTools` zwraca `[]` wprost). Narzędzia serwerów
 * ZEWNĘTRZNYCH (`tool.serverName`, MCP usera) są wykluczone bez względu na nazwę - `agent-turn`
 * nie ma prawa wykonać nieznanego, niekontrolowanego przez ten plik kodu.
 */
export const READONLY_TOOLS = ['read', 'list', 'search'] as const;

interface AgentTurnToolDef {
    type: string;
    function: { name: string; description: string; parameters: unknown };
}

/**
 * Whitelista narzędzi dla `agent-turn`. `tools=none` -> `[]`. `tools=readonly` ->
 * `toolRegistry.filterByAgent(agent)` (JEDNA OŚ NARZĘDZIOWA - `disabled_tools`/`mcp_servers`
 * agenta DZIAŁAJĄ, patrz `ToolRegistry.CLAUDE.md`), PRZECIĘTA z `READONLY_TOOLS`, z wykluczeniem
 * narzędzi serwerów zewnętrznych (`tool.serverName` obecne = MCP usera, nie built-in).
 */
export function resolveAgentTurnTools(
    toolRegistry: CliToolRegistry,
    agent: AgentTurnToolVisibility,
    mode: AgentTurnToolsMode,
): AgentTurnToolDef[] {
    if (mode === 'none') return [];
    const readonlySet: ReadonlySet<string> = new Set<string>(READONLY_TOOLS);
    const allowed = toolRegistry.filterByAgent(agent);
    const allowedNames = new Set(
        allowed
            .filter(tool => !tool.serverName && readonlySet.has(tool.name))
            .map(tool => tool.name),
    );
    return (toolRegistry.getToolDefinitions() as AgentTurnToolDef[])
        .filter(def => allowedNames.has(def.function.name));
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Egzekucja narzędzia - wrapper SPRAWDZA whitelistę PRZED `mcpClient.executeToolCall`
// ═══════════════════════════════════════════════════════════════════════════════════════

function toolCallName(tc: ParsedToolCall): string | undefined {
    return tc.name || tc.function?.name;
}

function toolCallArguments(tc: ParsedToolCall): unknown {
    return tc.arguments ?? tc.function?.arguments;
}

/**
 * `executeToolCall` podany do `runAgentLoop`: sprawdza nazwę narzędzia względem `toolsOffered`
 * PRZED wywołaniem `host.mcpClient.executeToolCall` - narzędzie spoza listy (model halucynuje
 * `write` mimo `tools=readonly`) dostaje BŁĄD (rzucony wyjątek), `mcpClient` NIE jest wołany.
 * `AgentLoop.ts` łapie ten wyjątek per-narzędziowo (Promise.all) i wpisuje go do
 * `toolCallDetails` z `error:true` - stąd wpis w `AgentTurnData.toolCalls` z `ok:false` bez
 * żadnej dodatkowej księgowości w tym pliku.
 */
function makeExecuteToolCall(
    host: AgentTurnHost,
    agentName: string,
    toolsOfferedNames: ReadonlySet<string>,
    mode: AgentTurnToolsMode,
): (toolCall: ParsedToolCall) => Promise<unknown> {
    return async (toolCall: ParsedToolCall): Promise<unknown> => {
        const name = toolCallName(toolCall);
        if (!name || !toolsOfferedNames.has(name)) {
            throw new Error(`Tool "${name ?? '?'}" is not allowed in agent-turn (tools=${mode}).`);
        }
        return host.mcpClient.executeToolCall(
            { id: toolCall.id, name, arguments: toolCallArguments(toolCall) },
            agentName,
            { autonomy: 'yolo' },
        );
    };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Orkiestracja
// ═══════════════════════════════════════════════════════════════════════════════════════

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

/**
 * Uruchamia jedną turę produkcyjnej pętli agenta w trybie bezpiecznym. `agent` jest już
 * rozwiązany przez wołacza (`commands.ts`, ten sam mechanizm co `agent-prompt`) - ten plik
 * dostaje go JAWNIE i nigdy nie woła `switchAgent`/nie czyta `getActiveAgent()`.
 */
export async function runAgentTurn(
    host: AgentTurnHost,
    agent: Agent,
    flags: AgentTurnFlags,
    deps: AgentTurnDeps,
): Promise<AgentTurnRunResult> {
    const startedAtMs = deps.now().getTime();

    const model = deps.createModel(host.raw, agent);
    if (!model || typeof model.stream !== 'function') {
        return {
            ok: false,
            code: 'model_unavailable',
            message: `Model not resolved for agent "${agent.name}" (missing API key or misconfigured settings).`,
        };
    }

    const toolDefs = resolveAgentTurnTools(host.toolRegistry, agent as unknown as AgentTurnToolVisibility, flags.tools);
    const toolsOfferedNames = new Set(toolDefs.map(def => def.function.name));

    let timedOut = false;
    const timerHandle = deps.setTimer(() => {
        timedOut = true;
        try { model.stopStream?.(); } catch { /* abort nie może przykryć timeoutu */ }
    }, flags.timeoutSeconds * 1000);

    try {
        const systemPrompt = await host.agentManager.getActiveSystemPromptWithMemory({}, agent);
        const store = deps.createStore([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: flags.prompt },
        ]);

        const loopResult = await deps.runAgentLoop({
            model: model as unknown as RunAgentLoopOptions['model'],
            store,
            resolveTools: () => toolDefs as unknown as ReturnType<NonNullable<RunAgentLoopOptions['resolveTools']>>,
            executeToolCall: makeExecuteToolCall(host, agent.name, toolsOfferedNames, flags.tools),
            limits: { maxIterations: flags.maxIterations },
            modelOptions: { agentName: agent.name, agent: agent.name },
            shouldAbort: () => timedOut,
        });

        const stoppedBy: AgentTurnData['stoppedBy'] = loopResult.stoppedBy === 'abort' && timedOut
            ? 'timeout'
            : loopResult.stoppedBy;

        const toolCalls: AgentTurnData['toolCalls'] = loopResult.toolCallDetails.map(detail => ({
            name: detail.name ?? '',
            args: detail.args,
            ok: !detail.error,
            resultPreview: detail.resultPreview,
            ...(detail.error ? { error: detail.resultPreview } : {}),
        }));

        const data: AgentTurnData = {
            agent: agent.name,
            model: model.modelKey ?? model.modelId ?? null,
            tools: flags.tools,
            toolsOffered: toolDefs.map(def => def.function.name),
            systemPrompt,
            finalText: loopResult.finalText,
            toolCalls,
            usage: {
                promptTokens: loopResult.usage.prompt_tokens,
                completionTokens: loopResult.usage.completion_tokens,
                estimated: loopResult.usage._estimated === true,
            },
            iterations: loopResult.iterations,
            stoppedBy,
            approvals: [],
            session: 'none',
            durationMs: deps.now().getTime() - startedAtMs,
        };
        return { ok: true, data };
    } catch (e) {
        return { ok: false, code: 'turn_failed', message: errorMessage(e) };
    } finally {
        deps.clearTimer(timerHandle);
    }
}
