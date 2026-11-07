import { readVaultFile } from './_asserts.js';
import { base, script, run, write, FILE, equal, listed, decide, persisted, toolResults } from './_drafts.js';
const model = script();
export default { ...base('70_edycja_bazy_konflikt', 'edycja użytkownika blokuje przyjęcie kopii', model),
  async asserts({ plugin, vaultRoot }: import('./_asserts.js').FixturePayload) {
    model.programs.set('EDYCJA', [write(FILE, 'Pierwsza'), write(FILE, 'Szkic')]);
    await run(plugin, 'EDYCJA'); toolResults(model, 'EDYCJA', []);
    const [item] = await listed(plugin);
    await persisted(plugin.app, item, 'Baza', 'Szkic', 'pending');
    await plugin.app.vault.modify(plugin.app.vault.getAbstractFileByPath(FILE), 'Kuba');
    await decide(plugin, item, 'accept', 'conflict');
    equal(readVaultFile(vaultRoot, FILE), 'Kuba', 'Konflikt chroni literalną edycję użytkownika');
    equal((await listed(plugin))[0].status, 'conflict', 'Ponowna lista pokazuje konflikt');
    await persisted(plugin.app, item, 'Baza', 'Szkic', 'conflict');
  },
};
