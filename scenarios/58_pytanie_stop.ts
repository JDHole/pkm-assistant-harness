/** Stop w trakcie pytania suba zachowuje dorobek i nie budzi prowadzącego. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { _deliverSubTaskQuestion, _deliverSubTaskResult } from '@plugin/modules/chat/chat/chat_streaming.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const QUESTION = 'Jaki zakres mam przyjąć?';
const TASK = 'Przeczytaj powitanie i zapytaj o zakres.';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state = { requests: 0 };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

export default ({
  file: '58_pytanie_stop', name: 'Stop w czasie pytania suba',
  opis: 'Stop podczas ask_parent zachowuje pytanie i dorobek bez auto-tury',
  agent: 'Tester', autonomy: 'yolo', approve: 'auto', maxIterations: 2,
  liveSkip: 'wymaga deterministycznego pytania i Stopu',
  async setup({ plugin }: FixturePayload) {
    state.requests = 0;
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },
  offlineScript: (ctx: FixturePayload) => {
    const messages = JSON.stringify(ctx.request?.messages || []);
    if (!messages.includes(TASK)) return textTurn('Tura kontrolna zakończona.');
    state.requests++;
    return lastToolResults(ctx.request).length === 0
      ? toolCallTurn('read', { path: 'Notatki/powitanie.md' })
      : toolCallTurn('ask_parent', { text: QUESTION });
  },
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    const receipt = await plugin.mcpClient.executeToolCall(
      { id: 'question-stop', name: 'delegate', arguments: { task: TASK, background: true } },
      'Tester', { autonomy: 'yolo', origin },
    );
    const id = receipt.task_id;
    assert(receipt.started === true && typeof id === 'string', `Brak pokwitowania: ${JSON.stringify(receipt)}.`);
    await until(() => registry.getQuestionState(id).kind === 'waiting');
    const task = registry.getTask(id);
    const question = registry.getQuestionState(id);
    assert(question.kind === 'waiting' && question.question.text === QUESTION, `Brak pytania: ${JSON.stringify(question)}.`);
    assert(state.requests === 2, `Liczba zapytań suba przed Stopem: ${state.requests}.`);
    const sent: FixturePayload[] = [];
    const tab = { ...origin, sessionId: origin.tabKey, isActive: true };
    const view: FixturePayload = { chatTabs: [tab], rollingWindow: { messages: [] }, _autoTurnChainCounts: new Map(),
      _subTaskTurnPending: false, is_generating: false, _drainSuppressed: true,
      env: plugin.env, plugin, send_message: (message: FixturePayload) => sent.push(message) };
    assert(registry.requestStop(id, 'user') === true, 'Stop nie został przyjęty.');
    await until(() => task.status !== 'running');
    assert(task.status !== 'running', 'Bieg wisi po Stopie.');
    assert(task.result?.outcome?.end?.kind === 'stopped' && task.result.outcome.end.by === 'user', `Outcome: ${JSON.stringify(task.result)}.`);
    assert(task.result?.question?.text === QUESTION && task.result.question.resolution.kind === 'cancelled'
      && task.result.question.resolution.by === 'user' && task.result.question.resolution.reason === 'stop', `Pytanie w wyniku: ${JSON.stringify(task.result)}.`);
    assert(String(task.result?.text).includes('Powitanie'), `Brak dorobku: ${JSON.stringify(task.result)}.`);
    assert(state.requests === 2, `Po Stopie wysłano kolejne zapytanie modelu: ${state.requests}.`);
    assert(_deliverSubTaskQuestion.call(view, question.question) === false && _deliverSubTaskResult.call(view, task) === false,
      'Stop nie zablokował automatycznego dostarczenia.');
    await Promise.resolve();
    assert(sent.length === 0, `Po Stopie uruchomiono auto-turę: ${JSON.stringify(sent)}.`);
  },
} satisfies Scenario);
