/**
 * boot.js — wspólny bootstrap harnessa (wydzielony z run.js w FAZIE C).
 *
 * PO CO: `run.js` (bieg eksploracyjny) i `scenarios/_runner.js` (scenariusze-łamacze) muszą
 * stawiać PLUGIN dokładnie tak samo — inaczej scenariusz testowałby inny bootstrap niż CLI (drift).
 * Ta funkcja jest JEDNYM miejscem, które: kopiuje fixture → temp, opcjonalnie nadpisuje pliki
 * vaulta scenariusza, stawia `PKMAssistantPlugin` do `_ready=true` i (w trybie offline) podmienia adapter
 * DeepSeek na harnessowy (endpoint → fake-serwer). Zero forka logiki pluginu.
 *
 * Globale (dom-shim) instaluje wołacz PRZED importem tego pliku (patrz run.js).
 */
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { createMockApp } from '../mock/app.js';
// Atrapa `obsidian` mieszka w TYM repo od 2026-09-11 (patrz `esbuild.harness.ts`), nie w
// drzewie pluginu — więc import jest lokalny, nie przez alias `@plugin/`.
import { shutdownHarnessRuntime } from '../test-support/obsidian.js';
import { harnessProviderOverrides } from './harnessProviders.js';
import { harnessRoot, pluginRoot } from './pluginRoot.js';

// TS-any: plugin, mock App and manifest meet at the harness composition boundary.
export type HarnessRuntime = any;
type ErrLike = { message?: string };

export interface FixtureOverride {
  path: string;
  content?: unknown;
}

export interface BootOptions {
  offline?: boolean;
  fixtureOverrides?: FixtureOverride[];
  tag?: string;
  fixtureDir?: string;
}

export interface BootResult {
  plugin: HarnessRuntime;
  app: HarnessRuntime;
  tempRoot: string;
  bootMs: number;
}

export interface CleanupOptions {
  keepVault?: boolean;
  quiet?: boolean;
}

// Korzeń TEGO repo (fixture, .env.local) i korzeń repo PLUGINU (manifest) — dwa różne
// katalogi od 2026-09-07, gdy harness wyprowadził się z repo pluginu. Rozstrzyga je
// `lib/pluginRoot.ts`; tu tylko sklejamy ścieżki.
export const HARNESS_DIR = harnessRoot();
export const FIXTURE_DIR = path.join(HARNESS_DIR, 'vault-fixture');
export const MANIFEST_PATH = path.join(pluginRoot(), 'manifest.json');
export const ENV_LOCAL_PATH = path.join(HARNESS_DIR, '.env.local');
export const TRACE_REL = path.join('.pkm-assistant', 'logs', 'trace.log');

/**
 * Podmienia dostawców czatu na harnessowych (tryb offline). Trzy platformy, bo trzy różne
 * dialekty strumienia, które chcemy dać się przepuścić przez pętlę bez sieci: DeepSeek
 * (SSE OpenAI, domyślny model scenariuszy), LM Studio (SSE OpenAI + parser `<think>`),
 * Ollama (NDJSON + natywne `message.thinking`). Podmieniamy WYŁĄCZNIE adres serwera.
 */
function swapHarnessProviders(providers: HarnessRuntime): void {
  Object.assign(providers, harnessProviderOverrides());
}

/**
 * Kopiuje katalog fixture do świeżego temp-vaulta (`tempRoot`, jeszcze nieistniejący — `fsp.cp`
 * go tworzy). Wydzielone z `bootPlugin` (prompt-eval adapter, impl_fixture 2026-09-23): `--fixture
 * <dir>` w `run.js` ma być testowalne bez kosztu pełnego bootu pluginu (`onload()+waitForReady()`
 * na PRAWDZIWYM `PKMAssistantPlugin`) — patrz `lib/boot.fixtureDir.test.ts`.
 *
 * @param tempRoot - katalog docelowy temp-vaulta.
 * @param fixtureDir - katalog źródłowy fixture; domyślnie `FIXTURE_DIR` (`vault-fixture` tego repo).
 * @throws Error z czytelnym komunikatem, gdy `fixtureDir` nie istnieje — zamiast surowego ENOENT
 *   z `fsp.cp`, które nie mówi wprost, CZEGO zabrakło.
 */
export async function copyFixture(tempRoot: string, fixtureDir: string = FIXTURE_DIR): Promise<void> {
  try {
    await fsp.stat(fixtureDir);
  } catch {
    throw new Error(`[harness] katalog fixture nie istnieje: ${fixtureDir}`);
  }
  await fsp.cp(fixtureDir, tempRoot, { recursive: true });
}

/**
 * Kopiuje fixture → świeży temp-vault, nakłada opcjonalne nadpisy scenariusza, stawia plugin.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.offline=false] - true → podmień dostawców na harnessowych (adres fake-serwera).
 * @param {Array<{path:string, content:string}>} [opts.fixtureOverrides] - pliki DOPISANE do temp-vaulta
 *   po skopiowaniu fixture, PRZED `onload()` (np. podłożona notatka brain dla scenariusza create-only).
 * @param {string} [opts.tag] - etykieta w nazwie katalogu temp (czytelność przy --keep-vault).
 * @param {string} [opts.fixtureDir] - katalog fixture do skopiowania zamiast domyślnego `FIXTURE_DIR`
 *   (prompt-eval adapter: żeby dało się złożyć realny prompt persony zamiast hard-coded vault-fixture).
 * @returns {Promise<{plugin, app, tempRoot, bootMs}>}
 */
export async function bootPlugin({ offline = false, fixtureOverrides = [], tag = '', fixtureDir }: BootOptions = {}): Promise<BootResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = tag ? `${timestamp}-${tag}` : timestamp;
  const tempRoot = path.join(os.tmpdir(), 'pkm-harness', suffix);
  await copyFixture(tempRoot, fixtureDir);

  // Nadpisy scenariusza — DOPISANE po fixture, przed bootem (świeży stan startowy per scenariusz).
  for (const ov of fixtureOverrides || []) {
    if (!ov || typeof ov.path !== 'string') continue;
    const abs = path.join(tempRoot, ov.path.replace(/\\/g, '/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, ov.content == null ? '' : String(ov.content), 'utf8');
  }

  const manifest: HarnessRuntime = JSON.parse(await fsp.readFile(MANIFEST_PATH, 'utf8'));
  const app = createMockApp(tempRoot);
  // Import DYNAMICZNY, celowo NIE statyczny u góry pliku: `@plugin/src/main.js` (composition root
  // pluginu) ciągnie za sobą PRAWDZIWY `'obsidian'`, którego poza bundlem esbuilda (alias →
  // atrapa, patrz `esbuild.harness.ts`) po prostu nie ma. Statyczny import wywalałby import
  // TEGO CAŁEGO modułu (`lib/boot.ts`) pod gołym `tsx`/AVA — czyli i `copyFixture`, i `FIXTURE_DIR`
  // — mimo że one same z 'obsidian' nic wspólnego nie mają. Odroczenie do wnętrza `bootPlugin()`
  // (wołane tylko przy PRAWDZIWYM boocie, nie w testach `copyFixture`) naprawia to bez zmiany
  // zachowania: `bootPlugin()` nadal stawia dokładnie tego samego, prawdziwego pluginu.
  const { default: PKMAssistantPlugin } = await import('@plugin/src/main.js');
  const plugin: HarnessRuntime = new (PKMAssistantPlugin as HarnessRuntime)(app, manifest);

  // C-02: config runtime'u powstaje w KONSTRUKTORZE pluginu, więc dostawców podmieniamy RAZ,
  // PRZED `onload()` — `runtime.config === plugin.runtimeConfig`, drugi swap po boocie jest
  // zbędny. Okna startu nie ma (start jest zdarzeniowy), więc nie ma czego nadpisywać.
  try {
    const cfg = plugin.runtimeConfig;
    if (offline && cfg?.chat?.providers) {
      swapHarnessProviders(cfg.chat.providers);
    }
  } catch (e) {
    console.warn('[harness] runtimeConfig provider swap failed:', (e as ErrLike)?.message || e);
  }

  const t0 = Date.now();
  plugin.onload();
  await Promise.race([
    plugin.waitForReady(),
    new Promise((_res, rej) => {
      const t = setTimeout(() => rej(new Error('waitForReady timeout (30s)')), 30000);
      t?.unref?.();
    }),
  ]);
  const bootMs = Date.now() - t0;

  return { plugin, app, tempRoot, bootMs };
}

/**
 * Sprząta plugin + temp-vault. Fail-soft (best-effort na każdym kroku).
 * @param {Object} plugin
 * @param {string} tempRoot
 * @param {Object} [opts]
 * @param {boolean} [opts.keepVault=false] - nie kasuj temp-vaulta (inspekcja).
 * @param {boolean} [opts.quiet=false] - nie loguj na stdout.
 * @returns {Promise<{cleared:number}>}
 */
export async function cleanupPlugin(plugin: HarnessRuntime, tempRoot: string, { keepVault = false, quiet = false }: CleanupOptions = {}): Promise<{ cleared: number }> {
  const line = (s: string) => { if (!quiet) console.log(s); };
  try { await plugin?.traceLog?.sink?.flush?.(); } catch { /* best-effort */ }
  try { plugin?.onunload?.(); } catch (e) { console.warn('[harness] onunload error:', (e as ErrLike)?.message || e); }
  try { clearTimeout(plugin?.env?.settingsStore?.pendingSaveTimer); } catch { /* best-effort */ }
  const cleared = shutdownHarnessRuntime();
  if (!keepVault) {
    try { await fsp.rm(tempRoot, { recursive: true, force: true }); }
    catch (e) { console.warn('[harness] temp cleanup failed:', (e as ErrLike)?.message || e); }
  } else {
    line(`[harness] --keep-vault: temp-vault zachowany: ${tempRoot}`);
  }
  return { cleared };
}
