import test from 'ava';
import { AgentMemory } from '@plugin/modules/memory/AgentMemory.js';
import { getConsolidationStatus } from './memoryStatus.js';

/**
 * PRZENIESIONE z `modules/memory/consolidationStatus.test.ts` pluginu - sekcja
 * `getConsolidationStatus` (integracja na realnej `AgentMemory`, na atrapie adaptera). Import
 * `AgentMemory` jako WARTOŚĆ pod `tsx`/AVA harnessu DZIAŁA bez atrapy `obsidian` (zweryfikowane
 * ręcznie przed napisaniem tego pliku - `AgentMemory.ts` i jej cały łańcuch importów w
 * `modules/memory/` nie dotykają `obsidian` jako WARTOŚCI, tylko `modules/memory/SettingsContent.ts`
 * ma `import type { Setting } from 'obsidian'`, co znika przy transpilacji), więc żaden przypadek
 * nie musiał zejść na krok scenariusza.
 *
 * Testy PURE funkcji (`resolveConsolidationThresholds`, `shouldTriggerConsolidation`,
 * `resolvePlanDedupThreshold`) oraz testy `StateManager.peek()` bezpośrednio NIE są tu
 * powtórzone - ta logika zostaje w pluginie NIEZMIENIONA (importowana runtime'owo z
 * `@plugin/modules/memory/consolidationStatus.js`/`ConsolidationRun.js`, patrz nagłówek
 * `memoryStatus.ts`) i jest już pokryta testami w repo pluginu; `StateManager.peek()` znika
 * z pluginu wraz z tą wyprowadzką i nie ma czego tu testować bezpośrednio - jego zastępstwo
 * (`peekState`, prywatne w `memoryStatus.ts`) jest sprawdzane POŚREDNIO, przez zachowanie
 * `getConsolidationStatus` (`state.source`), dokładnie jak chce specyfikacja zadania.
 */

function makeVault(initialFiles: Record<string, string> = {}, initialFolders: string[] = []) {
    const files: Record<string, string> = { ...initialFiles };
    const folders = new Set<string>(initialFolders);
    const calls: string[] = [];

    const parentFoldersFor = (path: string): string[] => {
        const parts = path.split('/');
        const result: string[] = [];
        for (let i = 1; i < parts.length; i++) {
            result.push(parts.slice(0, i).join('/'));
        }
        return result;
    };

    for (const path of Object.keys(files)) {
        for (const folder of parentFoldersFor(path)) folders.add(folder);
    }

    return {
        files,
        folders,
        calls,
        vault: {
            adapter: {
                async exists(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) || folders.has(path);
                },
                async mkdir(path: string) {
                    calls.push(`mkdir:${path}`);
                    folders.add(path);
                },
                async read(path: string) {
                    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`missing: ${path}`);
                    return files[path];
                },
                async write(path: string, content: string) {
                    calls.push(`write:${path}`);
                    for (const folder of parentFoldersFor(path)) folders.add(folder);
                    files[path] = content;
                },
                async remove(path: string) {
                    calls.push(`remove:${path}`);
                    delete files[path];
                },
                async append(path: string, content: string) {
                    calls.push(`append:${path}`);
                    files[path] = (files[path] || '') + content;
                },
                async rename(oldPath: string, newPath: string) {
                    calls.push(`rename:${oldPath}->${newPath}`);
                    if (Object.prototype.hasOwnProperty.call(files, oldPath)) {
                        files[newPath] = files[oldPath];
                        delete files[oldPath];
                    }
                },
                async copy(oldPath: string, newPath: string) {
                    calls.push(`copy:${oldPath}->${newPath}`);
                    if (Object.prototype.hasOwnProperty.call(files, oldPath)) {
                        files[newPath] = files[oldPath];
                    }
                },
                async list(folder: string) {
                    const prefix = `${folder}/`;
                    return {
                        files: Object.keys(files).filter(path => path.startsWith(prefix)),
                        folders: [...folders].filter(path => path.startsWith(prefix) && path !== folder),
                    };
                },
                async stat(path: string) {
                    return Object.prototype.hasOwnProperty.call(files, path) ? { mtime: 1 } : null;
                },
            },
        },
    };
}

function note(name: string, type = 'reference'): string {
    return `---
name: ${name}
description: opis
type: ${type}
created: 2026-05-14
---

Treść.
`;
}

const BASE = '.pkm-assistant/agents/agent/memory';

// ── granica: .state.json brakujący - source=missing ───────────────────────────────────

test('getConsolidationStatus: świeży agent bez plików - defaulty, plan pusty, wouldTrigger=false', async t => {
    // ZIMNA instancja (bez `initialize()`), 1:1 ze źródłem (`modules/memory/consolidationStatus.test.ts`).
    // Świadomie BEZ asercji "zero zapisu" tutaj - na zimnej instancji `listUncoveredArchiveSessions()`
    // (metoda INNA niż `peekState`) i tak woła `ensureMemoryStructure()` i materializuje `.state.json`
    // na dysku (znane, zaakceptowane ograniczenie diagnostyki - patrz nagłówek `memoryStatus.ts` i
    // dedykowany test niżej "na ZIMNEJ instancji"). Zero-zapisu dla `peekState` samego w sobie
    // sprawdza osobny test na ROZGRZANEJ instancji (`calls` deepEqual []).
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.deepEqual(status, {
        agent: 'Agent',
        state: { source: 'missing', lastArchiveAt: null },
        brainNotes: { count: 0, limit: 20, limitSource: 'default', overLimit: false },
        sessions: {
            archivedSinceLastConsolidation: 0,
            threshold: 10,
            overThreshold: false,
            uncoveredArchive: 0,
            activeFiles: 0,
            stateActive: 0,
        },
        summaries: { uncoveredL1: 0, uncoveredL2: 0, batchSize: 5 },
        wouldTrigger: false,
        plan: [],
    });
});

// ── granica: 20/21 notatek ─────────────────────────────────────────────────────────────

test('getConsolidationStatus: 20 notatek na limicie 20 -> overLimit=false', async t => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 20; i++) files[`${BASE}/brain/reference_${i}.md`] = note(`Notatka ${i}`);
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.count, 20);
    t.is(status.brainNotes.limit, 20);
    t.false(status.brainNotes.overLimit);
    t.false(status.wouldTrigger);
});

test('getConsolidationStatus: 21 notatek nad limitem 20 -> overLimit=true i wouldTrigger=true', async t => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) files[`${BASE}/brain/reference_${i}.md`] = note(`Notatka ${i}`);
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.count, 21);
    t.true(status.brainNotes.overLimit);
    t.true(status.wouldTrigger);
    t.true(status.plan.some(step => step.kind === 'dedup'));
});

// ── granica: 10 sesji zarchiwizowanych ─────────────────────────────────────────────────

test('getConsolidationStatus: 10 zarchiwizowanych sesji przy progu 10 -> overThreshold=true i wouldTrigger=true', async t => {
    const state = JSON.stringify({ active_sessions: [], archived_since_last_consolidation: 10, last_archive_at: '2026-09-01T00:00:00.000Z' });
    const { vault } = makeVault({ [`${BASE}/.state.json`]: state });
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'file');
    t.is(status.state.lastArchiveAt, '2026-09-01T00:00:00.000Z');
    t.is(status.sessions.archivedSinceLastConsolidation, 10);
    t.is(status.sessions.threshold, 10);
    t.true(status.sessions.overThreshold);
    t.true(status.wouldTrigger);
});

// ── trzy źródła limitSource: default (patrz test wyżej) / settings / agent_state ──────────

test('getConsolidationStatus: memoryV3BrainNotesThreshold z ustawień (bez brain_notes_limit w stanie) -> limitSource=settings', async t => {
    const { vault } = makeVault();
    const memory = new AgentMemory(vault, 'Agent', { memoryV3BrainNotesThreshold: 15 });

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.limit, 15);
    t.is(status.brainNotes.limitSource, 'settings');
});

test('getConsolidationStatus: state.brain_notes_limit z .state.json -> limitSource=agent_state (pierwszeństwo nad ustawieniami)', async t => {
    const state = JSON.stringify({ active_sessions: [], archived_since_last_consolidation: 0, last_archive_at: null, brain_notes_limit: 30 });
    const { vault } = makeVault({ [`${BASE}/.state.json`]: state });
    const memory = new AgentMemory(vault, 'Agent', { memoryV3BrainNotesThreshold: 15 });

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.limit, 30);
    t.is(status.brainNotes.limitSource, 'agent_state');
});

// ── .state.json uszkodzony -> unreadable ──────────────────────────────────────────────

test('getConsolidationStatus: uszkodzony .state.json (JSON.parse pada) -> state.source=unreadable, liczniki spadają na defaulty', async t => {
    const { vault } = makeVault({ [`${BASE}/.state.json`]: '{broken' });
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'unreadable');
    t.is(status.sessions.archivedSinceLastConsolidation, 0);
});

test('getConsolidationStatus: .state.json ISTNIEJE (exists()=true) ale read() RZUCA -> source=unreadable, nie missing (peekState: read-first, potem exists() potwierdza)', async t => {
    const { vault, files } = makeVault({ [`${BASE}/.state.json`]: 'nieważne, read i tak padnie' });
    const honestRead = vault.adapter.read.bind(vault.adapter);
    vault.adapter.read = async (path: string) => {
        if (path === `${BASE}/.state.json`) throw new Error('I/O padło mimo że plik jest');
        return honestRead(path);
    };
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'unreadable');
    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`), 'plik zostaje NIETKNIĘTY - peekState nigdy nie pisze');
});

// ── aktywne sesje / niepokryte archiwum ────────────────────────────────────────────────

test('getConsolidationStatus: aktywne sesje i niepokryte archiwum liczone osobno', async t => {
    const files: Record<string, string> = {
        [`${BASE}/sessions/active/Agent_2026-09-20_10-00.md`]: '---\nagent: Agent\n---\n',
        [`${BASE}/sessions/archive/2026-09-01_09-00.md`]: '---\nagent: Agent\ncreated: 2026-09-01\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1);
    t.is(status.sessions.uncoveredArchive, 1);
    t.false(status.plan.some(step => step.kind === 'l1'));
});

// ── rozgrzana instancja: zero zapisu, nawet gdy .state.json i brain/ zniknęły po starcie ──

test('getConsolidationStatus na ROZGRZANEJ instancji: .state.json i brain/ zniknęły po starcie -> ZERO zapisu, źródła zostają puste', async t => {
    const { vault, files, folders, calls } = makeVault();
    const memory = new AgentMemory(vault, 'Agent');

    await memory.initialize();
    t.true(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`), 'sanity: initialize() zakłada .state.json');
    t.true(folders.has(`${BASE}/brain`), 'sanity: initialize() zakłada brain/');

    delete files[`${BASE}/.state.json`];
    for (const folder of [...folders]) {
        if (folder === `${BASE}/brain` || folder.startsWith(`${BASE}/brain/`)) folders.delete(folder);
    }
    calls.length = 0;

    const status = await getConsolidationStatus(memory);

    t.deepEqual(calls, [], 'getConsolidationStatus na rozgrzanej instancji nie ma prawa nic zapisać');
    t.is(status.state.source, 'missing');
    t.is(status.brainNotes.count, 0);
    t.false(Object.prototype.hasOwnProperty.call(files, `${BASE}/.state.json`), '.state.json dalej NIE istnieje');
    t.false(folders.has(`${BASE}/brain`), 'brain/ dalej NIE istnieje');
});

// ── stateActive vs activeFiles - rozjazd widoczny ──────────────────────────────────────

test('getConsolidationStatus: sessions.stateActive (z .state.json) i sessions.activeFiles (z dysku) liczone NIEZALEŻNIE - rozjazd jest widoczny', async t => {
    const state = JSON.stringify({
        active_sessions: ['Agent_2026-09-19_08-00.md', 'zombie.md'],
        archived_since_last_consolidation: 0,
        last_archive_at: null,
    });
    const files: Record<string, string> = {
        [`${BASE}/.state.json`]: state,
        [`${BASE}/sessions/active/Agent_2026-09-19_08-00.md`]: '---\nagent: Agent\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1, 'z listowania katalogu - jeden PRAWDZIWY plik');
    t.is(status.sessions.stateActive, 2, 'z .state.json - dwie sesje, w tym jedna bez pliku');
});

test('getConsolidationStatus: activeFiles pomija podfolder .discarded/, licząc TYLKO pliki bezpośrednio w sessions/active', async t => {
    const files: Record<string, string> = {
        [`${BASE}/sessions/active/Agent_2026-09-20_10-00.md`]: '---\nagent: Agent\n---\n',
        [`${BASE}/sessions/active/.discarded/Agent_2026-09-18_09-00.md`]: '---\nagent: Agent\n---\n',
    };
    const { vault } = makeVault(files);
    const memory = new AgentMemory(vault, 'Agent');

    const status = await getConsolidationStatus(memory);

    t.is(status.sessions.activeFiles, 1);
});

// ── zimna instancja: bootstrap dokładnie raz ──────────────────────────────────────────

test('getConsolidationStatus na ZIMNEJ instancji: bootstrap struktury odpala się dokładnie raz (bez podwójnego mkdir z równoległych wywołań)', async t => {
    const { vault, calls } = makeVault();
    const memory = new AgentMemory(vault, 'Agent'); // celowo BEZ initialize() - zimna instancja

    await getConsolidationStatus(memory);

    const mkdirPaths = calls.filter(c => c.startsWith('mkdir:')).map(c => c.slice('mkdir:'.length));
    const uniqueMkdirPaths = new Set(mkdirPaths);
    t.is(mkdirPaths.length, 11, `bootstrap zimnej instancji zakłada 11 folderów: ${JSON.stringify(mkdirPaths)}`);
    t.is(uniqueMkdirPaths.size, 11, `każdy folder zakładany DOKŁADNIE raz, nie dwa razy równolegle: ${JSON.stringify(mkdirPaths)}`);
});

// ── exists() kłamiące false na brain/ ──────────────────────────────────────────────────

test('getConsolidationStatus: exists() KŁAMIE false na folderze brain/ (dysk chmurowy) -> notatki i tak policzone, jak w produkcyjnym listBrainNotes()', async t => {
    const { vault } = makeVault({
        [`${BASE}/brain/user_a.md`]: note('A', 'user'),
        [`${BASE}/brain/user_b.md`]: note('B', 'user'),
    });
    const memory = new AgentMemory(vault, 'Agent');
    await memory.initialize();

    const honestExists = vault.adapter.exists;
    vault.adapter.exists = async (path: string) => (path === `${BASE}/brain` ? false : honestExists(path));

    const status = await getConsolidationStatus(memory);

    t.is(status.brainNotes.count, 2);
});

// ── active_sessions: null (JSON poprawny, kształt zepsuty) ─────────────────────────────

test('getConsolidationStatus: .state.json z "active_sessions": null (poprawny JSON, zepsuty kształt) -> stateActive=0, status nie rzuca', async t => {
    const { vault, files } = makeVault();
    const memory = new AgentMemory(vault, 'Agent');
    await memory.initialize();
    files[`${BASE}/.state.json`] = '{"active_sessions": null, "archived_since_last_consolidation": 3}';

    const status = await getConsolidationStatus(memory);

    t.is(status.state.source, 'file');
    t.is(status.sessions.stateActive, 0);
    t.is(status.sessions.archivedSinceLastConsolidation, 3);
});
