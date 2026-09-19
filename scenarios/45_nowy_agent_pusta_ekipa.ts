/**
 * 45_nowy_agent_pusta_ekipa — `createAgent` nie tworzy automatycznie suba `<slug>-prep`.
 *
 * Regresja naprawiona po 2.2.6: guzik „+" zawsze nadawał nazwę Agent1, a `renameAgent` NIE
 * przenosił `agent1-prep` na nowy slug (patrz gotcha "Świadomie nie przenosi się" w
 * `modules/agents/CLAUDE.md`) — więc kolejny Agent1 (po zmianie nazwy poprzedniego na coś
 * innego) dostawał TEGO SAMEGO suba na dysku, dzielonego przez dwóch agentów. Naprawa:
 * `AgentManager.createAgent` startuje agenta z pustą Ekipą (`_subAgents = []`) i nie tworzy
 * niczego w `.pkm-assistant/sub-agents/` — delegacja ad-hoc i tak działa przez generycznego
 * workera (`pkm-sub`), a własne suby user odlewa z szablonów (Zaplecze). Istniejące suby
 * `*-prep` u userów sprzed naprawy NIE są ruszane przez tę zmianę.
 *
 * Bieg jest czysto OFFLINE i nie testuje żadnej decyzji modelu — jedna trywialna tura (wzór:
 * 39_boot_nie_pisze) tylko po to, żeby runner miał co odpalić (offlineScript jest wymagany).
 * Cała weryfikacja dzieje się w `asserts`, przez PRAWDZIWY `plugin.agentManager` na tym samym
 * temp-vaulcie (wzór: 33_skill_marker, 31_sub_szablon_fallback — sięganie po agentManager
 * bezpośrednio, bez udawania że to robi model).
 *
 * Sekwencja:
 *   1. `createAgent({name:'Agent1'})` — Ekipa pusta, zero folderu `agent1-prep` na dysku,
 *      zapisany `agent1.yaml` bez klucza `sub_agents`.
 *   2. `renameAgent('Agent1','Atlas')` — zwalnia slug `agent1`.
 *   3. DRUGI `createAgent({name:'Agent1'})` — też pusta Ekipa, dalej ZERO folderów `*-prep`
 *      na dysku. Przed naprawą ten drugi Agent1 odziedziczyłby suba PIERWSZEGO Agent1/Atlas
 *      (ten sam `agent1-prep`, bo rename zostawiał go pod starym slugiem) — dwóch agentów
 *      dzieliłoby jednego suba.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import { assert, assertFinalText, fileAbsent, listVaultFiles, readVaultFile } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const ODPOWIEDZ = 'Nowy agent startuje bez subow.';

export default ({
  file: '45_nowy_agent_pusta_ekipa',
  name: 'nowy agent pusta ekipa',
  opis: 'createAgent nie tworzy automatycznie suba <slug>-prep; rename nie zostawia go do odziedziczenia przez kolejnego Agent1',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'scenariusz testuje wyłącznie API AgentManager (createAgent/renameAgent), nie zależy od żadnej decyzji modelu',

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, plugin }) {
    const agentManager = plugin?.agentManager;
    assert(agentManager, 'Brak plugin.agentManager — bootstrap nieukończony?');

    // ── 1. Pierwszy Agent1: pusta Ekipa, zero suba na dysku, YAML bez sub_agents ──
    const agent1 = (await agentManager.createAgent({ name: 'Agent1' })) as FixturePayload;
    assert(
      Array.isArray(agent1._subAgents) && agent1._subAgents.length === 0,
      `createAgent miał zostawić PUSTĄ Ekipę — agent1._subAgents = ${JSON.stringify(agent1._subAgents)}.`,
    );
    fileAbsent(
      vaultRoot, '.pkm-assistant/sub-agents/agent1-prep',
      'createAgent NIE MIAŁ tworzyć suba agent1-prep na dysku — automat auto-prep wyleciał.',
    );
    const yaml1 = readVaultFile(vaultRoot, '.pkm-assistant/agents/agent1.yaml');
    assert(
      !/^sub_agents:/m.test(yaml1),
      `Zapisany agent1.yaml niesie klucz sub_agents mimo pustej Ekipy: ${yaml1.slice(0, 300)}`,
    );

    // ── 2. Rename Agent1 -> Atlas (zwalnia slug "agent1") ──
    const renamed = await agentManager.renameAgent('Agent1', 'Atlas');
    assert(renamed === true, `renameAgent('Agent1','Atlas') zwrócił ${JSON.stringify(renamed)}, oczekiwano true.`);

    // ── 3. Drugi Agent1: znowu pusta Ekipa, dalej zero *-prep na dysku ──
    const agent1b = (await agentManager.createAgent({ name: 'Agent1' })) as FixturePayload;
    assert(
      Array.isArray(agent1b._subAgents) && agent1b._subAgents.length === 0,
      `Drugi createAgent('Agent1') miał zostawić PUSTĄ Ekipę — _subAgents = ${JSON.stringify(agent1b._subAgents)}.`,
    );
    const prepFoldery = listVaultFiles(vaultRoot, '.pkm-assistant/sub-agents')
      .filter((p) => /-prep\//.test(p));
    assert(
      prepFoldery.length === 0,
      `Na dysku są pliki suba *-prep, mimo że automat miał zniknąć (i mimo że drugi Agent1 nie `
      + `mógł go odziedziczyć po pierwszym/Atlasie): ${prepFoldery.join(', ')}`,
    );

    assertFinalText(result, 'Pętla nie zwróciła odpowiedzi.');
  },
} satisfies Scenario);
