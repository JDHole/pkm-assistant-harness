import { DraftPersistence } from '@plugin/modules/vault-drafts/index.js';
import { desktopDraftPorts } from '@plugin/modules/tools/index.js';
import type { ToolDefinition } from '@plugin/modules/tools/index.js';
import { readVaultFile } from './_asserts.js';
import { base, script, write, read, FILE, Y, equal, listed, persisted, toolResults, observe, mcp, barrier, bounded, disk } from './_drafts.js';
import type { FixturePayload } from './_asserts.js';
const model = script();
export default { ...base('73_plan_i_stop_kopii', 'C czyta zamknięte A/B; Stop zachowuje kopię i odrzuca późny zapis', model),
  async asserts({ plugin, vaultRoot }: FixturePayload) {
    model.programs.set('A', [write(FILE, 'A')]);
    model.programs.set('B', [write(Y, 'B')]);
    model.programs.set('C', [read(FILE), read(Y), write(FILE, 'C'), read(FILE)]);
    const plan = observe(plugin, ['A', 'B', 'C']);
    const sealedAtC: string[] = [];
    const original = plugin.toolRegistry.getTool('read') as ToolDefinition;
    // Obserwacja tuż PRZED prawdziwym odczytem C (brak zmian hosta/zwrotki).
    plugin.toolRegistry.registerTool({ ...original, async execute(...args: Parameters<ToolDefinition['execute']>) {
      if (model.calls.has('C')) {
        const ports = desktopDraftPorts(plugin.app);
        const fresh = await new DraftPersistence(ports.storage, ports.hasher).loadAll();
        equal(fresh.issues, [], 'Odczyt manifestów poprzedników');
        sealedAtC.push(...fresh.manifests.filter(m => m.plan?.nodeId === 'A' || m.plan?.nodeId === 'B').map(m => m.phase.kind));
      }
      return original.execute(...args);
    } });
    try {
      const receipt = await mcp(plugin, 'delegate', { tasks: [
        { id: 'C', task: 'P6-C', aspect: 'worker', depends_on: ['A', 'B'] },
        { id: 'A', task: 'P6-A', aspect: 'worker' }, { id: 'B', task: 'P6-B', aspect: 'worker' },
      ] });
      equal([receipt.success, receipt.started], [true, true], 'Plan przyjęty');
      await plan.done();
      equal(['A', 'B', 'C'].map(id => plan.tasks.get(id)?.status), ['done', 'done', 'done'], 'Plan zakończony');
      equal(plan.ends.at(-1), 'C', 'C kończy po poprzednikach');
      equal(sealedAtC, ['sealed', 'sealed', 'sealed', 'sealed', 'sealed', 'sealed'], 'A/B zamknięte przed każdym odczytem C');
      toolResults(model, 'A', []); toolResults(model, 'B', []); toolResults(model, 'C', ['A', 'B', 'C']);
      equal([readVaultFile(vaultRoot, FILE), readVaultFile(vaultRoot, Y)], ['Baza', 'Baza-Y'], 'Plan nie zmienia vaulta');
      const changes = await listed(plugin);
      equal(changes.length, 3, 'Trzy kopie planu');
      for (const [id, before, after] of [['A', 'Baza', 'A'], ['B', 'Baza-Y', 'B'], ['C', 'Baza', 'C']]) {
        await persisted(plugin.app, changes.find(c => c.run_id === plan.tasks.get(id)!.id)!, before, after, 'pending');
      }
    } finally { plan.off(); plugin.toolRegistry.registerTool(original); }

    // Osobny plan: trwały Gotowe, następnie prawdziwe write wstrzymane
    // wewnątrz tool.execute. Stop musi zamknąć magazyn przed jego zwolnieniem.
    model.programs.set('STOP', [write(FILE, 'Gotowe'), write(FILE, 'Za późno')]);
    model.programs.set('NEXT', [read(FILE)]);
    const entered = barrier(), release = barrier(), completed = barrier();
    let lateResult: FixturePayload;
    const writer = plugin.toolRegistry.getTool('write') as ToolDefinition;
    plugin.toolRegistry.registerTool({ ...writer, async execute(...args: Parameters<ToolDefinition['execute']>) {
      if (args[0].content !== 'Za późno') return writer.execute(...args);
      entered.release(); await release.promise;
      try { lateResult = await writer.execute(...args); return lateResult; }
      catch (error) { lateResult = { error: String(error) }; throw error; }
      finally { completed.release(); }
    } });
    const stopped = observe(plugin, ['STOP', 'NEXT']);
    const sealed = barrier();
    let stopId = '';
    // Plan publikuje terminalny Stop przed asynchronicznym seal runnera.
    // task:draft po Stopie i przy wstrzymanym writerze pochodzi z trwałego seal.
    const offSeal = plugin.subTaskRegistry.events.on('task:draft', (task: FixturePayload) => {
      if (task.id === stopId) sealed.release();
    });
    try {
      const receipt = await mcp(plugin, 'delegate', { tasks: [
        { id: 'STOP', task: 'P6-STOP', aspect: 'worker' },
        { id: 'NEXT', task: 'P6-NEXT', aspect: 'worker', depends_on: ['STOP'] },
      ] });
      equal([receipt.success, receipt.started], [true, true], 'Plan Stopu przyjęty');
      await bounded(entered.promise, 'drugie write w trakcie wykonania');
      equal(model.results.get('STOP')?.[0]?.success, true, 'Pierwszy zapis potwierdzony modelowi');
      const task = plugin.subTaskRegistry.list().find((t: FixturePayload) => t.plan?.planId === receipt.plan_id && t.plan.nodeId === 'STOP');
      stopId = task.id;
      equal(plugin.subTaskRegistry.requestStop(task.id, 'user'), true, 'Stop przyjęty');
      await Promise.all([stopped.done(), bounded(sealed.promise, 'trwałe seal po Stopie')]);
      equal(task.result?.outcome?.end, { kind: 'stopped', by: 'user' }, 'Zatrzymanie pozostaje wynikiem suba');
      equal(stopped.tasks.get('NEXT')?.status, 'blocked', 'Stop blokuje następnika');
      equal(model.calls.has('NEXT'), false, 'Następnik nie uruchomił modelu');
      const item = (await listed(plugin)).find(c => c.run_id === task.id)!;
      await persisted(plugin.app, item, 'Baza', 'Gotowe', 'pending');
      const before = (await disk(plugin.app)).store.snapshot(item.draft_id);
      equal(before.phase, { kind: 'sealed', reason: 'stopped' }, 'Stop trwale zamknął kopię');
      release.release(); await bounded(completed.promise, 'późne write zakończone');
      equal(lateResult?.success, false, `Późny zapis odrzucony: ${JSON.stringify(lateResult)}`);
      equal((await disk(plugin.app)).store.snapshot(item.draft_id), before, 'Późny zapis nie publikuje nowej generacji');
      await persisted(plugin.app, item, 'Baza', 'Gotowe', 'pending');
      equal(readVaultFile(vaultRoot, FILE), 'Baza', 'Stop i późny zapis nie zmieniają vaulta');
      equal(stopped.ends.sort(), ['NEXT', 'STOP'], 'Każdy węzeł kończy dokładnie raz');
    } finally { release.release(); stopped.off(); offSeal(); plugin.toolRegistry.registerTool(writer); }
  },
};
