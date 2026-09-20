/**
 * memoryStatus.ts — status konsolidacji pamięci JEDNEGO agenta, dla komendy CLI `memory-status`.
 *
 * PRZENIESIONE z `modules/memory/consolidationStatus.ts` pluginu (`getConsolidationStatus`),
 * 1:1 w zachowaniu, z JEDNĄ różnicą: `agentMemory.stateManager.peek()` zastąpiony WŁASNYM,
 * lekkim odczytem `.state.json` (`peekState` niżej). Powód: `StateManager.peek()` istniał w
 * pluginie WYŁĄCZNIE dla tego jednego wołacza (CLI) i znika stamtąd wraz z wyprowadzką CLI do
 * tej wtyczki - patrz `modules/memory/CLAUDE.md` (gotcha "jedno liczydło progów konsolidacji").
 *
 * Progi (`resolveConsolidationThresholds`/`shouldTriggerConsolidation`) i plan (`buildPlan`)
 * WCIĄŻ idą runtime'owym importem z pluginu, bezpośrednio z lekkich,
 * czystych plików (`modules/memory/consolidationStatus.js`, `modules/memory/ConsolidationRun.js`,
 * NIE przez barrel `modules/memory/index.js` - ten ciągnie całe drzewo modułu). To jest JEDNO
 * liczydło współdzielone z produkcyjnym triggerem (`SaveSessionWorkflow._shouldTriggerArchive`) -
 * kopiowanie tej logiki tutaj byłoby dokładnie tym, przed czym ostrzega `modules/memory/CLAUDE.md`.
 *
 * ⚠️ "JEDNO liczydło" jest prawdą na poziomie ŹRÓDEŁ i CHWILI BUILDA tej wtyczki, NIE w runtime:
 * `dist/companion/main.js` ma te dwie funkcje WKOMPILOWANE (esbuild bundluje `@plugin/...` ze
 * ŹRÓDEŁ, nie linkuje do `dist/main.js` pluginu w vaulcie) - jeśli plugin zostanie przebudowany
 * PÓŹNIEJ (nowa formuła progów), TA wtyczka o tym nie wie, dopóki ktoś nie odpali
 * `npm run build:companion` ponownie. `StatusData.companionStale` (`cli/commands.ts`, K3)
 * porównuje znacznik builda tej wtyczki z mtime bundla pluginu w vaulcie i ostrzega, gdy się
 * rozjechały - `true` znaczy "wyniki `memory-status`/`selftest` mogą liczyć starą formułę".
 * Pełny opis: `companion/CLAUDE.md`, gotcha "dwa bundle - jedno liczydło".
 *
 * Zachowane poprawki ze źródła: zero write/mkdir na rozgrzanej instancji (`peekState` i
 * `listBrainNotesIfPresent` czytają, nigdy nie piszą/nie zakładają folderów), obecność `brain/`
 * rozstrzygana z LISTINGU (nie z gołego `exists()` - ten kłamie `false` na dyskach chmurowych),
 * `(state.active_sessions || []).length` (poprawny JSON o zepsutym kształcie, `null`, nie
 * wywraca statusu), wywołania SEKWENCYJNE (nie `Promise.all` - patrz komentarz przy
 * `getConsolidationStatus` niżej, wyścig w `ensureMemoryStructure()` na zimnej instancji).
 */

import {
    resolveConsolidationThresholds,
    shouldTriggerConsolidation,
} from '@plugin/modules/memory/consolidationStatus.js';
import { buildPlan as buildConsolidationPlan } from '@plugin/modules/memory/ConsolidationRun.js';

import type { AgentMemory, BrainNoteInfo } from '@plugin/modules/memory/index.js';
import type { MemoryState } from '@plugin/modules/memory/StateManager.js';

// ── Kontrakt danych `memory-status` - WŁASNOŚĆ tej wtyczki, nie pluginu ──────────────────────
//
// W pluginie zostaje wyłącznie to, czego używa jego własny silnik: dwie czyste funkcje progów
// (`resolveConsolidationThresholds`, `shouldTriggerConsolidation` - woła je
// `SaveSessionWorkflow._shouldTriggerArchive`). Kształt statusu, źródło stanu i próg dedupu dla
// planu nie mają w pluginie żadnego czytelnika, więc mieszkają TU. Typy wejść wyprowadzone z
// sygnatury funkcji pluginu (`Parameters`/`ReturnType`), nie przepisane - zmiana po stronie
// pluginu ma wywalić typecheck harnessu, a nie rozjechać się po cichu.

type ThresholdState = Parameters<typeof resolveConsolidationThresholds>[0];
type ThresholdSettings = Parameters<typeof resolveConsolidationThresholds>[1];
type BrainNotesLimitSource = ReturnType<typeof resolveConsolidationThresholds>['brainNotesLimitSource'];

/** Skąd pochodzą liczniki stanu: z pliku, z defaultów (pliku nie ma) albo z defaultów (plik nieczytelny). */
export type MemoryStateSource = 'file' | 'missing' | 'unreadable';

/** Status konsolidacji jednego agenta - kontrakt danych komendy `memory-status`. */
export interface ConsolidationStatus {
    agent: string;
    state: { source: MemoryStateSource; lastArchiveAt: string | null };
    brainNotes: { count: number; limit: number; limitSource: BrainNotesLimitSource; overLimit: boolean };
    sessions: {
        archivedSinceLastConsolidation: number;
        threshold: number;
        overThreshold: boolean;
        uncoveredArchive: number;
        activeFiles: number;
        stateActive: number;
    };
    summaries: { uncoveredL1: number; uncoveredL2: number; batchSize: number };
    /** Ta sama decyzja co produkcyjny trigger (`shouldTriggerConsolidation` z pluginu). */
    wouldTrigger: boolean;
    /** Kroki z `buildPlan` pluginu, w kolejności, tylko `kind`. */
    plan: Array<{ kind: string }>;
}

/**
 * Próg dedupu podawany do `buildPlan` - formuła 1:1 z produkcyjnym
 * `modules/chat/consolidationRunner.ts:startConsolidationRun` (baza z
 * `memoryV3BrainNotesThreshold`, domyślnie 20; `.state.json.brain_notes_limit` ją nadpisuje).
 * CELOWO inna niż `resolveConsolidationThresholds`: tamta ma jeszcze fallback na
 * `archiveBrainNotesThreshold`, którego trigger przebiegu nie zna. Dwie funkcje odpowiadają na
 * dwa różne pytania - nie scalaj ich. Przy zmianie formuły w `consolidationRunner.ts` popraw tutaj.
 */
export function resolvePlanDedupThreshold(state: ThresholdState, settings: ThresholdSettings): number {
    const base = Number(settings?.memoryV3BrainNotesThreshold) || 20;
    return Number(state?.brain_notes_limit) || base;
}

/** Wycinek `AgentMemory`, jakiego potrzebuje własny, lekki odczyt `.state.json`. */
type StateFsView = Pick<AgentMemory, 'vault' | 'paths'>;

function defaultState(): MemoryState {
    return {
        active_sessions: [],
        archived_since_last_consolidation: 0,
        last_archive_at: null,
    };
}

/** `typeof === 'object'`, nie `null`, nie tablica - "obiekt" w sensie `.state.json` (K4:
 *  `JSON.parse` na tablicy `[1,2]` też przechodzi jako `typeof 'object'`, ale to NIE jest kształt
 *  stanu, więc liczy się jako nieczytelny, tak samo jak zepsuty JSON). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Zawęża wynik `JSON.parse(...)` do `Partial<MemoryState>` NA GRANICY (K4, recenzja
 * adwersaryjna) - poprzedni `JSON.parse(...) as Partial<MemoryState>` był castem NA WIARĘ, bez
 * sprawdzenia kształtu: `.state.json` z `"active_sessions": "abc"` dawało `stateActive` liczone
 * jako `.length` STRINGU (3, nie 0), `"active_sessions": {...}` dawało `.length` `undefined`, a
 * `"last_archive_at": 42` przechodziło jako liczba tam, gdzie kod (i CLI) obiecuje `string | null`.
 *
 * Trzy pola, każde osobno, "zły kształt -> tak jakby pole nie przyszło" (nie rzuca, nie wywraca
 * reszty stanu):
 *  - `active_sessions` -> tablica SAMYCH stringów, inaczej `[]` (częściowa tablica - jeden zły
 *    element - też `[]`, nie "przefiltrowana reszta": ma być tablica stringów albo nic);
 *  - `archived_since_last_consolidation` -> skończona liczba (`typeof 'number'`, `Number.isFinite`),
 *    inaczej `0`;
 *  - `last_archive_at` -> string, inaczej `null`.
 *
 * `brain_notes_limit` NIE jest tu walidowane liczbowo - `resolveConsolidationThresholds` (plugin)
 * sama robi `Number(state?.brain_notes_limit) || fallback` na granicy WŁASNEGO modułu (jedno
 * liczydło, nie kopiować). Tu tylko filtr kształtu: przepuszczony jest TYLKO `number`/`string`
 * (to, co `Number(...)` sensownie koerguje), każdy inny kształt (obiekt, tablica, bool) - pole
 * pominięte całkiem, więc `resolveConsolidationThresholds` widzi `undefined` i spada na default.
 *
 * Wynik parsowania, który w ogóle NIE jest obiektem (np. `[1,2]`, `"tekst"`, `42`, `null`) -
 * `null` stąd, co wołacz (`peekState`) traktuje identycznie jak zepsuty JSON -> `source:'unreadable'`.
 */
function normalizeParsedState(parsed: unknown): Partial<MemoryState> | null {
    if (!isPlainObject(parsed)) return null;

    const result: Partial<MemoryState> = {};

    result.active_sessions = Array.isArray(parsed.active_sessions) && parsed.active_sessions.every(item => typeof item === 'string')
        ? parsed.active_sessions as string[]
        : [];

    result.archived_since_last_consolidation = typeof parsed.archived_since_last_consolidation === 'number' && Number.isFinite(parsed.archived_since_last_consolidation)
        ? parsed.archived_since_last_consolidation
        : 0;

    result.last_archive_at = typeof parsed.last_archive_at === 'string' ? parsed.last_archive_at : null;

    if (typeof parsed.brain_notes_limit === 'number' || typeof parsed.brain_notes_limit === 'string') {
        result.brain_notes_limit = parsed.brain_notes_limit;
    }

    return result;
}

/**
 * Odpowiednik `StateManager.peek()`, BEZ importu tamtej klasy (metoda znika z pluginu - żyła
 * tam wyłącznie dla tego jednego wołacza). Zero zapisu, zero bootstrapu.
 *
 * Kolejność jest CELOWO odwrotna względem `probeFile` pluginu (`core/utils/vaultFs.js` - zbyt
 * ciężki import runtime'owy na jedną potrzebę tej małej wtyczki, patrz raport zadania i CLAUDE.md
 * tego folderu): NAJPIERW `read` (ścieżka szczęśliwa - plik istnieje - to JEDNO wywołanie, nie
 * dwa), dopiero pad odczytu pyta `exists()` o potwierdzenie: `exists() === false` -> `'missing'`
 * (dwa niezależne sygnały zgodne, nikt nic nie zapisuje), inaczej (plik wygląda na obecny, ale
 * się nie czyta, ALBO sam `exists()` też padł - fail-closed) -> `'unreadable'`.
 */
async function peekState(agentMemory: StateFsView): Promise<{ state: MemoryState; source: MemoryStateSource }> {
    const path = agentMemory.paths.state;
    const adapter = agentMemory.vault.adapter;

    let raw: string;
    try {
        raw = await adapter.read(path);
    } catch {
        let exists: boolean;
        try {
            exists = await adapter.exists(path);
        } catch {
            exists = true; // sam exists() padł - nie potwierdzamy "nie ma", fail-closed -> unreadable
        }
        return { state: defaultState(), source: exists ? 'unreadable' : 'missing' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw || '{}');
    } catch {
        return { state: defaultState(), source: 'unreadable' };
    }

    const normalized = normalizeParsedState(parsed);
    if (normalized === null) return { state: defaultState(), source: 'unreadable' };
    return { state: { ...defaultState(), ...normalized }, source: 'file' };
}

/**
 * Notatki `brain/` - TYLKO gdy folder już istnieje. `AgentMemory.listBrainNotes()` (metoda
 * ŻYWEJ instancji, wołana bezpośrednio - zero importu wartości z pluginu) sam zakłada folder,
 * gdy go nie ma - niedopuszczalne dla diagnostyki na rozgrzanej instancji.
 *
 * O obecności folderu rozstrzyga LISTING, nie gołe `exists()` (kłamie `false` na dyskach
 * chmurowych) - identyczna logika i uzasadnienie co w źródle.
 */
async function listBrainNotesIfPresent(
    agentMemory: StateFsView & Pick<AgentMemory, 'listBrainNotes'>,
): Promise<BrainNoteInfo[]> {
    const adapter = agentMemory.vault.adapter;
    const folder = agentMemory.paths.brainNotes;
    let entries = 0;
    try {
        const listed = await adapter.list(folder);
        entries = (listed?.files?.length || 0) + (listed?.folders?.length || 0);
    } catch (e) {
        if (await adapter.exists(folder)) throw e;
        return [];
    }
    if (entries === 0 && !(await adapter.exists(folder))) return [];
    return agentMemory.listBrainNotes();
}

/**
 * Liczba plików sesji aktywnych - CZYSTY odczyt katalogu, BEZ `AgentMemory.listActiveSessions()`
 * (ta metoda bootstrapuje `.state.json` przez `stateManager.read()` - efekt uboczny
 * niedopuszczalny dla czystej diagnostyki). Filtr: tylko `.md` BEZPOŚREDNIO w folderze (sesje
 * odłożone żyją w `.discarded/` i nie są już aktywne).
 */
async function countActiveSessionFiles(agentMemory: StateFsView): Promise<number> {
    try {
        const listed = await agentMemory.vault.adapter.list(agentMemory.paths.sessionsActive);
        const prefix = `${agentMemory.paths.sessionsActive}/`;
        let count = 0;
        for (const filePath of listed?.files || []) {
            if (!filePath.endsWith('.md')) continue;
            const rest = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : (filePath.split('/').pop() as string);
            if (rest.includes('/')) continue;
            count++;
        }
        return count;
    } catch {
        return 0;
    }
}

/**
 * Status konsolidacji jednego agenta - czyta przez ISTNIEJĄCE metody żywej instancji (żadnego
 * bebechowego dostępu do plików - `agentMemory` przychodzi z `AgentManager.getAgentMemory()`
 * hosta, to jest OBIEKT, nie import), poza dwoma czystymi wyjątkami wyżej
 * (`countActiveSessionFiles`/`listBrainNotesIfPresent`), które świadomie OMIJAJĄ metody
 * instancji, żeby ominąć ich efekty uboczne.
 *
 * SEKWENCYJNIE, nie `Promise.all`: `listUncoveredArchiveSessions()` woła
 * `ensureMemoryStructure()` (memoizowane per instancja, flaga zapala się dopiero PO całym
 * bootstrapie) - na zimnej instancji dwa wywołania trafiające w `ensureMemoryStructure` zanim
 * któreś zdąży ustawić flagę odpalałyby bootstrap dwa razy równolegle. Kolejność sekwencyjna
 * zostaje jako świadoma ochrona, 1:1 ze źródłem.
 */
export async function getConsolidationStatus(agentMemory: AgentMemory): Promise<ConsolidationStatus> {
    const { state, source } = await peekState(agentMemory);

    const brainNotes = await listBrainNotesIfPresent(agentMemory);
    const uncoveredArchive = await agentMemory.listUncoveredArchiveSessions();
    const activeFiles = await countActiveSessionFiles(agentMemory);
    const uncoveredL1 = await agentMemory.listUncoveredL1s();
    const uncoveredL2 = await agentMemory.listUncoveredL2s();

    const thresholds = resolveConsolidationThresholds(state, agentMemory.settings);
    const brainNotesCount = brainNotes.length;
    const archivedSinceLastConsolidation = Number(state.archived_since_last_consolidation || 0);

    const plan = buildConsolidationPlan({
        archiveCount: uncoveredArchive.length,
        batchSize: thresholds.batchSize,
        brainNotesCount,
        dedupThreshold: resolvePlanDedupThreshold(state, agentMemory.settings),
        l1Count: uncoveredL1.length,
        l2Count: uncoveredL2.length,
    });

    return {
        agent: agentMemory.agentName,
        state: { source, lastArchiveAt: state.last_archive_at ?? null },
        brainNotes: {
            count: brainNotesCount,
            limit: thresholds.brainNotesLimit,
            limitSource: thresholds.brainNotesLimitSource,
            overLimit: brainNotesCount > thresholds.brainNotesLimit,
        },
        sessions: {
            archivedSinceLastConsolidation,
            threshold: thresholds.sessionThreshold,
            overThreshold: archivedSinceLastConsolidation >= thresholds.sessionThreshold,
            uncoveredArchive: uncoveredArchive.length,
            activeFiles,
            stateActive: (state.active_sessions || []).length,
        },
        summaries: {
            uncoveredL1: uncoveredL1.length,
            uncoveredL2: uncoveredL2.length,
            batchSize: thresholds.batchSize,
        },
        wouldTrigger: shouldTriggerConsolidation(state, brainNotesCount, agentMemory.settings),
        plan: plan.map(step => ({ kind: step.kind })),
    };
}
