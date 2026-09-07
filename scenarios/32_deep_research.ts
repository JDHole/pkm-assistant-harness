/**
 * 32_deep_research — fabryczny przepis „Deep Research — vault” przejechany OFFLINE, od A do Z.
 *
 * To jest test PRZEPISU, nie pojedynczego narzędzia: prompt tury = treść fabrycznego skilla
 * `deep-research-vault` (`core/i18n` → `factory.template.research_vault.body`) z podstawionymi
 * pre-questions `{{temat}}` / `{{glebokosc}}` — czyli DOKŁADNIE to, co produkcyjnie wpada do
 * inputu po odpowiedzi na pytania przed skillem. Fake-model odgrywa kroki przepisu:
 *
 *   krok 2 → `artifact_create {typ:'raport'}` (status startowy `w-trakcie`, pola pytanie/tryb)
 *   krok 3 → rozbicie na 2 podpytania („szybki przegląd”)
 *   krok 4 → JEDNO `delegate` z `tasks[]` (równolegle, `aspect:'researcher'` per task)
 *   krok 5 → synteza: `artifact_update` (Ustalenia / Źródła / TL;DR z wikilinkami)
 *   krok 7 → `set_field status = gotowy`
 *
 * Fuzzy match `aspect:'researcher'` trafia w odlew `<agent-slug>-researcher` (DelegateTool:
 * `endsWith('-'+aspect)`), więc fixture stawia `tester-researcher` — odlew fabrycznego szablonu.
 *
 * ⚠️ RESPONDER JEST DYNAMICZNY, bo DWA suby biegną RÓWNOLEGLE do TEGO SAMEGO fake-serwera —
 * numer tury nic nie mówi. Rozróżniamy: pętla główna vs sub (po szerokości whitelisty narzędzi),
 * który sub (po znaczniku w treści zadania), który krok (po liczbie wyników narzędzi w transkrypcie).
 *
 * Inwarianty: (1) DOKŁADNIE JEDNO `delegate` (multi-task, nie N pojedynczych), (2) DWIE pętle
 * sub-agenta w trace, (3) suby REALNIE czytały vault (`search` + `read` ze statusem ok),
 * (4) raport istnieje jako notatka z `typ: raport` / `status: gotowy` / polami pytanie+tryb,
 * (5) treść niesie sekcje Ustalenia i Źródła z wikilinkiem do prawdziwej notatki fixture'u.
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { t } from '../../core/i18n/index.js';
import { assert, assertFinalText, listVaultFiles, readVaultFile, subTraceEvents, toolPosts, toolResult } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SUB = 'tester-researcher';
const TEMAT = 'rekwizyty harnessowego vaultu';
const GLEBOKOSC = 'szybki przegląd';
const PYTANIE = 'Co vault mówi o rekwizytach harnessa?';

/** Znaczniki w treści zadań — po nich responder poznaje, KTÓRY z równoległych subów pyta. */
const ZNACZNIK_A = 'PODPYTANIE-A';
const ZNACZNIK_B = 'PODPYTANIE-B';

/** Notatki-rekwizyty z vault-fixture — suby mają czytać ISTNIEJĄCE pliki. */
const NOTATKA_A = 'Notatki/projekt.md';
const NOTATKA_B = 'Notatki/powitanie.md';
const WIKILINK_A = '[[Notatki/projekt]]';
const WIKILINK_B = '[[Notatki/powitanie]]';

const USTALENIA = [
  '### Stan projektu',
  `- Projekt jest w toku — „status: w-toku" (${WIKILINK_A})`,
  '',
  '### Rola rekwizytów',
  `- Notatki służą smoke-testom narzędzi — „notatka-rekwizyt w atrapie vaulta harnessa" (${WIKILINK_B})`,
].join('\n');

const ZRODLA = [`- ${WIKILINK_A}`, `- ${WIKILINK_B}`].join('\n');
const TLDR = 'Vault trzyma dwa rekwizyty: plan projektu w toku i notatkę powitalną opisującą przeznaczenie atrapy.';

const ODPOWIEDZ_KONCOWA = 'Raport gotowy — esencja w TL;DR, szczegóły w notatce artefaktu.';

/** Ile wiadomości `tool` jest w transkrypcie żądania = który krok przepisu/suba mamy odegrać. */
function ileWynikowNarzedzi(request: FixturePayload): number {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return messages.filter((m: FixturePayload) => m?.role === 'tool').length;
}

/**
 * Czy to żądanie SUB-AGENTA? Sub ma whitelistę z `tools:` (search/list/read = 3), agent główny
 * — komplet built-inów (>20). Rozróżnienie po liczbie narzędzi, nie po numerze tury (wzór z 11).
 */
function jestPodzapytaniem(request: FixturePayload): boolean {
  const nazwy = (request?.tools || [])
    .map((td: FixturePayload) => td?.function?.name)
    .filter(Boolean);
  return nazwy.length > 0 && nazwy.length <= 6;
}

/** Który z równoległych subów pyta — po znaczniku wstawionym w treść zadania. */
function ktorySub(request: FixturePayload): 'A' | 'B' {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const user = messages.find((m: FixturePayload) => m?.role === 'user');
  return String(user?.content || '').includes(ZNACZNIK_B) ? 'B' : 'A';
}

/** `id` artefaktu z DOWOLNEGO wyniku narzędzia w transkrypcie (create był kilka tur wcześniej). */
function idArtefaktu(request: FixturePayload): string | null {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  for (const m of messages) {
    if (m?.role !== 'tool') continue;
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const match = /"id"\s*:\s*"(art-[^"]+)"/.exec(raw);
    if (match) return match[1];
  }
  return null;
}

export default ({
  file: '32_deep_research',
  name: 'deep research vault',
  opis: 'przepis Deep Research (vault): artifact_create → JEDNO multi-task delegate → synteza artifact_update → status gotowy',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 8,
  evidenceFiles: ['PKM Assistant/Artefakty'],
  liveSkip: 'wymaga deterministycznej orkiestracji multi-task delegate + konkretnych artifact_update — bieg żywy w Fazie 2 kampanii osobnym promptem',

  /**
   * Prompt tury = FABRYCZNY przepis z pre-questions podstawionymi przez `t()` (interpolacja
   * `{{param}}` jest wbudowana w i18n). GETTER, nie pole — locale ustawia dopiero `onload`
   * pluginu (`src/main.ts` → `setLocale`), a runner czyta `livePrompt` po boocie.
   */
  get livePrompt(): string {
    return t('factory.template.research_vault.body', { temat: TEMAT, glebokosc: GLEBOKOSC });
  },

  fixtures: [
    {
      // Tester z ekipą: bez wpisu w `sub_agents` delegacja po `aspect` nie ma czego dopasować.
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
        'sub_agents:',
        `  - ${SUB}`,
        'mcp_servers:',
        '  - vault',
        '  - memory',
        '  - core',
        '',
      ].join('\n'),
    },
    {
      // Odlew fabrycznego szablonu `researcher` — read-only, bez web (harness nie robi requestów).
      path: `.pkm-assistant/sub-agents/${SUB}/SUB_AGENT.yaml`,
      content: [
        `name: ${SUB}`,
        'description: Worker researchu vaultu — bada jedno podpytanie i wraca z cytatami i wikilinkami.',
        'role: researcher',
        'tools:',
        '  - search',
        '  - list',
        '  - read',
        'max_iterations: 4',
        'min_iterations: 1',
        'max_tool_result_length: 15000',
        'enabled: true',
        '',
      ].join('\n'),
    },
    {
      path: `.pkm-assistant/sub-agents/${SUB}/KNOWLEDGE.md`,
      content: [
        'Szukasz TYLKO w vaulcie (search → read najlepszych trafień). Nie używasz sieci.',
        'Wracasz w formacie USTALENIA / LUKI / ŹRÓDŁA, przy każdym twierdzeniu cytat i wikilink.',
        '',
      ].join('\n'),
    },
  ],

  async setup({ plugin }) {
    const am = plugin?.agentManager;
    assert(am?.subAgentLoader?.getSubAgent?.(SUB), `Sub „${SUB}" nie wczytał się z fixture — delegacja po aspect nie miałaby czego dopasować.`);
    assert(am?.artifactTypeLoader?.getType?.('raport'), 'Wbudowany typ artefaktu „raport" nie zaseedował się — przepis nie ma czego tworzyć.');
    assert(plugin?.artifactStore, 'Brak plugin.artifactStore — narzędzia artefaktów nie mają silnika.');
  },

  offlineScript: (ctx: FixturePayload) => {
    const request = ctx.request;

    // ── SUB-AGENT (dwa biegną równolegle) ──
    if (jestPodzapytaniem(request)) {
      const kto = ktorySub(request);
      const krok = ileWynikowNarzedzi(request);
      if (krok === 0) {
        return toolCallTurn('search', {
          query: kto === 'A' ? 'projekt kroki harness' : 'powitanie rekwizyt vault',
          scope: 'vault',
          mode: 'keyword',
          limit: 5,
        });
      }
      if (krok === 1) {
        return toolCallTurn('read', { path: kto === 'A' ? NOTATKA_A : NOTATKA_B, scope: 'vault' });
      }
      return textTurn(kto === 'A'
        ? `USTALENIA:\n- Projekt jest w toku — „status: w-toku" (${WIKILINK_A})\nLUKI:\n- brak dat\nŹRÓDŁA:\n- ${WIKILINK_A}`
        : `USTALENIA:\n- Notatki to rekwizyty smoke-testów — „notatka-rekwizyt w atrapie vaulta harnessa" (${WIKILINK_B})\nLUKI:\n- brak\nŹRÓDŁA:\n- ${WIKILINK_B}`);
    }

    // ── PĘTLA GŁÓWNA (kroki przepisu) ──
    const krok = ileWynikowNarzedzi(request);

    if (krok === 0) {
      // Krok 2: szkielet raportu. Status zostaje startowy (`w-trakcie`) — tak każe przepis.
      return toolCallTurn('artifact_create', {
        typ: 'raport',
        tytul: `Research vault — ${TEMAT}`,
        pola: { pytanie: PYTANIE, tryb: 'vault' },
      });
    }

    if (krok === 1) {
      // Krok 4: JEDNO wywołanie z listą zadań (nie N pojedynczych delegacji).
      return toolCallTurn('delegate', {
        timeout_ms: 300000,
        tasks: [
          {
            task: `${ZNACZNIK_A} Co vault mówi o stanie przykładowego projektu? Szukaj TYLKO w vaulcie.`,
            aspect: 'researcher',
          },
          {
            task: `${ZNACZNIK_B} Po co istnieją notatki-rekwizyty w tym vaulcie? Szukaj TYLKO w vaulcie.`,
            aspect: 'researcher',
          },
        ],
      });
    }

    if (krok === 2) {
      // Kroki 5 + 7: synteza w sekcjach raportu + zamknięcie statusu.
      const id = idArtefaktu(request);
      if (!id) return textTurn('Nie udało się odczytać id raportu z wyniku artifact_create.');
      return toolCallTurn('artifact_update', {
        id,
        ops: [
          { op: 'set_section', heading: 'Ustalenia', text: USTALENIA },
          { op: 'set_section', heading: 'Źródła', text: ZRODLA },
          { op: 'set_section', heading: 'TL;DR', text: TLDR },
          { op: 'set_field', key: 'status', value: 'gotowy' },
        ],
      });
    }

    return textTurn(ODPOWIEDZ_KONCOWA);
  },

  async asserts(ctx) {
    const { result, trace, vaultRoot } = ctx;
    // ── 1. Kroki przepisu wykonane właściwymi narzędziami ──
    const posty = toolPosts(trace);
    const delegacje = posty.filter((p) => p.tool === 'delegate');
    assert(
      delegacje.length === 1,
      `Przepis wymaga JEDNEGO wywołania delegate z listą tasks (równolegle), a jest ${delegacje.length}. `
      + `Wywołania: ${posty.map((p) => `${p.tool}:${p.status}`).join(', ') || '(brak)'}`,
    );
    assert(
      posty.some((p) => p.tool === 'artifact_create' && p.status === 'ok'),
      'Brak udanego artifact_create — szkielet raportu (krok 2) nie powstał.',
    );
    assert(
      posty.some((p) => p.tool === 'artifact_update' && p.status === 'ok'),
      'Brak udanego artifact_update — synteza (krok 5) nie weszła.',
    );

    const patch = toolResult(result, 'artifact_update');
    assert(
      patch && /"errors"\s*:\s*\[\]/.test(patch.resultPreview || ''),
      `Patch syntezy zgłosił błędy (sekcje raportu mogły się rozjechać z szablonem typu): `
      + `${(patch?.resultPreview || '(brak)').slice(0, 300)}`,
    );

    // ── 2. DWIE pętle sub-agenta + realny odczyt vaulta przez suby ──
    const subTrace = await subTraceEvents(ctx, SUB);
    const petle = subTrace.filter((e) => e.type === 'loop.start');
    assert(
      petle.length === 2,
      `Oczekiwano DWÓCH pętli sub-agenta pod etykietą „sub/${SUB}" (2 podpytania równolegle), jest ${petle.length}.`,
    );
    const postySuba = toolPosts(subTrace);
    assert(
      postySuba.filter((p) => p.tool === 'search' && p.status === 'ok').length >= 2,
      `Suby nie przeszukały vaulta (search ok: ${postySuba.filter((p) => p.tool === 'search').length}).`,
    );
    assert(
      postySuba.filter((p) => p.tool === 'read' && p.status === 'ok').length >= 2,
      `Suby nie przeczytały notatek (read ok: ${postySuba.filter((p) => p.tool === 'read').length}).`,
    );

    // ── 3. Raport istnieje jako notatka z właściwym frontmatterem ──
    const notatki = listVaultFiles(vaultRoot, 'PKM Assistant/Artefakty').filter((p) => p.endsWith('.md'));
    const raporty = notatki.filter((rel) => /(^|\n)typ:\s*raport\b/.test(readVaultFile(vaultRoot, rel)));
    assert(
      raporty.length === 1,
      `Oczekiwano DOKŁADNIE jednej notatki typu raport, jest ${raporty.length}: ${notatki.join(', ') || '(brak)'}`,
    );
    const tresc = readVaultFile(vaultRoot, raporty[0]);

    assert(/(^|\n)pkm-artefakt:/.test(tresc), `Raport ${raporty[0]} nie ma frontmatteru pkm-artefakt.`);
    assert(
      /(^|\n)status:\s*gotowy\b/.test(tresc),
      `Krok 7 nie domknął raportu — status nie jest „gotowy". Frontmatter: ${tresc.slice(0, 300)}`,
    );
    assert(
      new RegExp(`(^|\\n)pytanie:\\s*.*${PYTANIE.slice(0, 20)}`).test(tresc),
      `Raport nie niesie pola „pytanie" z pytaniem badawczym. Frontmatter: ${tresc.slice(0, 300)}`,
    );
    assert(
      /(^|\n)tryb:\s*vault\b/.test(tresc),
      `Raport nie niesie pola „tryb: vault". Frontmatter: ${tresc.slice(0, 300)}`,
    );

    // ── 4. Synteza: sekcje z cytatami i wikilinkami do PRAWDZIWYCH notatek fixture'u ──
    assert(/\n##\s*Ustalenia\b/.test(tresc), `Raport ${raporty[0]} zgubił sekcję „Ustalenia".`);
    assert(/\n##\s*Źródła\b/.test(tresc), `Raport ${raporty[0]} zgubił sekcję „Źródła".`);
    for (const wikilink of [WIKILINK_A, WIKILINK_B]) {
      assert(
        tresc.includes(wikilink),
        `Raport nie zawiera wikilinku ${wikilink} — synteza zgubiła źródła z ustaleń workerów.`,
      );
    }
    assert(tresc.includes(TLDR), 'Raport nie ma TL;DR — przepis wymaga esencji na koniec.');

    // ── 5. Pętla główna domknęła się odpowiedzią ──
    const finalText = assertFinalText(result);
    assert(
      finalText.includes(ODPOWIEDZ_KONCOWA),
      `Finalny tekst pętli jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );
  },
} satisfies Scenario);
