import { textTurn } from '../mock/fake-llm-server.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
const first = 'Utwórz wątek bez pytania.';
const next = 'Wykonaj blokującą kontynuację bez pytania.';
export default ({
  file: '63_zwykla_delegacja_blokujaca', name: 'zwykła delegacja blokująca', opis: 'blokująca kontynuacja zwraca wynik',
  agent: 'Tester', autonomy: 'yolo', liveSkip: 'wymaga sterowanej kontynuacji',
  offlineScript: (ctx: FixturePayload) => textTurn(JSON.stringify(ctx.request?.messages).includes(next) ? 'Wynik blokujący.' : 'Gotowe.'),
  async asserts({ plugin }: FixturePayload) {
    const origin = { agentName: 'Tester', sessionPath: 'Chats/owner.md', sessionEpoch: 'epoch-owner', tabKey: 'owner' };
    const execute = (id: string, name: string, args: FixturePayload) => plugin.mcpClient.executeToolCall({ id, name, arguments: args }, 'Tester', { autonomy: 'yolo', origin });
    const start = await execute('start', 'delegate', { task: first });
    assert(start.started && start.sub_id, `Brak wątku: ${JSON.stringify(start)}`);
    const deadline = Date.now() + 8000;
    while (plugin.subTaskRegistry.getThread(start.sub_id)?.phase !== 'idle' && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert(plugin.subTaskRegistry.getThread(start.sub_id)?.phase === 'idle', 'Pierwszy bieg nie zakończył się.');
    const result = await execute('blocking', 'sub_agent', { action: 'task', sub_id: start.sub_id, task: next, background: false });
    assert(JSON.stringify(result).includes('Wynik blokujący.') && result.kind !== 'question' && !result.started, `Zwrotka: ${JSON.stringify(result)}`);
  },
} satisfies Scenario);
