/** Pytanie budzi prowadzącego, który odpowiada w automatycznej turze modelu. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
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
      state.question = state.window?.messages.find((m: FixturePayload) => m.questionId);
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
    const fixture = chatFixture(plugin, origin);
    state.window = fixture.window;
    const receipt = await plugin.mcpClient.executeToolCall(
      { id: 'question-answer', name: 'delegate', arguments: { task: TASK, background: true } }, 'Tester', { autonomy: 'yolo', origin });
    const id = receipt.task_id;
    assert(receipt.started === true && typeof id === 'string', `Brak pokwitowania: ${JSON.stringify(receipt)}.`);
    await until(() => registry.getTask(id)?.status !== 'running');
    const task = registry.getTask(id);
    await until(() => fixture.window.messages.some((m: FixturePayload) => m._subTaskNotification) && fixture.turns.active === 0);
    const meta = fixture.window.messages.find((m: FixturePayload) => m.questionId);
    assert(meta?.question === QUESTION && meta.name === 'pkm-sub' && meta.taskId === id && meta.subId === task.threadId && typeof meta.questionId === 'string', `Dane auto-tury: ${JSON.stringify(meta)}.`);
    assert([QUESTION, 'pkm-sub', task.threadId, meta.questionId].every(value => String(meta.content).includes(value)), `Treść auto-tury: ${meta.content}.`);
    assert(state.subRequests.length === 2 && lastToolResults(state.subRequests[1])[0] === ANSWER, `Odpowiedź suba: ${JSON.stringify(state.subRequests)}.`);
    assert(task.result?.text === RESULT && task.outcome?.end?.kind === 'finished', `Wynik: ${JSON.stringify(task.result)}.`);
    assert(fixture.window.messages.filter((m: FixturePayload) => m.questionId).length === 1 && fixture.errors.length === 0,
      `Wiadomości lub błędy: ${JSON.stringify({ messages: fixture.window.messages, errors: fixture.errors })}.`);
    assert(fixture.events.some((event: FixturePayload) => event.content?.includes(QUESTION)), 'Pytanie nie dotarło do zapisu sesji.');
    assert(fixture.window.messages.some((m: FixturePayload) => m._subTaskNotification) && fixture.turns.active === 0, 'Tura wyniku nie zakończyła się.');
    assert(!notifier.pendingNotices().some((n: FixturePayload) => n.kind === 'result' && n.task.id === id), 'Wynik nie został odebrany.');
    notifier.setNoticeDeliverer(null);
  },
} satisfies Scenario);
