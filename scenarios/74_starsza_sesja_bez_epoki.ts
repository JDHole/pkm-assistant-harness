import { AgentMemory } from '@plugin/modules/memory/index.js';
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { base, script, FILE, write, read, equal, observe, listed, persisted, toolResults, bounded } from './_drafts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const model = script();
const scenario = base('74_starsza_sesja_bez_epoki', 'starsza sesja dostaje trwałą epokę przed delegacją', model);
let mainCalls = 0, failedCalls = 0, retryCalls = 0;
export default ({ ...scenario,
  fixtures: [...scenario.fixtures!, { path: '.pkm-assistant/sub-agents/epoch-reader/SUB_AGENT.yaml',
    content: 'name: epoch-reader\ndescription: Odczyt bez kopii\nrole: researcher\ntools: [read]\nmax_iterations: 4\nenabled: true\n' }],
  offlineScript: async (ctx: FixturePayload) => {
    const has = (text: string) => ctx.request.messages.some((m: FixturePayload) => m.role === 'user' && m.content === text);
    if (has('P5 retry send')) return retryCalls++ === 0
      ? toolCallTurn('delegate', { task: 'P6-RETRY', aspect: 'worker' }, { callId: 'p5-retry' }) : textTurn('Ponowienie działa.');
    if (has('P5 failure send')) {
      const step = failedCalls++;
      if (step === 0) return toolCallTurn('delegate', { task: 'P6-READ', aspect: 'epoch-reader' }, { callId: 'p5-read' });
      if (step === 1) return toolCallTurn('delegate', { task: 'P6-DENIED', aspect: 'worker' }, { callId: 'p5-denied' });
      return textTurn('Rozmowa działa.');
    }
    if ((ctx.request.messages ?? []).some((m: FixturePayload) => m.role === 'user' && m.content === 'F1 legacy send')) {
      return mainCalls++ === 0 ? toolCallTurn('delegate', { task: 'P6-LEGACY', aspect: 'worker' }) : textTurn('Zlecono.');
    }
    return model.respond(ctx);
  },
  async asserts({ plugin }: FixturePayload) {
    mainCalls = failedCalls = retryCalls = 0;
    model.programs.set('LEGACY', [write(FILE, 'Szkic legacy'), read(FILE)]);
    const memory = plugin.agentManager.getAgentMemory('Tester');
    const path = `${memory.paths.sessionsActive}/legacy.md`;
    const header = '---\ntype: active_session\nagent: Tester\n---\n\nHistoria legacy\n';
    await plugin.app.vault.adapter.write(path, header);
    await memory.stateManager.addActiveSession('legacy.md');
    await memory.restoreActiveSession();
    equal(memory.activeSessionPath, path, 'Przywrócona starsza sesja');
    equal(memory.sessionEpoch, null, 'Przywrócenie samo nie migruje');
    const before = await plugin.app.vault.adapter.list(memory.paths.sessionsActive);
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
      const bytes = await plugin.app.vault.adapter.read(path);
      equal(bytes.startsWith(header), true, 'Niezmieniony prefiks legacy');
      equal(memory._parseFrontmatter(bytes).epoch, null, 'Epoka wyłącznie w dopisku');
      equal((bytes.match(/— session epoch/g) ?? []).length, 1, 'Jeden event epoki');
      equal(await plugin.app.vault.adapter.list(memory.paths.sessionsActive), before, 'Brak plików migracyjnych');
      const fresh = new AgentMemory(plugin.app.vault, 'Tester');
      equal((await fresh.loadActiveSession(path)).metadata.epoch, epoch, 'Epoka po odczycie pliku nową instancją');
      equal(chat.view.chatTabs[0].sessionEpoch, epoch, 'Tożsamość zakładki');
      equal(watcher.tasks.get('LEGACY')?.origin?.sessionEpoch, epoch, 'Zamrożony właściciel suba');
      const [change] = await listed(plugin);
      await persisted(plugin.app, change, 'Baza', 'Szkic legacy', 'pending');
    } finally { watcher.off(); }

    // Separate legacy session; fail only epoch append, keeping normal chat writes usable.
    const adapter = plugin.app.vault.adapter, append = adapter.append.bind(adapter);
    const failedPath = `${memory.paths.sessionsActive}/legacy-failure.md`;
    await adapter.write(failedPath, header);
    memory.setActiveSessionIdentity(failedPath, null);
    await plugin.agentManager.updateAgent('Tester', { sub_agents: [{ name: 'epoch-reader', role: 'researcher' }] });
    model.programs.set('READ', [read(FILE)]);
    model.programs.set('RETRY', [write(FILE, 'Szkic po ponowieniu'), read(FILE)]);
    const failedChat = chatFixture(plugin, { agentName: 'Tester', sessionPath: failedPath, sessionEpoch: null, tabKey: 'failure' });
    failedChat.view.plugin.agentManager = plugin.agentManager;
    failedChat.view.appendToActiveSession = (event: FixturePayload) => memory.appendToActiveSession(event);
    plugin.subTaskNotifier.setNoticeDeliverer(() => false);
    const filesBefore = await adapter.list(memory.paths.sessionsActive);
    const changesBefore = await listed(plugin);
    let attempts = 0;
    adapter.append = async (target: string, data: string) => {
      if (target === failedPath && data.includes('— session epoch')) { attempts++; throw new Error('EACCES epoch append'); }
      await append(target, data);
    };
    const failureWatcher = observe(plugin, ['READ', 'DENIED']);
    const retryWatcher = observe(plugin, ['RETRY']);
    try {
      await bounded(failedChat.view.send_message({ injectedText: 'P5 failure send', meta: { origin: 'human' } }), 'send po awarii epoki');
      await failureWatcher.done();
      equal(failedChat.errors, [], 'Awaria epoki nie blokuje prowadzącego');
      equal(failedChat.window.messages.at(-1)?.content, 'Rozmowa działa.', 'Odpowiedź prowadzącego');
      toolResults(model, 'READ', ['Baza']);
      const refused = failureWatcher.tasks.get('DENIED')!;
      equal(refused.status, 'error', 'Writer otrzymuje odmowę');
      equal(refused.error, 'Nie można przygotować kopii roboczej: nie udało się potwierdzić tożsamości tej rozmowy. Powód: Nie udało się dopisać identyfikatora rozmowy: EACCES epoch append. Możesz dalej rozmawiać i zlecać zadania tylko do odczytu.', 'Odmowa niesie powód');
      equal(refused.origin?.sessionEpochFailure, { kind: 'append-failed', detail: 'EACCES epoch append' }, 'Zamrożona przyczyna');
      equal(failureWatcher.tasks.get('READ')?.status, 'done', 'Sub odczytowy działa');
      equal([memory.sessionEpoch, failedChat.view.chatTabs[0].sessionEpoch], [null, null], 'Brak fikcyjnej epoki');
      equal(await listed(plugin), changesBefore, 'Odmowa nie tworzy kopii');
      equal((await adapter.read(failedPath)).startsWith(header), true, 'Prefiks po awarii');
      equal(await adapter.list(memory.paths.sessionsActive), filesBefore, 'Brak plików po awarii');
      adapter.append = append;
      await bounded(failedChat.view.send_message({ injectedText: 'P5 retry send', meta: { origin: 'human' } }), 'ponowienie send');
      await retryWatcher.done();
      equal(failedChat.errors, [], 'Ponowienie bez błędów czatu');
      equal(failedChat.window.messages.at(-1)?.content, 'Ponowienie działa.', 'Odpowiedź po ponowieniu');
      equal(attempts, 1, 'Jedna nieudana próba');
      const fresh = new AgentMemory(plugin.app.vault, 'Tester');
      equal((await fresh.loadActiveSession(failedPath)).metadata.epoch, memory.sessionEpoch, 'Trwała epoka ponowienia');
      equal(/^[0-9a-f]{32}$/.test(memory.sessionEpoch), true, 'Potwierdzona epoka');
      equal(retryWatcher.tasks.get('RETRY')?.origin?.sessionEpoch, memory.sessionEpoch, 'Owner ponowienia');
      equal(failedChat.view.chatTabs[0].sessionEpoch, memory.sessionEpoch, 'Zakładka ponowienia');
      toolResults(model, 'RETRY', ['Szkic po ponowieniu']);
      const change = (await listed(plugin)).find(item => item.run_id === retryWatcher.tasks.get('RETRY')?.id)!;
      await persisted(plugin.app, change, 'Baza', 'Szkic po ponowieniu', 'pending');
      const bytes = await adapter.read(failedPath);
      equal(bytes.startsWith(header), true, 'Prefiks po ponowieniu');
      equal((bytes.match(/— session epoch/g) ?? []).length, 1, 'Jeden event po ponowieniu');
      equal(await adapter.list(memory.paths.sessionsActive), filesBefore, 'Brak plików po ponowieniu');
      equal(await adapter.read(FILE), 'Baza', 'Vault nie zmieniony po ponowieniu');
    } finally { adapter.append = append; failureWatcher.off(); retryWatcher.off(); }
  },
} satisfies Scenario);
