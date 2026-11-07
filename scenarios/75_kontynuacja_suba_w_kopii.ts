import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { base, script, FILE, write, equal, run, observe, mcp, listed, persisted, preview } from './_drafts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
const model = script();
const scenario = base('75_kontynuacja_suba_w_kopii', 'delegate i sub_agent task korzystają z tego samego runtime kopii', model);
let continuationCalls = 0;
const reads: string[] = [];
const effects: unknown[] = [];
export default ({ ...scenario,
  offlineScript: async (ctx: FixturePayload) => {
    if ((ctx.request.messages ?? []).some((m: FixturePayload) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('P6-NEXT'))) {
      const n = continuationCalls++;
      if (n === 0) return toolCallTurn('read', { path: FILE });
      if (n === 1) {
        reads.push(...lastToolResults(ctx.request).map((value: string) => JSON.parse(value).content));
        return toolCallTurn('write', { path: FILE, content: 'C', mode: 'replace' });
      }
      effects.push(JSON.parse(lastToolResults(ctx.request).at(-1)!).vault_effect?.kind);
      return textTurn('Kontynuacja zakończona.');
    }
    return model.respond(ctx);
  },
  async asserts({ plugin }: FixturePayload) {
    continuationCalls = 0; reads.length = 0; effects.length = 0;
    model.programs.set('FIRST', [write(FILE, 'A')]);
    const first = await run(plugin, 'FIRST');
    equal(await plugin.app.vault.adapter.read(FILE), 'Baza', 'Baza po pierwszym delegate');
    const watcher = observe(plugin, ['NEXT']);
    try {
      const response = await mcp(plugin, 'sub_agent', { action: 'task', sub_id: first.threadId, task: 'P6-NEXT' });
      equal([response.success, response.started], [true, true], 'Kontynuacja przyjęta');
      await watcher.done();
      equal(watcher.tasks.get('NEXT')?.status, 'done', 'Kontynuacja zakończona');
      equal(reads, ['A'], 'Kontynuacja odczytuje poprzednią kopię');
      equal(effects, ['draft'], 'Efekt kontynuacji');
      equal(await plugin.app.vault.adapter.read(FILE), 'Baza', 'Kontynuacja nie zapisuje live');
      const changes = await listed(plugin);
      equal(changes.length, 2, 'Dwie osobne propozycje');
      const next = changes.find(c => c.run_id === watcher.tasks.get('NEXT')?.id)!;
      equal(next.draft_id === first.result?.draft?.draftId, false, 'Nowa kopia kontynuacji');
      await preview(plugin, next, 'Baza', 'C');
      await persisted(plugin.app, next, 'Baza', 'C', 'pending');
      equal(watcher.ends, ['NEXT'], 'Jedno doręczenie kontynuacji');
    } finally { watcher.off(); }
  },
} satisfies Scenario);
