/**
 * hostPlugin.ts — rozwiązywanie ŻYWEJ instancji hosta (`pkm-assistant`) z `app.plugins.plugins`.
 *
 * PO CO: `companion/` (id `pkm-assistant-dev`) nie ROBI nic sam - jest tylko nosicielem
 * czterech komend CLI Obsidiana, które pytają o stan INNEGO, głównego pluginu. `resolveHost`
 * jest wołane PRZY KAŻDYM wywołaniu komendy (nigdy raz w `onload()`): główny plugin bywa
 * przeładowywany niezależnie (`plugin:reload id=pkm-assistant`), a trzymana referencja
 * wskazywałaby martwą instancję.
 *
 * Host przychodzi jako `unknown` (inny bundle, inny moduł `obsidian`, żadnego `instanceof` -
 * dwie różne klasy `Plugin` z dwóch różnych bundli NIGDY nie przejdą `instanceof`) i jest
 * zawężany NA GRANICY: `typeof`/`in`, sprawdzenie że potrzebne metody są funkcjami - dopiero
 * POTEM typ (`as` na końcu, po walidacji, nigdy na wiarę). Brak hosta, albo host bez
 * kompletu metod agenta, oddaje `undefined`/`null` - wołacz (`commands.ts`) decyduje, co
 * z tym zrobić (`status` czyta co jest, reszta komend odmawia `not_ready`).
 */
import type { AgentManager } from '@plugin/modules/agents/index.js';

/** Id manifestu hosta, którego szuka ta wtyczka-nosiciel. */
const HOST_PLUGIN_ID = 'pkm-assistant';

/**
 * Wąski wycinek `AgentManager`, na którym stoją komendy `agent-prompt`/`memory-status` -
 * `Pick`, nie cała klasa (ten plik nie ma prawa importować bebechów `modules/agents/`
 * WARTOŚCIOWO - tylko typ, wyłącznie do sprawdzania zgodności na `npm run typecheck`).
 */
export type CliAgentManager = Pick<
    AgentManager,
    'getAllAgents' | 'getAgent' | 'getActiveAgent' | 'getPromptInspectorDataForAgent' | 'getAgentMemory'
>;

/** Status jednego wpisu indeksu wektorowego, tak jak go widzi CLI (bez importu z `modules/embedding/`). */
export interface CliIndexStatus {
    status: string;
    progress?: { indexed?: number; total?: number };
    modelKey?: string | null;
    lastError?: unknown;
}

/**
 * Widok żywej instancji hosta, zwalidowany na granicy. `raw` idzie do `buildSelfTestReport`
 * (kontrakt `SelfTestPlugin` z `core/selftest.js` ma WSZYSTKIE pola opcjonalne z założenia -
 * "raport ma nigdy nie wybuchnąć") i do śledzenia tożsamości instancji (`instanceSince`
 * w `commands.ts`, porównanie referencji `===`).
 */
export interface ResolvedHost {
    raw: Record<string, unknown>;
    id: string;
    version: string;
    isReady: boolean;
    agentManager: CliAgentManager | undefined;
    indexStatus: CliIndexStatus | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Metody, które MUSZĄ być funkcjami, żeby obiekt liczył się jako `CliAgentManager`. */
const AGENT_MANAGER_METHODS = [
    'getAllAgents',
    'getAgent',
    'getActiveAgent',
    'getPromptInspectorDataForAgent',
    'getAgentMemory',
] as const;

function resolveAgentManager(raw: Record<string, unknown>): CliAgentManager | undefined {
    const candidate = raw.agentManager;
    if (!isRecord(candidate)) return undefined;
    for (const method of AGENT_MANAGER_METHODS) {
        if (typeof candidate[method] !== 'function') return undefined;
    }
    // Walidacja skończona (każda z pięciu metod jest funkcją) - `as` tutaj NIE jest castem
    // na wiarę, tylko finalnym krokiem po sprawdzeniu kształtu.
    return candidate as unknown as CliAgentManager;
}

function resolveIndexStatus(raw: Record<string, unknown>): CliIndexStatus | undefined {
    const indexer = raw.vaultIndexer;
    if (!isRecord(indexer) || typeof indexer.getStatus !== 'function') return undefined;
    let status: unknown;
    try {
        status = indexer.getStatus();
    } catch {
        return undefined;
    }
    if (!isRecord(status) || typeof status.status !== 'string') return undefined;
    return status as unknown as CliIndexStatus;
}

function resolveManifest(raw: Record<string, unknown>): { id: string; version: string } {
    const manifest = raw.manifest;
    const id = isRecord(manifest) && typeof manifest.id === 'string' ? manifest.id : HOST_PLUGIN_ID;
    const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : 'unknown';
    return { id, version };
}

function resolveIsReady(raw: Record<string, unknown>): boolean {
    return typeof raw._ready === 'boolean' ? raw._ready : false;
}

/**
 * ISO mtime bundla HOSTA na dysku (`<configDir>/plugins/pkm-assistant/main.js`, K3) - NIE mtime
 * tej wtyczki. Po co: `companion/` wkompilowuje progi konsolidacji/plan/raport selftestu ze
 * ŹRÓDEŁ pluginu W CHWILI WŁASNEGO builda (patrz `companion/buildInfo.ts`) - jeśli plugin w
 * vaulcie zostanie przebudowany PÓŹNIEJ, ta wtyczka o tym nie wie. `StatusData.companionStale`
 * (`cli/commands.ts`) porównuje ten znacznik z `companion.builtAt`, żeby to ujawnić.
 *
 * Czyta `app.vault.configDir` (nazwa folderu konfiguracji Obsidiana - NIE zgadywana, tak jak
 * `AccessGuard.setConfigDir` w pluginie) i `app.vault.adapter.stat(...)`, zawężając NA GRANICY
 * jak `resolveHost` - `null` na każdym brakującym/złym kształcie, fail-soft (nigdy nie rzuca).
 */
export async function resolvePluginBundleMtime(app: unknown): Promise<string | null> {
    if (!isRecord(app)) return null;
    const vault = app.vault;
    if (!isRecord(vault)) return null;
    if (typeof vault.configDir !== 'string' || vault.configDir === '') return null;
    const adapter = vault.adapter;
    if (!isRecord(adapter) || typeof adapter.stat !== 'function') return null;

    let stat: unknown;
    try {
        stat = await adapter.stat(`${vault.configDir}/plugins/${HOST_PLUGIN_ID}/main.js`);
    } catch {
        return null;
    }
    if (!isRecord(stat) || typeof stat.mtime !== 'number') return null;
    return new Date(stat.mtime).toISOString();
}

/**
 * Rozwiązuje żywą instancję hosta z `app.plugins.plugins['pkm-assistant']`. `null`, gdy hosta
 * nie ma w ogóle (nie zainstalowany, wyłączony, albo `app.plugins` nie ma oczekiwanego
 * kształtu - atrapy testowe bywają skromniejsze niż prawdziwy Obsidian).
 */
export function resolveHost(app: unknown): ResolvedHost | null {
    if (!isRecord(app)) return null;
    const pluginsContainer = app.plugins;
    if (!isRecord(pluginsContainer)) return null;
    const registry = pluginsContainer.plugins;
    if (!isRecord(registry)) return null;
    const raw = registry[HOST_PLUGIN_ID];
    if (!isRecord(raw)) return null;

    const { id, version } = resolveManifest(raw);
    return {
        raw,
        id,
        version,
        isReady: resolveIsReady(raw),
        agentManager: resolveAgentManager(raw),
        indexStatus: resolveIndexStatus(raw),
    };
}
