/**
 * 47_cli_odczyt — komendy CLI Obsidiana (wtyczka-nosiciel `companion/`, id `pkm-assistant-dev`)
 * end-to-end, offline.
 *
 * Werdykt właściciela 2026-09-20: narzędzia CLI wewnętrzne (agenci Claude Code pytają plugin
 * o stan) nie żyją w repo pluginu — przeniesione do MAŁEJ PRYWATNEJ wtyczki-nosiciela (`companion/`,
 * TEN repo), która przy KAŻDYM wywołaniu komendy rozwiązuje żywą instancję hosta
 * `app.plugins.plugins['pkm-assistant']` (`companion/hostPlugin.ts`). Ten scenariusz stawia
 * OBIE wtyczki w JEDNEJ atrapie `app`: prawdziwy plugin (jak dotąd, przez `bootPlugin`) I
 * wtyczkę-nosiciela (`new CompanionPlugin(app, manifest); companion.onload()`), wpina pluginu
 * pod `app.plugins.plugins['pkm-assistant']`, i woła cztery komendy `pkm-assistant-dev:*`
 * dokładnie tak, jak zrobiłby to Obsidian z CLI — `handler(params)` na surowym worku
 * `{klucz: 'wartość'}`, parsując JSON, który handler oddaje na "stdout".
 *
 * `liveSkip`: cztery komendy CLI nie dotykają modelu w ogóle (czysty odczyt stanu hosta) —
 * bieg na żywym DeepSeeku nie dodałby nic ponad offline, tylko kosztowałby. Tura modelu w tym
 * scenariuszu jest tu WYŁĄCZNIE dlatego, że `_runner.ts` zawsze odpala jedną (wzór
 * `45_nowy_agent_pusta_ekipa`/`46_boot_bez_starterow`) — cała weryfikacja CLI dzieje się w
 * `asserts`, PO turze, wołając produkcyjne handlery wprost na żywej parze plugin+companion.
 *
 * DOWÓD "TYLKO ODCZYT" (punkt e specyfikacji zadania): migawka rekurencyjna CAŁEGO drzewa
 * temp-vaulta (ścieżka + rozmiar + mtime + sha256 treści) TUŻ PRZED skonstruowaniem
 * wtyczki-nosiciela i TUŻ PO wywołaniu WSZYSTKICH komend tego scenariusza (w tym kroku "host
 * nieobecny" niżej) musi wyjść identyczna. Wykluczone są WYŁĄCZNIE dwa KONKRETNE pliki — sink
 * `Logger`/`LogFileSink` (`core/utils/LogFileSink.ts`) hosta, `.pkm-assistant/logs/pkm-assistant.log`
 * + jego rotacja `.pkm-assistant/logs/pkm-assistant.log.old` (`DEFAULT_PATH`/`oldPath` w
 * `LogFileSink.ts`) — NIE cały katalog `.pkm-assistant/logs/`. `Logger` buforuje KAŻDE
 * `log.info/warn/error` z CAŁEGO pluginu (nie tylko CLI) i zrzuca bufor na dysk co
 * `flushEveryN=20` wpisów ALBO po debounce ~1s — niezależnie od tego, czy ktokolwiek woła CLI.
 * Boot sam z siebie już zdążył zapełnić bufor, więc odpalenie flusha w oknie między dwiema
 * migawkami jest kwestią TIMINGU zegara, nie efektem komend pod testem. Wykluczenie CAŁEGO
 * katalogu maskowałoby też każdy INNY, NIEOCZEKIWANY plik, który mógłby się tam pojawić — np.
 * raport `selftest-<stamp>.md`, który produkcyjny `run_self_test()` pluginu (`src/main.ts`) pisze
 * właśnie tam; komenda CLI `selftest` tej wtyczki go NIE woła (woła `buildSelfTestReport`
 * bezpośrednio, bez zapisu — patrz `companion/CLAUDE.md`), ale gdyby to się kiedyś zmieniło, ta
 * migawka MA to złapać. Sama treść vaulta (ustawienia, notatki, YAML agentów, pamięć) idzie przez
 * migawkę bez wyjątków. Wtyczka-nosiciel sama (konstrukcja + `onload()`, czyste
 * `registerCliHandler` na SOBIE) nie dotyka dysku w ogóle - migawka "przed" obejmuje też ten
 * krok, żeby to było zmierzone, nie tylko założone.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { textTurn } from '../mock/fake-llm-server.js';
import { assert, assertFinalText, fail, listVaultFiles } from './_asserts.js';
import CompanionPlugin from '../companion/main.js';

import type { FixturePayload, Scenario } from './_asserts.js';
import type { RegisteredCliHandler, CliData } from '../test-support/obsidian.js';
import type { CliResponse, StatusData, AgentPromptData, MemoryStatusData } from '../companion/cli/index.js';

const HOST_ID = 'pkm-assistant';
const COMPANION_ID = 'pkm-assistant-dev';
const CMD = {
  status: `${COMPANION_ID}:status`,
  selftest: `${COMPANION_ID}:selftest`,
  agentPrompt: `${COMPANION_ID}:agent-prompt`,
  memoryStatus: `${COMPANION_ID}:memory-status`,
} as const;
const EXPECTED_COMMAND_IDS = [CMD.status, CMD.selftest, CMD.agentPrompt, CMD.memoryStatus];

/** Manifest wtyczki-nosiciela dla TEGO biegu - kształt z `companion/manifest.json`, bez
 *  wczytywania pliku z dysku (scenariusz nie zależy od ścieżki repo tej wtyczki na dysku). */
const COMPANION_MANIFEST = { id: COMPANION_ID, name: 'PKM Assistant Dev', version: '0.1.0' };

/** Agent z fixture harnessa (`vault-fixture/.pkm-assistant/agents/tester.yaml`, `name: Tester`). */
const FIXTURE_AGENT = 'Tester';
/** Wbudowany agent systemowy — istnieje niezależnie od fixture (`archetypes/HumanVibe.ts`). */
const BUILT_IN_AGENT = 'Jaskier';

const ODPOWIEDZ = 'Cztery komendy CLI przeszly test, boot niczego nie napisal.';

/** Sink Loggera hosta + jego rotacja — WYŁĄCZNIE te dwa pliki, patrz uzasadnienie w nagłówku
 *  pliku i `core/utils/LogFileSink.ts` pluginu (`DEFAULT_PATH`/`oldPath`). Każdy INNY plik w
 *  `.pkm-assistant/logs/` (np. `selftest-<stamp>.md`) MA wywrócić migawkę "zero zapisu". */
const EXCLUDED_FILES = ['.pkm-assistant/logs/pkm-assistant.log', '.pkm-assistant/logs/pkm-assistant.log.old'];

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Migawka {ścieżka względna → {size, mtimeMs, sha256}} całego drzewa vaulta, bez sinka Loggera. */
function snapshotTree(vaultRoot: string): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  for (const rel of listVaultFiles(vaultRoot)) {
    if (EXCLUDED_FILES.includes(rel)) continue;
    const abs = path.join(vaultRoot, rel);
    const st = fs.statSync(abs);
    const content = fs.readFileSync(abs);
    out[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(content).digest('hex') };
  }
  return out;
}

/** Różnice między dwiema migawkami — puste = identyczne. Komunikaty gotowe do wklejenia w asercję. */
function diffSnapshots(before: Record<string, FileFingerprint>, after: Record<string, FileFingerprint>): string[] {
  const out: string[] = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const rel of [...paths].sort()) {
    const b = before[rel];
    const a = after[rel];
    if (!b) { out.push(`POWSTAŁ podczas wywołań CLI: ${rel}`); continue; }
    if (!a) { out.push(`ZNIKNĄŁ podczas wywołań CLI: ${rel}`); continue; }
    if (b.sha256 !== a.sha256) { out.push(`TREŚĆ zmieniona: ${rel} (${b.size}B → ${a.size}B)`); continue; }
    if (b.mtimeMs !== a.mtimeMs) { out.push(`mtime zmieniony (treść ta sama — ktoś przepisał plik identyczną zawartością): ${rel} (${b.mtimeMs} → ${a.mtimeMs})`); }
  }
  return out;
}

/** Woła zarejestrowany handler DOKŁADNIE tak, jak zrobiłby to Obsidian z CLI (`handler(params)`), parsuje JSON. */
async function callCli<T>(
  handlers: Map<string, RegisteredCliHandler>,
  id: string,
  params: CliData = {},
): Promise<CliResponse<T>> {
  const registered = handlers.get(id);
  assert(registered, `Komenda CLI "${id}" nie jest zarejestrowana (zarejestrowane: ${[...handlers.keys()].join(', ') || '(brak)'}).`);
  const raw = await registered.handler(params);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`Odpowiedź "${id}" nie jest poprawnym JSON-em: ${String(raw).slice(0, 300)} (${String(e)})`);
  }
  return parsed as CliResponse<T>;
}

export default ({
  file: '47_cli_odczyt',
  name: 'komendy CLI wtyczki-nosiciela end-to-end offline',
  opis: 'wtyczka-nosiciel (pkm-assistant-dev) rejestruje 4 komendy CLI wołające żywy plugin (pkm-assistant); sprawdzamy kontrakt danych, zachowanie z hostem nieobecnym i że nic na dysku się nie zmieniło',
  agent: FIXTURE_AGENT,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'komendy CLI nie dotykają modelu (czysty odczyt stanu hosta) — bieg na żywym DeepSeeku niczego by nie dodał, tylko kosztował',

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, plugin }: FixturePayload) {
    // `plugin.app` — ta sama atrapa `app`, na której zbootował się plugin (Plugin#app w
    // konstruktorze atrapy). Wtyczka-nosiciel dostaje TĘ SAMĄ instancję, dokładnie jak w
    // prawdziwym Obsidianie (jeden `app` na cały workspace).
    const app = plugin.app as FixturePayload;

    // ── migawka „przed" — obejmuje TAKŻE konstrukcję i onload() wtyczki-nosiciela ──
    const before = snapshotTree(vaultRoot);

    app.plugins.plugins[HOST_ID] = plugin;
    const companion = new CompanionPlugin(app, COMPANION_MANIFEST);
    companion.onload();

    // ── a) dokładnie 4 komendy, dokładnie te id, na WTYCZCE-NOSICIELU (nie na pluginie) ──
    const handlers = companion._registeredCliHandlers as Map<string, RegisteredCliHandler> | undefined;
    assert(handlers instanceof Map, 'companion._registeredCliHandlers nie jest Mapą — registerCliHandler(atrapa) się nie wywołał albo zmienił kształt.');
    assert(
      handlers.size === 4,
      `Oczekiwano 4 zarejestrowanych komend CLI, jest ${handlers.size}: ${[...handlers.keys()].sort().join(', ') || '(brak)'}`,
    );
    const missing = EXPECTED_COMMAND_IDS.filter((id) => !handlers.has(id));
    assert(missing.length === 0, `Brakuje komend CLI: ${missing.join(', ')}. Zarejestrowane: ${[...handlers.keys()].sort().join(', ')}`);

    // ── b) status — host obecny i gotowy ──
    const status = await callCli<StatusData>(handlers, CMD.status);
    assert(status.ok === true, `status: ok !== true — ${JSON.stringify(status)}`);
    if (!status.ok) return; // TS: zawęża status do wariantu ok:true poniżej
    assert(status.data.ready === true, `status.data.ready = ${status.data.ready}, oczekiwano true`);
    assert(status.data.plugin.id === HOST_ID, `status.data.plugin.id = "${status.data.plugin.id}", oczekiwano "${HOST_ID}"`);
    assert(status.data.companion.id === COMPANION_ID, `status.data.companion.id = "${status.data.companion.id}", oczekiwano "${COMPANION_ID}"`);
    assert(typeof status.data.plugin.instanceSince === 'string' && status.data.plugin.instanceSince.length > 0, `status.data.plugin.instanceSince powinien być znacznikiem ISO, jest: ${JSON.stringify(status.data.plugin.instanceSince)}`);
    // K3: znacznik builda companiona + porównanie z bundlem hosta — pod harnessem (poza
    // `build:companion`) builtAt/pluginCommit spadają na fallback "unknown" (`buildInfo.ts`),
    // a bundleMtime na null (fixture nie ma prawdziwego <configDir>/plugins/pkm-assistant/main.js).
    assert(typeof status.data.companion.builtAt === 'string' && status.data.companion.builtAt.length > 0, `status.data.companion.builtAt powinien być stringiem niepustym, jest: ${JSON.stringify(status.data.companion.builtAt)}`);
    assert(typeof status.data.companion.pluginCommit === 'string' && status.data.companion.pluginCommit.length > 0, `status.data.companion.pluginCommit powinien być stringiem niepustym, jest: ${JSON.stringify(status.data.companion.pluginCommit)}`);
    assert(typeof status.data.companion.pluginTreeDirty === 'boolean', `status.data.companion.pluginTreeDirty powinien być boolem, jest: ${JSON.stringify(status.data.companion.pluginTreeDirty)}`);
    assert(status.data.plugin.bundleMtime === null || typeof status.data.plugin.bundleMtime === 'string', `status.data.plugin.bundleMtime powinien być stringiem albo null, jest: ${JSON.stringify(status.data.plugin.bundleMtime)}`);
    assert(status.data.companionStale === null || typeof status.data.companionStale === 'boolean', `status.data.companionStale powinien być boolem albo null, jest: ${JSON.stringify(status.data.companionStale)}`);
    assert(!!status.data.agents, 'status.data.agents jest null — agentManager niedostępny mimo ready:true.');
    const agentNames = status.data.agents!.names;
    assert(agentNames.includes(FIXTURE_AGENT), `status.data.agents.names nie zawiera "${FIXTURE_AGENT}" (fixture): ${JSON.stringify(agentNames)}`);
    assert(agentNames.includes(BUILT_IN_AGENT), `status.data.agents.names nie zawiera wbudowanego "${BUILT_IN_AGENT}": ${JSON.stringify(agentNames)}`);
    assert(
      JSON.stringify([...status.data.commands].sort()) === JSON.stringify([...EXPECTED_COMMAND_IDS].sort()),
      `status.data.commands = ${JSON.stringify(status.data.commands)}, oczekiwano dokładnie ${JSON.stringify(EXPECTED_COMMAND_IDS)}`,
    );

    // ── c) agent-prompt ──
    const prompt = await callCli<AgentPromptData>(handlers, CMD.agentPrompt, { agent: FIXTURE_AGENT });
    assert(prompt.ok === true, `agent-prompt(${FIXTURE_AGENT}): ok !== true — ${JSON.stringify(prompt)}`);
    if (!prompt.ok) return;
    assert(prompt.data.totalTokens > 0, `agent-prompt.data.totalTokens = ${prompt.data.totalTokens}, oczekiwano > 0`);
    assert(prompt.data.sections.length > 0, 'agent-prompt.data.sections jest puste.');
    const sectionWithContent = prompt.data.sections.find((s) => Object.prototype.hasOwnProperty.call(s, 'content'));
    assert(
      !sectionWithContent,
      `Bez flagi section= ŻADNA sekcja nie ma prawa nieść pola "content" (kontrakt AgentPromptData) — a niesie: ${JSON.stringify(sectionWithContent)}`,
    );

    const promptLower = await callCli<AgentPromptData>(handlers, CMD.agentPrompt, { agent: FIXTURE_AGENT.toLowerCase() });
    assert(promptLower.ok === true, `agent-prompt(${FIXTURE_AGENT.toLowerCase()}): ok !== true — ${JSON.stringify(promptLower)}`);
    if (!promptLower.ok) return;
    assert(
      promptLower.data.agent === prompt.data.agent,
      `Rozwiązanie imienia małymi literami dało inne "agent" niż dokładne dopasowanie: "${promptLower.data.agent}" vs "${prompt.data.agent}"`,
    );

    const firstKey = prompt.data.sections[0].key;
    const withSection = await callCli<AgentPromptData>(handlers, CMD.agentPrompt, { agent: FIXTURE_AGENT, section: firstKey });
    assert(withSection.ok === true, `agent-prompt(section=${firstKey}): ok !== true — ${JSON.stringify(withSection)}`);
    if (!withSection.ok) return;
    assert(!!withSection.data.section, `agent-prompt(section=${firstKey}) nie zwrócił pola "section".`);
    const sectionContent = withSection.data.section?.content ?? '';
    assert(sectionContent.length > 0, `agent-prompt(section=${firstKey}).data.section.content jest puste.`);

    const unknownAgentName = 'Nikt-Taki-Nie-Istnieje';
    const unknownAgent = await callCli<AgentPromptData>(handlers, CMD.agentPrompt, { agent: unknownAgentName });
    assert(unknownAgent.ok === false, `agent-prompt(${unknownAgentName}): oczekiwano ok:false, jest ${JSON.stringify(unknownAgent)}`);
    if (unknownAgent.ok) return;
    assert(
      unknownAgent.error.code === 'agent_not_found',
      `agent-prompt(${unknownAgentName}): error.code = "${unknownAgent.error.code}", oczekiwano "agent_not_found"`,
    );

    // ── d) memory-status agent=all ──
    const memStatus = await callCli<MemoryStatusData>(handlers, CMD.memoryStatus, { agent: 'all' });
    assert(memStatus.ok === true, `memory-status(all): ok !== true — ${JSON.stringify(memStatus)}`);
    if (!memStatus.ok) return;
    assert(memStatus.data.errors.length === 0, `memory-status(all).data.errors niepuste: ${JSON.stringify(memStatus.data.errors)}`);
    assert(
      memStatus.data.agents.length === agentNames.length,
      `memory-status(all) zwrócił ${memStatus.data.agents.length} agentów, status zna ${agentNames.length} (${JSON.stringify(agentNames)})`,
    );
    for (const agentStatus of memStatus.data.agents) {
      assert(
        agentStatus.brainNotes.limit === 20,
        `agent "${agentStatus.agent}": brainNotes.limit = ${agentStatus.brainNotes.limit}, oczekiwano 20 `
        + '(fixture nie ustawia ani per-agent brain_notes_limit w .state.json, ani progów globalnych w settings.json — czysty default z consolidationStatus.ts).',
      );
      assert(
        agentStatus.state.source === 'file',
        `agent "${agentStatus.agent}": state.source = "${agentStatus.state.source}", oczekiwano "file" `
        + '(AgentManager.initialize() bootstrapuje .state.json KAŻDEGO agenta przy starcie pluginu, przed jakimkolwiek wywołaniem CLI).',
      );
    }

    // ── selftest: wołany dla kompletu (dowód e obejmuje WSZYSTKIE komendy), sanity-check ok:true ──
    const selftest = await callCli<Record<string, unknown>>(handlers, CMD.selftest);
    assert(selftest.ok === true, `selftest: ok !== true — ${JSON.stringify(selftest).slice(0, 500)}`);

    // ── f) host NIEOBECNY — status daje ready:false, pozostałe trzy komendy not_ready ──
    delete app.plugins.plugins[HOST_ID];

    const statusAbsent = await callCli<StatusData>(handlers, CMD.status);
    assert(statusAbsent.ok === true, `status (host nieobecny): ok !== true — ${JSON.stringify(statusAbsent)}`);
    if (!statusAbsent.ok) return;
    assert(statusAbsent.data.ready === false, `status (host nieobecny): ready = ${statusAbsent.data.ready}, oczekiwano false`);
    assert(statusAbsent.data.agents === null, `status (host nieobecny): agents = ${JSON.stringify(statusAbsent.data.agents)}, oczekiwano null`);
    assert(statusAbsent.data.index === null, `status (host nieobecny): index = ${JSON.stringify(statusAbsent.data.index)}, oczekiwano null`);
    assert(statusAbsent.data.plugin.version === 'unknown', `status (host nieobecny): plugin.version = "${statusAbsent.data.plugin.version}", oczekiwano "unknown"`);
    assert(statusAbsent.data.plugin.instanceSince === null, `status (host nieobecny): instanceSince = ${JSON.stringify(statusAbsent.data.plugin.instanceSince)}, oczekiwano null`);

    for (const [id, params] of [
      [CMD.selftest, {}],
      [CMD.agentPrompt, { agent: FIXTURE_AGENT }],
      [CMD.memoryStatus, { agent: 'all' }],
    ] as const) {
      const response = await callCli<unknown>(handlers, id, params);
      assert(response.ok === false, `${id} (host nieobecny): oczekiwano ok:false, jest ${JSON.stringify(response)}`);
      if (response.ok) continue;
      assert(response.error.code === 'not_ready', `${id} (host nieobecny): error.code = "${response.error.code}", oczekiwano "not_ready"`);
    }

    // ── e) migawka „po" — MUSI wyjść identyczna migawce „przed" ──
    const after = snapshotTree(vaultRoot);
    const different = diffSnapshots(before, after);
    assert(
      different.length === 0,
      `Komendy CLI "tylko do odczytu" ZMIENIŁY coś na dysku vaulta: \n${different.join('\n')}`,
    );

    // ── tura modelu przeszła normalnie (wymóg runnera — patrz nagłówek pliku) ──
    const finalText = assertFinalText(result, 'Pętla nie zwróciła odpowiedzi.');
    assert(finalText.includes(ODPOWIEDZ), `finalText nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`);
  },
} satisfies Scenario);
