/**
 * _runner.js — sterownik scenariuszy-łamaczy „Szklane Pudło" (S26 FAZA C).
 *
 * Per scenariusz: świeży temp-vault (fixture + nadpisy scenariusza), własny fake-serwer ze
 * skryptem scenariusza (offline, deterministycznie) LUB prompt do żywego DeepSeeka (--live),
 * bieg przez PRODUKCYJNĄ pętlę (`runExploratoryTurn` → `runAgentLoop`), zebranie
 * {result, trace, vaultRoot}, odpalenie asercji-inwariantów, sprzątnięcie. SEKWENCYJNIE
 * (model trzyma stan tury per instancja — nie jest concurrent-safe). Raport zbiorczy: GREEN/EMPTY/RED/SKIP + dowód przy RED.
 *
 * DUAL-MODE (decyzja Fable): te same asercje, dwa źródła zachowania modelu. Offline = domyślne,
 * deterministyczne, za darmo, po każdej zmianie. Live (--live) = żywy DeepSeek prowokowany
 * promptem; asercje IDENTYCZNE; brak klucza → czytelny komunikat + exit 2.
 *
 * Kolejność globali: dom-shim PRZED bundlem pluginu (boot.js importuje PKMAssistantPlugin).
 */
import '../mock/dom-shim.js';
import fs from 'fs';
import path from 'path';
import { bootPlugin, cleanupPlugin, ENV_LOCAL_PATH, TRACE_REL } from '../lib/boot.js';
import { startFakeLlmServer } from '../mock/fake-llm-server.js';
import { setHarnessLlmEndpoint } from '../lib/harnessProviders.js';
import { clearHarnessRequestUrlRoutes } from '../mock/obsidian.js';
import { clearHarnessCompletions, setHarnessLmStudioEndpoint, setHarnessOllamaHost } from '../lib/harnessProviders.js';
import { parseEnvLocal } from '../lib/envLocal.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { parseTrace, snapshot, AssertionError, resetCheckCount, getCheckCount, isNoAttemptRun, NO_ATTEMPT_MESSAGE } from './_asserts.js';
import type { FixturePayload, Scenario, TraceEvents } from './_asserts.js';
import { SCENARIOS } from './index.js';

// TS-any: granice CLI, pluginu i fixture harnessa są składane przez runtime integracyjny.
type RunnerPayload = any;
type RunnerFlags = { live: boolean; keepVault: boolean; only: string | null };

// ── CLI ──
function parseArgs(argv: string[]): RunnerFlags {
  const flags: RunnerFlags = { live: false, keepVault: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') flags.live = true;
    else if (a === '--keep-vault') flags.keepVault = true;
    else if (a === '--only') flags.only = argv[++i];
    else if (a.startsWith('--only=')) flags.only = a.slice(7);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));

const bar = '══════════════════════════════════════════════════════════════';
const rule = '──────────────────────────────────────────────────────────────';
const line = (s = ''): void => console.log(s);

async function hardExit(code: number): Promise<never> {
  try { await new Promise((r) => setTimeout(r, 150)); } catch { /* noop */ }
  process.exit(code);
}

/** Wybór scenariuszy wg --only (dopasowanie po prefiksie numeru albo fragmencie nazwy pliku). */
function selectScenarios(): Scenario[] {
  if (!flags.only) return SCENARIOS as Scenario[];
  const needle = String(flags.only).toLowerCase();
  const picked = (SCENARIOS as Scenario[]).filter((s: Scenario) => {
    const file = (s.file || s.name || '').toLowerCase();
    return file.includes(needle) || file.startsWith(needle) || file.startsWith(`${needle}_`) || file.startsWith(`0${needle}`);
  });
  return picked.length ? picked : (SCENARIOS as Scenario[]).filter((s: Scenario) => (s.file || '').toLowerCase().includes(needle));
}

/** Ostatnie N wierszy trace.log jako dowód. */
function traceExcerpt(events: TraceEvents, n = 14): string {
  const raws = events.map((e) => {
    const pos = e.raw.indexOf('[trace] ');
    return pos >= 0 ? e.raw.slice(pos) : e.raw;
  });
  const tail = raws.slice(-n);
  return tail.map((l) => `      ${l}`).join('\n');
}

/** Krótki dump interesujących plików vaulta (dowód fs przy RED). */
function fsEvidence(vaultRoot: string, rels: string[] = []): string {
  const out = [];
  for (const rel of rels) {
    const p = path.join(vaultRoot, rel.replace(/\\/g, '/'));
    if (fs.existsSync(p)) {
      let body = '';
      try { body = fs.readFileSync(p, 'utf8'); } catch { body = '(nieczytelny)'; }
      out.push(`      ${rel}: ISTNIEJE (${body.length} zn.)`);
    } else {
      out.push(`      ${rel}: BRAK`);
    }
  }
  return out.join('\n');
}

// Wycisz szum bootstrapu pluginu (jego własne console.log/info/debug) na czas biegu — przekieruj
// na stderr, żeby stdout był czystym raportem. Restore w finally runOne.
function muteBootChatter() {
  const orig = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...a: unknown[]): boolean => process.stderr.write(`${a.map(String).join(' ')}\n`);
  console.log = toErr; console.info = toErr; console.debug = toErr;
  return () => { console.log = orig.log; console.info = orig.info; console.debug = orig.debug; };
}

/** Zeruje globalny stan harnessa dzielony między scenariuszami (router + adresy lokalnych platform). */
function resetHarnessGlobals(): void {
  clearHarnessRequestUrlRoutes();
  clearHarnessCompletions();
  setHarnessLmStudioEndpoint(null);
  setHarnessOllamaHost(null);
}

async function runOne(scenario: Scenario): Promise<RunnerPayload> {
  const agentName = scenario.agent || 'Tester';
  const offline = !flags.live;

  // Scenariusze z natury niewymuszalne na żywym modelu (np. wymagają symulacji halucynacji
  // nazwy narzędzia, którą potrafi tylko fake-serwer) deklarują liveSkip z powodem.
  if (flags.live && scenario.liveSkip) {
    return { scenario, status: 'SKIP', reason: scenario.liveSkip };
  }

  // Stan globalny harnessa jest współdzielony przez scenariusze (biegną w JEDNYM procesie,
  // sekwencyjnie) — zerujemy go PRZED scenariuszem i w `finally` po nim, żeby trasa routera
  // ani adres lokalnej platformy z jednego scenariusza nie przeciekły do następnego.
  resetHarnessGlobals();

  const restoreConsole = muteBootChatter();

  // ── Live: wymagany klucz (asercje identyczne, ale bieg na żywym modelu) ──
  let apiKey: string | null = null;
  if (flags.live) {
    const env: FixturePayload = parseEnvLocal(ENV_LOCAL_PATH);
    apiKey = env.DEEPSEEK_API_KEY || null;
    if (!apiKey) {
      process.stderr.write(
        '\n[harness] --live wymaga harness/.env.local z DEEPSEEK_API_KEY.\n'
        + '          Skopiuj harness/.env.example → harness/.env.local i wklej klucz DeepSeek,\n'
        + '          albo uruchom scenariusze bez --live (offline, deterministycznie).\n\n');
      await hardExit(2);
    }
  }

  // ── Offline: fake-serwer ze skryptem scenariusza ──
  let fakeServer: RunnerPayload = null;
  if (offline) {
    const script = scenario.offlineScript;
    if (!script) {
      return { scenario, status: 'RED', infra: true, error: `Scenariusz "${scenario.file}" nie ma offlineScript (a biegniemy offline).` };
    }
    fakeServer = await startFakeLlmServer({ script });
    setHarnessLlmEndpoint(fakeServer.url);
  } else {
    setHarnessLlmEndpoint(null); // live → prawdziwy endpoint DeepSeek
  }

  let plugin: RunnerPayload = null;
  let tempRoot: string | null = null;
  let failed = false; // RED ⇒ temp-vault zostaje jako materiał dowodowy (fs-dowód czytany PO finally)
  try {
    const booted: RunnerPayload = await bootPlugin({
      offline,
      fixtureOverrides: scenario.fixtures || [],
      tag: scenario.file,
    });
    plugin = booted.plugin;
    tempRoot = booted.tempRoot;

    // Mostek klucza do settings (modelResolver czyta klucz wyłącznie stąd).
    //
    // ⚠️ Zapis idzie do SUROWEGO worka (`settingsStore.raw`), NIE przez obserwowane proxy.
    // Klucz wstrzykuje harness, nie user — mutacja proxy zaplanowałaby zapis całego
    // `.pkm-assistant/settings.json` sekundę po boocie i zafałszowała dowód w scenariuszach
    // pancerza (26/27/39), które sprawdzają właśnie to, że NIKT nie pisze przy starcie.
    // Czytelnicy (`modelResolver`) i tak widzą tę samą wartość — proxy owija ten sam obiekt.
    // Od clean-room gałąź `chat` istnieje ZAWSZE (fabryczne kontenery z `config/defaultSettings.ts`),
    // więc mostek nie jest już no-opem na vaultcie bez ustawień.
    const chatKeys = (plugin.env?.settingsStore?.raw as RunnerPayload)?.pkmAssistant?.chat?.apiKeys
      ?? plugin.env?.settings?.pkmAssistant?.chat?.apiKeys;
    if (chatKeys) chatKeys.deepseek = offline ? 'harness-offline-dummy' : apiKey;

    // Hook PO boocie, PRZED turą modelu. Scenariusz może dostroić ŻYWY plugin tam, gdzie
    // pliku w vaulcie nie ma (np. podłączyć atrapę zewnętrznego serwera MCP przez DI
    // `externalMcpManager._clientFactory`). Świadomie minimalny: żadnej magii, żadnego
    // teardownu — sprzątanie robi `cleanupPlugin` jak dla każdego innego biegu.
    await scenario.setup?.({ plugin, vaultRoot: tempRoot, app: booted.app });

    // Migawki „przed" (fileUnchanged itd.).
    const before: Record<string, FixturePayload> = {};
    for (const rel of scenario.snapshotFiles || []) before[rel] = snapshot(tempRoot!, rel);

    const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
    const turn = await runExploratoryTurn(plugin, {
      agentName,
      prompt: flags.live ? (scenario.livePrompt || scenario.opis) : (scenario.livePrompt || scenario.opis || 'wykonaj zadanie'),
      autonomy: scenario.autonomy || 'edge',
      approve: scenario.approve || 'auto',
      maxIterations: scenario.maxIterations || null,
      runId,
      // K5: scenariusz może odegrać Stop (predykat przerwania tury) — patrz 44_stop_zatrzask.
      ...(typeof scenario.shouldAbort === 'function' ? { shouldAbort: scenario.shouldAbort } : {}),
    });

    // Trace: flush + parse dla labelu tego biegu.
    try { await plugin.traceLog?.sink?.flush?.(); } catch { /* best-effort */ }
    const tracePath = path.join(tempRoot!, TRACE_REL);
    const events = parseTrace(tracePath, turn.traceLabel);

    // Asercje-inwarianty.
    // `plugin` = ŻYWY obiekt pluginu tego biegu (jeszcze przed cleanupem w `finally`).
    // Potrzebny scenariuszom, które po turze wołają produkcyjne API na tym samym temp-vaulcie
    // (np. 11_sesja_pisarze: `agentManager.getActiveMemory().saveSession(...)` = symulacja
    // autozapisu). Asercje MOGĄ z niego korzystać, ale nie muszą — reszta scenariuszy go ignoruje.
    // `live` — asercje mogą różnicować oczekiwania: offline WYMUSZA sekwencję skryptem,
    // żywy model może odpuścić po pierwszej odmowie (lekcja z live-walidacji 2026-07-24).
    const ctx: FixturePayload = { result: turn.result, trace: events, vaultRoot: tempRoot, before, approvals: turn.approvals, turn, plugin, live: !!flags.live };

    // Werdykt Kuby 2026-09-02: bieg żywy bez ANI JEDNEJ próby narzędzia rozpoznaje RUNNER dla
    // każdego scenariusza (nie każdy scenariusz z osobna, jak dotąd tylko 03). Osobny status —
    // nie RED (to nie znalezisko w pluginie) i nie GREEN (niczego nie sprawdziliśmy). Offline
    // nie dotyczy: skrypt fake-serwera wymusza wywołania, brak = bug skryptu, który złapią asercje.
    // Temp-vault zostaje (jak przy RED) — trace to jedyny dowód, co model zrobił zamiast próby.
    if (flags.live && isNoAttemptRun(turn.result)) {
      failed = true;
      return { scenario, status: 'NO_ATTEMPT', assertion: NO_ATTEMPT_MESSAGE, turn, events, tempRoot };
    }

    try {
      resetCheckCount();
      await scenario.asserts(ctx);
      const status = getCheckCount() === 0 ? 'EMPTY' : 'GREEN';
      return { scenario, status, turn, events, tempRoot };
    } catch (err) {
      if (err instanceof AssertionError) {
        failed = true;
        return { scenario, status: 'RED', assertion: err.message, turn, events, tempRoot };
      }
      throw err; // błąd nie-asercyjny → infra
    }
  } catch (err: RunnerPayload) {
    failed = true;
    return { scenario, status: 'RED', infra: true, error: err?.stack || String(err), tempRoot };
  } finally {
    resetHarnessGlobals();
    if (fakeServer) { try { await fakeServer.close(); } catch { /* best-effort */ } }
    if (plugin) {
      try { await cleanupPlugin(plugin, tempRoot!, { keepVault: flags.keepVault || failed, quiet: true }); }
      catch { /* best-effort */ }
    }
    restoreConsole();
  }
}

async function main(): Promise<void> {
  const scenarios = selectScenarios();

  line();
  line(bar);
  line(`  HARNESS „Szklane Pudło" — FAZA C: scenariusze-łamacze  [${flags.live ? 'LIVE DeepSeek' : 'OFFLINE deterministyczny'}]`);
  line(bar);
  line(`  scenariuszy do uruchomienia: ${scenarios.length}${flags.only ? ` (filtr --only ${flags.only})` : ''}`);
  line();

  const results: RunnerPayload[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`  ▶ ${scenario.file} … `);
    const res = await runOne(scenario);
    results.push(res);
    line(res.status === 'GREEN' ? 'GREEN'
      : (res.status === 'EMPTY' ? 'EMPTY (0 sprawdzen — scenariusz niczego nie zweryfikowal)'
        : (res.status === 'SKIP' ? 'SKIP (offline-only)'
          : (res.status === 'NO_ATTEMPT' ? 'NO_ATTEMPT (zywy model nic nie sprobowal — bieg nierozstrzygniety)' : 'RED'))));

    if (res.status === 'SKIP') {
      line(`      └─ ${res.reason}`);
    }
    if (res.status === 'NO_ATTEMPT') {
      line(rule);
      line(`  ${res.scenario.file} — ${res.scenario.opis || res.scenario.name}`);
      line(`  NO_ATTEMPT — ${res.assertion}`);
      const r = res.turn?.result;
      if (r) {
        line(`  wynik pętli: stoppedBy=${r.stoppedBy} iters=${r.iterations} tools=[]`);
        const said = String(r.finalText || '').replace(/\s+/g, ' ').trim();
        if (said) line(`  model zamiast próby powiedział: „${said.slice(0, 240)}${said.length > 240 ? '…' : ''}"`);
      }
      if (res.events?.length) {
        line(`  trace (ogon):`);
        line(traceExcerpt(res.events));
      }
      if (res.tempRoot) line(`  temp-vault (dowody, NIE usunięty): ${res.tempRoot}`);
      line(rule);
    }
    if (res.status === 'RED') {
      line(rule);
      line(`  ${res.scenario.file} — ${res.scenario.opis || res.scenario.name}`);
      if (res.infra) {
        line(`  RED (błąd infrastruktury/biegu — NIE asercja):`);
        line(`      ${String(res.error).split('\n').slice(0, 8).join('\n      ')}`);
      } else {
        line(`  RED — padła asercja:`);
        line(`      ${res.assertion}`);
        if (res.turn?.result) {
          const r = res.turn.result;
          line(`  wynik pętli: stoppedBy=${r.stoppedBy} iters=${r.iterations} tools=[${(r.toolsUsed || []).join(', ')}]`);
        }
        if (res.events?.length) {
          line(`  trace (ogon):`);
          line(traceExcerpt(res.events));
        }
        if (res.tempRoot && res.scenario.evidenceFiles?.length) {
          line(`  fs:`);
          line(fsEvidence(res.tempRoot, res.scenario.evidenceFiles));
        }
        if (res.tempRoot) line(`  temp-vault (dowody, NIE usunięty): ${res.tempRoot}`);
      }
      line(rule);
    }
  }

  const green = results.filter((r) => r.status === 'GREEN').length;
  const empty = results.filter((r) => r.status === 'EMPTY').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const noAttempt = results.filter((r) => r.status === 'NO_ATTEMPT').length;
  const total = results.length;

  line();
  line(bar);
  line('  PODSUMOWANIE');
  line(rule);
  for (const r of results) {
    const mark = r.status === 'GREEN' ? '✓' : (r.status === 'SKIP' ? '−' : (r.status === 'NO_ATTEMPT' ? '?' : '✗'));
    const note = r.status === 'GREEN' ? ''
      : (r.status === 'EMPTY' ? '  (0 sprawdzen — scenariusz niczego nie zweryfikowal)'
        : (r.status === 'SKIP' ? '  (offline-only)'
          : (r.status === 'NO_ATTEMPT' ? '  (zywy model nic nie sprobowal — nierozstrzygniety)'
            : (r.infra ? '  (infra/bieg)' : '  (asercja/znalezisko)'))));
    line(`   ${mark} ${String(r.scenario.file).padEnd(28)} ${r.status}${note}`);
  }
  line(rule);
  line(`  WYNIK: ${green}/${total - skipped} GREEN${empty ? ` (+${empty} EMPTY)` : ''}${noAttempt ? ` (+${noAttempt} NO_ATTEMPT — model nic nie sprobowal)` : ''}${skipped ? ` (+${skipped} SKIP offline-only)` : ''}`);
  line(bar);
  line();

  // Fail-closed: NO_ATTEMPT liczy się w bramce jak EMPTY — bieg, który niczego nie dowiódł,
  // nie może wyjść zerem. Wyjście 1 mówi „powtórz / popraw prompt", nie „plugin pękł".
  const anyRed = results.some((r) => r.status === 'RED');
  const anyEmpty = results.some((r) => r.status === 'EMPTY');
  const anyNoAttempt = results.some((r) => r.status === 'NO_ATTEMPT');
  await hardExit(anyRed || anyEmpty || anyNoAttempt || total === 0 ? 1 : 0);
}

main().catch(async (err: RunnerPayload) => {
  process.stderr.write(`\n[harness/scenarios] BŁĄD krytyczny:\n${err?.stack || err}\n`);
  try { const { shutdownHarnessRuntime } = await import('../mock/obsidian.js'); shutdownHarnessRuntime(); } catch { /* best-effort */ }
  await hardExit(1);
});
