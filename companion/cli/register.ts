/**
 * @module register
 * Wiąże `buildCliCommands(deps)` z hostem Obsidiana (`Plugin#registerCliHandler`, API od
 * 1.12.2). PRZENIESIONE 1:1 z `modules/cli/register.ts` pluginu - mechanika okablowania nie
 * zmienia się wcale, zmienia się tylko KTO jest hostem: tutaj to WTYCZKA-NOSICIEL SAMA (`this`
 * z `companion/main.ts` `onload()`), bo tylko obiekt zarejestrowany w `app.plugins.plugins`
 * może w ogóle zawołać `registerCliHandler` - `pkm-assistant` (host, o który te komendy pytają)
 * nie bierze w tym udziału jako REJESTRUJĄCY, tylko jako CEL zapytań (patrz `hostPlugin.ts`).
 */

import { log } from '../logger.js';
import { buildCliCommands } from './commands.js';

// Typy z LOKALNEJ atrapy, nie z bare specyfiera `obsidian` - patrz komentarz w `commands.ts`.
import type { CliHandler, CliFlags } from '../../test-support/obsidian.js';
import type { CliDeps } from './commands.js';

/**
 * Powierzchnia hosta, jakiej potrzebuje rejestracja - `registerCliHandler` jest OPCJONALNE,
 * bo `manifest.json` tej wtyczki ma `minAppVersion: 1.12.2`, ale sprawdzenie zostaje takie samo
 * jak w źródle (Obsidian starszy po prostu nie ma tej metody - wtyczka ma wtedy wstać normalnie,
 * bez komend CLI, zamiast rzucić).
 */
export interface CliHost {
    registerCliHandler?: (command: string, description: string, flags: CliFlags | null, handler: CliHandler) => void;
}

/** Wynik jednego przebiegu rejestracji - co się udało, czy hosta w ogóle stać na CLI, co padło. */
export interface RegisterCliCommandsResult {
    registered: string[];
    skipped: 'unsupported' | null;
    failed: Array<{ id: string; message: string }>;
}

/**
 * Rejestruje cztery komendy fali 1 na hoście. Brak `registerCliHandler` kończy się CICHO
 * (`skipped:'unsupported'`), bez rzucania - `companion/main.ts` woła to z `onload()` i awaria
 * rejestracji CLI nie ma prawa wywrócić startu tej małej wtyczki. Każda komenda rejestruje się
 * w OSOBNYM try/catch: `registerCliHandler` rzuca na duplikacie id, więc jedna nieudana
 * rejestracja (np. drugi reload w tej samej sesji Obsidiana) nie blokuje pozostałych trzech.
 */
export function registerCliCommands(host: CliHost, deps: CliDeps): RegisterCliCommandsResult {
    const handler = host.registerCliHandler;
    if (typeof handler !== 'function') {
        return { registered: [], skipped: 'unsupported', failed: [] };
    }

    const registered: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];

    for (const spec of buildCliCommands(deps)) {
        try {
            // P1 (ze źródła): WOŁANE NA HOŚCIE (`handler.call(host, ...)`), NIGDY jako gołą
            // funkcję. Prawdziwa implementacja Obsidiana jest metodą prototypu, która czyta
            // `this` (`this.app.cli...`, `this.manifest.name`, `this.register(...)`) - odpięta
            // referencja gubi `this` i rzuca TypeError na KAŻDEJ komendzie w prawdziwym
            // Obsidianie (fejkowy host jako strzałka tego nie widzi, bo strzałki i tak nie mają
            // własnego `this`).
            handler.call(host, spec.id, spec.description, spec.flags, spec.run);
            registered.push(spec.id);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log.warn('CLI', `Rejestracja komendy "${spec.id}" padła, idę dalej: ${message}`);
            failed.push({ id: spec.id, message });
        }
    }

    return { registered, skipped: null, failed };
}
