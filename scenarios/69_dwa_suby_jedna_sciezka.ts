import { readVaultFile } from './_asserts.js';
import { base, script, run, write, read, FILE, equal, listed, decide, persisted, toolResults } from './_drafts.js';
const model = script();
export default { ...base('69_dwa_suby_jedna_sciezka', 'dwie kopie jednej ścieżki: przyjęcie A blokuje B', model),
  async asserts({ plugin, vaultRoot }: import('./_asserts.js').FixturePayload) {
    for (const id of ['A', 'B']) model.programs.set(id, [write(FILE, id), read(FILE)]);
    const tasks = await Promise.all(['A', 'B'].map(id => run(plugin, id)));
    toolResults(model, 'A', ['A']); toolResults(model, 'B', ['B']);
    equal(readVaultFile(vaultRoot, FILE), 'Baza', 'Równoległe zapisy nie zmieniają vaulta');
    const changes = await listed(plugin);
    equal(changes.length, 2, 'Dwie niezależne kopie');
    const [a, b] = tasks.map(task => changes.find(c => c.run_id === task.id)!);
    await persisted(plugin.app, a, 'Baza', 'A', 'pending');
    await persisted(plugin.app, b, 'Baza', 'B', 'pending');
    await decide(plugin, a, 'accept', 'accepted');
    equal(readVaultFile(vaultRoot, FILE), 'A', 'Przyjęta treść A');
    await decide(plugin, b, 'accept', 'conflict');
    equal(readVaultFile(vaultRoot, FILE), 'A', 'Konflikt B zachowuje A');
    await persisted(plugin.app, a, 'Baza', 'A', 'accepted');
    await persisted(plugin.app, b, 'Baza', 'B', 'conflict');
  },
};
