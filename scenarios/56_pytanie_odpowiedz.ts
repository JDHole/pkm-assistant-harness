/** Pytanie budzi prowadzącego, który odpowiada w automatycznej turze modelu. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { runExploratoryTurn } from '../lib/runTurn.js';
import { _deliverSubTaskQuestion, _deliverSubTaskResult } from '@plugin/modules/chat/chat/chat_streaming.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const TASK = 'Sprawdź brakujący zakres i przygotuj wynik.';
const QUESTION = 'Jaki zakres wybrać?';
const ANSWER = 'Zakres to projekt Alfa.';
const RESULT = 'Wynik dla projektu Alfa.';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state: FixturePayload = { question: null, subRequests: [], auto: [] };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

export default ({
  file: '56_pytanie_odpowiedz', name: 'odpowiedź na pytanie suba',
  opis: 'pytanie z tła budzi prowadzącego i odpowiedź wraca w tym samym wątku',
  agent: 'Tester', autonomy: 'yolo', approve: 'auto', maxIterations: 2,
  liveSkip: 'wymaga skryptu suba i automatycznej odpowiedzi prowadzącego',
  async setup({ plugin }: FixturePayload) {
    Object.assign(state, { question: null, subRequests: [], auto: [] });
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },
  offlineScript: (ctx: FixturePayload) => {
    const messages = JSON.stringify(ctx.request?.messages || []);
    if (messages.includes(TASK)) {
      state.subRequests.push(ctx.request);
      return lastToolResults(ctx.request).length === 0
        ? toolCallTurn('ask_parent', { text: QUESTION }) : textTurn(RESULT);
    }
    if (messages.includes(QUESTION)) {
      if (lastToolResults(ctx.request).length === 0) return toolCallTurn('sub_agent', {
        action: 'message', sub_id: state.question.subId, question_id: state.question.questionId, text: ANSWER,
      });
      return textTurn('Odpowiedziałem subowi.');
    }
    return textTurn('Tura kontrolna zakończona.');
  },
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    const notifier = plugin.subTaskNotifier;
    const tab = { ...origin, sessionId: origin.tabKey, isActive: true };
    const window = { messages: [] as FixturePayload[] };
    const agentManager = { getActiveAgent: () => ({ name: 'Tester' }), getAgentMemory: () => ({ activeSessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch }) };
    const view: FixturePayload = { chatTabs: [tab], rollingWindow: window, plugin: { subTaskRegistry: registry, subTaskNotifier: notifier, agentManager },
      env: plugin.env, _autoTurnChainCounts: new Map(), _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
      send_message: async (opts: FixturePayload) => {
        state.auto.push(opts);
        if (opts.questionDelivery) {
          state.question = opts.meta;
          window.messages.push(opts.meta);
          opts.questionDelivery.claim.ack();
          await runExploratoryTurn(plugin, { agentName: 'Tester', prompt: opts.injectedText, autonomy: 'yolo', origin, awaitSubTasks: false });
        }
      } };
    notifier.setNoticeDeliverer((notice: FixturePayload) => notice.kind === 'question'
      ? _deliverSubTaskQuestion.call(view, notice.question) : _deliverSubTaskResult.call(view, notice.task));
    const receipt = await plugin.mcpClient.executeToolCall(
      { id: 'question-answer', name: 'delegate', arguments: { task: TASK, background: true } }, 'Tester', { autonomy: 'yolo', origin });
    const id = receipt.task_id;
    assert(receipt.started === true && typeof id === 'string', `Brak pokwitowania: ${JSON.stringify(receipt)}.`);
    await until(() => registry.getTask(id)?.status !== 'running');
    const task = registry.getTask(id);
    await until(() => state.auto.length >= 2);
    const meta = state.question;
    assert(meta?.question === QUESTION && meta.name === 'pkm-sub' && meta.taskId === id && meta.subId === task.threadId && typeof meta.questionId === 'string', `Dane auto-tury: ${JSON.stringify(meta)}.`);
    assert([QUESTION, 'pkm-sub', task.threadId, meta.questionId].every(value => state.auto[0].injectedText.includes(value)), `Treść auto-tury: ${state.auto[0].injectedText}.`);
    assert(state.subRequests.length === 2 && lastToolResults(state.subRequests[1])[0] === ANSWER, `Odpowiedź suba: ${JSON.stringify(state.subRequests)}.`);
    assert(task.result?.text === RESULT && task.outcome?.end?.kind === 'finished', `Wynik: ${JSON.stringify(task.result)}.`);
    assert(state.auto.filter((x: FixturePayload) => x.meta?.questionId).length === 1 && state.auto.length === 2,
      `Liczba auto-tur pytania i wyniku: ${state.auto.length}.`);
    assert(!notifier.pendingNotices().some((n: FixturePayload) => n.kind === 'result' && n.task.id === id), 'Wynik nie został odebrany.');
    notifier.setNoticeDeliverer(null);
  },
} satisfies Scenario);
