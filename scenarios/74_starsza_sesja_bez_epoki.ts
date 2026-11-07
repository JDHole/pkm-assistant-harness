import { AgentMemory } from '@plugin/modules/memory/index.js';
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { base, script, FILE, write, read, equal, observe, listed, persisted, toolResults, bounded } from './_drafts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const model = script();
const scenario = base('74_starsza_sesja_bez_epoki', 'starsza sesja dostaje trwałą epokę przed delegacją', model);
let mainCalls = 0;
export default ({ ...scenario,
  offlineScript: async (ctx: FixturePayload) => {
    if ((ctx.request.messages ?? []).some((m: FixturePayload) => m.role === 'user' && m.content === 'F1 legacy send')) {
      return mainCalls++ === 0 ? toolCallTurn('delegate', { task: 'P6-LEGACY', aspect: 'worker' }) : textTurn('Zlecono.');
    }
    return model.respond(ctx);
  },
  async asserts({ plugin }: FixturePayload) {
    mainCalls = 0;
    model.programs.set('LEGACY', [write(FILE, 'Szkic legacy'), read(FILE)]);
    const memory = plugin.agentManager.getAgentMemory('Tester');
    const path = `${memory.paths.sessionsActive}/legacy.md`;
    const header = '---\ntype: active_session\nagent: Tester\n---\n\nHistoria legacy\n';
    await plugin.app.vault.adapter.write(path, header);
    await memory.stateManager.addActiveSession('legacy.md');
    await memory.restoreActiveSession();
    equal(memory.activeSessionPath, path, 'Przywrócona starsza sesja');
    equal(memory.sessionEpoch, null, 'Przywrócenie samo nie migruje');
    const origin = { agentName: 'Tester', sessionPath: path, sessionEpoch: null, tabKey: 'legacy' };
    const chat = chatFixture(plugin, origin);
    chat.view.plugin.agentManager = plugin.agentManager;
    chat.view.appendToActiveSession = (event: FixturePayload) => memory.appendToActiveSession(event);
    plugin.subTaskNotifier.setNoticeDeliverer(() => false);
    const watcher = observe(plugin, ['LEGACY']);
    try {
      await bounded(chat.view.send_message({ injectedText: 'F1 legacy send', meta: { origin: 'human' } }), 'send_message legacy');
      await watcher.done();
      equal(chat.errors, [], 'Brak błędów czatu');
      equal(watcher.tasks.get('LEGACY')?.status, 'done', 'Piszący worker starszej sesji');
      equal(await plugin.app.vault.adapter.read(FILE), 'Baza', 'Vault nie zmieniony');
      toolResults(model, 'LEGACY', ['Szkic legacy']);
      const epoch = memory.sessionEpoch;
      equal(/^[0-9a-f]{32}$/.test(epoch), true, 'Poprawna epoka');
      const fresh = new AgentMemory(plugin.app.vault, 'Tester');
      equal((await fresh.loadActiveSession(path)).metadata.epoch, epoch, 'Epoka po odczycie pliku nową instancją');
      equal(chat.view.chatTabs[0].sessionEpoch, epoch, 'Tożsamość zakładki');
      equal(watcher.tasks.get('LEGACY')?.origin?.sessionEpoch, epoch, 'Zamrożony właściciel suba');
      const [change] = await listed(plugin);
      await persisted(plugin.app, change, 'Baza', 'Szkic legacy', 'pending');
    } finally { watcher.off(); }
  },
} satisfies Scenario);
