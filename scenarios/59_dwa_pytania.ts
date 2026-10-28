/** Dwa pytania w tle: adresowanie odpowiedzi i serializacja tur prowadzącego. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const tasks = ['Zadanie Alfa: zapytaj o kolor.', 'Zadanie Beta: zapytaj o liczbę.'];
const questions = ['Jaki kolor dla Alfy?', 'Jaka liczba dla Bety?'];
const answers = ['Kolor zielony.', 'Liczba siedem.'];
const results = ['Alfa jest zielona.', 'Beta ma siedem.'];
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state: FixturePayload = { activeMeta: null, requests: [[], []], turns: [], active: 0, max: 0 };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

export default ({
  file: '59_dwa_pytania', name: 'dwa pytania subów',
  opis: 'odpowiedzi trafiają do właściwych subów, auto-tury nie nakładają się',
  agent: 'Tester', autonomy: 'yolo', approve: 'auto', maxIterations: 2,
  liveSkip: 'wymaga jednoczesnych pytań i sterowanych odpowiedzi',
  async setup({ plugin }: FixturePayload) {
    Object.assign(state, { activeMeta: null, requests: [[], []], turns: [], active: 0, max: 0, bothWaiting: false });
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    limits.max_parallel_delegations = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },
  offlineScript: (ctx: FixturePayload) => {
    const messages = JSON.stringify(ctx.request?.messages || []);
    const sub = tasks.findIndex(task => messages.includes(task));
    if (sub >= 0) {
      state.requests[sub].push(ctx.request);
      return lastToolResults(ctx.request).length === 0 ? toolCallTurn('ask_parent', { text: questions[sub] }) : textTurn(results[sub]);
    }
    const lastUser = [...(ctx.request?.messages || [])].reverse().find((m: FixturePayload) => m.role === 'user');
    const q = questions.findIndex(question => String(lastUser?.content).includes(question));
    state.activeMeta = state.window?.messages.find((m: FixturePayload) => m.question === questions[q]);
    const userIndex = (ctx.request?.messages || []).lastIndexOf(lastUser);
    const currentToolResult = (ctx.request?.messages || []).slice(userIndex + 1).some((m: FixturePayload) => m.role === 'tool');
    if (q >= 0) return !currentToolResult
      ? toolCallTurn('sub_agent', { action: 'message', sub_id: state.activeMeta.subId, question_id: state.activeMeta.questionId, text: answers[q] })
      : textTurn('Odpowiedź wysłana.');
    return textTurn('Tura kontrolna zakończona.');
  },
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    const notifier = plugin.subTaskNotifier;
    const fixture = chatFixture(plugin, origin, async () => {
      if (state.bothWaiting) return;
      await until(() => registry.list().filter((t: FixturePayload) => registry.getQuestionState(t.id).kind === 'waiting').length === 2);
      state.bothWaiting = registry.list().filter((t: FixturePayload) => registry.getQuestionState(t.id).kind === 'waiting').length === 2;
    });
    state.window = fixture.window;
    const receipts = await Promise.all(tasks.map((task, i) => plugin.mcpClient.executeToolCall(
      { id: `parallel-${i}`, name: 'delegate', arguments: { task, background: true } }, 'Tester', { autonomy: 'yolo', origin })));
    assert(receipts.every((r: FixturePayload) => r.started && typeof r.task_id === 'string'), `Pokwitowania: ${JSON.stringify(receipts)}.`);
    await until(() => receipts.every((r: FixturePayload) => registry.getTask(r.task_id)?.status !== 'running') && fixture.turns.completed === 2 && fixture.turns.active === 0);
    state.turns = fixture.window.messages.filter((m: FixturePayload) => m.questionId);
    assert(state.bothWaiting && state.turns.length === 2 && fixture.turns.completed === 2 && fixture.turns.maxQuestions === 1 && fixture.errors.length === 0, `Auto-tury: ${JSON.stringify({ turns: state.turns, counts: fixture.turns, bothWaiting: state.bothWaiting, errors: fixture.errors })}.`);
    for (let i = 0; i < 2; i++) {
      const task = registry.getTask(receipts[i].task_id);
      const meta = state.turns.find((m: FixturePayload) => m.question === questions[i]);
      assert(meta?.subId === task.threadId && state.requests[i].length === 2 && lastToolResults(state.requests[i][1])[0] === answers[i]
        && task.result?.text === results[i], `Błędna odpowiedź dla ${tasks[i]}: ${JSON.stringify({ meta, task, requests: state.requests[i] })}.`);
    }
    notifier.setNoticeDeliverer(null);
  },
} satisfies Scenario);
