/** Błąd renderowania po dopisaniu pytania nie może ponowić dostarczenia. */
import { textTurn } from '../mock/fake-llm-server.js';
import { chatFixture } from './_chat_fixture.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };

export default ({
  file: '61_blad_po_dopisaniu', name: 'błąd po dopisaniu pytania',
  opis: 'błąd renderowania po append nie powoduje ponownego dostarczenia',
  agent: 'Tester', autonomy: 'yolo', liveSkip: 'wymaga wstrzyknięcia błędu renderowania',
  offlineScript: () => textTurn('Tura kontrolna.'),
  async asserts({ plugin }: FixturePayload) {
    const registry = plugin.subTaskRegistry;
    const notifier = plugin.subTaskNotifier;
    const { view, window, events, errors } = chatFixture(plugin, origin);
    view.updateTokenCounter = () => { throw new Error('wstrzyknięty błąd renderowania'); };
    const task = registry.create({ id: 'render-error', threadId: 'render-thread', name: 'Sub', origin, background: true });
    try {
      const opened = registry.openParentQuestion(task.id, 'Jaki zakres?');
      assert(opened.kind === 'opened', 'Nie otwarto pytania.');
      await new Promise(resolve => setTimeout(resolve, 30));
      notifier.drain();
      await new Promise(resolve => setTimeout(resolve, 30));
      assert(events.length === 1 && errors.length === 1 && String(errors[0]).includes('wstrzyknięty błąd renderowania'),
        `Nie osiągnięto zapisu i błędu renderowania: ${JSON.stringify({ events, errors: errors.map(String) })}.`);
      assert(window.messages.filter((message: FixturePayload) => message.questionId === opened.question.id).length === 1,
        `Pytanie dopisano więcej niż raz: ${JSON.stringify(window.messages)}.`);
      assert(!notifier.pendingNotices().some((notice: FixturePayload) => notice.kind === 'question' && notice.question.id === opened.question.id),
        'Pytanie pozostało do ponownego dostarczenia.');
      assert(view._subTaskTurnPending === false, 'Rezerwacja dostarczenia nie została zwolniona.');
    } finally {
      notifier.setNoticeDeliverer(null);
      registry.requestStop(task.id, 'user');
    }
  },
} satisfies Scenario);
