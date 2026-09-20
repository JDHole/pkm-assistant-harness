/**
 * logger.ts — lokalny logger wtyczki-nosiciela `pkm-assistant-dev`.
 *
 * ŚWIADOMIE nie `core/utils/Logger.js` pluginu: `companion/` jest osobnym bundlem
 * (`dist/companion/main.js`, patrz `esbuild.harness.ts`), więc import tamtego pliku
 * dałby OSOBNĄ instancję jego singletona `log` - bez `fileSinkActive` hosta, bez jego
 * pliku na dysku, bez sensu (patrz `CLAUDE.md` tego folderu, sekcja "Czego selftest tu
 * NIE wie"). Ta wtyczka jest za mała, żeby uzasadnić własny plikowy sink - proste
 * przejście na `console.debug`/`console.warn`, z tym samym kształtem wywołania
 * (`scope, ...args`) co reszta repo.
 */

const PREFIX = '[pkm-assistant-dev]';

export const log = {
    debug(scope: string, ...args: unknown[]): void {
        console.debug(PREFIX, scope, ...args);
    },
    warn(scope: string, ...args: unknown[]): void {
        console.warn(PREFIX, scope, ...args);
    },
};
