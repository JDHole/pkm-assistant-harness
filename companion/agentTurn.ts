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
import type { LoopMessage, MessageStoreLike, ParsedToolCall, RunAgentLoopOptions, RunAgentLoopResult, ToolResultEntry } from '@plugin/modules/agent-loop/index.js';
import { getLimits } from '@plugin/config/limits.js';
import { maskSensitiveData } from '@plugin/core/security/SensitiveDataGuard.js';
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
    /** Widok surowy hosta - konsumenci: `deps.createModel` (mirror `createModelForRole(hostRaw,
     *  ...)`) i `computeAgentTurnLimits` (`hostRaw.env.settings`, K-adwersarialna: limity 1:1
     *  z czatem). */
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
 *
 * ⚠️ Przecięcie ze stałą trzyma nawet wtedy, gdy `toolRegistry.filterByAgent(agent)` sam z
 * siebie ZEZWALA agentowi na `write`/`delete`/cokolwiek innego (agent z pełnym dostępem w
 * ustawieniach hosta) - `READONLY_TOOLS` jest GÓRNYM sufitem tej komendy, nie tylko odbiciem
 * uprawnień agenta. Test tej własności (rejestr allow, `tools=readonly` mimo to tnie):
 * `agentTurn.test.ts`.
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
 * `AgentLoop.ts` łapie ten wyjątek per-narzędziowo (Promise.all) i sam wpisuje go do
 * `toolCallDetails`/`onToolResults` z `error` - `verdictFromEntry` (niżej) czyta to jako
 * `ok:false` tak samo jak `isError:true` zwrócone PRZEZ `mcpClient` bez rzutu (K-adwersarialna,
 * punkt C: `MCPClient.executeToolCall` w praktyce nigdy nie rzuca, tylko zwraca
 * `{isError:true, error}` - ten wrapper się NIE myli co do źródła prawdy, ale samo AgentLoop nie
 * wie o `isError`, więc księgowość `ok`/`error` liczy `verdictFromEntry`, nie `detail.error`).
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
//  K-adwersarialna/C: ok/error UCZCIWE - `isError:true` zwrócone (nie rzucone) przez mcpClient
//  liczy się jako porażka, nie tylko rzucony wyjątek (AgentLoop sam o `isError` nie wie).
// ═══════════════════════════════════════════════════════════════════════════════════════

interface ToolResultVerdict {
    ok: boolean;
    error?: string;
}

const GENERIC_TOOL_ERROR_MESSAGE = 'Tool reported an error.';

/**
 * Werdykt PER WYWOŁANIE narzędzia, liczony z tego, co REALNIE wróciło (albo z rzutu, którego
 * `makeExecuteToolCall` używa dla narzędzi spoza whitelisty) - `entry` przychodzi z hooka
 * `onToolResults` (jeden wpis na jedno wywołanie, w kolejności `tool_calls`).
 *
 * - `entry.error` obecne -> rzut (whitelista TEGO pliku) -> `ok:false`.
 * - `entry.result` to JSON obiektu z `isError:true` (kontrakt `MCPClient.executeToolCall`,
 *   `MCPClient.ts` ok. l.1195-1204: klient łapie WŁASNE wyjątki i oddaje `{isError:true, error}`,
 *   nigdy nie rzuca) -> `ok:false`, `error` z pola `error`/`message` obiektu.
 * - inaczej -> `ok:true`.
 */
function verdictFromEntry(entry: ToolResultEntry): ToolResultVerdict {
    if (entry.error) {
        return { ok: false, error: typeof entry.error === 'string' ? entry.error : GENERIC_TOOL_ERROR_MESSAGE };
    }
    if (!Array.isArray(entry.result) && typeof entry.result === 'string') {
        try {
            const parsed: unknown = JSON.parse(entry.result);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).isError === true) {
                const rec = parsed as Record<string, unknown>;
                const msg = typeof rec.error === 'string' ? rec.error : (typeof rec.message === 'string' ? rec.message : GENERIC_TOOL_ERROR_MESSAGE);
                return { ok: false, error: msg };
            }
        } catch { /* nie-JSON - zwykły tekstowy wynik, nie kształt błędu */ }
    }
    return { ok: true };
}

/** Wpis lokalnej księgowości (`collected`, niżej) - ten sam kształt co `AgentTurnData.toolCalls[number]`. */
type CollectedCall = AgentTurnData['toolCalls'][number];

function toResultPreview(result: string | unknown[]): string {
    // Ta sama konwersja co `AgentLoop.ts` (`String(r.result).slice(0, 500)`) - parytet na
    // wypadek, gdyby wynik TEJ księgowości musiał zastąpić `resultPreview` z detali pętli
    // (gałąź timeoutu, gdzie detali pętli jeszcze nie ma).
    return String(result).slice(0, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  K-adwersarialna/A: limity 1:1 z czatem produkcyjnym (`chat_streaming.ts:676-694`)
// ═══════════════════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Worek ustawień hosta w zakresie, jaki czyta ten plik - zwalidowany NA GRANICY (`isRecord`
 *  na każdym poziomie), NIGDY na wiarę. Brak/zły kształt -> `null`, `getLimits(null)` spada na
 *  same defaulty (dokładnie jak `getLimits(undefined)` w produkcji, patrz jego JSDoc). */
function resolveHostSettings(hostRaw: Record<string, unknown>): { pkmAssistant?: { limits?: Record<string, unknown>; chat?: { platform?: unknown } } } | null {
    const env = hostRaw.env;
    if (!isRecord(env)) return null;
    const settings = env.settings;
    if (!isRecord(settings)) return null;
    return settings as unknown as { pkmAssistant?: { limits?: Record<string, unknown>; chat?: { platform?: unknown } } };
}

interface AgentTurnLoopLimits {
    maxIterations: number;
    maxToolResultLength: number;
    maxToolResultLengthPerTool: Record<string, number>;
    perCallTimeoutMs: number;
    stallTimeoutMs: number;
}

/**
 * Limity `runAgentLoop` 1:1 z tym, co podaje główny czat (`chat_streaming.ts:676-694`) -
 * WYŁĄCZNIE `maxIterations` przychodzi z flagi CLI (`agent-turn` nie ma tury "kontynuacji"
 * z osobnym limitem jak czat). `settings` z `hostRaw.env.settings` (zwalidowane na granicy,
 * brak/zły kształt -> `getLimits(null)`, same defaulty `DEFAULT_LIMITS`).
 *
 * `stallTimeoutMs`: chat NIE podaje go do `runAgentLoop` (ma własny, zewnętrzny
 * `StreamWatchdog` napędzany UI, którego `agent-turn` nie ma) - warunek platformy
 * (`chat_streaming.ts:639-642`: `xai` nie streamuje, cisza mid-flight tam normalna, watchdog
 * wyłączony) jest jednak TYM SAMYM warunkiem, jakiego potrzebuje WBUDOWANY watchdog ciszy
 * `runAgentLoop` (`limits.stallTimeoutMs`) - `agent-turn` używa go wprost, bo to jedyny
 * dostępny mu odpowiednik bez własnej warstwy UI.
 */
function computeAgentTurnLimits(hostRaw: Record<string, unknown>, maxIterations: number): AgentTurnLoopLimits {
    const settings = resolveHostSettings(hostRaw);
    const limits = getLimits(settings);
    const platform = typeof settings?.pkmAssistant?.chat?.platform === 'string' ? settings.pkmAssistant.chat.platform : '';
    const stallTimeoutMs = platform === 'xai' ? 0 : limits.chat_stream_stall_timeout_ms;
    return {
        maxIterations,
        maxToolResultLength: limits.max_tool_result_length,
        maxToolResultLengthPerTool: {
            delegate: limits.subagent_result_max_chars,
            agent_delegate: limits.subagent_result_max_chars,
        },
        perCallTimeoutMs: limits.chat_model_call_timeout_ms,
        stallTimeoutMs,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Orkiestracja
// ═══════════════════════════════════════════════════════════════════════════════════════

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

/** `turn_failed`/`internal` MASKUJĄ sekrety (K-adwersarialna, punkt D) - komunikat wyjątku
 *  potrafi nieść surowy fragment żądania/nagłówka (`Authorization: Bearer sk-...`) z warstwy
 *  transportu modelu; `maskSensitiveData` (zero zależności, `core/security/SensitiveDataGuard.js`)
 *  jest tą samą maską, którą `MCPClient`/`SubAgentRunner`/`ExternalMcpManager` nakładają na
 *  błędy narzędzi - jedna granica dla wszystkich odbiorców błędu, teraz też dla tej komendy. */
function maskedErrorMessage(e: unknown): string {
    return maskSensitiveData(errorMessage(e));
}

/**
 * Uruchamia jedną turę produkcyjnej pętli agenta w trybie bezpiecznym. `agent` jest już
 * rozwiązany przez wołacza (`commands.ts`, ten sam mechanizm co `agent-prompt`) - ten plik
 * dostaje go JAWNIE i nigdy nie woła `switchAgent`/nie czyta `getActiveAgent()`.
 *
 * K-adwersarialna/B: termin CAŁEGO biegu jest WYŚCIGIEM (`Promise.race`) między pętlą a
 * budzikiem, nie flagą, na którą pętla musi sama zerknąć. Wywołanie narzędzia, które WISI
 * (np. zawieszony HTTP embeddingu w `search` scope=memory) blokowałoby `await runAgentLoop(...)`
 * w nieskończoność, mimo że `stopStream()` już poszedł - `stopStream` ubija tylko STREAM modelu,
 * nie egzekucję narzędzia. Wyścig gwarantuje zwrot po `timeoutSeconds` NIEZALEŻNIE od tego, co
 * robi pętla - osierocony bieg dostaje `shouldAbort:true` (kończy się sam przy najbliższej
 * okazji, jeśli/gdy jego wywołanie narzędzia w końcu wróci) i jego późniejsze rozstrzygnięcie
 * (sukces ALBO wyjątek) jest POŁKNIĘTE (`.then(ok, ok)` niżej - obie gałęzie obsłużone, zero
 * unhandled rejection). Blokada "jeden bieg naraz" (`commands.ts`) jest zwalniana w `finally`
 * WOŁACZA zaraz po powrocie tej funkcji - osierocony bieg w tle NIE trzyma jej dłużej.
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
    const modelName = model.modelKey ?? model.modelId ?? null;

    let timedOut = false;
    let timerHandle: AgentTurnTimerHandle;
    // Rozstrzyga się WYŁĄCZNIE, gdy budzik strzeli - nigdy nie odrzucane (nie ma czego łapać).
    const timeoutSettlement = new Promise<{ kind: 'timeout' }>(resolve => {
        timerHandle = deps.setTimer(() => {
            timedOut = true;
            try { model.stopStream?.(); } catch { /* abort nie może przykryć timeoutu */ }
            resolve({ kind: 'timeout' });
        }, flags.timeoutSeconds * 1000);
    });

    let systemPrompt: string;
    try {
        systemPrompt = await host.agentManager.getActiveSystemPromptWithMemory({}, agent);
    } catch (e) {
        deps.clearTimer(timerHandle);
        return { ok: false, code: 'turn_failed', message: maskedErrorMessage(e) };
    }

    // Budżet CAŁEGO biegu obejmuje też budowę promptu (budzik tyka od startu funkcji) - jeśli
    // termin minął W TRAKCIE niej, nie ma sensu w ogóle startować pętli/modelu.
    if (timedOut) {
        deps.clearTimer(timerHandle);
        return {
            ok: true,
            data: {
                agent: agent.name,
                model: modelName,
                tools: flags.tools,
                toolsOffered: toolDefs.map(def => def.function.name),
                systemPrompt,
                finalText: '',
                toolCalls: [],
                usage: { promptTokens: 0, completionTokens: 0, estimated: true },
                iterations: 0,
                stoppedBy: 'timeout',
                approvals: [],
                session: 'none',
                durationMs: deps.now().getTime() - startedAtMs,
            },
        };
    }

    const store = deps.createStore([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: flags.prompt },
    ]);

    // Księgowość LOKALNA (zero zapisu/persystencji - patrz punkt 7 specyfikacji zadania,
    // dopuszcza "lokalne zbieranie danych bez zapisu"): źródło prawdy dla `ok`/`error` per
    // wywołanie narzędzia (K-adwersarialna/C) I jedyne źródło `toolCalls`, gdy termin wygrywa
    // wyścig zanim `runAgentLoop` w ogóle zdąży się zakończyć (K-adwersarialna/B).
    const collected: CollectedCall[] = [];
    let iterationsSoFar = 0;

    const loopSettlement = deps.runAgentLoop({
        model: model as unknown as RunAgentLoopOptions['model'],
        store,
        resolveTools: () => toolDefs as unknown as ReturnType<NonNullable<RunAgentLoopOptions['resolveTools']>>,
        executeToolCall: makeExecuteToolCall(host, agent.name, toolsOfferedNames, flags.tools),
        limits: computeAgentTurnLimits(host.raw, flags.maxIterations),
        modelOptions: { agentName: agent.name, agent: agent.name },
        hooks: {
            onIterationStart: () => { iterationsSoFar += 1; },
            onToolResults: (results: ToolResultEntry[]) => {
                for (const entry of results) {
                    const name = entry.toolCall.name || entry.toolCall.function?.name || '';
                    const args = entry.toolCall.arguments ?? entry.toolCall.function?.arguments;
                    const verdict = verdictFromEntry(entry);
                    collected.push({
                        name,
                        args,
                        resultPreview: toResultPreview(entry.result),
                        ok: verdict.ok,
                        ...(verdict.ok ? {} : { error: verdict.error }),
                    });
                }
            },
        },
        shouldAbort: () => timedOut,
        // `.then(ok, ok)` - OBIE gałęzie obsłużone: sukces I wyjątek stają się zwykłą wartością
        // zwróconą tej promisie, więc bieg osierocony przez wygraną budzika (patrz niżej) nigdy
        // nie zostawia ERR_UNHANDLED_REJECTION, mimo że nikt już go dalej nie awaituje.
    }).then(
        (value): { kind: 'result'; value: RunAgentLoopResult } => ({ kind: 'result', value }),
        (error: unknown): { kind: 'error'; error: unknown } => ({ kind: 'error', error }),
    );

    const winner = await Promise.race([loopSettlement, timeoutSettlement]);

    if (winner.kind === 'timeout') {
        // Bieg NIE jest anulowany - kontynuuje w tle z `shouldAbort()===true` (kończy się sam
        // przy najbliższej okazji); `loopSettlement` ma już OBIE gałęzie obsłużone (wyżej), więc
        // jego późniejsze rozstrzygnięcie jest po prostu zignorowane, bez unhandled rejection.
        return {
            ok: true,
            data: {
                agent: agent.name,
                model: modelName,
                tools: flags.tools,
                toolsOffered: toolDefs.map(def => def.function.name),
                systemPrompt,
                finalText: '',
                toolCalls: collected.slice(),
                usage: { promptTokens: 0, completionTokens: 0, estimated: true },
                iterations: iterationsSoFar,
                stoppedBy: 'timeout',
                approvals: [],
                session: 'none',
                durationMs: deps.now().getTime() - startedAtMs,
            },
        };
    }

    // Pętla wygrała wyścig - budzik już niepotrzebny (jeśli jeszcze nie strzelił, anuluj go;
    // jeśli strzelił tuż PRZED wygraną pętli w tym samym takcie, `clearTimer` na już odpalonym
    // timerze jest bezpiecznym no-opem).
    deps.clearTimer(timerHandle);

    if (winner.kind === 'error') {
        return { ok: false, code: 'turn_failed', message: maskedErrorMessage(winner.error) };
    }

    const loopResult = winner.value;
    // Obrona w głąb: `timedOut` mógł i tak wpaść na `true` w wąskim oknie tuż PRZED wygraną
    // pętli (oba warunki wyścigu rozstrzygnięte w tym samym takcie) - `stoppedBy:'abort'` z
    // takiego biegu nadal znaczy "nasz budzik", nie jakiś inny, nieznany pętli abort.
    const stoppedBy: AgentTurnData['stoppedBy'] = loopResult.stoppedBy === 'abort' && timedOut
        ? 'timeout'
        : loopResult.stoppedBy;

    const toolCalls: AgentTurnData['toolCalls'] = loopResult.toolCallDetails.map((detail, i) => {
        // Pozycyjne zip z `collected`: OBA źródła iterują TEN SAM `results` (Promise.all) w
        // TEJ SAMEJ kolejności, per iteracja, w kolejności iteracji - `collected[i]` odpowiada
        // `toolCallDetails[i]` jeden-do-jednego. Brak wpisu (nie powinno się zdarzyć) spada na
        // stare, mniej dokładne kryterium AgentLoop (`!detail.error`) - fail-soft, nie throw.
        const verdict = collected[i];
        const ok = verdict ? verdict.ok : !detail.error;
        const base = { name: detail.name ?? '', args: detail.args, resultPreview: detail.resultPreview };
        if (!ok) return { ...base, ok: false, error: (verdict && verdict.error) ?? detail.resultPreview };
        return { ...base, ok: true };
    });

    const data: AgentTurnData = {
        agent: agent.name,
        model: modelName,
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
}
