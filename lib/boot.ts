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
import PKMAssistantPlugin from '../../src/main.js';
import { createMockApp } from '../mock/app.js';
import { shutdownHarnessRuntime } from '../mock/obsidian.js';
import { harnessProviderOverrides } from './harnessProviders.js';

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

export const HARNESS_DIR = path.resolve(__dirname, '..');
export const FIXTURE_DIR = path.join(HARNESS_DIR, 'vault-fixture');
export const MANIFEST_PATH = path.join(HARNESS_DIR, '..', 'manifest.json');
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
 * Kopiuje fixture → świeży temp-vault, nakłada opcjonalne nadpisy scenariusza, stawia plugin.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.offline=false] - true → podmień dostawców na harnessowych (adres fake-serwera).
 * @param {Array<{path:string, content:string}>} [opts.fixtureOverrides] - pliki DOPISANE do temp-vaulta
 *   po skopiowaniu fixture, PRZED `onload()` (np. podłożona notatka brain dla scenariusza create-only).
 * @param {string} [opts.tag] - etykieta w nazwie katalogu temp (czytelność przy --keep-vault).
 * @returns {Promise<{plugin, app, tempRoot, bootMs}>}
 */
export async function bootPlugin({ offline = false, fixtureOverrides = [], tag = '' }: BootOptions = {}): Promise<BootResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = tag ? `${timestamp}-${tag}` : timestamp;
  const tempRoot = path.join(os.tmpdir(), 'pkm-harness', suffix);
  await fsp.cp(FIXTURE_DIR, tempRoot, { recursive: true });

  // Nadpisy scenariusza — DOPISANE po fixture, przed bootem (świeży stan startowy per scenariusz).
  for (const ov of fixtureOverrides || []) {
    if (!ov || typeof ov.path !== 'string') continue;
    const abs = path.join(tempRoot, ov.path.replace(/\\/g, '/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, ov.content == null ? '' : String(ov.content), 'utf8');
  }

  const manifest: HarnessRuntime = JSON.parse(await fsp.readFile(MANIFEST_PATH, 'utf8'));
  const app = createMockApp(tempRoot);
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
