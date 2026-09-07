/**
 * run.js — sterownik biegu harnessa „Szklane Pudło".
 *
 * FAZA A: `--dry-boot` — pełny `onload()+initialize()` do `_ready=true`, bez modelu.
 * FAZA B: bieg eksploracyjny — `--agent X --prompt "..."` = PEŁNY cykl pętli agenta z żywym
 *         DeepSeekiem (albo `--offline` = fake-serwer SSE, bez sieci i bez klucza).
 *
 * Składa PRAWDZIWY plugin (`PKMAssistantPlugin` z `src/main.js`) przez atrapę 'obsidian' (alias esbuild)
 * i stawia go w Node. Model, prompt systemowy, narzędzia, pętla, pamięć, trace — wszystko
 * produkcyjne. Podstawiamy tylko to, czego poza Obsidianem fizycznie nie ma: 'obsidian' (atrapa),
 * DOM (shim). Drift niemożliwy z definicji.
 *
 * Kolejność importów: dom-shim (instaluje globale) PRZED bundlem pluginu.
 */
import './mock/dom-shim.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { shutdownHarnessRuntime } from './mock/obsidian.js';
import { startFakeLlmServer, defaultSelftestScript } from './mock/fake-llm-server.js';
import { setHarnessLlmEndpoint } from './lib/harnessProviders.js';
import { parseEnvLocal } from './lib/envLocal.js';
import { runExploratoryTurn } from './lib/runTurn.js';
import { parseTrace, summarizeTrace, buildTextReport, buildJsonReport, buildDod, dodToExitCode } from './lib/report.js';
import { bootPlugin, cleanupPlugin, ENV_LOCAL_PATH, TRACE_REL } from './lib/boot.js';
import type { ExploratoryTurn } from './lib/runTurn.js';
import type { ReportContext } from './lib/report.js';
import type { HarnessRuntime } from './lib/boot.js';

// TS-any: fake server and plugin objects are injected by the harness composition boundary.
type Runtime = any;
type ErrLike = { message?: string; stack?: string };

interface CliFlags {
  dryBoot: boolean;
  keepVault: boolean;
  offline: boolean;
  json: boolean;
  agent: string | null | undefined;
  prompt: string | null | undefined;
  autonomy: string | undefined;
  approve: string | undefined;
  maxIterations: number | null;
}

interface FakeLlmServer {
  url: string;
  close(): Promise<void> | void;
  getRequestCount(): number;
}

// ── CLI parsing ──
function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    dryBoot: false, keepVault: false, offline: false, json: false,
    agent: null, prompt: null, autonomy: 'edge', approve: 'auto', maxIterations: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dry-boot': flags.dryBoot = true; break;
      case '--keep-vault': flags.keepVault = true; break;
      case '--offline': flags.offline = true; break;
      case '--json': flags.json = true; break;
      case '--agent': flags.agent = next(); break;
      case '--prompt': flags.prompt = next(); break;
      case '--autonomy': flags.autonomy = next(); break;
      case '--approve': flags.approve = next(); break;
      case '--max-iterations': flags.maxIterations = parseInt(next(), 10) || null; break;
      default:
        if (a.startsWith('--agent=')) flags.agent = a.slice(8);
        else if (a.startsWith('--prompt=')) flags.prompt = a.slice(9);
        else if (a.startsWith('--autonomy=')) flags.autonomy = a.slice(11);
        else if (a.startsWith('--approve=')) flags.approve = a.slice(10);
        else if (a.startsWith('--max-iterations=')) flags.maxIterations = parseInt(a.slice(17), 10) || null;
        break;
    }
  }
  return flags;
}

const flags: CliFlags = parseArgs(process.argv.slice(2));

// W trybie --json stdout MUSI być JEDNYM obiektem JSON → przekieruj szum bootstrapu na stderr.
if (flags.json) {
  const toErr = (...args: unknown[]): boolean => process.stderr.write(args.map(String).join(' ') + '\n');
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

const line = (s = ''): void => console.log(s);
const pass = (b: boolean): string => (b ? 'PASS' : 'FAIL');

// Twarde zamknięcie procesu. Krótki „settle" pozwala domknąć się socketom undici (fetch keep-alive)
// PRZED process.exit — inaczej na Windows leci libuv assertion (UV_HANDLE_CLOSING, async.c) przez
// wyścig exit↔zamykanie handle'a.
async function hardExit(code: number): Promise<never> {
  try { await new Promise((r) => setTimeout(r, 150)); } catch { /* noop */ }
  process.exit(code);
}

// Sprzątanie owijające cleanupPlugin z boot.js — dokłada log spójny z dotychczasowym wyjściem CLI.
async function cleanup(plugin: HarnessRuntime, tempRoot: string, { keepVault }: { keepVault: boolean }): Promise<void> {
  const { cleared } = await cleanupPlugin(plugin, tempRoot, { keepVault, quiet: flags.json });
  if (!flags.json) {
    line(`[harness] wyczyszczono ${cleared} timer(ów) registerInterval`);
    if (!keepVault) line('[harness] temp-vault usunięty');
  }
}

// ── FAZA A: dry-boot ──
async function runDryBoot(): Promise<void> {
  const { plugin, tempRoot, bootMs } = await bootPlugin({ offline: false });

  const envState = plugin.env?.state ?? '(brak)';
  const settingsLoaded = !!plugin.env?.settings;
  const agentsSize = plugin.agentManager?.agents?.size ?? 0;
  const agentNames = plugin.agentManager?.agents ? [...plugin.agentManager.agents.keys()] : [];
  const toolsSize = plugin.toolRegistry?.tools?.size ?? 0;
  const toolNames = plugin.toolRegistry?.tools ? [...plugin.toolRegistry.tools.keys()] : [];
  // S28 D7: flaga domyslnie ON — wylacza ja dopiero jawne `false`.
  const komunikatorOn = plugin.settings?.pkmAssistant?.komunikatorEnabled !== false;
  // Review W5-01: komendy i ikony wstążki rejestrują się w `onload()`, NIEZALEŻNIE od bootu env.
  // Bez tego pomiaru regresja „env padł, więc user nie ma ani jednej komendy" była niewidzialna.
  const commandNames = (plugin._registeredCommands ?? []).map((c: Runtime) => c?.id ?? '(bez id)');
  const ribbonTitles = (plugin._registeredRibbonIcons ?? []).map((r: Runtime) => r?.title ?? '(bez tytułu)');

  let traceExists = false, traceEntry = '';
  try {
    plugin.traceLog?.scope('harness/dry-boot')('boot', { env: envState, agents: agentsSize, tools: toolsSize, boot_ms: bootMs });
    await plugin.traceLog?.sink?.flush?.();
    const tracePath = path.join(tempRoot, TRACE_REL);
    if (fs.existsSync(tracePath)) {
      const content = (await fsp.readFile(tracePath, 'utf8')).trim();
      if (content.length > 0) { traceExists = true; traceEntry = content.split('\n').pop() as string; }
    }
  } catch (e) { console.warn('[harness] trace check failed:', (e as ErrLike)?.message || e); }

  line();
  line('══════════════════════════════════════════════════════════════');
  line('  HARNESS „Szklane Pudło" — FAZA A: dry-boot');
  line('══════════════════════════════════════════════════════════════');
  line(`  temp-vault      : ${tempRoot}`);
  line(`  boot time       : ${(bootMs / 1000).toFixed(2)}s`);
  line('  ────────────────────────────────────────────────────────────');
  line(`  env state       : ${envState}  [${pass(envState === 'loaded')}]`);
  line(`  settings loaded : ${settingsLoaded}  [${pass(settingsLoaded)}]`);
  line(`  agents          : ${agentsSize}  (${agentNames.join(', ')})`);
  line(`  tools registered: ${toolsSize}  (komunikator ${komunikatorOn ? 'ON' : 'OFF'})`);
  line(`  komendy         : ${commandNames.length}  [${pass(commandNames.length > 0)}]`);
  line(`     ${commandNames.join(', ') || '(BRAK — user nie ma pluginu w palecie komend!)'}`);
  line(`  ikony wstążki   : ${ribbonTitles.length}  [${pass(ribbonTitles.length > 0)}]`);
  line(`     ${ribbonTitles.join(' | ') || '(BRAK)'}`);
  line(`  trace.log entry : ${traceExists ? 'POWSTAŁ' : 'BRAK'}  [${pass(traceExists)}]`);
  if (traceEntry) line(`     └─ ${traceEntry}`);
  line('  ────────────────────────────────────────────────────────────');
  line('  narzędzia:');
  line(`     ${toolNames.join(', ')}`);
  line('══════════════════════════════════════════════════════════════');

  const dod = {
    'env loaded': envState === 'loaded',
    'agents ≥ 2': agentsSize >= 2,
    'tools ≥ 1': toolsSize >= 1,
    'komendy zarejestrowane': commandNames.length > 0,
    'ikony wstążki zarejestrowane': ribbonTitles.length > 0,
    'trace.log powstał z wpisem': traceExists,
    'plugin _ready': plugin._ready === true,
  };
  line('  DoD:');
  for (const [k, v] of Object.entries(dod)) line(`     [${pass(v)}] ${k}`);
  const allGreen = Object.values(dod).every(Boolean);
  line(`  → ${allGreen ? 'DoD FAZY A: GREEN' : 'DoD FAZY A: RED'}`);
  line('══════════════════════════════════════════════════════════════');
  line();

  await cleanup(plugin, tempRoot, flags);
  process.exit(allGreen ? 0 : 1);
}

// ── FAZA B: bieg eksploracyjny ──
async function runExploration(): Promise<void> {
  const prompt = flags.prompt || 'Przeczytaj Notatki/powitanie.md i streść w jednym zdaniu.';
  const agentName = flags.agent || 'Tester';

  // OFFLINE: postaw fake-serwer SSE i wskaż na niego adapter deepseek (endpoint przez global harnessa).
  let fakeServer: FakeLlmServer | null = null;
  if (flags.offline) {
    fakeServer = await (startFakeLlmServer as Runtime)({ script: defaultSelftestScript() }) as FakeLlmServer;
    setHarnessLlmEndpoint(fakeServer.url);
    if (!flags.json) line(`[harness] fake-serwer SSE: ${fakeServer.url}`);
  }

  const { plugin, tempRoot } = await bootPlugin({ offline: flags.offline });

  // ── Mostek klucza: .env.local → env.settings.pkmAssistant.chat.apiKeys.deepseek ──
  const chatKeys = plugin.env?.settings?.pkmAssistant?.chat?.apiKeys;
  if (flags.offline) {
    // Fake-serwer ignoruje auth, ale modelResolver wymaga NIEPUSTEGO klucza, by w ogóle stworzyć model.
    if (chatKeys) chatKeys.deepseek = 'harness-offline-dummy';
  } else {
    const env = parseEnvLocal(ENV_LOCAL_PATH);
    const key = env.DEEPSEEK_API_KEY;
    if (!key) {
      // DoD-B2: brak klucza → czytelny komunikat + exit 2 (odróżnialny od crashu).
      process.stderr.write(
        '\n[harness] Brak harness/.env.local z DEEPSEEK_API_KEY — bieg żywy niedostępny.\n'
        + '          Skopiuj harness/.env.example → harness/.env.local i wklej klucz DeepSeek,\n'
        + '          albo uruchom z flagą --offline (fake-serwer, bez klucza i bez sieci).\n\n');
      await cleanup(plugin, tempRoot, flags);
      await hardExit(2);
    }
    if (chatKeys) chatKeys.deepseek = key;
    if (!flags.json) line('[harness] klucz DeepSeek wstrzyknięty z .env.local');
  }

  // ── Bieg ──
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
  let turn: ExploratoryTurn;
  try {
    turn = await runExploratoryTurn(plugin, {
      agentName,
      prompt,
      autonomy: flags.autonomy,
      approve: flags.approve,
      maxIterations: flags.maxIterations,
      runId,
    });
  } catch (err) {
    process.stderr.write(`\n[harness] BŁĄD biegu: ${(err as ErrLike)?.stack || err}\n`);
    if (fakeServer) await fakeServer.close();
    await cleanup(plugin, tempRoot, flags);
    await hardExit(1);
    return;
  }

  // ── Trace: flush + odczyt + parse ──
  try { await plugin.traceLog?.sink?.flush?.(); } catch { /* best-effort */ }
  const tracePath = path.join(tempRoot, TRACE_REL);
  let traceContent = '';
  try { traceContent = await fsp.readFile(tracePath, 'utf8'); } catch { /* brak = pusty */ }
  const traceEvents = parseTrace(traceContent, turn.traceLabel);
  const traceSummary = summarizeTrace(traceEvents);

  const reportCtx: ReportContext = { turn, traceSummary, traceEvents, tempVault: tempRoot, tracePath, keepVault: flags.keepVault, offline: flags.offline };

  if (flags.json) {
    process.stdout.write(JSON.stringify(buildJsonReport(reportCtx)) + '\n');
  } else {
    line(buildTextReport(reportCtx));
    if (fakeServer) line(`[harness] fake-serwer obsłużył ${fakeServer.getRequestCount()} zapytań`);
  }

  // Kod wyjścia = werdykt DoD FAZY B (jak FAZA A na :172 i runner scenariuszy). `harness:selftest`
  // jest bramką przed merge — bramka, która nie potrafi zwrócić czerwieni, nie jest bramką.
  const exitCode = dodToExitCode(buildDod(reportCtx));

  if (fakeServer) await fakeServer.close();
  await cleanup(plugin, tempRoot, flags);
  await hardExit(exitCode);
}

async function main(): Promise<void> {
  if (flags.dryBoot) return runDryBoot();
  return runExploration();
}

main().catch((err: unknown) => {
  process.stderr.write(`\n[harness] BŁĄD krytyczny:\n${(err as ErrLike)?.stack || err}\n`);
  try { shutdownHarnessRuntime(); } catch { /* best-effort */ }
  process.exit(1);
});
