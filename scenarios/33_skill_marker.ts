/**
 * 33_skill_marker — ścieżka MARKERA `@@skill:` (klik w slim barze / popup `/`).
 *
 * Wydzielony z `30_skill_przepis`: obie ścieżki jadą z JEDNEJ globalnej kolejki tur
 * fake-serwera, a splot „4 tury runnera + 2 tury ręczne" był nieczytelny i kruchy.
 *
 * CO SIĘ DZIEJE W PRODUKCJI (`chat_streaming.send_message`): user klika skill → do treści
 * wiadomości wjeżdża marker `@@skill:<nazwa>` (`makeInlineTriggerMarker`) → `parseInlineTriggers`
 * go wyłuskuje → `agentManager.resolveSkillConfig(nazwa, agent)` resolwuje przepis RAZEM
 * z overrides per-agent → `buildInlineTriggerInstruction` skleja instrukcję tury z WKLEJONYM
 * pełnym przepisem → marker znika z treści (`stripInlineTriggers`), a instrukcja dokleja się
 * do promptu tury. Harness nie stawia warstwy czatu, więc scenariusz robi to samo czystymi
 * funkcjami z `InlineChipPlugin` i podaje wynik jako `systemPromptSuffix` (`runTurn.ts`).
 *
 * Inwarianty: (1) marker parsuje się jako `type:'skill'`, (2) instrukcja niesie PEŁNY przepis
 * (nie samą nazwę), (3) przepis dotarł po drucie w prompcie systemowym, (4) marker NIE dotarł
 * do treści wiadomości usera, (5) tura domknęła się odpowiedzią.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  buildInlineTriggerInstruction,
  makeInlineTriggerMarker,
  parseInlineTriggers,
  stripInlineTriggers,
} from '../../modules/chat/chat/InlineChipPlugin.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { assert, assertFinalText } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SLUG = 'poligon-marker';
const SKILL_REL = `.pkm-assistant/skills/${SLUG}/SKILL.md`;

/** Zdanie żyjące WYŁĄCZNIE w treści przepisu — jego obecność w prompcie dowodzi wklejenia. */
const ZDANIE_PRZEPISU = 'ZNACZNIK-PRZEPISU-POLIGON-91';

const ODPOWIEDZ_PIERWSZA = 'Gotów — czekam na marker.';
const ODPOWIEDZ_MARKERA = 'Przepis z markera przyjęty.';

/** Dowody zebrane W BIEGU: kopie promptów z drutu dla tury markera. */
const zebrane: { system: string | null; user: string | null } = { system: null, user: null };

function tresc(request: FixturePayload, rola: string): string {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const msg = messages.find((m: FixturePayload) => m?.role === rola);
  return typeof msg?.content === 'string' ? msg.content : '';
}

export default ({
  file: '33_skill_marker',
  name: 'skill marker',
  opis: 'marker @@skill: wkleja PEŁNY przepis do instrukcji tury, a sam znika z treści wiadomości',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'ścieżka markera jest sterowana przez UI czatu (klik w chip), nie przez decyzję modelu — bieg na żywym DeepSeeku niczego by nie dodał',

  fixtures: [
    {
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
      path: SKILL_REL,
      content: [
        '---',
        `name: ${SLUG}`,
        'description: "Przepis Poligonu uruchamiany markerem inline."',
        'category: research',
        'version: 1',
        'enabled: true',
        'icon: "📎"',
        'user-invocable: true',
        '---',
        '',
        '# Przepis markera',
        '',
        `Zdanie kontrolne przepisu: ${ZDANIE_PRZEPISU}`,
        '',
        'Odpowiedz jednym zdaniem, że przepis został przyjęty.',
        '',
      ].join('\n'),
    },
  ],

  offlineScript: (ctx: FixturePayload) => {
    if (ctx.turnIndex === 0) return textTurn(ODPOWIEDZ_PIERWSZA);
    // Tura MARKERA (odpalana ręcznie z asserts) — przechwyć oba prompty z drutu.
    zebrane.system = tresc(ctx.request, 'system');
    zebrane.user = tresc(ctx.request, 'user');
    return textTurn(ODPOWIEDZ_MARKERA);
  },

  async asserts({ plugin }) {
    const agentManager = plugin?.agentManager;
    assert(agentManager, 'Brak plugin.agentManager — bootstrap nieukończony?');
    const agent = agentManager.getActiveAgent();
    assert(agent?.name === 'Tester', `Aktywny agent to ${agent?.name}, oczekiwano „Tester".`);

    // ── 1. Marker: budowa + parsowanie (czyste funkcje InlineChipPlugin) ──
    const marker = makeInlineTriggerMarker('skill', SLUG);
    assert(marker === `@@skill:${SLUG}`, `Nieoczekiwany kształt markera: ${marker}`);

    const surowa = `Odpal to teraz ${marker} i nic nie dopytuj.`;
    const markery = parseInlineTriggers(surowa);
    assert(
      markery.length === 1 && markery[0].type === 'skill' && markery[0].name === SLUG,
      `parseInlineTriggers nie rozpoznał markera skilla: ${JSON.stringify(markery)}`,
    );

    // ── 2. Resolucja przepisu przez ŻYWY AgentManager (overrides per-agent w tej samej ścieżce) ──
    const cfg = agentManager.resolveSkillConfig(SLUG, agent);
    assert(cfg, `resolveSkillConfig nie znalazł skilla „${SLUG}".`);
    assert(
      String(cfg.prompt || '').includes(ZDANIE_PRZEPISU),
      `Zresolwowany przepis nie niesie zdania kontrolnego: ${JSON.stringify(String(cfg.prompt).slice(0, 200))}`,
    );

    const instrukcja = buildInlineTriggerInstruction(markery, { [SLUG]: { name: cfg.name, prompt: cfg.prompt } });
    assert(
      instrukcja.includes(ZDANIE_PRZEPISU),
      'buildInlineTriggerInstruction NIE wkleiło pełnego przepisu — marker zamienił się w samą wzmiankę '
      + `o skillu (D17 wymaga przepisu inline). Instrukcja: ${JSON.stringify(instrukcja.slice(0, 300))}`,
    );
    assert(
      /UŻYTKOWNIK URUCHOMIŁ SKILL/.test(instrukcja),
      `Instrukcja tury nie ma nagłówka wymuszającego wykonanie przepisu: ${JSON.stringify(instrukcja.slice(0, 300))}`,
    );

    // ── 3. Marker znika z treści wiadomości usera ──
    const czysta = stripInlineTriggers(surowa);
    assert(
      !czysta.includes('@@skill:') && czysta.includes('Odpal to teraz'),
      `stripInlineTriggers zostawiło marker albo zjadło treść: ${JSON.stringify(czysta)}`,
    );

    // ── 4. Tura z doklejoną instrukcją (produkcyjna pętla, ten sam plugin i vault) ──
    const tura = await runExploratoryTurn(plugin, {
      agentName: 'Tester',
      prompt: czysta,
      autonomy: 'edge',
      approve: 'auto',
      maxIterations: 2,
      runId: 'marker',
      systemPromptSuffix: instrukcja,
    });

    assert(
      tura.systemPrompt.includes(ZDANIE_PRZEPISU),
      'Prompt systemowy tury nie zawiera wklejonego przepisu — systemPromptSuffix nie zadziałał.',
    );
    assert(
      zebrane.system !== null,
      'Fake-serwer nie zobaczył tury markera — kolejka tur rozjechała się z planem scenariusza.',
    );
    assert(
      zebrane.system.includes(ZDANIE_PRZEPISU) && /UŻYTKOWNIK URUCHOMIŁ SKILL/.test(zebrane.system),
      'Przepis NIE poszedł po drucie w prompcie systemowym — instrukcja markera zgubiła się po drodze.',
    );
    assert(
      zebrane.user !== null && !zebrane.user.includes('@@skill:'),
      `Marker dotarł do modelu w treści wiadomości usera (miał zostać zdjęty): ${JSON.stringify(zebrane.user)}`,
    );

    const finalText = assertFinalText(tura.result, 'Tura markera nie zwróciła odpowiedzi.');
    assert(
      finalText.includes(ODPOWIEDZ_MARKERA),
      `Finalny tekst tury markera jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );
  },
} satisfies Scenario);
