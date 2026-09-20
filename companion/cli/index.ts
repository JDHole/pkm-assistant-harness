/**
 * companion/cli - drzwi publiczne tej podpaczki (barrel). PRZENIESIONE z `modules/cli/index.ts`
 * pluginu - tylko id komend i kształt `CliDeps`/`StatusData` się zmieniły (patrz `commands.ts`).
 *
 * `buildCliCommands` (z `commands.ts`) świadomie NIE jest w barrelu - jedyny konsument spoza
 * `register.ts` to testy tego samego folderu, które importują go wprost jako sibling.
 */
export { registerCliCommands } from './register.js';
export type { CliHost, RegisterCliCommandsResult } from './register.js';

export type {
    CliDeps,
    CliCommandSpec,
    StatusData,
    AgentPromptData,
    MemoryStatusData,
} from './commands.js';

export type { CliEffect, CliErrorCode, CliResponse } from './response.js';
