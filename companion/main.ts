/**
 * companion/main.ts — wtyczka-nosiciel `pkm-assistant-dev`.
 *
 * PO CO: komendy CLI Obsidiana (`status`/`selftest`/`agent-prompt`/`memory-status`) są
 * narzędziem WEWNĘTRZNYM (agenci Claude Code pytają plugin o stan), nie funkcją dla userów
 * pluginu `pkm-assistant` - więc nie żyją w jego repo (werdykt właściciela 2026-09-20). Ta
 * mała prywatna wtyczka (instalowana TYLKO w vaulcie właściciela) rejestruje własne cztery
 * komendy `pkm-assistant-dev:*` i przy KAŻDYM wywołaniu rozwiązuje żywą instancję hosta
 * `pkm-assistant` z `app.plugins.plugins` (`resolveHost` w `hostPlugin.ts`) - nigdy raz tutaj,
 * w `onload()`, bo host bywa przeładowywany niezależnie od tej wtyczki.
 *
 * Zero UI, zero ustawień, zero zapisu - jedyny efekt uboczny `onload()` jest rejestracja
 * czterech komend CLI (`registerCliHandler`, best-effort, patrz `cli/register.ts`).
 */
// `obsidian` NIE jest zależnością tego repo (harness testuje przez atrapę
// `test-support/obsidian.ts`, nie przez oficjalny pakiet - i nie wolno dokładać nowych
// zależności npm), więc `tsc` nie ma skąd wziąć typów dla tego bare specyfiera. W RUNTIME to
// MUSI zostać dokładnie tym: prawdziwym pakietem, dostarczonym przez hosta
// (`esbuild.harness.ts` -> `buildCompanion()` znaczy `obsidian` jako `external`, jak
// produkcyjny `esbuild.js` pluginu) - stąd import zostaje bare, a niedoskonałość typechecku
// jest odizolowana do TEJ JEDNEJ linii. `this.app`/`this.manifest`/`this.registerCliHandler`
// dostają zaraz niżej WŁASNE, precyzyjne typy (`declare`) - `extends` na nierozwiązanym imporcie
// nie przenosi żadnych typów bazowych, więc i tak trzeba je zadeklarować samemu.
// @ts-expect-error TS2307 - pakiet 'obsidian' nie jest zainstalowany w tym repo (patrz wyżej)
import { Plugin, Platform } from 'obsidian';
import { registerCliCommands } from './cli/index.js';
import { resolveHost } from './hostPlugin.js';
import { getConsolidationStatus } from './memoryStatus.js';
import { log } from './logger.js';

import type { SelfTestPlugin } from '@plugin/core/selftest.js';
import type { CliFlags, CliHandler, RegisteredCliHandler } from '../test-support/obsidian.js';

export default class PkmAssistantDevPlugin extends Plugin {
    // Re-deklaracje pól odziedziczonych po `Plugin` - baza jest `any` (import nierozwiązany
    // dla `tsc`, patrz wyżej), więc `extends Plugin` sam z siebie nie daje ŻADNYCH typów
    // odziedziczonych (włącznie z konstruktorem - stąd jawny konstruktor niżej, inaczej
    // `new PkmAssistantDevPlugin(app, manifest)` dostawałby "Expected 0 arguments"). `app`
    // zostaje `unknown` - `resolveHost(app: unknown)` i tak zawęża go sam, na granicy (patrz
    // `hostPlugin.ts`). `_registeredCliHandlers` jest polem atrapy Obsidiana
    // (`test-support/obsidian.ts`, `Plugin._registeredCliHandlers`) - w PRAWDZIWYM Obsidianie
    // tego pola nie ma (nieudokumentowany szczegół hosta), więc żaden kod produkcyjny na nim
    // nie polega; re-deklaracja istnieje WYŁĄCZNIE, żeby scenariusz harnessu (`47_cli_odczyt.ts`,
    // stawia tę wtyczkę na atrapie) mógł go odczytać z typami, zamiast castować na wiarę.
    declare app: unknown;
    declare manifest: { id?: string; version?: string };
    declare registerCliHandler?: (command: string, description: string, flags: CliFlags | null, handler: CliHandler) => void;
    declare _registeredCliHandlers?: Map<string, RegisteredCliHandler>;

    constructor(app: unknown, manifest: { id?: string; version?: string }) {
        // Baza `any` (patrz wyżej) - `super(...)` nie jest tu typowany, ale w RUNTIME to
        // ZAWSZE prawdziwy konstruktor `Plugin` (atrapy w testach/scenariuszach, hosta w
        // produkcji), który sam ustawia `this.app`/`this.manifest`.
        super(app, manifest);
    }

    onload(): void {
        const result = registerCliCommands(this, {
            companionId: this.manifest.id || 'pkm-assistant-dev',
            companionVersion: this.manifest.version || 'unknown',
            resolveHost: () => resolveHost(this.app),
            selfTest: async (hostRaw: Record<string, unknown>) => {
                const { buildSelfTestReport } = await import('@plugin/core/selftest.js');
                // Granica: `hostRaw` przyszedł z `resolveHost` już zwalidowany (obiekt,
                // niepusty - patrz `hostPlugin.ts`). `SelfTestPlugin` ma WSZYSTKIE pola
                // opcjonalne z założenia ("raport ma nigdy nie wybuchnąć") - dokładnie ten sam
                // wzorzec castu co oryginalny wołacz w `src/main.ts`
                // (`this as unknown as Parameters<typeof buildSelfTestReport>[0]`).
                return buildSelfTestReport(hostRaw as unknown as SelfTestPlugin, {
                    isMobile: !!Platform?.isMobile,
                    // `countDocs`/`fileLogActive` ŚWIADOMIE pominięte - patrz `CLAUDE.md` tego
                    // folderu, sekcja "Czego selftest tu nie wie", i raport zadania.
                });
            },
            consolidationStatus: getConsolidationStatus,
        });
        log.debug('onload', result.skipped
            ? 'registerCliHandler niedostępny (Obsidian < 1.12.2) - zero komend'
            : `${result.registered.length} komend zarejestrowanych${result.failed.length ? `, ${result.failed.length} padło` : ''}`);
    }
}
