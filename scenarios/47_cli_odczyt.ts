/**
 * 47_cli_odczyt — komendy CLI Obsidiana (fala 1, `modules/cli/` pluginu) end-to-end, offline.
 *
 * Od Obsidian 1.12.2 plugin rejestruje w `onload()` przez `Plugin#registerCliHandler` cztery
 * komendy TYLKO DO ODCZYTU: `pkm-assistant:status`, `pkm-assistant:selftest`,
 * `pkm-assistant:agent-prompt` (flagi `agent`/`section`), `pkm-assistant:memory-status`
 * (flaga `agent` = imię albo `all`). Kontrakt danych: `modules/cli/CLAUDE.md` w repo pluginu.
 *
 * Do commitu `feat(test-support): registerCliHandler w atrapie Plugin` atrapa `Plugin` nie miała
 * tej metody — `typeof host.registerCliHandler === 'function'` było `false`, rejestracja kończyła
 * się cicho (`skipped:'unsupported'`) i ŻADNA z czterech komend nigdy nie biegła pod harnessem.
 * Ten scenariusz jest pierwszym biegiem end-to-end: bootuje żywy plugin, wyciąga zarejestrowane
 * handlery z atrapy i woła je DOKŁADNIE TAK, jak zrobiłby to Obsidian z CLI — `handler(params)`
 * na surowym worku `{klucz: 'wartość'}`, parsując JSON, który handler oddaje na "stdout".
 *
 * `liveSkip`: cztery komendy CLI nie dotykają modelu w ogóle (czysty odczyt stanu pluginu) —
 * bieg na żywym DeepSeeku nie dodałby nic ponad offline, tylko kosztowałby. Tura modelu w tym
 * scenariuszu jest tu WYŁĄCZNIE dlatego, że `_runner.ts` zawsze odpala jedną (wzór
 * `45_nowy_agent_pusta_ekipa`/`46_boot_bez_starterow`) — cała weryfikacja CLI dzieje się w
 * `asserts`, PO turze, wołając produkcyjne handlery wprost na żywym `plugin`.
 *
 * DOWÓD "TYLKO ODCZYT" (punkt e specyfikacji zadania): migawka rekurencyjna CAŁEGO drzewa
 * temp-vaulta (ścieżka + rozmiar + mtime + sha256 treści) TUŻ PRZED i TUŻ PO wywołaniu
 * wszystkich komend tego scenariusza musi wyjść identyczna. Jedyny wykluczony katalog to
 * `.pkm-assistant/logs/` — `Logger`/`LogFileSink` (`core/utils/LogFileSink.ts`) buforuje
 * KAŻDE `log.info/warn/error` z CAŁEGO pluginu (nie tylko CLI) i zrzuca bufor na dysk co
 * `flushEveryN=20` wpisów ALBO po debounce ~1s — niezależnie od tego, czy ktokolwiek woła CLI.
 * Boot sam z siebie już zdążył zapełnić bufor (np. `log.info('Plugin', 'File-log sink: ON...')`),
 * więc odpalenie flusha w oknie między dwiema migawkami jest kwestią TIMINGU zegara, nie efektem
 * komend pod testem — dokładnie tak samo zmieniłby ten plik bieg, który w ogóle nie woła CLI.
 * Sama treść vaulta (ustawienia, notatki, YAML agentów, pamięć — DOKŁADNIE to, co
 * `modules/cli/CLAUDE.md` obiecuje nie ruszać) idzie przez migawkę bez wyjątków.
 * `log.debug('CLI', ...)` (jedna linia na KAŻDE wywołanie handlera, patrz `commands.ts`) i tak
 * nie osiąga nawet tego pliku pod domyślnym `debugMode` — próg sinka to `'info'`
 * (`pkmSettings?.debugMode ? 'debug' : 'info'`, `src/main.ts`), a `'debug' < 'info'` w
 * `LEVEL_RANK` — więc gdyby WYŁĄCZNIE ten katalog był pominięty bez powodu, dowód byłby słabszy
 * niż mógłby być; jest pominięty z udokumentowanego, zweryfikowanego wyżej powodu.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { textTurn } from '../mock/fake-llm-server.js';
import { assert, assertFinalText, fail, listVaultFiles } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';
import type { RegisteredCliHandler, CliData } from '../test-support/obsidian.js';
import type { CliResponse, StatusData, AgentPromptData, MemoryStatusData } from '@plugin/modules/cli/index.js';

const PLUGIN_ID = 'pkm-assistant';
const CMD = {
  status: `${PLUGIN_ID}:status`,
  selftest: `${PLUGIN_ID}:selftest`,
  agentPrompt: `${PLUGIN_ID}:agent-prompt`,
  memoryStatus: `${PLUGIN_ID}:memory-status`,
} as const;
const EXPECTED_COMMAND_IDS = [CMD.status, CMD.selftest, CMD.agentPrompt, CMD.memoryStatus];

/** Agent z fixture harnessa (`vault-fixture/.pkm-assistant/agents/tester.yaml`, `name: Tester`). */
const FIXTURE_AGENT = 'Tester';
/** Wbudowany agent systemowy — istnieje niezależnie od fixture (`archetypes/HumanVibe.ts`). */
const BUILT_IN_AGENT = 'Jaskier';

const ODPOWIEDZ = 'Cztery komendy CLI przeszly test, boot niczego nie napisal.';

/** Katalogi logów pluginu — patrz uzasadnienie w nagłówku pliku. */
const EXCLUDED_DIRS = ['.pkm-assistant/logs/'];

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** Migawka {ścieżka względna → {size, mtimeMs, sha256}} całego drzewa vaulta, bez katalogów logów. */
function snapshotTree(vaultRoot: string): Record<string, FileFingerprint> {
  const out: Record<string, FileFingerprint> = {};
  for (const rel of listVaultFiles(vaultRoot)) {
    if (EXCLUDED_DIRS.some((dir) => rel.startsWith(dir))) continue;
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
  name: 'komendy CLI end-to-end offline',
  opis: 'plugin rejestruje 4 komendy CLI (status/selftest/agent-prompt/memory-status); wołamy je jak Obsidian i sprawdzamy kontrakt danych oraz że nic na dysku się nie zmieniło',
  agent: FIXTURE_AGENT,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'komendy CLI nie dotykają modelu (czysty odczyt stanu pluginu) — bieg na żywym DeepSeeku niczego by nie dodał, tylko kosztował',

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, plugin }: FixturePayload) {
    const handlers = plugin?._registeredCliHandlers as Map<string, RegisteredCliHandler> | undefined;
    assert(handlers instanceof Map, 'plugin._registeredCliHandlers nie jest Mapą — registerCliHandler(atrapa) się nie wywołał albo zmienił kształt.');

    // ── a) dokładnie 4 komendy, dokładnie te id ──
    assert(
      handlers.size === 4,
      `Oczekiwano 4 zarejestrowanych komend CLI, jest ${handlers.size}: ${[...handlers.keys()].sort().join(', ') || '(brak)'}`,
    );
    const missing = EXPECTED_COMMAND_IDS.filter((id) => !handlers.has(id));
    assert(missing.length === 0, `Brakuje komend CLI: ${missing.join(', ')}. Zarejestrowane: ${[...handlers.keys()].sort().join(', ')}`);

    // ── e) migawka „przed" — obejmuje WSZYSTKIE wywołania CLI tego scenariusza, poniżej ──
    const before = snapshotTree(vaultRoot);

    // ── b) status ──
    const status = await callCli<StatusData>(handlers, CMD.status);
    assert(status.ok === true, `status: ok !== true — ${JSON.stringify(status)}`);
    if (!status.ok) return; // TS: zawęża status do wariantu ok:true poniżej
    assert(status.data.ready === true, `status.data.ready = ${status.data.ready}, oczekiwano true`);
    assert(status.data.plugin.id === PLUGIN_ID, `status.data.plugin.id = "${status.data.plugin.id}", oczekiwano "${PLUGIN_ID}"`);
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

    // ── selftest: wołany dla kompletu (dowód e obejmuje WSZYSTKIE 4 komendy), sanity-check ok:true ──
    const selftest = await callCli<Record<string, unknown>>(handlers, CMD.selftest);
    assert(selftest.ok === true, `selftest: ok !== true — ${JSON.stringify(selftest).slice(0, 500)}`);

    // ── e) migawka „po" — MUSI wyjść identyczna migawce „przed" ──
    const after = snapshotTree(vaultRoot);
    const different = diffSnapshots(before, after);
    assert(
      different.length === 0,
      `Cztery komendy CLI "tylko do odczytu" ZMIENIŁY coś na dysku vaulta: \n${different.join('\n')}`,
    );

    // ── tura modelu przeszła normalnie (wymóg runnera — patrz nagłówek pliku) ──
    const finalText = assertFinalText(result, 'Pętla nie zwróciła odpowiedzi.');
    assert(finalText.includes(ODPOWIEDZ), `finalText nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`);
  },
} satisfies Scenario);
