/** Błąd renderowania po dopisaniu pytania nie może ponowić dostarczenia. */
import { textTurn } from '../mock/fake-llm-server.js';
import { RollingWindow } from '@plugin/modules/chat/chat/RollingWindow.js';
import { append_message } from '@plugin/modules/chat/chat/chat_messages.js';
import { _deliverSubTaskQuestion, send_message } from '@plugin/modules/chat/chat/chat_streaming.js';
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
    const window = new RollingWindow();
    const tab = { ...origin, sessionId: origin.tabKey, isActive: true };
    const agentManager = { getActiveAgent: () => ({ name: 'Tester' }),
      getAgentMemory: () => ({ activeSessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch }) };
    const view: FixturePayload = {
      chatTabs: [tab], rollingWindow: window, plugin: { subTaskRegistry: registry, subTaskNotifier: notifier, agentManager },
      env: plugin.env, _autoTurnChainCounts: new Map(), _preparingTurns: new Map(),
      _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false,
      append_message: (...args: FixturePayload[]) => append_message.call(view, ...args as [any, any, any, any]),
      updateTokenCounter: () => { throw new Error('wstrzyknięty błąd renderowania'); },
      send_message: (opts: FixturePayload) => send_message.call(view, opts),
    };
    notifier.setNoticeDeliverer((notice: FixturePayload) => notice.kind === 'question'
      ? _deliverSubTaskQuestion.call(view, notice.question) : false);
    const task = registry.create({ id: 'render-error', threadId: 'render-thread', name: 'Sub', origin, background: true });
    try {
      const opened = registry.openParentQuestion(task.id, 'Jaki zakres?');
      assert(opened.kind === 'opened', 'Nie otwarto pytania.');
      await new Promise(resolve => setTimeout(resolve, 30));
      notifier.drain();
      await new Promise(resolve => setTimeout(resolve, 30));
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
