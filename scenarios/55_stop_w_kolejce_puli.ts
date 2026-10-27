/** Kolejka puli delegacji: Stop przed startem i odmowa inicjalizacji. */
import { textTurn } from '../mock/fake-llm-server.js';
import { assert } from './_asserts.js';
// Czat nie ma barrelowego API doręczenia; testujemy jego rzeczywisty punkt wejścia.
import { _deliverSubTaskResult } from '@plugin/modules/chat/chat/chat_streaming.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FIRST = 'Pierwsze zadanie puli czeka na zwolnienie.';
const SECOND = 'Drugie zadanie puli oczekuje na start.';
const ANSWER = 'Pierwsze zadanie puli zakończone.';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state: { held: boolean; release: (() => void) | null; first: number; second: number } =
  { held: false, release: null, first: 0, second: 0 };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

async function probe(plugin: FixturePayload, failure: boolean): Promise<void> {
  Object.assign(state, { held: false, release: null, first: 0, second: 0 });
  const receipt = await plugin.mcpClient.executeToolCall({ id: failure ? 'pool-failure' : 'pool-stop', name: 'delegate',
    arguments: { tasks: [{ task: FIRST }, { task: SECOND }] } }, 'Tester', { autonomy: 'yolo', origin });
  assert(receipt?.started === true && receipt.tasks?.length === 2 && receipt.queued === 1,
    `Pokwitowanie puli: ${JSON.stringify(receipt)}.`);
  const [firstId, secondId] = receipt.tasks.map((item: FixturePayload) => item.sub_id);
  assert(typeof firstId === 'string' && typeof secondId === 'string' && firstId !== secondId
    && receipt.tasks[1].queued === true, `Brak adresów obu wątków: ${JSON.stringify(receipt)}.`);
  const registry = plugin.subTaskRegistry;
  await until(() => state.held);
  assert(state.held && state.first === 1 && state.second === 0 && registry.getThread(secondId)?.phase === 'queued',
    `Zadania nie znalazły się w puli: ${JSON.stringify({ ...state, thread: registry.getThread(secondId) })}.`);
  const providers = plugin.env.config.chat.providers;
  try {
    if (failure) plugin.env.config.chat.providers = {};
    else assert(registry.closeThread(secondId, 'user') === true, 'Stop nie zamknął wątku oczekującego.');
    state.release?.();
    state.release = null;
    await until(() => Boolean(registry.getTask(firstId)?.outcome && registry.getTask(secondId)?.outcome));
    const first = registry.getTask(firstId);
    const second = registry.getTask(secondId);
    const thread = registry.getThread(secondId);
    const evidence = JSON.stringify({ first, second, thread, requests: { first: state.first, second: state.second } });
    assert(state.first === 1 && state.second === 0, `Nieprawidłowe zapytania modelu: ${evidence}.`);
    assert(first?.outcome?.end?.kind === 'finished' && first.result?.text === ANSWER, `Pierwszy wynik: ${evidence}.`);
    assert(thread?.runIds?.length === 1 && thread.runIds[0] === second?.id, `Brak biegu w wątku: ${evidence}.`);
    if (failure) {
      assert(second?.status === 'error' && second.outcome?.end?.kind === 'failed'
        && second.outcome.end.stage === 'work' && second.error === 'Brak dostępnego modelu AI dla sub-agenta',
      `Odmowa nie zachowała przyczyny: ${evidence}.`);
    } else {
      assert(second?.outcome?.end?.kind === 'stopped' && second.outcome.end.by === 'user'
        && second.outcome.completeness === 'empty', `Wynik Stopu: ${evidence}.`);
      for (const otherPath of [origin.sessionPath, 'Chats/other.md']) {
        const sent: FixturePayload[] = [];
        const owner = { ...origin, sessionId: origin.tabKey, isActive: false };
        const other = { ...origin, sessionPath: otherPath, sessionId: 'other', isActive: true };
        const view: FixturePayload = { chatTabs: [other, owner], _autoTurnChainCounts: new Map(),
          _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
          env: plugin.env, plugin, send_message: (message: FixturePayload) => sent.push(message) };
        assert(_deliverSubTaskResult.call(view, second) === false, 'Wynik doręczono do obcej aktywnej zakładki.');
        await Promise.resolve();
        assert(sent.length === 0, `Obca zakładka otrzymała wynik: ${JSON.stringify(sent)}.`);
        owner.isActive = true;
        other.isActive = false;
        assert(_deliverSubTaskResult.call(view, second) === true, 'Nie doręczono wyniku właścicielowi.');
        await Promise.resolve();
        assert(Number(sent.length) === 1 && sent[0].meta?._subTaskResult?.outcome?.end?.kind === 'stopped'
          && sent[0].meta._subTaskResult.outcome.end.by === 'user'
          && typeof sent[0].injectedText === 'string' && /użytkownik/i.test(sent[0].injectedText),
        `Doręczenie nie opisuje Stopu użytkownika: ${JSON.stringify(sent)}.`);
      }
    }
  } finally {
    plugin.env.config.chat.providers = providers;
    state.release?.();
    state.release = null;
  }
}

export default ({
  file: '55_stop_w_kolejce_puli', name: 'Stop w kolejce puli delegacji',
  opis: 'Stop i odmowa zadania oczekującego na slot puli', agent: 'Tester', autonomy: 'yolo',
  approve: 'auto', maxIterations: 2, liveSkip: 'wymaga przytrzymania pierwszego zadania puli',
  async setup({ plugin }: FixturePayload) {
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_parallel_delegations = 2;
    limits.local_platform_max_concurrent = 1;
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
    const settings = plugin.env.settings.pkmAssistant;
    settings.modelLibrary.researcher = [{ platform: 'lm_studio', model: 'harness', isDefault: true }];
    settings.modelLibrary.minion = [{ platform: 'lm_studio', model: 'harness', isDefault: true }];
  },
  offlineScript: async (ctx: FixturePayload) => {
    const messages = JSON.stringify(ctx.request?.messages || []);
    if (messages.includes(FIRST)) {
      state.first++;
      state.held = true;
      await new Promise<void>(resolve => { state.release = resolve; });
      return textTurn(ANSWER);
    }
    if (messages.includes(SECOND)) { state.second++; return textTurn('Nieoczekiwany start.'); }
    return textTurn('Tura kontrolna zakończona.');
  },
  async asserts({ plugin }: FixturePayload) {
    await probe(plugin, false);
    await probe(plugin, true);
  },
} satisfies Scenario);
