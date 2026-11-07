/** P6: wspólne wejścia publiczne, odczyt trwałych blobów i bariery zdarzeń.
 * Żadnej repliki logiki kopii: zapis/review wykonuje produkcyjny MCP i runner.
 */
import { DraftPersistence, DraftStore, DraftView } from '@plugin/modules/vault-drafts/index.js';
import type { ChangeSummary } from '@plugin/modules/vault-drafts/index.js';
import { desktopDraftPorts } from '@plugin/modules/tools/index.js';
import type { SubTask } from '@plugin/modules/sub-agents/index.js';
import { lastToolResults, textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

export const FILE = 'Notatki/kopia.md';
export const Y = 'Notatki/druga-kopia.md';
const origin = { agentName: 'Tester', sessionPath: '', sessionEpoch: '', tabKey: 'kopie' };
export function equal(actual: unknown, expected: unknown, label: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: oczekiwano ${JSON.stringify(expected)}, otrzymano ${JSON.stringify(actual)}.`);
}
export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
/** Timer jest wyłącznie limitem błędu; nigdy sygnałem zakończenia pracy. */
export async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Brak zdarzenia: ${label}`)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
export async function mcp(plugin: FixturePayload, name: string, args: FixturePayload) {
  return plugin.mcpClient.executeToolCall({ id: `p6-${name}`, name, arguments: args }, 'Tester', { autonomy: 'yolo', origin });
}
export async function listed(plugin: FixturePayload, detail?: ChangeSummary): Promise<ChangeSummary[]> {
  const result = await mcp(plugin, 'subagent_changes', { action: 'list', scope: 'agent',
    ...(detail ? { draft_id: detail.draft_id, change_id: detail.change_id } : {}) });
  equal(result.kind, 'listed', 'Status list prowadzącego');
  equal(result.next_cursor, null, 'Kompletna lista zmian');
  return result.changes;
}
export async function decide(plugin: FixturePayload, item: ChangeSummary, action: 'accept' | 'reject', kind: string) {
  const result = await mcp(plugin, 'subagent_changes', { action, draft_id: item.draft_id, change_id: item.change_id, revision: item.revision });
  equal(result.kind, kind, `${action} ${item.path}`);
  if (kind === 'conflict') equal([result.isError, result.reason], [true, 'base-changed'], 'Konflikt nie pozwala przyjąć');
  return result;
}
/** Nowy store, bez cache poprzedniego runtime; restore waliduje manifesty i SHA blobów. */
export async function disk(app: FixturePayload) {
  const ports = desktopDraftPorts(app);
  const persistence = new DraftPersistence(ports.storage, ports.hasher);
  const saved = await persistence.loadAll();
  equal(saved.issues, [], 'Odczyt generacji bez błędów');
  assert(saved.manifests.every(m => m.phase.kind === 'sealed'), 'Odczyt kontrolny dopiero po trwałym zamknięciu wszystkich kopii');
  const store = new DraftStore(persistence, ports.vault, { now: () => Date.now() });
  const restored = await store.restore();
  equal(restored.issues, [], 'Odtworzenie magazynu bez błędów');
  return { store, persistence, view: (id: ChangeSummary['draft_id']) => new DraftView(store, persistence, ports.vault, id) };
}
export async function persisted(app: FixturePayload, item: ChangeSummary, before: string, after: string, status: string) {
  const fresh = await disk(app);
  const manifest = fresh.store.snapshot(item.draft_id);
  equal(manifest.phase.kind, 'sealed', 'Kopia zamknięta na dysku');
  const change = manifest.changes.find(c => c.id === item.change_id);
  assert(change?.base.kind === 'file' && change.proposed.kind === 'text', 'Oczekiwano tekstowej propozycji i zachowanej bazy');
  equal(change.review.kind, status, 'Trwały status decyzji');
  equal(change.revision, item.revision, 'Rewizja po ponownym odczycie');
  const bytes = await fresh.persistence.readBlob(item.draft_id, change.base.blob, change.base.version.hash, change.base.version.bytes);
  equal(new TextDecoder().decode(bytes), before, 'Literalna pierwsza baza na dysku');
  equal(await fresh.view(item.draft_id).read(item.path), after, 'Literalna kopia na dysku');
}
export async function preview(plugin: FixturePayload, item: ChangeSummary, before: string, after: string) {
  const [detail] = await listed(plugin, item);
  equal(detail.preview, { kind: 'text', oldContent: before, newContent: after }, 'Podgląd prowadzącego');
  equal(detail.truncated, false, 'Podgląd kompletny');
}

export type Step = { tool: string; args: Record<string, unknown> };
export const write = (path: string, content: string): Step => ({ tool: 'write', args: { path, content, mode: 'replace' } });
export const read = (path: string): Step => ({ tool: 'read', args: { path } });
/** Każdy request przechodzi SSE i produkcyjną pętlę. Zbieramy faktyczne zwrotki
 * narzędzi widziane przez model, zamiast wnioskować o wykonaniu z finalText. */
export function script() {
  const programs = new Map<string, Step[]>();
  const calls = new Map<string, number>();
  const results = new Map<string, FixturePayload[]>();
  const requests: string[] = [];
  return { programs, calls, results, requests,
    async respond({ request }: FixturePayload) {
      const user = (request?.messages ?? []).find((m: FixturePayload) => m.role === 'user' && typeof m.content === 'string' && /^P6-[A-Z]+(?:\n|$)/.test(m.content));
      if (!user) return textTurn('Tura kontrolna; harness sprawdzi kopie przez narzędzia prowadzącego.');
      const id = user.content.split('\n')[0].slice(3) as string;
      requests.push(id);
      const n = calls.get(id) ?? 0;
      if (n > 0) {
        const values = lastToolResults(request).map((value: string) => JSON.parse(value));
        results.set(id, [...(results.get(id) ?? []), ...values]);
      }
      calls.set(id, n + 1);
      const step = programs.get(id)?.[n];
      return step ? toolCallTurn(step.tool, step.args) : textTurn(`Zakończono ${id}.`);
    },
  };
}
export function base(file: string, name: string, model: ReturnType<typeof script>): Scenario {
  return { file, name, opis: name, agent: 'Tester', autonomy: 'yolo', maxIterations: 2,
    liveSkip: 'wymaga sterowanych odpowiedzi modelu, barier i literalnych propozycji',
    fixtures: [{ path: FILE, content: 'Baza' }, { path: Y, content: 'Baza-Y' }],
    offlineScript: model.respond,
    async setup({ plugin }: FixturePayload) {
      model.programs.clear(); model.calls.clear(); model.results.clear(); model.requests.length = 0;
      const memory = plugin.agentManager.getAgentMemory('Tester');
      await memory.startActiveSession();
      Object.assign(origin, { sessionPath: memory.activeSessionPath, sessionEpoch: memory.sessionEpoch });
      assert(origin.sessionPath && /^[0-9a-f]{32}$/.test(origin.sessionEpoch), 'Rzeczywista sesja właściciela gotowa');
    },
    asserts() { throw new Error('Brak asercji scenariusza'); },
  };
}
/** Subskrypcja przed delegate, bez pollingu. Stop planu wymaga dodatkowo
 * bariery trwałego seal (73), bo plan może wcześniej opublikować task:finished. */
export function observe(plugin: FixturePayload, ids: string[]) {
  const tasks = new Map<string, SubTask>();
  const finished = new Map(ids.map(id => [id, barrier()]));
  const ends: string[] = [];
  const off = plugin.subTaskRegistry.events.on('task:finished', (task: SubTask) => {
    const id = task.plan?.nodeId ?? task.taskPreview?.slice(3) ?? '';
    if (!finished.has(id)) return;
    tasks.set(id, task); ends.push(id); finished.get(id)!.release();
  });
  return { tasks, ends, off, done: () => bounded(Promise.all([...finished.values()].map(b => b.promise)), 'koniec subów') };
}
export async function run(plugin: FixturePayload, id: string) {
  const watcher = observe(plugin, [id]);
  try {
    const receipt = await mcp(plugin, 'delegate', { task: `P6-${id}`, aspect: 'worker' });
    equal([receipt.success, receipt.started], [true, true], 'Delegacja przyjęta');
    await watcher.done();
    const task = watcher.tasks.get(id)!;
    equal(task.status, 'done', 'Sub zakończył pracę');
    equal(watcher.ends, [id], 'Jedno zakończenie');
    return task;
  } finally { watcher.off(); }
}
export function toolResults(model: ReturnType<typeof script>, id: string, contents: string[]) {
  const values = model.results.get(id) ?? [];
  equal(values.length, (model.programs.get(id) ?? []).length, 'Każda zwrotka dotarła do modelu');
  for (const value of values) equal(value.success, true, 'Narzędzie suba zakończone sukcesem');
  equal(values.filter(v => typeof v.content === 'string').map(v => v.content), contents, 'Literalne odczyty suba');
}
