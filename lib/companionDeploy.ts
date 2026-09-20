/**
 * companionDeploy.ts — deploy wtyczki-nosiciela `pkm-assistant-dev` do JEDNEGO vaulta
 * dewelopera, sterowany plikiem `companion/deploy.local.json` (gitignored, ten skrypt go
 * NIE TWORZY - patrz `companion/deploy.local.example.json`).
 *
 * Lustro `utils/buildManifest.ts` pluginu (`pluginDeployDir`/`deployToVaults`), uproszczone do
 * jednego vaulta i jednego pliku konfiguracyjnego zamiast zmiennych `.env`: `build:companion`
 * jest narzędziem jednego dewelopera na jego własnej maszynie, nie wieloosobowym CI.
 *
 * Brak pliku konfiguracyjnego = `{deployed:false, reason:'no-config'}` - `esbuild.harness.ts`
 * zamienia to na JEDNĄ linię "deploy pominięty" i kończy sukcesem (deploy jest wygodą, nie
 * bramką builda). Błąd kopiowania też NIE wywraca builda - z tego samego powodu.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Id TEJ wtyczki (musi się zgadzać z `companion/manifest.json`). */
const COMPANION_ID = 'pkm-assistant-dev';

/** Pliki kopiowane do vaulta - w tej kolejności, tak jak `DIST_ARTIFACTS` pluginu. */
const ARTIFACTS = ['main.js', 'manifest.json'] as const;

export interface DeployConfig {
    vault: string;
    configDir: string;
}

export interface DeployOutcome {
    deployed: boolean;
    target?: string;
    reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Waliduje kształt wczytanego JSON-a z `deploy.local.json` - `null`, gdy brakuje któregokolwiek
 * niepustego pola string (`vault`/`configDir`). Nazwy pól i sens 1:1 z tym, co `esbuild.js`
 * pluginu czyta ze zmiennych `.env` (`DESTINATION_VAULTS`/`DESTINATION_CONFIG_DIR`) - tu jeden
 * plik JSON zamiast dwóch zmiennych środowiskowych, bo cel jest jeden vault, nie lista.
 */
export function parseDeployConfig(raw: unknown): DeployConfig | null {
    if (!isRecord(raw)) return null;
    const vault = typeof raw.vault === 'string' ? raw.vault.trim() : '';
    const configDir = typeof raw.configDir === 'string' ? raw.configDir.trim() : '';
    if (!vault || !configDir) return null;
    return { vault, configDir };
}

/** Katalog docelowy wtyczki-nosiciela w vaultcie: `<vault>/<configDir>/plugins/<id>`. */
export function companionDeployDir(config: DeployConfig): string {
    return path.join(config.vault, config.configDir, 'plugins', COMPANION_ID);
}

/**
 * Kopiuje `main.js` + `manifest.json` z `distDir` do vaulta, TYLKO gdy `deployConfigPath`
 * istnieje. Nazwa folderu konfiguracji Obsidiana NIE jest zgadywana - musi przyjść z pliku,
 * dokładnie jak w `esbuild.js` pluginu (`DESTINATION_CONFIG_DIR` nie jest odgadywana z gołego
 * Node'a).
 */
export function deployCompanion(distDir: string, deployConfigPath: string): DeployOutcome {
    if (!fs.existsSync(deployConfigPath)) {
        return { deployed: false, reason: 'no-config' };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(deployConfigPath, 'utf8'));
    } catch (e) {
        return { deployed: false, reason: `bad-json: ${e instanceof Error ? e.message : String(e)}` };
    }

    const config = parseDeployConfig(parsed);
    if (!config) {
        return { deployed: false, reason: 'bad-shape (oczekiwano {"vault": "...", "configDir": "..."})' };
    }

    const target = companionDeployDir(config);
    try {
        fs.mkdirSync(target, { recursive: true });
        for (const artifact of ARTIFACTS) {
            fs.copyFileSync(path.join(distDir, artifact), path.join(target, artifact));
        }
        return { deployed: true, target };
    } catch (e) {
        return { deployed: false, reason: `copy-failed: ${e instanceof Error ? e.message : String(e)}` };
    }
}
