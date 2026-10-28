/** Kontynuacja blokująca oddaje pytanie i promuje żywy bieg do tła. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FIRST = 'Przygotuj wątek do dalszej pracy.';
const NEXT = 'Kontynuuj i zapytaj o zakres.';
const QUESTION = 'Który projekt wybrać?';
const ANSWER = 'Projekt Alfa.';
const RESULT = 'Wybrałem projekt Alfa.';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state: FixturePayload = { continued: [] };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

export default ({
  file: '60_pytanie_blokujace', name: 'pytanie w delegacji blokującej',
  opis: 'blokująca kontynuacja zwraca pytanie, wynik wraca z tła',
  agent: 'Tester', autonomy: 'yolo', approve: 'auto', maxIterations: 2,
  liveSkip: 'wymaga blokującej kontynuacji i odpowiedzi na pytanie',
  async setup({ plugin }: FixturePayload) {
    state.continued = [];
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },
  offlineScript: (ctx: FixturePayload) => {
    const messages = JSON.stringify(ctx.request?.messages || []);
    if (messages.includes(NEXT)) {
      state.continued.push(ctx.request);
      return lastToolResults(ctx.request).length === 0 ? toolCallTurn('ask_parent', { text: QUESTION }) : textTurn(RESULT);
    }
    return textTurn(messages.includes(FIRST) ? 'Wątek gotowy.' : 'Tura kontrolna zakończona.');
  },
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    const execute = (id: string, name: string, args: FixturePayload) => plugin.mcpClient.executeToolCall(
      { id, name, arguments: args }, 'Tester', { autonomy: 'yolo', origin });
    const first = await execute('first', 'delegate', { task: FIRST });
    assert(first.started === true && typeof first.sub_id === 'string', `Pokwitowanie: ${JSON.stringify(first)}.`);
    await until(() => registry.getThread(first.sub_id)?.phase === 'idle');
    assert(registry.getThread(first.sub_id)?.phase === 'idle', 'Pierwszy bieg nie zakończył się.');
    const receipt = await execute('blocking', 'sub_agent', { action: 'task', sub_id: first.sub_id, task: NEXT, background: false });
    assert(receipt.kind === 'question' && receipt.question === QUESTION && receipt.sub_id === first.sub_id
      && typeof receipt.question_id === 'string' && receipt.started === true, `Blokujące pokwitowanie: ${JSON.stringify(receipt)}.`);
    const task = registry.getTask(receipt.task_id);
    assert(task?.background === true && task.status === 'running', `Pytający bieg nie przeszedł do tła: ${JSON.stringify(task)}.`);
    const answer = await execute('answer', 'sub_agent', { action: 'message', sub_id: first.sub_id, question_id: receipt.question_id, text: ANSWER });
    assert(answer.success === true, `Odpowiedź odrzucona: ${JSON.stringify(answer)}.`);
    await until(() => task.status !== 'running');
    assert(task.result?.text === RESULT && state.continued.length === 2 && lastToolResults(state.continued[1])[0] === ANSWER,
      `Kontynuacja: ${JSON.stringify({ result: task.result, requests: state.continued })}.`);
    assert(plugin.subTaskNotifier.pending().filter((item: FixturePayload) => item.id === task.id).length === 1,
      `Wynik nie czeka dokładnie raz w tle: ${JSON.stringify(plugin.subTaskNotifier.pending())}.`);
  },
} satisfies Scenario);
