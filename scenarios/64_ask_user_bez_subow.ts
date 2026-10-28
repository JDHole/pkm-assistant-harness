import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert, toolResult } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
export default ({
  file: '64_ask_user_bez_subow', name: 'ask_user bez subów', opis: 'odpowiedź użytkownika wraca do prowadzącego',
  agent: 'Tester', autonomy: 'yolo', maxIterations: 3, liveSkip: 'wymaga sterowanej odpowiedzi użytkownika',
  setup({ plugin }: FixturePayload) { plugin._askUserPromise = Promise.resolve('Opcja B'); },
  offlineScript: (ctx: FixturePayload) => lastToolResults(ctx.request).length === 0
    ? toolCallTurn('ask_user', { question: 'Którą opcję wybierasz?', options: ['Opcja A', 'Opcja B'] }) : textTurn('Przyjąłem opcję B.'),
  asserts({ plugin, result }: FixturePayload) {
    const answer = toolResult(result, 'ask_user');
    assert(String(answer?.resultPreview).includes('Opcja B'), `Odpowiedź: ${JSON.stringify(answer)}.`);
    assert(result.finalText === 'Przyjąłem opcję B.', `Odpowiedź prowadzącego: ${result.finalText}`);
    assert(plugin.subTaskRegistry.list().length === 0, 'Pojawił się sub-agent.');
  },
} satisfies Scenario);
