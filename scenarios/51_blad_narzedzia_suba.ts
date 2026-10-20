/**
 * 51_blad_narzedzia_suba: nieudane narzędzie jest widoczne, choć sub odpowie normalnie.
 *
 * Co realnie sprawdza: produkcyjny worker próbuje utworzyć istniejący plik, MCPClient zwraca
 * błąd narzędzia, a sub następnie kończy odpowiedzią. Efekt write ma outcome `error`.
 *
 * Inwarianty:
 *   1. naturalna odpowiedź daje finished/unconfirmed, nie failed całego biegu,
 *   2. efekt write ma literalne outcome error i nie jest policzony jako returned,
 *   3. rejestr biegu i trace zachowują krok błędu z nazwą narzędzia.
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { assert, subTraceEvents } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FILE = 'Notatki/powitanie.md';
const CONTENT = 'nowa treść, której tryb create nie może nadpisać';
const state: { attempts: number; transcript: string } = { attempts: 0, transcript: '' };

function isSub(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((message: FixturePayload) => message?.role === 'system');
  const content = Array.isArray(system?.content) ? system.content.map((part: FixturePayload) => part?.text || '').join('\n') : system?.content;
  return typeof content === 'string' && /Jesteś sub-agentem /.test(content);
}

export default ({
  file: '51_blad_narzedzia_suba',
  name: 'błąd narzędzia przy normalnej odpowiedzi',
  opis: 'błąd write nie psuje końca biegu i nie jest zaliczany jako wykonany efekt',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'wymaga wymuszenia próby utworzenia pliku, który już istnieje',

  async setup({ plugin }: FixturePayload) {
    state.attempts = 0;
    state.transcript = '';
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },

  offlineScript: (ctx: FixturePayload) => {
    if (!isSub(ctx.request)) return textTurn('Tura kontrolna zakończona.');
    state.attempts += 1;
    state.transcript = JSON.stringify(ctx.request.messages);
    if (state.attempts === 1) return toolCallTurn('write', { path: FILE, content: CONTENT, mode: 'create' });
    return textTurn('Próba zapisu nie powiodła się, ale reszta zadania została sprawdzona.');
  },

  async asserts({ plugin, vaultRoot }: FixturePayload) {
    const response = await plugin.mcpClient.executeToolCall(
      { id: 'tool-error', name: 'delegate', arguments: { task: 'Zapisz nową notatkę i opisz wynik.', aspect: 'worker' } },
      'Tester',
      { delegationDepth: 1, autonomy: 'yolo' },
    );
    const task = plugin.subTaskRegistry.list().at(-1);
    assert(response.success === true, `Odpowiedź delegate success=${response.success}; oczekiwano finished.`);
    assert(response.outcome?.end?.kind === 'finished', `outcome.end=${JSON.stringify(response.outcome?.end)}.`);
    assert(response.outcome?.completeness === 'unconfirmed', `completeness=${response.outcome?.completeness}.`);
    assert(task?.result?.outcome?.end?.kind === 'finished', `Rejestr outcome=${JSON.stringify(task?.result?.outcome)}.`);
    const effect = task.result.outcome.effects.find((item: FixturePayload) => item.tool === 'write');
    assert(effect, `Brak efektu write w rejestrze: ${JSON.stringify(task.result.outcome.effects)}.`);
    assert(effect.outcome === 'error', `Efekt write.outcome=${effect.outcome}, oczekiwano error.`);
    assert(effect.outcome !== 'returned', 'Nieudany zapis nie może być przedstawiony jako wykonany.');
    assert(task.steps.some((step: FixturePayload) => step.type === 'tool.post' && step.fields?.tool === 'write' && step.fields?.status === 'error'), `Kroki rejestru nie zawierają tool.post write/error: ${JSON.stringify(task.steps)}.`);
    assert(state.transcript.includes('już istnieje'), 'Pełny transkrypt żądania suba nie zachowuje literalnego błędu create na istniejącym pliku.');
    assert(state.attempts === 2, `Fake model obsłużył ${state.attempts} żądań suba, oczekiwano 2.`);
    const events = await subTraceEvents({ plugin, vaultRoot }, task.name);
    assert(events.some((event) => event.type === 'tool.post' && event.fields.tool === 'write' && event.fields.status === 'error'), `Trace nie zawiera tool.post write/error: ${JSON.stringify(events.map((event) => event.fields))}.`);
  },
} satisfies Scenario);
