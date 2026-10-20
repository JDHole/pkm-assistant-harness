/**
 * 52_stop_w_kolejce: Stop suba czekającego na slot modelu.
 *
 * Co realnie sprawdza: delegate(tasks) tworzy dwa biegi przy limicie dwóch
 * delegacji, ale pula modelu ma jeden slot. Wywołujemy requestStop(id, 'user')
 * na wpisie drugiego suba czekającego na slot i zwalniamy pierwszego.
 *
 * Inwarianty: drugie zadanie ma stopped/by user i zero requestów; pierwsze ma
 * finished; odpowiedź zbiorcza ma success:false i liczniki 1/0/1. Rejestr
 * i trace zawierają literalne stop.requested/by user.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './_asserts.js';
import { ChatModel } from '@plugin/modules/models/index.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const FIRST = 'pierwsze zadanie czeka na wynik';
const QUEUED = 'drugie zadanie czeka na slot';
const state: {
  firstHeld: boolean; releaseFirst: (() => void) | null;
  firstRequests: number; queuedRequests: number;
  originalGateLimit?: () => number;
} = { firstHeld: false, releaseFirst: null, firstRequests: 0, queuedRequests: 0 };

function userText(request: FixturePayload): string {
  return (request?.messages || [])
    .filter((message: FixturePayload) => message?.role === 'user')
    .map((message: FixturePayload) => typeof message.content === 'string' ? message.content : '')
    .join('\n');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type QueueProbe = {
  response: FixturePayload; firstRequests: number; queuedRequests: number;
  queuedAtStop: FixturePayload | undefined; queuedStatusAtStop: string | undefined;
  queuedRequestsAtStop: number; stopAccepted: boolean;
  first: FixturePayload | undefined; queued: FixturePayload | undefined;
};

async function probeQueue(plugin: FixturePayload): Promise<QueueProbe> {
  Object.assign(state, { firstHeld: false, releaseFirst: null, firstRequests: 0, queuedRequests: 0 });
  // Dwa biegi mają wpisy w rejestrze, a bramka modelu wpuszcza jeden request.
  let gateCalls = 0;
  ChatModel.prototype._streamGateLimit = () => ++gateCalls === 1 ? 2 : 1;
  const execution = plugin.mcpClient.executeToolCall(
    { id: 'queued-stop', name: 'delegate', arguments: {
      background: false, tasks: [{ task: FIRST }, { task: QUEUED }],
    } },
    'Tester',
    { delegationDepth: 1, autonomy: 'yolo' },
  );
  let settled = false;
  void execution.then(() => { settled = true; }, () => { settled = true; });
  try {
    const start = Date.now();
    while (!state.firstHeld && !settled && Date.now() - start < 5000) await wait(10);
    let queuedAtStop = plugin.subTaskRegistry.list().find((task: FixturePayload) => task.taskPreview === QUEUED);
    const queueStart = Date.now();
    while (state.firstHeld && !queuedAtStop && Date.now() - queueStart < 500) {
      await wait(10);
      queuedAtStop = plugin.subTaskRegistry.list().find((task: FixturePayload) => task.taskPreview === QUEUED);
    }
    const queuedStatusAtStop = queuedAtStop?.status;
    const queuedRequestsAtStop = state.queuedRequests;
    // Gdy wpisu nie ma, false dowodzi, że zadanie w puli nie ma adresu Stop.
    const stopAccepted = plugin.subTaskRegistry.requestStop(queuedAtStop?.id ?? 'missing-queued-task', 'user');
    state.releaseFirst?.();
    state.releaseFirst = null;
    const response = await execution;
    const tasks = plugin.subTaskRegistry.list();
    return {
      response, firstRequests: state.firstRequests, queuedRequests: state.queuedRequests,
      queuedAtStop, queuedStatusAtStop, queuedRequestsAtStop, stopAccepted,
      first: tasks.find((task: FixturePayload) => task.taskPreview === FIRST),
      queued: tasks.find((task: FixturePayload) => task.taskPreview === QUEUED),
    };
  } finally {
    state.releaseFirst?.();
    state.releaseFirst = null;
    await execution;
  }
}

async function verifyProbe(probe: QueueProbe, vaultRoot: string): Promise<void> {
  const evidence = JSON.stringify({
    response: probe.response, firstRequests: probe.firstRequests,
    queuedRequests: probe.queuedRequests, queuedAtStop: probe.queuedAtStop?.id,
    queuedStatusAtStop: probe.queuedStatusAtStop, queuedRequestsAtStop: probe.queuedRequestsAtStop,
    stopAccepted: probe.stopAccepted, first: probe.first?.result?.outcome,
    queued: probe.queued?.result?.outcome,
  });
  assert(probe.firstRequests === 1, `Pierwszy bieg nie wysłał dokładnie jednego requestu: ${evidence}.`);
  assert(probe.queuedStatusAtStop === 'running' && probe.queuedRequestsAtStop === 0
    && probe.queuedAtStop?.stopRequestedBy === 'user' && probe.stopAccepted === true,
    `Stop nie trafił do rzeczywistego wpisu oczekującego: ${evidence}.`);
  assert(probe.queuedRequests === 0, `Zatrzymany bieg wysłał request do modelu: ${evidence}.`);
  assert(probe.queued?.result?.outcome?.end?.kind === 'stopped'
    && probe.queued.result.outcome.end.by === 'user', `Outcome drugiego biegu: ${evidence}.`);
  assert(probe.queued?.steps?.some((step: FixturePayload) => step.type === 'stop.requested' && step.fields?.by === 'user'),
    `Brak literalnego kroku stop.requested/by user: ${evidence}.`);
  const tracePath = path.join(vaultRoot, '.pkm-assistant', 'logs', 'trace.log');
  const traceNeedle = `${probe.queued?.id} | stop.requested | by=user`;
  let trace = '';
  const traceStart = Date.now();
  while (Date.now() - traceStart < 1000) {
    trace = fs.readFileSync(tracePath, 'utf8');
    if (trace.includes(traceNeedle)) break;
    await wait(10);
  }
  assert(trace.includes(traceNeedle),
    `Trace nie zawiera Stopu oczekującego biegu: ${evidence}.`);
  assert(probe.first?.result?.outcome?.end?.kind === 'finished', `Pierwszy bieg nie zakończył się normalnie: ${evidence}.`);
  assert(probe.response?.success === false, `Odpowiedź zbiorcza ma fałszywy sukces: ${evidence}.`);
  assert(probe.response?.counts?.finished === 1 && probe.response.counts.partial === 0
    && probe.response.counts.failed === 1, `Liczniki odpowiedzi zbiorczej są błędne: ${evidence}.`);
}

export default ({
  file: '52_stop_w_kolejce',
  name: 'Stop suba czekającego na slot modelu',
  opis: 'drugi sub czekający na slot modelu otrzymuje Stop przed pierwszym requestem',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'wymaga zatrzymania drugiego suba przed zwolnieniem slotu modelu',

  async setup({ plugin }: FixturePayload) {
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.max_parallel_delegations = 2;
    limits.max_delegation_depth = 2;
    limits.local_platform_max_concurrent = 1;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
    assert(typeof ChatModel.prototype._streamGateLimit === 'function', 'ChatModel nie udostępnia _streamGateLimit.');
    state.originalGateLimit = ChatModel.prototype._streamGateLimit;
  },

  offlineScript: async (ctx: FixturePayload) => {
    const prompt = userText(ctx.request);
    if (prompt.includes(FIRST)) {
      state.firstRequests += 1;
      state.firstHeld = true;
      await new Promise<void>((resolve) => { state.releaseFirst = resolve; });
      return textTurn('Pierwsze zadanie zakończone normalnie.');
    }
    if (prompt.includes(QUEUED)) {
      state.queuedRequests += 1;
      return textTurn('Drugie zadanie nie powinno się uruchomić po Stopie.');
    }
    return textTurn('Odpowiedź bez treści zadania.');
  },

  async asserts({ plugin, vaultRoot }: FixturePayload) {
    try {
      await verifyProbe(await probeQueue(plugin), vaultRoot);
    } finally {
      if (state.originalGateLimit) ChatModel.prototype._streamGateLimit = state.originalGateLimit;
    }
  },
} satisfies Scenario);
