import { readVaultFile } from './_asserts.js';
import { base, script, run, write, read, FILE, equal, listed, preview, persisted, toolResults } from './_drafts.js';
const model = script();
export default { ...base('68_zapis_do_kopii', 'zapis suba: Szkic w kopii, Baza w vaulcie', model),
  async asserts({ plugin, vaultRoot }: import('./_asserts.js').FixturePayload) {
    model.programs.set('SZKIC', [write(FILE, 'Szkic'), read(FILE)]);
    const task = await run(plugin, 'SZKIC');
    equal(readVaultFile(vaultRoot, FILE), 'Baza', 'Vault przed przyjęciem');
    toolResults(model, 'SZKIC', ['Szkic']);
    const changes = await listed(plugin);
    equal(changes.length, 1, 'Jedna propozycja');
    equal([changes[0].run_id, changes[0].path, changes[0].status], [task.id, FILE, 'pending'], 'Tożsamość i stan kopii');
    await preview(plugin, changes[0], 'Baza', 'Szkic');
    await persisted(plugin.app, changes[0], 'Baza', 'Szkic', 'pending');
  },
};
