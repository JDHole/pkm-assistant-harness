import type { FixturePayload } from './_asserts.js';
import { assert } from './_asserts.js';

/** Identity comes from the real persisted session, as in the chat entry point. */
export async function sessionOrigin(plugin: FixturePayload, agentName: string) {
  const memory = plugin.agentManager.getAgentMemory(agentName);
  assert(memory, `Brak pamięci właściciela ${agentName}`);
  const sessionPath = await memory.startActiveSession(agentName);
  if (!/^[0-9a-f]{32}$/.test(memory.sessionEpoch ?? '')) {
    await memory.ensureActiveSessionEpoch(sessionPath, () => memory.activeSessionPath === sessionPath);
  }
  return { agentName, sessionPath, sessionEpoch: memory.sessionEpoch };
}
