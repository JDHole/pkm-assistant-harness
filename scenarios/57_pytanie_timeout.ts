/** Pięć minut oczekiwania mierzone zegarem protokołu, bez rzeczywistego oczekiwania. */
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const TASK = 'Odczytaj powitanie i zapytaj o brakujący zakres.';
const QUESTION = 'Który zakres wybrać?';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state = { requests: 0 };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await wait(10);
}

export default ({
  file: '57_pytanie_timeout', name: 'brak odpowiedzi na pytanie suba',
  opis: 'po 300000 ms sub kończy pracę częściowym wynikiem bez syntezy',
  agent: 'Tester', autonomy: 'yolo', approve: 'auto', maxIterations: 2,
  liveSkip: 'wymaga sterowanego zegara pytania',
  async setup({ plugin }: FixturePayload) {
    state.requests = 0;
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },
  offlineScript: (ctx: FixturePayload) => {
    if (!JSON.stringify(ctx.request?.messages || []).includes(TASK)) return textTurn('Tura kontrolna zakończona.');
    state.requests++;
    return lastToolResults(ctx.request).length === 0
      ? toolCallTurn('read', { path: 'Notatki/powitanie.md' })
      : toolCallTurn('ask_parent', { text: QUESTION });
  },
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    // Produkcyjny ParentQuestions przyjmuje zegar przez konstruktor rejestru. Plugin już
    // zbudował rejestr, więc podmieniamy tylko jego zegar przed otwarciem pytania.
    const questions = registry._questions;
    const original = questions.clock;
    let now = 0;
    let callback: (() => void) | undefined;
    let delay = -1;
    questions.clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => { callback = fn; delay = ms; return 1; },
      clearTimeout: () => { callback = undefined; } };
    try {
      const receipt = await plugin.mcpClient.executeToolCall(
        { id: 'question-timeout', name: 'delegate', arguments: { task: TASK, background: true } },
        'Tester', { autonomy: 'yolo', origin },
      );
      const id = receipt.task_id;
      assert(receipt.started === true && typeof id === 'string', `Brak pokwitowania: ${JSON.stringify(receipt)}.`);
      await until(() => registry.getQuestionState(id).kind === 'waiting');
      const task = registry.getTask(id);
      assert(registry.getQuestionState(id).question?.text === QUESTION && delay === 300000 && callback,
        `Pytanie lub timer nie powstały: ${JSON.stringify(registry.getQuestionState(id))}, delay=${delay}.`);
      now = 299999;
      assert(registry.getQuestionState(id).kind === 'waiting', 'Pytanie wygasło przed pięcioma minutami.');
      now = 300000;
      callback!();
      await until(() => task.status !== 'running');
      assert(task.status !== 'running', 'Bieg nie zakończył się po wygaśnięciu.');
      assert(task.result?.question?.text === QUESTION && task.result.question.resolution.kind === 'no-answer', `Pytanie w wyniku: ${JSON.stringify(task.result)}.`);
      assert(String(task.result?.text).includes(QUESTION) && String(task.result?.text).includes('Powitanie'), `Brak pytania lub dorobku: ${JSON.stringify(task.result)}.`);
      assert(task.result?.outcome?.completeness === 'partial' && task.partial?.synthesis === 'skipped', `Wynik częściowy: ${JSON.stringify({ result: task.result, partial: task.partial })}.`);
      assert(state.requests === 2, `Liczba zapytań modelu po wygaśnięciu: ${state.requests}, oczekiwano 2.`);
    } finally {
      questions.clock = original;
    }
  },
} satisfies Scenario);
