/**
 * 50_synteza_500: HTTP 500 w syntezie po limicie zachowuje dorobek suba.
 *
 * Co realnie sprawdza: blokująca delegacja przez produkcyjny MCPClient wykonuje odczyt,
 * dochodzi do limitu, a awaria końcowego zapytania bez narzędzi zapisuje failed/synthesis
 * w odpowiedzi i SubTaskRegistry.
 *
 * Inwarianty:
 *   1. odpowiedź delegate ma success:false, end failed/synthesis i literalny partial_result,
 *   2. rejestr ma identyczny outcome i handoff z wynikiem odczytu,
 *   3. trace potwierdza udany read i końcową odpowiedź modelu HTTP 500.
 */
import { errorTurn, toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import { assert, subTraceEvents } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FILE = 'Notatki/powitanie.md';
const TASK = 'Odczytaj notatkę i podsumuj.';
const state: { read: boolean; synthesisFailures: number; transcript: string } = { read: false, synthesisFailures: 0, transcript: '' };

function isSub(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((message: FixturePayload) => message?.role === 'system');
  const content = Array.isArray(system?.content) ? system.content.map((part: FixturePayload) => part?.text || '').join('\n') : system?.content;
  return typeof content === 'string' && /Jesteś sub-agentem /.test(content);
}

function isSynthesis(request: FixturePayload): boolean {
  return !Array.isArray(request?.tools) || request.tools.length === 0;
}

export default ({
  file: '50_synteza_500',
  name: 'awaria syntezy zachowuje dorobek',
  opis: 'HTTP 500 w finalnej syntezie nie usuwa wyniku read ani nie udaje sukcesu',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'wymaga limitu jednego kroku i wymuszonego HTTP 500 podczas syntezy',

  async setup({ plugin }: FixturePayload) {
    state.read = false;
    state.synthesisFailures = 0;
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.subagent_max_iterations_worker = 1;
    limits.model_synthesis_timeout_ms = 30000;
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
  },

  offlineScript: (ctx: FixturePayload) => {
    if (!isSub(ctx.request)) return textTurn('Tura kontrolna zakończona.');
    state.transcript = JSON.stringify(ctx.request.messages);
    if (!state.read) {
      state.read = true;
      return toolCallTurn('read', { path: FILE });
    }
    if (isSynthesis(ctx.request)) {
      state.synthesisFailures += 1;
      return errorTurn({ status: 500, message: 'Harness synthesis failure' });
    }
    return textTurn('Nieoczekiwana odpowiedź suba.');
  },

  async asserts({ plugin, vaultRoot }: FixturePayload) {
    const response = await plugin.mcpClient.executeToolCall(
      { id: 'synthesis-500', name: 'delegate', arguments: { task: TASK } },
      'Tester',
      { delegationDepth: 1, autonomy: 'yolo' },
    );
    const task = plugin.subTaskRegistry.list().at(-1);
    assert(task?.result?.outcome, 'Brak wyniku i outcome suba w rejestrze.');
    assert(response.success === false, `delegate.success=${response.success}, oczekiwano false.`);
    assert(response.outcome?.end?.kind === 'failed' && response.outcome?.end?.stage === 'synthesis', `delegate.outcome.end=${JSON.stringify(response.outcome?.end)}.`);
    assert(response.outcome?.completeness === 'partial', `delegate.completeness=${response.outcome?.completeness}.`);
    assert(typeof response.partial_result === 'string' && response.partial_result.includes(FILE), `partial_result nie zachował ${FILE}: ${JSON.stringify(response.partial_result)}.`);
    assert(task.result.outcome.end.kind === 'failed' && task.result.outcome.end.stage === 'synthesis', `Rejestr outcome.end=${JSON.stringify(task.result.outcome.end)}.`);
    assert(task.result.outcome.completeness === 'partial' && task.result.outcome.hasMaterial === true, `Rejestr nie zachował partial material: ${JSON.stringify(task.result.outcome)}.`);
    assert(task.result.handoff?.includes(FILE), `Handoff nie zawiera ścieżki odczytu ${FILE}: ${JSON.stringify(task.result.handoff)}.`);
    assert(state.transcript.includes('To jest notatka-rekwizyt w atrapie vaulta harnessa.'), 'Pełny transkrypt żądania syntezy nie zachował wyniku read.');
    assert(state.synthesisFailures === 1, `Atrapa zwróciła ${state.synthesisFailures} błędów syntezy, oczekiwano 1.`);
    const events = await subTraceEvents({ plugin, vaultRoot }, task.name);
    assert(events.some((event) => event.type === 'tool.post' && event.fields.tool === 'read' && event.fields.status === 'ok'), `Brak poprawnego tool.post read w trace: ${JSON.stringify(events.map((e) => e.fields))}.`);
    assert(events.some((event) => event.type === 'loop.end' && event.fields.stop === 'error'), `Trace nie pokazuje terminalnego błędu syntezy: ${JSON.stringify(events.map((event) => ({ type: event.type, fields: event.fields })))}.`);
    assert(events.filter((event) => event.type === 'loop.end').length === 1, `Trace ma ${events.filter((event) => event.type === 'loop.end').length} zdarzeń loop.end, oczekiwano 1.`);
  },
} satisfies Scenario);
