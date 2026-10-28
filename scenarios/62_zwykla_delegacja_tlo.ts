import { textTurn } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
const taskText = 'Zwykła praca w tle bez pytania.';
const resultText = 'Zwykły wynik w tle.';
export default ({
  file: '62_zwykla_delegacja_tlo', name: 'zwykła delegacja w tle', opis: 'wynik bez pytań budzi prowadzącego',
  agent: 'Tester', autonomy: 'yolo', liveSkip: 'wymaga sterowanej delegacji',
  offlineScript: (ctx: FixturePayload) => textTurn(JSON.stringify(ctx.request?.messages).includes(taskText) ? resultText : 'Gotowe.'),
  async asserts({ plugin }: FixturePayload) {
    const f = chatFixture(plugin, origin);
    try {
      const receipt = await plugin.mcpClient.executeToolCall({ id: 'ordinary-background', name: 'delegate', arguments: { task: taskText, background: true } }, 'Tester', { autonomy: 'yolo', origin });
      assert(receipt.started && receipt.task_id, `Brak pokwitowania: ${JSON.stringify(receipt)}`);
      const deadline = Date.now() + 8000;
      while ((!f.window.messages.some((m: FixturePayload) => m._subTaskNotification) || f.turns.active) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      const task = plugin.subTaskRegistry.getTask(receipt.task_id);
      assert(task?.result?.text === resultText, `Wynik: ${JSON.stringify(task?.result)}`);
      assert(f.window.messages.filter((m: FixturePayload) => m._subTaskNotification).length === 1 && !f.view.is_generating && !f.errors.length, 'Wynik nie dotarł do jednej zakończonej tury.');
      assert(!f.window.messages.some((m: FixturePayload) => m.questionId), 'Pojawiło się niezamówione pytanie.');
    } finally { plugin.subTaskNotifier.setNoticeDeliverer(null); }
  },
} satisfies Scenario);
