import { createMockApp } from '../mock/app.js';
import { harnessProviderOverrides } from '../lib/harnessProviders.js';
import { readVaultFile } from './_asserts.js';
import { base, script, run, write, FILE, Y, equal, listed, decide, persisted, preview, bounded } from './_drafts.js';
const model = script();
export default { ...base('72_restart_kopii', 'nowy plugin odtwarza kopie bez ponownego uruchamiania subów', model),
  async asserts({ plugin, vaultRoot }: import('./_asserts.js').FixturePayload) {
    model.programs.set('RESTART', [write(FILE, 'Szkic'), write(Y, 'Druga')]);
    await run(plugin, 'RESTART');
    const before = await listed(plugin);
    equal(before.length, 2, 'Dwie propozycje przed restartem');
    await plugin.subTaskRegistry.flushHistory();
    await plugin.traceLog.sink.flush();
    plugin.onunload();
    clearTimeout(plugin.env.settingsStore.pendingSaveTimer);
    // Nowa instancja TEGO SAMEGO produkcyjnego pluginu, nowa app i cache,
    // ten sam fizyczny temp-vault. Bez importu wnętrz ani kopiowania magazynu.
    const restarted = new plugin.constructor(createMockApp(vaultRoot), plugin.manifest);
    Object.assign(restarted.runtimeConfig.chat.providers, harnessProviderOverrides());
    const requests = model.requests.length;
    try {
      restarted.onload();
      await bounded(restarted.waitForReady(), 'restart pluginu');
      const changes = await listed(restarted);
      equal(changes, before, 'Identyczne ID, rewizje, ścieżki i statusy po restarcie');
      equal(model.requests.length, requests, 'Restart nie uruchamia modeli');
      equal(restarted.subTaskRegistry.list().filter((task: import('./_asserts.js').FixturePayload) => task.status === 'running').length, 0, 'Brak aktywnych subów');
      equal([readVaultFile(vaultRoot, FILE), readVaultFile(vaultRoot, Y)], ['Baza', 'Baza-Y'], 'Restart nie przyjmuje zmian');
      const x = changes.find(c => c.path === FILE)!, y = changes.find(c => c.path === Y)!;
      await preview(restarted, x, 'Baza', 'Szkic');
      await persisted(restarted.app, x, 'Baza', 'Szkic', 'pending');
      await persisted(restarted.app, y, 'Baza-Y', 'Druga', 'pending');
      await decide(restarted, x, 'accept', 'accepted');
      equal(readVaultFile(vaultRoot, FILE), 'Szkic', 'Przyjęcie w nowym runtime działa');
      await persisted(restarted.app, x, 'Baza', 'Szkic', 'accepted');
      equal(model.requests.length, requests, 'Przegląd i decyzja nie wznawiają subów');
    } finally {
      await restarted.subTaskRegistry?.flushHistory();
      restarted.onunload();
      clearTimeout(restarted.env?.settingsStore?.pendingSaveTimer);
    }
  },
};
