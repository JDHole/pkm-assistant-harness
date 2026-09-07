/**
 * 25_think_parser — pancerz parsera myślenia na ŻYWYCH adapterach LM Studio i Ollamy.
 *
 * KONTEKST: modele rozumujące (DeepSeek-R1 distill, Qwen3) wysyłają rozumowanie dwiema drogami —
 * inline w tagach `<think>…</think>` (LM Studio i reszta platform OpenAI-kształtnych, przez
 * domieszkę `withInlineThinkParsing`) albo w osobnym polu `message.thinking` (Ollama, `/api/chat`
 * z `think: true`). Jedno źródło mechaniki to `ThinkTagParser`
 * (`modules/models/adapters/chat/think_tag_parser.ts`), a wpięcia są DWA i różne.
 *
 * CZYM TO SIĘ RÓŻNI OD TESTÓW JEDNOSTKOWYCH (`lm_studio_think_parser.test.ts`,
 * `ollama_think_parser.test.ts`): tamte karmią adapter odpowiedzi chunkami wprost i patrzą na
 * `_res.message`. Tutaj nie ma skrótu — leci PEŁNY łańcuch: fake-serwer (SSE / NDJSON) →
 * transport strumienia → adapter → `runAgentLoop` → egzekutor narzędzi. Sprawdzamy więc
 * INTEGRACJĘ: czy myślenie faktycznie NIE dochodzi do widocznej odpowiedzi pętli i czy tool call
 * wysłany PO bloku myślenia dalej się parsuje i wykonuje.
 *
 * Co realnie sprawdza (oba tory):
 *   1. treść bloków myślenia NIE występuje w finalnym tekście pętli,
 *   2. normalna treść przechodzi nietknięta (do ostatniego znaku — parser trzyma rezerwę
 *      ≤8 znaków na tag rozcięty między chunki i musi ją dopchnąć na koniec strumienia),
 *   3. wydzielone myślenie ląduje w `reasoning_content` odpowiedzi i jest NIEPUSTE
 *      (podsłuch `getHarnessCompletions` — pętla go nie wystawia, a request adapter nie
 *      przepisuje go do kolejnego żądania, więc to jedyny punkt obserwacji),
 *   4. (LM Studio) tool call po bloku myślenia parsuje się i wykonuje — `tool.post read ok`.
 *
 * Znacznik `<think>` jedzie ROZCIĘTY między chunki (tura 0 idzie 3-znakowymi kawałkami), bo
 * właśnie na tym parser dwa razy się wywrócił: skanuje treść SKUMULOWANĄ, nie pojedynczy chunk.
 *
 * TOR OLLAMY jest odpalany RĘCZNIE w `asserts` — runner stawia jeden fake-serwer na scenariusz
 * (SSE, dla toru LM Studio), a Ollama potrzebuje własnego serwera NDJSON i własnego agenta.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { startFakeOllamaServer, ollamaTextTurn } from '../mock/fake-ollama-server.js';
import {
  clearHarnessCompletions,
  getHarnessCompletions,
  setHarnessOllamaHost,
} from '../lib/harnessProviders.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { assert, assertToolPost, assertToolOk, assertFinalText, loopEnd } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const AGENT_LM = 'MyslicielLM';
const AGENT_OLLAMA = 'MyslicielOllama';

// Treści myślenia — NIE MOGĄ pojawić się w widocznej odpowiedzi.
const SEKRET_LM_1 = 'SEKRET-MYSLENIA-LM-PIERWSZY';
const SEKRET_LM_2 = 'SEKRET-MYSLENIA-LM-DRUGI';
const SEKRET_OLLAMA = 'SEKRET-MYSLENIA-OLLAMA';

// Treści widoczne — MUSZĄ przejść w całości.
const WIDOCZNE_LM_1 = 'Zajrze do notatki powitalnej.';
const WIDOCZNE_LM_2 = 'Notatka powitalna opisuje testowy vault harnessa.';
const WIDOCZNE_OLLAMA = 'Ollama odpowiada nie zdradzajac swojego myslenia.';

/** Wiadomość z podsłuchanej odpowiedzi modelu (kształt OpenAI po `to_openai()`). */
function wiadomosc(platform: string, tura: number): FixturePayload {
  const zapisy = getHarnessCompletions(platform);
  assert(
    zapisy.length > tura,
    `Podsłuch nie ma tury ${tura} dla platformy ${platform} (zapisano ${zapisy.length}). `
    + 'Adapter harnessowy nie został zarejestrowany albo model w ogóle nie odpowiedział.',
  );
  const msg = (zapisy[tura].completion as FixturePayload)?.choices?.[0]?.message;
  assert(msg, `Odpowiedź ${platform} tura ${tura} nie ma choices[0].message.`);
  return msg;
}

/** Wspólny komplet asercji „myślenie osobno, treść osobno" dla jednej odpowiedzi modelu. */
function assertMyslenieOddzielone(
  msg: FixturePayload,
  { sekret, widoczne, etykieta }: { sekret: string; widoczne: string; etykieta: string },
): void {
  const tresc = String(msg.content ?? '');
  const myslenie = String(msg.reasoning_content ?? '');

  assert(
    myslenie.includes(sekret),
    `${etykieta}: myślenie NIE trafiło do reasoning_content (jest: ${JSON.stringify(myslenie).slice(0, 200)}).`,
  );
  assert(
    myslenie.trim().length > 0,
    `${etykieta}: reasoning_content jest puste — wydzielone myślenie przepadło.`,
  );
  assert(
    !tresc.includes(sekret),
    `${etykieta}: treść myślenia WYCIEKŁA do widocznej odpowiedzi: ${JSON.stringify(tresc).slice(0, 200)}`,
  );
  assert(
    !tresc.includes('<think>') && !tresc.includes('</think>'),
    `${etykieta}: surowy znacznik <think> został w widocznej treści: ${JSON.stringify(tresc).slice(0, 200)}`,
  );
  assert(
    tresc.includes(widoczne),
    `${etykieta}: normalna treść nie przeszła w całości. Oczekiwano „${widoczne}", jest: ${JSON.stringify(tresc).slice(0, 200)}`,
  );
}

/** Wspólny YAML agenta harnessa — różni się tylko nazwą i platformą modelu. */
function agentYaml(name: string, model: string): string {
  return [
    `name: ${name}`,
    `description: Agent harnessa na modelu rozumujacym (${model}).`,
    'personality: |',
    '  Jestes Myslicielem — agentem testowym harnessa na lokalnym modelu rozumujacym.',
    '  Odpowiadasz krotko i konkretnie.',
    `model: ${model}`,
    'access_policy_version: 2',
    'admin_access: false',
    'default_permissions:',
    '  memory: true',
    '  guidance_mode: true',
    'disabled_tools: []',
    'default_autonomy: edge',
    'mcp_servers:',
    '  - vault',
    '  - memory',
    '  - core',
    '',
  ].join('\n');
}

export default ({
  file: '25_think_parser',
  name: 'parser myslenia',
  opis: 'myślenie nie wycieka do odpowiedzi (LM Studio inline <think> + Ollama message.thinking), tool call po bloku myślenia dalej działa',
  agent: AGENT_LM,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 4,
  liveSkip: 'wymaga lokalnych platform LM Studio/Ollama, nie DeepSeek',

  fixtures: [
    { path: '.pkm-assistant/agents/mysliciel_lm.yaml', content: agentYaml(AGENT_LM, 'lm_studio/qwen3-harness') },
    { path: '.pkm-assistant/agents/mysliciel_ollama.yaml', content: agentYaml(AGENT_OLLAMA, 'ollama/qwen3-harness') },
  ],

  offlineScript: [
    // Tura 0: myślenie inline + zapowiedź + tool call. `textSplit: 24` daje 3-znakowe kawałki,
    // więc `<think>` i `</think>` przyjeżdżają ROZCIĘTE — dokładnie patologia, na której
    // parser się wykładał.
    toolCallTurn('read', { path: 'Notatki/powitanie.md' }, {
      text: `<think>${SEKRET_LM_1}</think>${WIDOCZNE_LM_1}`,
      textSplit: 24,
    }),
    // Tura 1: odpowiedź finalna, też z blokiem myślenia na starcie.
    textTurn(`<think>${SEKRET_LM_2}</think>${WIDOCZNE_LM_2}`),
  ],

  async setup() {
    clearHarnessCompletions(); // czysty podsłuch na start (runner zeruje też sam, to pas i szelki)
  },

  async asserts({ result, trace, plugin }) {
    // ══ TOR 1: LM Studio (myślenie inline w tagach <think>) ══
    assertToolPost(trace, 'read', 'ok');
    assertToolOk(result, 'read');
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);

    const finalText = assertFinalText(result);
    assert(
      !finalText.includes(SEKRET_LM_1) && !finalText.includes(SEKRET_LM_2),
      `Myślenie modelu WYCIEKŁO do finalnego tekstu pętli: ${JSON.stringify(finalText).slice(0, 300)}`,
    );
    assert(
      finalText.includes(WIDOCZNE_LM_2),
      `Finalny tekst pętli nie zawiera widocznej odpowiedzi „${WIDOCZNE_LM_2}": ${JSON.stringify(finalText).slice(0, 300)}`,
    );

    assertMyslenieOddzielone(wiadomosc('lm_studio', 0), {
      sekret: SEKRET_LM_1, widoczne: WIDOCZNE_LM_1, etykieta: 'LM Studio tura 0 (z tool callem)',
    });
    assertMyslenieOddzielone(wiadomosc('lm_studio', 1), {
      sekret: SEKRET_LM_2, widoczne: WIDOCZNE_LM_2, etykieta: 'LM Studio tura 1 (finalna)',
    });

    // Tool call przyszedł PO bloku myślenia — nazwa i argumenty muszą być nietknięte.
    const toolCalls = wiadomosc('lm_studio', 0).tool_calls || [];
    assert(
      toolCalls.length === 1 && toolCalls[0]?.function?.name === 'read',
      `Tool call po bloku myślenia rozjechał się: ${JSON.stringify(toolCalls).slice(0, 300)}`,
    );
    assert(
      String(toolCalls[0]?.function?.arguments || '').includes('Notatki/powitanie.md'),
      `Argumenty tool calla po bloku myślenia rozjechały się: ${JSON.stringify(toolCalls[0]?.function?.arguments)}`,
    );

    // ══ TOR 2: Ollama (myślenie NATYWNE w message.thinking) ══
    // Własny fake-serwer NDJSON + własny agent; ta sama produkcyjna pętla (`runExploratoryTurn`).
    const serwer = await startFakeOllamaServer({
      script: [ollamaTextTurn(WIDOCZNE_OLLAMA, { split: 4, thinking: SEKRET_OLLAMA, thinkingSplit: 3 })],
    });
    try {
      setHarnessOllamaHost(serwer.origin);
      clearHarnessCompletions();

      const turaOllama = await runExploratoryTurn(plugin, {
        agentName: AGENT_OLLAMA,
        prompt: 'Odpowiedz krótko, bez używania narzędzi.',
        autonomy: 'edge',
        approve: 'auto',
        maxIterations: 2,
        runId: 'ollama',
      });

      const finalOllama = assertFinalText(turaOllama.result, 'Ollama: finalText jest pusty.');
      assert(
        !finalOllama.includes(SEKRET_OLLAMA),
        `Ollama: natywne myślenie WYCIEKŁO do finalnego tekstu pętli: ${JSON.stringify(finalOllama).slice(0, 300)}`,
      );
      assert(
        finalOllama.includes(WIDOCZNE_OLLAMA),
        `Ollama: finalny tekst pętli nie zawiera widocznej odpowiedzi: ${JSON.stringify(finalOllama).slice(0, 300)}`,
      );

      assertMyslenieOddzielone(wiadomosc('ollama', 0), {
        sekret: SEKRET_OLLAMA, widoczne: WIDOCZNE_OLLAMA, etykieta: 'Ollama tura 0 (natywne thinking)',
      });

      assert(
        serwer.getRequestCount() === 1,
        `Fake-serwer Ollamy miał dostać DOKŁADNIE 1 zapytanie, dostał ${serwer.getRequestCount()}.`,
      );
    } finally {
      setHarnessOllamaHost(null);
      try { await serwer.close(); } catch { /* best-effort */ }
    }
  },
} satisfies Scenario);
