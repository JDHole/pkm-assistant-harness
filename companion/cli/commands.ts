/**
 * @module commands
 * Cztery komendy CLI Obsidiana fali 1 - WYŁĄCZNIE odczyt (`status`/`selftest`/`agent-prompt`/
 * `memory-status`). PRZENIESIONE z `modules/cli/commands.ts` pluginu; różnice względem źródła:
 *
 *  - id komend są prefiksowane id TEJ wtyczki (`deps.companionId`, `pkm-assistant-dev`), nie id
 *    hosta - konwencja `<plugin-id>:<action>` z `obsidian.d.ts` mówi o id WOŁANEJ wtyczki, a
 *    komendę może zarejestrować tylko ten, kto ją rejestruje (`Plugin#registerCliHandler`);
 *  - host (żywa instancja `pkm-assistant`) jest rozwiązywany PRZY KAŻDYM wywołaniu przez
 *    `deps.resolveHost()` (patrz `hostPlugin.ts`), nigdy raz przy rejestracji - `CliDeps` nie ma
 *    już statycznych getterów `agentManager()`/`indexStatus()` związanych z jedną instancją;
 *  - `StatusData.plugin` niesie `instanceSince` zamiast `loadedAt` - znacznik "kiedy TA żywa
 *    instancja hosta została zobaczona po raz pierwszy" (porównanie tożsamości referencji,
 *    liczone w zamknięciu `buildCliCommands`), nie "kiedy TA wtyczka-nosiciel się zarejestrowała";
 *    doszło pole `companion: {id, version}` (tożsamość SAMEJ wtyczki-nosiciela);
 *  - `selfTest`/`consolidationStatus` w `CliDeps` przyjmują dane hosta jako argument (host
 *    rozwiązany przez `runGuardedReady`), zamiast domykać się nad `this` pluginu w `src/main.ts`.
 *
 * Koperta, kody błędów, parsowanie flag, rozwiązywanie imienia agenta i migawka `brain.md` +
 * `brain/` w `agent-prompt` są BEZ ZMIAN względem źródła.
 */

import { log } from '../logger.js';
import { okResponse, errorResponse, serializeCliResponse } from './response.js';

// Typy CLI z LOKALNEJ atrapy (`test-support/obsidian.ts`), nie z bare specyfiera `obsidian` -
// ten pakiet nie jest zależnością tego repo (harness testuje przez atrapę, nie przez oficjalny
// pakiet; `companion/main.ts` ma osobne, udokumentowane uzasadnienie, czemu ONO musi zostać
// przy bare specyfierze). Atrapa i tak dopasowuje się do prawdziwego Obsidiana (kontrakt
// `Plugin#registerCliHandler`, patrz jej nagłówek), więc jest wiarygodnym źródłem tych typów.
import type { CliData, CliFlag, CliFlags } from '../../test-support/obsidian.js';
import type { AgentMemory, ConsolidationStatus } from '@plugin/modules/memory/index.js';
import type { CliAgentManager, ResolvedHost } from '../hostPlugin.js';
import type { CliEffect, CliErrorCode, CliResponse } from './response.js';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Kontrakty
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Jedna komenda gotowa do rejestracji na hoście Obsidiana (`register.ts`) albo do wołania w
 * testach. `run` jest WŁAŚCIWOŚCIĄ funkcyjną, nie skrótem metody - patrz `register.ts` (`P1`),
 * ten sam powód co w źródle: skrót metody każe `@typescript-eslint/unbound-method` traktować
 * `spec.run` jako coś, co mogłoby polegać na `this` przy wyciągnięciu z obiektu.
 */
export interface CliCommandSpec {
    /** Pełne id z prefiksem TEJ wtyczki, np. `pkm-assistant-dev:status`. */
    id: string;
    description: string;
    flags: CliFlags | null;
    run: (params: CliData) => Promise<string>;
}

/**
 * Zależności wstrzykiwane z `companion/main.ts`. `resolveHost` zastępuje statyczne gettery
 * oryginału - wołane PRZY KAŻDYM wywołaniu komendy wymagającej gotowości (patrz nagłówek pliku).
 */
export interface CliDeps {
    /** Id TEJ wtyczki (manifest `companion/manifest.json`) - prefiks czterech komend. */
    companionId: string;
    /** Wersja TEJ wtyczki - `StatusData.companion.version`. */
    companionVersion: string;
    /** Rozwiązuje żywą instancję hosta `pkm-assistant` - `null`, gdy nie ma go/nieaktywny. */
    resolveHost: () => ResolvedHost | null;
    /** Raport self-testu HOSTA - nieprzezroczysty ładunek, przechodzi do `data` bez kształtowania. */
    selfTest: (hostRaw: Record<string, unknown>) => Promise<object>;
    consolidationStatus: (memory: AgentMemory) => Promise<ConsolidationStatus>;
    /** Wstrzykiwalny zegar (testy) - domyślnie `new Date()`. */
    now?: () => Date;
}

/** `pkm-assistant-dev:status` - działa ZAWSZE, nawet gdy hosta nie ma w ogóle. */
export interface StatusData {
    /** Host, o którym ta wtyczka-nosiciel raportuje - `pkm-assistant`. */
    plugin: { id: string; version: string; instanceSince: string | null };
    /** TA wtyczka-nosiciel sama - `pkm-assistant-dev`. */
    companion: { id: string; version: string };
    ready: boolean;
    agents: { count: number; active: string | null; names: string[] } | null;
    index: { status: string; indexed: number; total: number; modelKey: string | null; lastError: string | null } | null;
    commands: string[];
}

/** `pkm-assistant-dev:agent-prompt`. */
export interface AgentPromptData {
    /** Rozwiązane, kanoniczne imię (może różnić się wielkością liter od `agent=` w żądaniu). */
    agent: string;
    totalTokens: number;
    sections: Array<{ key: string; label: string; category: string; tokens: number; enabled: boolean; required: boolean }>;
    /** Obecne TYLKO gdy w żądaniu podano `section=<key>`. */
    section?: { key: string; label: string; tokens: number; content: string };
}

/** `pkm-assistant-dev:memory-status`. */
export interface MemoryStatusData {
    /** Zawsze tablica, także dla jednego agenta (`agent=<name>`, nie `all`). */
    agents: ConsolidationStatus[];
    /** Pad odczytu JEDNEGO agenta nie wywraca reszty - ląduje tu, agent wypada z `agents`. */
    errors: Array<{ agent: string; message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Opisy (stale po angielsku - interfejs maszynowy, niezależny od języka UI)
// ═══════════════════════════════════════════════════════════════════════════════════════

const FORMAT_FLAG: CliFlag = { value: 'json', description: 'Output format. Only "json" (default) is supported.' };

const STATUS_DESCRIPTION = 'Report the host plugin\'s liveness (pkm-assistant): version, readiness, loaded agents, vault index status. Works even when the host is not installed or not ready yet.';
const SELFTEST_DESCRIPTION = 'Run the host plugin\'s built-in self-test and return its report as JSON, without writing a log file or showing a Notice.';
const AGENT_PROMPT_DESCRIPTION = 'Inspect one agent\'s system prompt on the host plugin: section breakdown with token counts, or the full content of one section.';
const MEMORY_STATUS_DESCRIPTION = 'Report memory consolidation status for one agent or all agents on the host plugin (thresholds, counters, whether consolidation would trigger).';

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Rozwiązywanie imienia agenta - (1) dokładne dopasowanie, (2) bez wielkości liter jeśli JEDNOZNACZNE
// ═══════════════════════════════════════════════════════════════════════════════════════

type AgentNameResolution =
    | { ok: true; name: string }
    | { ok: false; code: 'agent_not_found' | 'agent_ambiguous'; message: string };

/**
 * `AgentManager.getAgent(name)` jest case-sensitive, a `getPromptInspectorDataForAgent` dla
 * nieznanego imienia oddaje CICHO pusty wynik - dlatego istnienie agenta sprawdzamy TUTAJ,
 * zanim cokolwiek wołamy. Obie gałęzie błędu wymieniają dostępne imiona.
 */
function resolveAgentName(names: string[], requested: string): AgentNameResolution {
    if (names.includes(requested)) return { ok: true, name: requested };

    const lower = requested.toLowerCase();
    const caseInsensitiveMatches = names.filter(name => name.toLowerCase() === lower);
    const available = names.length > 0 ? names.join(', ') : '(none)';

    if (caseInsensitiveMatches.length === 1) return { ok: true, name: caseInsensitiveMatches[0] };
    if (caseInsensitiveMatches.length > 1) {
        return {
            ok: false,
            code: 'agent_ambiguous',
            message: `Agent name "${requested}" matches ${caseInsensitiveMatches.length} agents case-insensitively (${caseInsensitiveMatches.join(', ')}). Available agents: ${available}`,
        };
    }
    return {
        ok: false,
        code: 'agent_not_found',
        message: `Agent "${requested}" not found. Available agents: ${available}`,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Wspólny szkielet uruchomienia - format, gotowość hosta, log, nigdy nie rzuca
// ═══════════════════════════════════════════════════════════════════════════════════════

function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    return String(e);
}

/** `format` jest jedyną flagą wspólną wszystkim czterem komendom - dozwolona wartość: `json`
 *  (domyślna), bez wielkości liter (`JSON` = `json`) i po `trim()`. */
function validateFormat(params: CliData): CliErrorCode | null {
    if (params.format === undefined) return null;
    if (params.format.trim().toLowerCase() !== 'json') return 'bad_flag';
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Flagi `agent`/`section` - trim, `agent=all` bez wielkości liter, pusta/`'true'` -> bad_flag
// ═══════════════════════════════════════════════════════════════════════════════════════

type FlagParseResult<T> = { ok: true; value: T } | { ok: false; code: 'bad_flag'; message: string };

/**
 * Flaga `agent`: `trim()`, `all` rozpoznawane bez wielkości liter (`ALL`, `All`) - dotyczy tylko
 * `memory-status`, `agent-prompt` po prostu ignoruje `isAll`. Brak flagi, pusty string po
 * `trim()` albo literał `'true'` (flaga podana BEZ wartości w `CliData`) -> `bad_flag` z
 * komunikatem, że `agent` wymaga wartości - NIE `agent_not_found`.
 */
function parseAgentFlag(params: CliData): FlagParseResult<{ value: string; isAll: boolean }> {
    const raw = typeof params.agent === 'string' ? params.agent.trim() : '';
    if (raw === '' || raw === 'true') {
        return { ok: false, code: 'bad_flag', message: 'Flag "agent" requires a value (an agent name, or "all" for memory-status).' };
    }
    return { ok: true, value: { value: raw, isAll: raw.toLowerCase() === 'all' } };
}

/** Flaga `section` (opcjonalna): `trim()`; pusty string po `trim()` albo literał `'true'`
 *  (flaga podana bez wartości) -> `bad_flag`. Brak flagi -> `value: undefined`, bez błędu. */
function parseSectionFlag(params: CliData): FlagParseResult<string | undefined> {
    if (params.section === undefined) return { ok: true, value: undefined };
    const trimmed = params.section.trim();
    if (trimmed === '' || trimmed === 'true') {
        return { ok: false, code: 'bad_flag', message: 'Flag "section" requires a value (a section key).' };
    }
    return { ok: true, value: trimmed };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Uczciwość koperty `agent-prompt` - `stat` pliku brain.md przed/po `getPromptInspectorDataForAgent`
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Wycinek `AgentMemory`, jakiego potrzebuje `stat` pliku `brain.md` - `Pick`, nie cała klasa. */
type BrainStatMemory = Pick<AgentMemory, 'vault' | 'paths'>;

/** `stat()` zwraca `null`, gdy plik nie istnieje - to PRAWIDŁOWY, porównywalny wynik.
 *  `undefined` znaczy co innego: nie dało się nawet SPRÓBOWAĆ. */
type BrainFileStat = { mtime?: number; size?: number } | null;

/**
 * Migawka DWÓCH bytów, które droga budowy promptu potrafi zmaterializować na dysku:
 *  - plik `brain.md` (`getBrain()` dokleja brakujące nagłówki indeksu i ZAPISUJE plik),
 *  - folder `brain/` (`listBrainNotes()` sam go zakłada, gdy zniknął spod rozgrzanej instancji).
 */
interface BrainSnapshot {
    file: BrainFileStat;
    notesDirPresent: boolean;
}

/**
 * Migawka pamięci agenta - `undefined`, gdy nie da się w ogóle spróbować (brak instancji pamięci,
 * adapter bez `stat`, albo `stat()` rzucił).
 */
async function snapshotBrain(memory: BrainStatMemory | null): Promise<BrainSnapshot | undefined> {
    if (!memory || typeof memory.vault.adapter.stat !== 'function') return undefined;
    try {
        const file = (await memory.vault.adapter.stat(memory.paths.brain)) ?? null;
        const notesDir = (await memory.vault.adapter.stat(memory.paths.brainNotes)) ?? null;
        return { file, notesDirPresent: notesDir !== null };
    } catch {
        return undefined;
    }
}

function sameBrainStat(a: BrainFileStat, b: BrainFileStat): boolean {
    if (a === null || b === null) return a === b;
    return (a.mtime ?? null) === (b.mtime ?? null) && (a.size ?? null) === (b.size ?? null);
}

/**
 * `verified`/`effect` koperty `agent-prompt`: migawka niedostępna przed ALBO po ->
 * `verified:false, effect:'unknown'`. Identyczna migawka przed i po -> `verified:true,
 * effect:'unchanged'`; różna -> `verified:true, effect:'changed'`.
 */
function brainStatVerdict(before: BrainSnapshot | undefined, after: BrainSnapshot | undefined): { verified: boolean; effect: CliEffect } {
    if (before === undefined || after === undefined) return { verified: false, effect: 'unknown' };
    const same = sameBrainStat(before.file, after.file) && before.notesDirPresent === after.notesDirPresent;
    return same ? { verified: true, effect: 'unchanged' } : { verified: true, effect: 'changed' };
}

/**
 * `status` nie wymaga hosta gotowego - buduje odpowiedź z tego, co akurat udało się rozwiązać
 * (patrz `StatusData`). Jedyna wspólna bramka to `format`.
 */
async function runGuardedAlways(
    id: string,
    params: CliData,
    build: () => CliResponse<unknown>,
): Promise<string> {
    log.debug('CLI', `${id} params=${JSON.stringify(params)}`);
    try {
        const formatError = validateFormat(params);
        if (formatError) return serializeCliResponse(errorResponse(id, formatError, `Unsupported format "${String(params.format)}" - only "json" is supported.`));
        return serializeCliResponse(build());
    } catch (e) {
        return serializeCliResponse(errorResponse(id, 'internal', errorMessage(e)));
    }
}

/** Host rozwiązany i zawężony do "gotowy, z agent managerem" - dokładnie to, czego wymagają
 *  trzy komendy poza `status`. */
interface ReadyHost extends ResolvedHost {
    agentManager: CliAgentManager;
}

/**
 * Reszta komend: `format` + host rozwiązany PRZY TYM WYWOŁANIU + gotowość hosta + obecność
 * agent managera (`not_ready`, gdy którekolwiek zawiedzie). `handler` dostaje już-gotowy
 * `ReadyHost` - bez ponownego, potencjalnie rozjeżdżającego się w typach wołania `resolveHost()`.
 */
async function runGuardedReady(
    id: string,
    params: CliData,
    deps: CliDeps,
    handler: (host: ReadyHost) => Promise<CliResponse<unknown>>,
): Promise<string> {
    log.debug('CLI', `${id} params=${JSON.stringify(params)}`);
    try {
        const formatError = validateFormat(params);
        if (formatError) return serializeCliResponse(errorResponse(id, formatError, `Unsupported format "${String(params.format)}" - only "json" is supported.`));
        const host = deps.resolveHost();
        if (!host || !host.isReady || !host.agentManager) {
            return serializeCliResponse(errorResponse(id, 'not_ready', 'Host plugin "pkm-assistant" is not installed, not ready yet, or its agent manager is not available.'));
        }
        return serializeCliResponse(await handler({ ...host, agentManager: host.agentManager }));
    } catch (e) {
        // `unknown`, nie `unchanged`: wyjątek mógł paść W POŁOWIE drogi silnika (po samonaprawie
        // `brain.md`, przed zwrotką) - nie wiemy, co zdążyło się zapisać, więc tego nie obiecujemy.
        return serializeCliResponse(errorResponse(id, 'internal', errorMessage(e), 'unknown'));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Budowa danych per komenda
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Pamięta OSTATNIO WIDZIANĄ żywą instancję hosta (porównanie tożsamości obiektu) i chwilę,
 *  gdy zobaczyła ją po raz pierwszy - nowa instancja po `plugin:reload id=pkm-assistant`
 *  (nowa referencja) dostaje nowy znacznik. Zamknięcie żyje tak długo jak rejestracja komend
 *  zwrócona przez `buildCliCommands` (czyli cały czas życia TEJ instancji wtyczki-nosiciela). */
function createInstanceTracker(now: () => Date) {
    let lastSeen: object | null = null;
    let since: string | null = null;
    return (raw: object): string => {
        if (raw !== lastSeen) {
            lastSeen = raw;
            since = now().toISOString();
        }
        return since as string;
    };
}

function buildStatusData(deps: CliDeps, trackInstance: (raw: object) => string, commandIds: string[]): StatusData {
    const host = deps.resolveHost();
    const agents = host?.agentManager
        ? { count: host.agentManager.getAllAgents().length, active: host.agentManager.getActiveAgent()?.name ?? null, names: host.agentManager.getAllAgents().map(a => a.name) }
        : null;

    const idx = host?.indexStatus;
    const index = idx
        ? {
            status: idx.status,
            indexed: Number(idx.progress?.indexed) || 0,
            total: Number(idx.progress?.total) || 0,
            modelKey: idx.modelKey ?? null,
            lastError: idx.lastError == null ? null : String(idx.lastError),
        }
        : null;

    return {
        plugin: {
            id: host?.id ?? 'pkm-assistant',
            version: host?.version ?? 'unknown',
            instanceSince: host ? trackInstance(host.raw) : null,
        },
        companion: { id: deps.companionId, version: deps.companionVersion },
        ready: host?.isReady ?? false,
        agents,
        index,
        commands: commandIds,
    };
}

async function runAgentPrompt(id: string, params: CliData, am: CliAgentManager): Promise<CliResponse<AgentPromptData>> {
    const agentFlag = parseAgentFlag(params);
    if (!agentFlag.ok) return errorResponse(id, agentFlag.code, agentFlag.message);

    const sectionFlag = parseSectionFlag(params);
    if (!sectionFlag.ok) return errorResponse(id, sectionFlag.code, sectionFlag.message);

    const names = am.getAllAgents().map(a => a.name);
    const resolved = resolveAgentName(names, agentFlag.value.value);
    if (!resolved.ok) return errorResponse(id, resolved.code, resolved.message);

    const memory = am.getAgentMemory(resolved.name);
    const before = await snapshotBrain(memory);
    const inspected = await am.getPromptInspectorDataForAgent(resolved.name);
    const after = await snapshotBrain(memory);
    const verdict = brainStatVerdict(before, after);

    const data: AgentPromptData = {
        agent: resolved.name,
        totalTokens: inspected.breakdown.total,
        sections: inspected.sections.map(s => ({
            key: s.key,
            label: s.label,
            category: s.category,
            tokens: s.tokens,
            enabled: s.enabled,
            required: s.required,
        })),
    };

    if (sectionFlag.value !== undefined) {
        const sectionKey = sectionFlag.value;
        const found = inspected.sections.find(s => s.key === sectionKey);
        if (!found) {
            const keys = inspected.sections.map(s => s.key);
            const available = keys.length > 0 ? keys.join(', ') : '(none)';
            return errorResponse(id, 'section_not_found', `Section "${sectionKey}" not found. Available sections: ${available}`, verdict.effect, verdict.verified);
        }
        data.section = { key: found.key, label: found.label, tokens: found.tokens, content: found.content };
    }

    return okResponse(id, data, verdict.effect, verdict.verified);
}

async function runMemoryStatus(id: string, params: CliData, deps: CliDeps, am: CliAgentManager): Promise<CliResponse<MemoryStatusData>> {
    const agentFlag = parseAgentFlag(params);
    if (!agentFlag.ok) return errorResponse(id, agentFlag.code, agentFlag.message);

    const agents: ConsolidationStatus[] = [];
    const errors: MemoryStatusData['errors'] = [];

    const collect = async (agentName: string, memory: AgentMemory | null): Promise<void> => {
        if (!memory) {
            errors.push({ agent: agentName, message: 'Agent has no memory instance yet.' });
            return;
        }
        try {
            agents.push(await deps.consolidationStatus(memory));
        } catch (e) {
            errors.push({ agent: agentName, message: errorMessage(e) });
        }
    };

    if (agentFlag.value.isAll) {
        for (const agent of am.getAllAgents()) {
            await collect(agent.name, am.getAgentMemory(agent.name));
        }
    } else {
        const names = am.getAllAgents().map(a => a.name);
        const resolved = resolveAgentName(names, agentFlag.value.value);
        if (!resolved.ok) return errorResponse(id, resolved.code, resolved.message);
        await collect(resolved.name, am.getAgentMemory(resolved.name));
    }

    return okResponse(id, { agents, errors });
}

// ═══════════════════════════════════════════════════════════════════════════════════════
//  Montaż
// ═══════════════════════════════════════════════════════════════════════════════════════

/** Kolejność MUSI się zgadzać z kolejnością komend budowanych niżej - `commands` w `StatusData` ją zwraca. */
const COMMAND_NAMES = ['status', 'selftest', 'agent-prompt', 'memory-status'] as const;

/**
 * Buduje cztery `CliCommandSpec` - czyste, zero Obsidiana (żaden argument, żadne pole tego
 * modułu nie dotyka `obsidian`; `register.ts` dopiero wiąże je z hostem). Id komend biorą
 * prefiks z `deps.companionId` (TA wtyczka), nie z hosta.
 */
export function buildCliCommands(deps: CliDeps): CliCommandSpec[] {
    const ids = COMMAND_NAMES.map(name => `${deps.companionId}:${name}`);
    const [statusId, selftestId, agentPromptId, memoryStatusId] = ids;
    const trackInstance = createInstanceTracker(deps.now ? deps.now : () => new Date());

    return [
        {
            id: statusId,
            description: STATUS_DESCRIPTION,
            flags: { format: FORMAT_FLAG },
            run: params => runGuardedAlways(statusId, params, () => okResponse(statusId, buildStatusData(deps, trackInstance, ids))),
        },
        {
            id: selftestId,
            description: SELFTEST_DESCRIPTION,
            flags: { format: FORMAT_FLAG },
            run: params => runGuardedReady(selftestId, params, deps, async host => okResponse(selftestId, await deps.selfTest(host.raw))),
        },
        {
            id: agentPromptId,
            description: AGENT_PROMPT_DESCRIPTION,
            flags: {
                agent: { value: '<name>', description: 'Exact or case-insensitive agent name.', required: true },
                section: { value: '<key>', description: 'Return only this prompt section, including its content.' },
                format: FORMAT_FLAG,
            },
            run: params => runGuardedReady(agentPromptId, params, deps, host => runAgentPrompt(agentPromptId, params, host.agentManager)),
        },
        {
            id: memoryStatusId,
            description: MEMORY_STATUS_DESCRIPTION,
            flags: {
                agent: { value: '<name|all>', description: 'Agent name, or "all" for every agent.', required: true },
                format: FORMAT_FLAG,
            },
            run: params => runGuardedReady(memoryStatusId, params, deps, host => runMemoryStatus(memoryStatusId, params, deps, host.agentManager)),
        },
    ];
}
