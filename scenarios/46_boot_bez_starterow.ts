/**
 * 46_boot_bez_starterow — świeży vault: plugin NIE sieje żadnych fabrycznych skilli.
 *
 * Do 2.2.7 `SkillLoader.ensureStarterSkills()` przy każdym starcie zakładał
 * `.pkm-assistant/skills/` i wrzucał tam 8 starterów, gdy folder był pusty albo go nie było,
 * a wbudowany Jaskier miał ich nazwy zaszyte w liście `skills`. Decyzja właściciela (2026-09):
 * plugin nie dostarcza skilli — user tworzy własne, a w Zapleczu są szablony do odlania.
 *
 * Co tu dowodzimy na PRAWDZIWYM boocie pluginu w temp-vaulcie:
 *   1. po boocie nie istnieje ANI JEDEN `SKILL.md` pod `.pkm-assistant/skills/` — boot nie pisze,
 *   2. Jaskier startuje z pustą listą skilli (brak nazw plików, których nie ma na dysku),
 *   3. pierwszy zapis skilla SAM zakłada folder — nikt nie polega już na tym, że zrobił to boot.
 *
 * Bieg czysto OFFLINE, jedna trywialna tura tylko po to, żeby runner miał co odpalić
 * (wzór: 45_nowy_agent_pusta_ekipa). Cała weryfikacja w `asserts`.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import { assert, assertFinalText, fileExists, listVaultFiles, readVaultFile } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const ODPOWIEDZ = 'Boot bez starterow.';
const STARTERY = [
  'welcome-tour', 'daily-review', 'vault-organization', 'note-from-idea',
  'weekly-review', 'create-agent', 'create-skill', 'system-health-check',
];

export default ({
  file: '46_boot_bez_starterow',
  name: 'boot bez starterów',
  opis: 'świeży vault: boot nie sieje fabrycznych skilli, Jaskier ma pustą listę, zapis skilla sam tworzy folder',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'scenariusz testuje boot i API SkillLoadera, nie zależy od żadnej decyzji modelu',

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, plugin }) {
    const agentManager = plugin?.agentManager;
    assert(agentManager, 'Brak plugin.agentManager — bootstrap nieukończony?');

    // ── 1. Boot nie posiał ani jednego skilla ──
    const posiane = listVaultFiles(vaultRoot, '.pkm-assistant/skills').filter((p) => /SKILL\.md$/i.test(p));
    assert(
      posiane.length === 0,
      `Boot posiał skille, a plugin miał ich nie dostarczać: ${posiane.join(', ')}`,
    );
    const zaladowane = ((agentManager.skillLoader?.getAllSkills?.() || []) as FixturePayload[]).map((s) => String(s.slug || s.name));
    const fabryczne = zaladowane.filter((n) => STARTERY.includes(n));
    assert(
      fabryczne.length === 0,
      `SkillLoader zna fabryczne startery mimo wycinki: ${fabryczne.join(', ')}`,
    );

    // ── 2. Jaskier bez zaszytych nazw skilli ──
    const jaskier = agentManager.getAgent?.('Jaskier') as FixturePayload;
    assert(jaskier, 'Wbudowany Jaskier nie wstał — nie ma na kim sprawdzić listy skilli.');
    assert(
      Array.isArray(jaskier.skills) && jaskier.skills.length === 0,
      `Jaskier ma startować z PUSTĄ listą skilli, a ma: ${JSON.stringify(jaskier.skills)}`,
    );

    // ── 3. Zapis skilla sam zakłada folder (boot już tego nie robi) ──
    const sciezka = await agentManager.skillLoader.saveSkill({
      name: 'Harness Przepis 46',
      description: 'skill usera zapisany na swiezym vaultcie',
      prompt: 'Krok 1: przywitaj sie.',
    });
    assert(
      sciezka === '.pkm-assistant/skills/harness-przepis-46/SKILL.md',
      `saveSkill zwrócił nieoczekiwaną ścieżkę: ${JSON.stringify(sciezka)}`,
    );
    fileExists(vaultRoot, sciezka, 'saveSkill nie utworzył pliku na świeżym vaulcie (brak folderu skilli?).');
    const tresc = readVaultFile(vaultRoot, sciezka);
    assert(
      tresc.includes('Krok 1: przywitaj sie.'),
      `Zapisany SKILL.md nie niesie treści przepisu: ${tresc.slice(0, 200)}`,
    );

    assertFinalText(result, 'Pętla nie zwróciła odpowiedzi.');
  },
} satisfies Scenario);
