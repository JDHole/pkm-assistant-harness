/**
 * 48_cli_agent_turn — komenda CLI `pkm-assistant-dev:agent-turn` (fala 2, produkcyjna pętla)
 * end-to-end, offline.
 *
 * Wzorem `47_cli_odczyt`: OBIE wtyczki w JEDNEJ atrapie `app` (prawdziwy plugin przez
 * `bootPlugin`, wtyczka-nosiciel `companion/` na wierzchu), komenda wołana DOKŁADNIE tak, jak
 * zrobiłby to Obsidian z CLI (`handler(params)` na surowym worku `{klucz:'wartość'}`). RÓŻNICA
 * względem 47: ta komenda WOŁA żywy model (fake-serwer offline) - `_runner.ts` odpala jedną
 * turę SAM (wzór wszystkich scenariuszy), a `agent-turn` woła DRUGĄ, NIEZALEŻNĄ turę na tym
 * samym fake-serwerze (kolejne indeksy `offlineScript`).
 *
 * Dowodzi trzech rzeczy specyfikacji zadania:
 *  (1) `read` (w `tools=readonly`) wykonuje się NAPRAWDĘ - wynik trafia do `toolCalls` z `ok:true`;
 *  (2) `write` (model halucynuje narzędzie spoza whitelisty `tools=readonly`) jest ODRZUCONY
 *      PRZED `mcpClient.executeToolCall` - `toolCalls` niesie wpis `ok:false`, a drzewo vaulta
 *      dowodzi, że NIC nie zostało zapisane;
 *  (3) tura kończy się naturalnie (`stoppedBy:'natural'`) i NIC nie ląduje w
 *      `memory/sessions/active` (agent-turn nie dotyka pamięci sesji czatu - `session:'none'`).
 *
 * `liveSkip`: fake-serwer musi wymusić DOKŁADNIE ten sam skrypt (read -> write halucynowany ->
 * tekst) - żywy DeepSeek nie da się do tego zmusić deterministycznie; asercje o TEJ SEKWENCJI
 * są z natury offline-only (ten sam powód co "07_yolo_nie_omija"/"10_sklejone_tool_calls").
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { assert, assertFinalText, fail, listVaultFiles } from './_asserts.js';
import CompanionPlugin from '../companion/main.js';

import type { FixturePayload, Scenario } from './_asserts.js';
import type { RegisteredCliHandler, CliData } from '../test-support/obsidian.js';
import type { CliResponse } from '../companion/cli/index.js';
import type { AgentTurnData } from '../companion/cli/index.js';

const HOST_ID = 'pkm-assistant';
const COMPANION_ID = 'pkm-assistant-dev';
const CMD_AGENT_TURN = `${COMPANION_ID}:agent-turn`;

const COMPANION_MANIFEST = { id: COMPANION_ID, name: 'PKM Assistant Dev', version: '0.1.0' };

/** Agent z fixture harnessa (`vault-fixture/.pkm-assistant/agents/tester.yaml`, `name: Tester`). */
const FIXTURE_AGENT = 'Tester';

/** Odpowiedź WŁASNEJ tury runnera (`_runner.ts`, script[0] - nie dotyczy agent-turn). */
const RUNNER_REPLY = 'Boot OK, nic do zrobienia.';
const READ_PATH = 'Notatki/powitanie.md';
const FINAL_REPLY = 'Przeczytalem plik powitalny; zapis nowej notatki zostal odrzucony przez tryb bezpieczny.';

/** Sink Loggera hosta + jego rotacja - wykluczone z migawki (ten sam powód co `47_cli_odczyt`). */
const EXCLUDED_FILES = ['.pkm-assistant/logs/pkm-assistant.log', '.pkm-assistant/logs/pkm-assistant.log.old'];

/** Jedyna dopuszczalna lokalizacja zmiany poza `EXCLUDED_FILES` - samonaprawa `brain.md`/`brain/`
 *  PRZEZ `getActiveSystemPromptWithMemory` (ten sam mechanizm co `agent-prompt`, patrz
 *  `commands.ts` `snapshotBrain`). Koperta `agent-turn` (`verified`/`effect`) ma to jawnie
 *  zmierzyć - ta migawka MA złapać wszystko INNE. */
const MEMORY_PATH_RE = /^\.pkm-assistant\/agents\/[^/]+\/memory\//;

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha256: string;
}

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

/** Różnice między migawkami, z wyjątkiem dopuszczalnego memory/brain* (parametr `allowMemory`). */
function diffSnapshots(before: Record<string, FileFingerprint>, after: Record<string, FileFingerprint>, allowMemory: boolean): string[] {
  const out: string[] = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const rel of [...paths].sort()) {
    if (allowMemory && MEMORY_PATH_RE.test(rel)) continue;
    const b = before[rel];
    const a = after[rel];
    if (!b) { out.push(`POWSTAŁ podczas wywołania agent-turn: ${rel}`); continue; }
    if (!a) { out.push(`ZNIKNĄŁ podczas wywołania agent-turn: ${rel}`); continue; }
    if (b.sha256 !== a.sha256) { out.push(`TREŚĆ zmieniona: ${rel} (${b.size}B → ${a.size}B)`); continue; }
    if (b.mtimeMs !== a.mtimeMs) { out.push(`mtime zmieniony (treść ta sama): ${rel}`); }
  }
  return out;
}

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
  file: '48_cli_agent_turn',
  name: 'komenda CLI agent-turn (produkcyjna pętla, tryb bezpieczny) end-to-end offline',
  opis: 'agent-turn woła runAgentLoop na żywym hoście: read (tools=readonly) wykonuje się, write halucynowany jest odrzucony PRZED mcpClient, tura kończy się naturalnie, nic nie ląduje w sesji czatu ani w drzewie vaulta poza ewentualną samonaprawą brain.md',
  agent: FIXTURE_AGENT,
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'sekwencja read -> write halucynowany -> tekst jest wymuszona skryptem fake-serwera; nie da się jej odtworzyć deterministycznie na żywym DeepSeeku',

  offlineScript: [
    // script[0]: tura WŁASNA runnera (_runner.ts, wzór 45/46/47) - treść bez znaczenia dla tego scenariusza.
    textTurn(RUNNER_REPLY),
    // script[1]: PIERWSZE wywołanie modelu W AGENT-TURN - narzędzie `read` (dozwolone, tools=readonly).
    toolCallTurn('read', { path: READ_PATH }),
    // script[2]: DRUGIE wywołanie - model halucynuje `write` (agent-turn go NIE oferował w toolsOffered).
    toolCallTurn('write', { path: 'Notatki/nowa-nielegalna.md', content: 'nie powinno powstać' }),
    // script[3]: TRZECIE wywołanie - finalna odpowiedź tekstowa (naturalne domknięcie).
    textTurn(FINAL_REPLY),
  ],

  async asserts({ result, vaultRoot, plugin }: FixturePayload) {
    const app = plugin.app as FixturePayload;

    // ── migawka "przed" - obejmuje TAKŻE konstrukcję i onload() wtyczki-nosiciela ──
    const before = snapshotTree(vaultRoot);

    app.plugins.plugins[HOST_ID] = plugin;
    const companion = new CompanionPlugin(app, COMPANION_MANIFEST);
    companion.onload();
    const handlers = companion._registeredCliHandlers as Map<string, RegisteredCliHandler> | undefined;
    assert(handlers instanceof Map, 'companion._registeredCliHandlers nie jest Mapą.');
    assert(handlers.has(CMD_AGENT_TURN), `Komenda "${CMD_AGENT_TURN}" nie jest zarejestrowana: ${[...handlers.keys()].sort().join(', ')}`);

    const response = await callCli<AgentTurnData>(handlers, CMD_AGENT_TURN, {
      agent: FIXTURE_AGENT,
      prompt: 'Przeczytaj Notatki/powitanie.md, a potem zapisz nową notatkę z jego streszczeniem.',
      tools: 'readonly',
      'max-iterations': '5',
    });

    assert(response.ok === true, `agent-turn: ok !== true — ${JSON.stringify(response).slice(0, 800)}`);
    if (!response.ok) return;
    const data = response.data;

    // ── (1) tura kończy się, agent rozwiązany, tools=readonly ──
    assert(data.agent === FIXTURE_AGENT, `data.agent = "${data.agent}", oczekiwano "${FIXTURE_AGENT}"`);
    assert(data.tools === 'readonly', `data.tools = "${data.tools}", oczekiwano "readonly"`);
    assert(
      data.toolsOffered.includes('read') && !data.toolsOffered.includes('write'),
      `data.toolsOffered powinno zawierać "read" i NIE zawierać "write": ${JSON.stringify(data.toolsOffered)}`,
    );
    assert(data.session === 'none', `data.session = "${data.session}", oczekiwano "none" (zero zapisu do pamięci persony)`);
    assert(Array.isArray(data.approvals) && data.approvals.length === 0, `data.approvals powinno być puste (tryb yolo): ${JSON.stringify(data.approvals)}`);
    assert(data.stoppedBy === 'natural', `data.stoppedBy = "${data.stoppedBy}", oczekiwano "natural" (model odpowiedział tekstem po odrzuceniu write)`);
    assert(data.finalText.includes(FINAL_REPLY) || data.finalText.length > 0, 'data.finalText jest puste.');

    // ── (2) read WYKONANE naprawdę - ok:true, treść pliku powitalnego w resultPreview ──
    const readCall = data.toolCalls.find(c => c.name === 'read');
    assert(!!readCall, `Brak wpisu "read" w data.toolCalls: ${JSON.stringify(data.toolCalls)}`);
    assert(readCall!.ok === true, `"read" powinno być ok:true: ${JSON.stringify(readCall)}`);

    // ── (3) write ODRZUCONE PRZED mcpClient - ok:false, komunikat "not allowed" ──
    const writeCall = data.toolCalls.find(c => c.name === 'write');
    assert(!!writeCall, `Brak wpisu "write" w data.toolCalls (model miał je wywołać, halucynując poza tools=readonly): ${JSON.stringify(data.toolCalls)}`);
    assert(writeCall!.ok === false, `"write" powinno być ok:false (odrzucone przez whitelistę agent-turn): ${JSON.stringify(writeCall)}`);
    assert(
      /not allowed/i.test(writeCall!.error || writeCall!.resultPreview || ''),
      `Komunikat odrzucenia "write" powinien mówić "not allowed": ${JSON.stringify(writeCall)}`,
    );

    // ── (4) migawka "po" - drzewo vaulta identyczne, poza ewentualną samonaprawą brain.md/brain/ ──
    const after = snapshotTree(vaultRoot);
    const allowMemory = response.effect === 'changed' || response.effect === 'unknown';
    const different = diffSnapshots(before, after, allowMemory);
    assert(
      different.length === 0,
      `agent-turn (tools=readonly) ZMIENIŁ coś na dysku vaulta poza pamięcią persony (effect="${response.effect}"): \n${different.join('\n')}`,
    );

    // ── (5) brak nowego pliku w memory/sessions/active - agent-turn nie zapisuje sesji czatu ──
    const newSessionFiles = [...Object.keys(after)].filter(
      rel => !before[rel] && /\/memory\/sessions\/active\//.test(rel),
    );
    assert(newSessionFiles.length === 0, `Powstał nowy plik w memory/sessions/active - agent-turn NIE powinno zapisywać sesji: ${JSON.stringify(newSessionFiles)}`);

    // Plik z halucynowanego write NIE powstał (dowód dodatkowy, obok migawki całego drzewa).
    assert(!fs.existsSync(path.join(vaultRoot, 'Notatki/nowa-nielegalna.md')), 'Plik "Notatki/nowa-nielegalna.md" ISTNIEJE - odrzucenie "write" nie zadziałało.');

    // ── tura WŁASNA runnera przeszła normalnie (wymóg _runner.ts - patrz nagłówek pliku) ──
    const finalText = assertFinalText(result, 'Pętla runnera nie zwróciła odpowiedzi.');
    assert(finalText.includes(RUNNER_REPLY), `finalText tury runnera nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`);
  },
} satisfies Scenario);
