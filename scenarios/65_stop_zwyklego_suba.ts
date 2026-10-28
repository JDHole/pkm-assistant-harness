import { textTurn } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
const taskText = 'Zwykła praca przerwana przyciskiem Stop.';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const state: FixturePayload = { entered: false, release: null };
export default ({
  file: '65_stop_zwyklego_suba', name: 'Stop zwykłego suba', opis: 'Stop bez pytania nie budzi prowadzącego',
  agent: 'Tester', autonomy: 'yolo', liveSkip: 'wymaga zatrzymania odpowiedzi modelu',
  setup() { state.entered = false; state.release = null; },
  async offlineScript(ctx: FixturePayload) {
    if (!JSON.stringify(ctx.request?.messages).includes(taskText)) return textTurn('Tura kontrolna.');
    state.entered = true;
    await new Promise<void>(resolve => { state.release = resolve; });
    return textTurn('Wynik po Stopie.');
  },
  async asserts({ plugin }: FixturePayload) {
    const f = chatFixture(plugin, origin);
    try {
      const receipt = await plugin.mcpClient.executeToolCall({ id: 'ordinary-stop', name: 'delegate', arguments: { task: taskText, background: true } }, 'Tester', { autonomy: 'yolo', origin });
      const task = plugin.subTaskRegistry.getTask(receipt.task_id);
      assert(receipt.started && task, `Brak taska: ${JSON.stringify(receipt)}.`);
      const deadline = Date.now() + 8000;
      while (!state.entered && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert(state.entered, 'Sub nie rozpoczął żądania.');
      assert(plugin.subTaskRegistry.requestStop(task.id, 'user'), 'Stop nie został przyjęty.');
      state.release(); state.release = null;
      while (task.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 50));
      assert(task.result?.outcome?.end?.kind === 'stopped' && task.result.outcome.end.by === 'user', `Outcome: ${JSON.stringify(task.result)}.`);
      assert(f.window.messages.length === 0 && !f.view.is_generating && !f.errors.length, `Stop uruchomił turę: ${JSON.stringify(f.window.messages)}.`);
      assert(!task.result?.question, 'Zwykły sub ma niezamówione pytanie.');
    } finally { state.release?.(); plugin.subTaskNotifier.setNoticeDeliverer(null); }
  },
} satisfies Scenario);
