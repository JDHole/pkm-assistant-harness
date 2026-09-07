/**
 * 30_skill_przepis — skille headless: indeks w prompcie → przepis przez `read` → wykonanie.
 *
 * Skille NIE mają już narzędzi (E2.4 D17). Cała odkrywalność to trzy niezależne ścieżki
 * produkcyjne i ten scenariusz przechodzi WSZYSTKIE TRZY na żywym pluginie:
 *
 *   1. **Indeks w system prompcie** — `AgentManager._buildBaseContext` bierze skille agenta
 *      (`skillLoader.getSkillsForAgent(agent.skills)`), a `buildSkillIndex`
 *      (`modules/prompts/skillIndex.ts`) renderuje linijkę `⚡ nazwa: opis → read("ścieżka")`.
 *      Sprawdzamy prompt zbudowany przez pętlę ORAZ — offline — jego kopię z DRUTU
 *      (`ctx.request.messages[0]`), bo dopiero to dowodzi, że indeks realnie poszedł do modelu.
 *   2. **Przepis przez `read`** — wyjątek TYLKO-ODCZYT w `vault_path_validator.ts`
 *      (`allowSkillsRead`) przepuszcza `.pkm-assistant/skills/**`. Model czyta SKILL.md,
 *      potem `references/dane.md` (nikt tych plików nie dokleja automatycznie) i dopiero
 *      wtedy wykonuje kroki przepisu — zapis notatki z liczbą kontrolną z references.
 *   3. **Pre-questions** — czysta funkcja `substituteVariables` (`modules/skills`) podstawia
 *      `{{cel}}` w przepisie wczytanym z DYSKU przez żywy `SkillLoader`. To regresja E3.5:
 *      `parseSkillMarkdown` liczył `preQuestions`, ale gubił je z returna, więc modal pytań
 *      przed skillem był martwy, a placeholdery zostawały niepodstawione.
 *
 * Ścieżka MARKERA `@@skill:` (popup `/`) siedzi w osobnym scenariuszu `33_skill_marker`
 * — splot tur globalnej kolejki fake-serwera był tu nieczytelny.
 *
 * Inwarianty: (1) indeks skilla w system prompcie, (2) DWA `read` pod `.pkm-assistant/skills/**`
 * zakończone `ok`, (3) notatka powstała i niesie liczbę kontrolną z references, (4) pętla
 * domknęła się naturalnie, (5) pre-questions podstawiają się bez resztek `{{`.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { substituteVariables } from '../../modules/skills/index.js';
import {
  assert, assertFinalText, assertToolPost, listVaultFiles, loopEnd, readVaultFile, toolPosts,
} from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SLUG = 'poligon-przepis';
const SKILL_REL = `.pkm-assistant/skills/${SLUG}/SKILL.md`;
const REFS_REL = `.pkm-assistant/skills/${SLUG}/references/dane.md`;
const NOTATKA_REL = 'Notatki/poligon-raport.md';

/** Liczba kontrolna żyje WYŁĄCZNIE w references — jej obecność w notatce dowodzi, że model tam dotarł. */
const LICZBA_KONTROLNA = 'POLIGON-DANE-73';
/** Wartość podstawiana w pre-question `{{cel}}` (ścieżka 3). */
const CEL = 'kontrola przepisu w Poligonie';

/** Dowody zebrane W BIEGU (offline): kopia promptu systemowego z drutu. */
const zebrane: { systemPromptZDrutu: string | null } = { systemPromptZDrutu: null };

/** Treść wiadomości `system` z żądania do modelu (to, co REALNIE poszło po drucie). */
function systemPromptZadania(request: FixturePayload): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const sys = messages.find((m: FixturePayload) => m?.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

export default ({
  file: '30_skill_przepis',
  name: 'skill przepis',
  opis: 'indeks skilli w prompcie → read SKILL.md → read references → wykonanie kroków przepisu',
  agent: 'Tester',
  // ⚠️ `yolo`, a nie `edge`, WYŁĄCZNIE z powodu kroku 5b w `MCPClient.executeToolCall`:
  // zatwierdzony `write` w trybie create/replace/patch otwiera `DiffModal` (prawdziwe okno
  // Obsidiana). Harness nie ma UI, więc `waitForApproval()` nigdy się nie rozstrzyga i bieg
  // wisi. `yolo` pomija pytania i diff, NIE omijając No-Go / protected / whitelist (te siedzą
  // w `checkPermission` wcześniej — pilnuje tego scenariusz `07_yolo_nie_omija`).
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 6,
  evidenceFiles: [SKILL_REL, REFS_REL, NOTATKA_REL],
  livePrompt: `Użyj skilla ${SLUG}: przeczytaj jego przepis i references, wykonaj kroki.`,

  fixtures: [
    {
      // Tester z fixture NIE ma pola `skills:` — bez niego indeks skilli jest pusty,
      // więc nadpisujemy CAŁY plik (nadpisy fixture są plikowe, nie scalane).
      path: '.pkm-assistant/agents/tester.yaml',
      content: [
        'name: Tester',
        'description: Agent testowy harnessa — pełen dostęp do zwykłego vaulta.',
        'personality: |',
        '  Jesteś Tester — rzeczowy agent do smoke-testów pluginu. Odpowiadasz krótko,',
        '  wykonujesz zadania wprost, nie owijasz w bawełnę.',
        'access_policy_version: 2',
        'admin_access: false',
        'default_permissions:',
        '  memory: true',
        '  guidance_mode: true',
        'disabled_tools: []',
        'default_autonomy: edge',
        'skills:',
        `  - ${SLUG}`,
        'mcp_servers:',
        '  - vault',
        '  - memory',
        '  - core',
        '',
      ].join('\n'),
    },
    {
      // Slug unikalny — `ensureStarterSkills()` widzi niepusty katalog skilli i nie sieje 8 starterów.
      path: SKILL_REL,
      content: [
        '---',
        `name: ${SLUG}`,
        'description: "Przepis Poligonu: czyta swoje references i zapisuje notatke kontrolna."',
        'category: research',
        'version: 1',
        'enabled: true',
        'icon: "🧪"',
        'tags: [poligon, harness]',
        'user-invocable: true',
        'pre-questions:',
        '  - key: cel',
        '    question: "Po co uruchamiasz ten przepis?"',
        '    default: "kontrola harnessu"',
        '---',
        '',
        '# Przepis Poligonu',
        '',
        'Cel tego uruchomienia: {{cel}}',
        '',
        '## Kroki',
        `1. Przeczytaj plik "${REFS_REL}" — jest tam liczba kontrolna.`,
        `2. Zapisz notatkę "${NOTATKA_REL}" (mode: create) i wpisz do niej tę liczbę kontrolną.`,
        '3. Odpowiedz jednym zdaniem, co zostało zrobione.',
        '',
      ].join('\n'),
    },
    {
      // `references/` NIE są nigdzie doklejane automatycznie — model musi po nie sięgnąć `read`em.
      path: REFS_REL,
      content: [
        '# Dane referencyjne przepisu Poligonu',
        '',
        `Liczba kontrolna: ${LICZBA_KONTROLNA}`,
        '',
        'Ten plik istnieje po to, żeby udowodnić, że model realnie sięgnął po materiały',
        'pomocnicze skilla, a nie zgadł treść z samego indeksu w prompcie.',
        '',
      ].join('\n'),
    },
  ],

  offlineScript: (ctx: FixturePayload) => {
    if (ctx.turnIndex === 0) {
      // Kopia promptu Z DRUTU — jedyny dowód, że indeks skilli poszedł do modelu.
      zebrane.systemPromptZDrutu = systemPromptZadania(ctx.request);
      return toolCallTurn('read', { path: SKILL_REL, scope: 'vault' });
    }
    if (ctx.turnIndex === 1) {
      return toolCallTurn('read', { path: REFS_REL, scope: 'vault' });
    }
    if (ctx.turnIndex === 2) {
      return toolCallTurn('write', {
        path: NOTATKA_REL,
        mode: 'create',
        content: [
          '# Raport z przepisu Poligonu',
          '',
          `Liczba kontrolna z references: ${LICZBA_KONTROLNA}`,
          '',
        ].join('\n'),
      });
    }
    return textTurn(`Przepis wykonany — notatka zapisana z liczbą kontrolną ${LICZBA_KONTROLNA}.`);
  },

  async asserts({ result, trace, vaultRoot, turn, plugin }) {
    // ── 1. INDEKS SKILLI w system prompcie ──
    // `turn.systemPrompt` = prompt zbudowany produkcyjną ścieżką (`getActiveSystemPromptWithMemory`).
    const prompt = String(turn?.systemPrompt || '');
    assert(
      prompt.includes(SLUG),
      `Indeks skilli nie wymienia „${SLUG}". Agent ma skill przypisany w YAML, więc `
      + `_buildBaseContext → buildSkillIndex powinien go wyrenderować. Prompt (ogon): `
      + JSON.stringify(prompt.slice(-600)),
    );
    assert(
      prompt.includes(SKILL_REL),
      `Indeks skilli nie podaje ŚCIEŻKI przepisu (${SKILL_REL}) — bez niej model nie ma czego `
      + 'wczytać `read`em (D17: odkrywalność = indeks, przepis = read).',
    );
    // Offline: ta sama asercja na kopii Z DRUTU. Live: fake-serwera nie ma, więc pomijamy.
    if (zebrane.systemPromptZDrutu !== null) {
      assert(
        zebrane.systemPromptZDrutu.includes(SLUG) && zebrane.systemPromptZDrutu.includes(SKILL_REL),
        'Indeks skilli jest w zbudowanym prompcie, ale NIE poszedł po drucie do modelu — '
        + 'coś go gubi między budowaniem promptu a żądaniem.',
      );
    }

    // ── 2. DWA `read` pod .pkm-assistant/skills/** (przepis + references) ──
    assertToolPost(trace, 'read', 'ok');
    const odczyty = toolPosts(trace).filter((p) => p.tool === 'read' && p.status === 'ok');
    assert(
      odczyty.length >= 2,
      `Oczekiwano co najmniej 2 udanych wywołań read (SKILL.md + references/dane.md), jest ${odczyty.length}. `
      + 'Wyjątek allowSkillsRead w vault_path_validator mógł przestać przepuszczać .pkm-assistant/skills/**.',
    );

    // ── 3. Kroki przepisu WYKONANE: notatka istnieje i niesie liczbę z references ──
    assertToolPost(trace, 'write', 'ok');
    const notatki = listVaultFiles(vaultRoot, 'Notatki').filter((p) => p.endsWith('.md'));
    const zLiczba = notatki.filter((rel) => readVaultFile(vaultRoot, rel).includes(LICZBA_KONTROLNA));
    assert(
      zLiczba.length >= 1,
      `Żadna notatka w Notatki/ nie zawiera liczby kontrolnej „${LICZBA_KONTROLNA}" z references. `
      + `Pliki: ${notatki.join(', ') || '(brak)'}`,
    );

    // ── 4. Pętla domknęła się naturalnie ──
    assertFinalText(result);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);

    // ── 5. PRE-QUESTIONS: przepis z DYSKU + podstawienie {{cel}} ──
    // Skill czytamy przez ŻYWY loader pluginu (owner: AgentManager.skillLoader), a nie z fixture —
    // to zamyka regresję E3.5 (parseSkillMarkdown gubił preQuestions z returna).
    const skillLoader = plugin?.agentManager?.skillLoader;
    assert(skillLoader, 'Brak plugin.agentManager.skillLoader — owner skilli się przesunął.');
    const skill = skillLoader.getSkill(SLUG);
    assert(skill, `SkillLoader nie zna skilla „${SLUG}" — nie wczytał się z dysku.`);
    assert(
      Array.isArray(skill.preQuestions) && skill.preQuestions.some((q: FixturePayload) => q?.key === 'cel'),
      `Skill wczytany z dysku zgubił pre-questions: ${JSON.stringify(skill.preQuestions)}`,
    );
    assert(
      String(skill.prompt || '').includes('{{cel}}'),
      'Przepis z dysku nie ma placeholdera {{cel}} — nie ma czego podstawiać.',
    );

    const podstawiony = substituteVariables(skill.prompt, { cel: CEL });
    assert(
      podstawiony.includes(CEL),
      `substituteVariables nie podstawiło wartości pre-question: ${JSON.stringify(podstawiony.slice(0, 300))}`,
    );
    assert(
      !podstawiony.includes('{{'),
      `Po podstawieniu został niezamieniony placeholder: ${JSON.stringify(podstawiony.slice(0, 300))}`,
    );
  },
} satisfies Scenario);
