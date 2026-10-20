/**
 * 53_pozny_wynik: późny tool_call po Stopie nie uruchamia narzędzia ani nie zmienia biegu.
 *
 * Co realnie sprawdza: odpowiedź fake-modelu jest wstrzymana po rozpoczęciu zapytania suba;
 * produkcyjne requestStop(id, 'user') zatrzymuje bieg przed zwolnieniem odpowiedzi.
 *
 * Inwarianty:
 *   1. po Stopie odpowiedź z tool_call nie wykonuje write,
 *   2. outcome rejestru zostaje stopped/by user,
 *   3. rejestr zapisuje dokładnie jedno terminalne zakończenie i nie zmienia się po zwolnieniu.
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FILE = 'Notatki/late-write.md';
const state: { requests: number; toolCalls: number; heldStarted: boolean; release: (() => void) | null; finishes: number } = {
  requests: 0, toolCalls: 0, heldStarted: false, release: null, finishes: 0,
};

function isSub(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((message: FixturePayload) => message?.role === 'system');
  const content = Array.isArray(system?.content) ? system.content.map((part: FixturePayload) => part?.text || '').join('\n') : system?.content;
  return typeof content === 'string' && /Jesteś sub-agentem /.test(content);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default ({
  file: '53_pozny_wynik',
  name: 'późny tool_call po Stopie',
  opis: 'odpowiedź przytrzymana w trakcie requestu nie wykonuje narzędzia po Stopie',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'wymaga przytrzymania odpowiedzi modelu i zatrzymania konkretnego biegu',

  async setup({ plugin }: FixturePayload) {
    Object.assign(state, { requests: 0, toolCalls: 0, heldStarted: false, release: null, finishes: 0 });
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
    plugin.subTaskRegistry.events.on('task:finished', (task: FixturePayload) => {
      if (task?.taskPreview === 'Poczekaj na odpowiedź, która przyjdzie po Stopie.') state.finishes += 1;
    });
    const originalExecute = plugin.mcpClient.executeToolCall.bind(plugin.mcpClient);
    plugin.mcpClient.executeToolCall = async (call: FixturePayload, ...rest: FixturePayload[]) => {
      if (call?.name === 'write') state.toolCalls += 1;
      return originalExecute(call, ...rest);
    };
  },

  offlineScript: async (ctx: FixturePayload) => {
    if (!isSub(ctx.request)) return textTurn('Tura kontrolna zakończona.');
    state.requests += 1;
    state.heldStarted = true;
    await new Promise<void>((resolve) => { state.release = resolve; });
    return toolCallTurn('write', { path: FILE, content: 'late', mode: 'create' });
  },

  async asserts({ plugin, vaultRoot }: FixturePayload) {
    const response = await plugin.mcpClient.executeToolCall(
      { id: 'late-stop', name: 'delegate', arguments: { task: 'Poczekaj na odpowiedź, która przyjdzie po Stopie.' } },
      'Tester',
      { autonomy: 'yolo' },
    );
    const task = plugin.subTaskRegistry.getTask(response.task_id);
    assert(response.started === true && task, `Brak task_id/rejestru dla tła: ${JSON.stringify(response)}.`);
    try {
      const start = Date.now();
      while (!state.heldStarted && Date.now() - start < 3000) await wait(10);
      assert(state.heldStarted === true && state.requests === 1, `Atrapa nie przytrzymała pierwszego requestu suba: ${JSON.stringify(state)}.`);
      const stopped = plugin.subTaskRegistry.requestStop(task.id, 'user');
      assert(stopped === true, `requestStop(${task.id}, 'user') zwrócił ${stopped}.`);
      assert(task.stopRequestedBy === 'user', `Rejestr zapisał stopRequestedBy=${task.stopRequestedBy}.`);
      state.release?.();
      state.release = null;
      const stopAt = Date.now();
      while (task.status === 'running' && Date.now() - stopAt < 5000) await wait(20);
      assert(task.result?.outcome?.end?.kind === 'stopped' && task.result.outcome.end.by === 'user', `Outcome po Stopie=${JSON.stringify(task.result?.outcome)}.`);
      assert(state.toolCalls === 0, `Po Stopie rozpoczęto ${state.toolCalls} write.`);
      assert(state.requests === 1, `Fake model obsłużył ${state.requests} requestów, oczekiwano jednego przytrzymanego.`);
      assert(task.steps.filter((step: FixturePayload) => step.type === 'loop.end').length === 1, `Rejestr ma terminalne loop.end: ${JSON.stringify(task.steps)}.`);
      assert(task.steps.every((step: FixturePayload) => step.type !== 'tool.pre' && step.type !== 'tool.post'), `Po Stopie pojawił się krok narzędzia: ${JSON.stringify(task.steps)}.`);
      const terminal = JSON.stringify({ status: task.status, result: task.result, steps: task.steps });
      await wait(100);
      assert(JSON.stringify({ status: task.status, result: task.result, steps: task.steps }) === terminal, 'Stan biegu lub rejestr zmienił się po terminalnym Stopie.');
      assert(state.finishes === 1, `Liczba zdarzeń task:finished=${state.finishes}, oczekiwano 1.`);
      assert(!fs.existsSync(path.join(vaultRoot, FILE)), `Plik ${FILE} powstał po Stopie.`);
    } finally {
      state.release?.();
      state.release = null;
    }
  },
} satisfies Scenario);
