import { readVaultFile } from './_asserts.js';
import { base, script, run, write, FILE, Y, equal, listed, decide, persisted, toolResults } from './_drafts.js';
const model = script();
export default { ...base('71_przyjecie_i_odrzucenie', 'przyjęcie X i odrzucenie Y są osobnymi trwałymi decyzjami', model),
  async asserts({ plugin, vaultRoot }: import('./_asserts.js').FixturePayload) {
    model.programs.set('DECYZJE', [write(FILE, 'X'), write(Y, 'Y')]);
    await run(plugin, 'DECYZJE'); toolResults(model, 'DECYZJE', []);
    const changes = await listed(plugin);
    equal(changes.length, 2, 'Dwa pliki do decyzji');
    const x = changes.find(c => c.path === FILE)!, y = changes.find(c => c.path === Y)!;
    const accepted = await decide(plugin, x, 'accept', 'accepted');
    equal([readVaultFile(vaultRoot, FILE), readVaultFile(vaultRoot, Y)], ['X', 'Baza-Y'], 'Przyjęcie zmienia tylko X');
    equal((await listed(plugin)).find(c => c.path === Y)?.status, 'pending', 'Y nadal oczekuje');
    await decide(plugin, y, 'reject', 'rejected');
    equal(await decide(plugin, x, 'accept', 'accepted'), accepted, 'Ponowienie zwraca to samo pokwitowanie');
    equal([readVaultFile(vaultRoot, FILE), readVaultFile(vaultRoot, Y)], ['X', 'Baza-Y'], 'Vault po obu decyzjach');
    equal((await listed(plugin)).map(c => [c.path, c.status]).sort(), [[FILE, 'accepted'], [Y, 'rejected']].sort(), 'Ponowna lista decyzji');
    await persisted(plugin.app, x, 'Baza', 'X', 'accepted');
    await persisted(plugin.app, y, 'Baza-Y', 'Y', 'rejected');
  },
};
