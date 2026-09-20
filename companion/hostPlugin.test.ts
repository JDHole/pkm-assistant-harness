import test from 'ava';
import { resolveHost, resolvePluginBundleMtime } from './hostPlugin.js';

/**
 * `resolveHost` jest NOWY w tym repo (nie ma odpowiednika w `modules/cli/` pluginu - tam
 * `src/main.ts` po prostu przekazywał `this` przez zamknięcie, bo CLI żyło W TYM SAMYM
 * pluginie). Testy pokrywają zawężanie na granicy: `typeof`/`in`, sprawdzenie że metody agent
 * managera są funkcjami, dopiero potem cast.
 */

function makeApp(pluginsRegistry: Record<string, unknown> | undefined): unknown {
    if (pluginsRegistry === undefined) return {};
    return { plugins: { plugins: pluginsRegistry } };
}

const FULL_AGENT_MANAGER = {
    getAllAgents: () => [],
    getAgent: () => undefined,
    getActiveAgent: () => null,
    getPromptInspectorDataForAgent: async () => ({ sections: [], breakdown: { total: 0, sections: [] } }),
    getAgentMemory: () => null,
};

// ── kształt `app` ──────────────────────────────────────────────────────────────────────

test('app nie-obiekt (null/string/liczba) -> null', t => {
    t.is(resolveHost(null), null);
    t.is(resolveHost('nope'), null);
    t.is(resolveHost(42), null);
});

test('app bez pola plugins -> null', t => {
    t.is(resolveHost({}), null);
});

test('app.plugins bez pola plugins -> null', t => {
    t.is(resolveHost({ plugins: {} }), null);
});

test('app.plugins.plugins bez klucza pkm-assistant -> null', t => {
    t.is(resolveHost(makeApp({})), null);
});

test('app.plugins.plugins["pkm-assistant"] nie-obiekt (null/string) -> null', t => {
    t.is(resolveHost(makeApp({ 'pkm-assistant': null })), null);
    t.is(resolveHost(makeApp({ 'pkm-assistant': 'nope' })), null);
});

// ── manifest (id/version) ──────────────────────────────────────────────────────────────

test('host bez manifestu -> id/version domyślne (pkm-assistant/unknown)', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': {} }));
    t.truthy(host);
    t.is(host?.id, 'pkm-assistant');
    t.is(host?.version, 'unknown');
});

test('host z manifestem {id, version} -> odzwierciedlone 1:1', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { manifest: { id: 'pkm-assistant', version: '2.2.8' } } }));
    t.is(host?.id, 'pkm-assistant');
    t.is(host?.version, '2.2.8');
});

test('manifest z polami nie-stringowymi -> traktowane jak brak (defaulty)', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { manifest: { id: 42, version: null } } }));
    t.is(host?.id, 'pkm-assistant');
    t.is(host?.version, 'unknown');
});

// ── _ready ──────────────────────────────────────────────────────────────────────────────

test('host bez pola _ready -> isReady:false', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': {} }));
    t.is(host?.isReady, false);
});

test('host z _ready:true -> isReady:true; _ready:false -> isReady:false', t => {
    t.is(resolveHost(makeApp({ 'pkm-assistant': { _ready: true } }))?.isReady, true);
    t.is(resolveHost(makeApp({ 'pkm-assistant': { _ready: false } }))?.isReady, false);
});

test('_ready nie-boolean (string) -> traktowane jak brak, isReady:false', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { _ready: 'true' } }));
    t.is(host?.isReady, false);
});

// ── agentManager ────────────────────────────────────────────────────────────────────────

test('host bez pola agentManager -> agentManager undefined', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': {} }));
    t.is(host?.agentManager, undefined);
});

test('agentManager z KOMPLETEM pięciu metod-funkcji -> zwrócony (ta sama referencja, po walidacji)', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { agentManager: FULL_AGENT_MANAGER } }));
    t.is(host?.agentManager, FULL_AGENT_MANAGER);
});

test('agentManager z BRAKUJĄCĄ jedną metodą -> undefined (fail-closed, nie połowiczny obiekt)', t => {
    const { getAgentMemory: _drop, ...incomplete } = FULL_AGENT_MANAGER;
    void _drop;
    const host = resolveHost(makeApp({ 'pkm-assistant': { agentManager: incomplete } }));
    t.is(host?.agentManager, undefined);
});

test('agentManager z metodą, która NIE jest funkcją (np. string) -> undefined', t => {
    const broken = { ...FULL_AGENT_MANAGER, getAgent: 'not-a-function' };
    const host = resolveHost(makeApp({ 'pkm-assistant': { agentManager: broken } }));
    t.is(host?.agentManager, undefined);
});

test('agentManager nie-obiekt (null) -> undefined', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { agentManager: null } }));
    t.is(host?.agentManager, undefined);
});

// ── indexStatus ─────────────────────────────────────────────────────────────────────────

test('host bez vaultIndexer -> indexStatus undefined', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': {} }));
    t.is(host?.indexStatus, undefined);
});

test('vaultIndexer.getStatus() zwraca poprawny kształt -> indexStatus zwrócony', t => {
    const status = { status: 'ready', progress: { indexed: 3, total: 3 }, modelKey: 'x', lastError: null };
    const host = resolveHost(makeApp({ 'pkm-assistant': { vaultIndexer: { getStatus: () => status } } }));
    t.deepEqual(host?.indexStatus, status);
});

test('vaultIndexer.getStatus() RZUCA -> indexStatus undefined, resolveHost nie propaguje wyjątku', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { vaultIndexer: { getStatus: () => { throw new Error('boom'); } } } }));
    t.is(host?.indexStatus, undefined);
});

test('vaultIndexer.getStatus() zwraca kształt bez pola status (string) -> indexStatus undefined', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { vaultIndexer: { getStatus: () => ({ progress: {} }) } } }));
    t.is(host?.indexStatus, undefined);
});

test('vaultIndexer bez getStatus jako funkcji -> indexStatus undefined', t => {
    const host = resolveHost(makeApp({ 'pkm-assistant': { vaultIndexer: {} } }));
    t.is(host?.indexStatus, undefined);
});

// ── raw ─────────────────────────────────────────────────────────────────────────────────

test('host.raw jest DOKŁADNIE tym samym obiektem referencyjnie (identity, nie kopia)', t => {
    const pkmAssistant = { agentManager: FULL_AGENT_MANAGER };
    const host = resolveHost(makeApp({ 'pkm-assistant': pkmAssistant }));
    t.is(host?.raw, pkmAssistant);
});

// ── K3: resolvePluginBundleMtime - ISO mtime <configDir>/plugins/pkm-assistant/main.js ────

function makeStatApp(configDir: unknown, statImpl: ((path: string) => unknown) | undefined): unknown {
    return { vault: { configDir, adapter: statImpl ? { stat: statImpl } : {} } };
}

test('resolvePluginBundleMtime: app nie-obiekt (null/string/liczba) -> null', async t => {
    t.is(await resolvePluginBundleMtime(null), null);
    t.is(await resolvePluginBundleMtime('nope'), null);
    t.is(await resolvePluginBundleMtime(42), null);
});

test('resolvePluginBundleMtime: brak app.vault -> null', async t => {
    t.is(await resolvePluginBundleMtime({}), null);
});

test('resolvePluginBundleMtime: configDir nie-string (brak/liczba/pusty) -> null, stat NIE wołane', async t => {
    let called = false;
    const stat = () => { called = true; return { mtime: 1 }; };
    t.is(await resolvePluginBundleMtime(makeStatApp(undefined, stat)), null);
    t.is(await resolvePluginBundleMtime(makeStatApp(42, stat)), null);
    t.is(await resolvePluginBundleMtime(makeStatApp('', stat)), null);
    t.false(called, 'configDir zły kształt -> stat() nie ma prawa się wykonać');
});

test('resolvePluginBundleMtime: adapter bez stat() jako funkcji -> null', async t => {
    t.is(await resolvePluginBundleMtime(makeStatApp('.obsidian', undefined)), null);
});

test('resolvePluginBundleMtime: stat() zwraca {mtime} -> ISO string tego mtime, ścieżka = <configDir>/plugins/pkm-assistant/main.js', async t => {
    let receivedPath: string | undefined;
    const mtime = Date.UTC(2026, 8, 20, 10, 0, 0);
    const stat = (path: string) => { receivedPath = path; return { mtime }; };

    const result = await resolvePluginBundleMtime(makeStatApp('.obsidian', stat));

    t.is(result, new Date(mtime).toISOString());
    t.is(receivedPath, '.obsidian/plugins/pkm-assistant/main.js');
});

test('resolvePluginBundleMtime: stat() zwraca null (plik nie istnieje) -> null', async t => {
    const stat = () => null;
    t.is(await resolvePluginBundleMtime(makeStatApp('.obsidian', stat)), null);
});

test('resolvePluginBundleMtime: stat() zwraca kształt bez pola mtime (liczba) -> null', async t => {
    const stat = () => ({ size: 123 });
    t.is(await resolvePluginBundleMtime(makeStatApp('.obsidian', stat)), null);
});

test('resolvePluginBundleMtime: stat() RZUCA -> null, resolvePluginBundleMtime nie propaguje wyjątku', async t => {
    const stat = () => { throw new Error('boom'); };
    t.is(await resolvePluginBundleMtime(makeStatApp('.obsidian', stat)), null);
});
