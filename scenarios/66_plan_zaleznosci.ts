import { errorTurn, textTurn } from '../mock/fake-llm-server.js';
import deepResearch from './32_deep_research.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';
import type { SubTaskRegistry, SubTaskNotice, SubTaskPlanRuntime } from '@plugin/modules/sub-agents/index.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** A deadline only fails a missing event; it never releases work. */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Plan barrier timed out')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Both variants exercise real MCP, runner, HTTP transport, registry and notifier. */
export function dependencyPlanScenario(failA: boolean): Scenario {
  let gates = { A: barrier(), B: barrier() };
  let entered = { A: barrier(), B: barrier() };
  let starts: string[] = [], dependencyMessages: string[] = [];
  let predecessorStatesAtC: string[] = [];
  let runtime: SubTaskPlanRuntime | undefined;
  return {
    file: failA ? '67_plan_awaria' : '66_plan_zaleznosci',
    name: failA ? 'dependency plan failure' : 'dependency plan success',
    opis: 'A and B run behind barriers; C requires both settled results; one aggregate notice',
    agent: 'Tester', autonomy: 'yolo',
    liveSkip: 'Requires deterministic response barriers and a controlled HTTP failure.',
    fixtures: deepResearch.fixtures,
    setup() {
      gates = { A: barrier(), B: barrier() }; entered = { A: barrier(), B: barrier() };
      starts = []; dependencyMessages = []; predecessorStatesAtC = []; runtime = undefined;
    },
    async offlineScript(ctx: FixturePayload) {
      const messages: Array<{ role: string; content: string }> = ctx.request?.messages ?? [];
      const task = messages.find(message => message.role === 'user' && /^PLAN-NODE-[ABC]$/.test(message.content));
      if (!task) return textTurn('The harness will submit a dependency plan through MCP.');
      const id = task.content.slice(-1);
      starts.push(id);
      if (id === 'A' || id === 'B') {
        entered[id].release();
        await gates[id].promise;
        if (id === 'A' && failA) return errorTurn({ status: 400, message: 'controlled plan A failure' });
        return textTurn(id === 'A' ? 'wynik A' : 'wynik B');
      }
      predecessorStatesAtC = runtime!.nodes.slice(0, 2).map(node => node.state.kind);
      dependencyMessages = messages.filter(message => message.role === 'user' && message.content.includes('source="dependency_results"'))
        .map(message => message.content);
      return textTurn('wynik C');
    },
    async asserts({ plugin }: FixturePayload) {
      const memory = plugin.agentManager.getActiveMemory();
      const sessionPath = await memory.startActiveSession('Tester');
      const origin = { agentName: 'Tester', sessionPath, sessionEpoch: memory.sessionEpoch };
      const registry: SubTaskRegistry = plugin.subTaskRegistry;
      const notices: SubTaskNotice[] = [];
      const delivered = barrier(), aSettled = barrier();
      const off = registry.events.on('plan:changed', () => {
        if (runtime && ['done', 'error'].includes(runtime.nodes[0].state.kind)) aSettled.release();
      });
      plugin.subTaskNotifier.setNoticeDeliverer((notice: SubTaskNotice) => {
        notices.push(notice); delivered.release(); return true;
      });
      try {
        const receipt = await plugin.mcpClient.executeToolCall({ id: 'dependency-plan', name: 'delegate', arguments: {
          tasks: [
            { id: 'A', task: 'PLAN-NODE-A', aspect: 'researcher' },
            { id: 'B', task: 'PLAN-NODE-B', aspect: 'researcher' },
            { id: 'C', task: 'PLAN-NODE-C', aspect: 'researcher', depends_on: ['A', 'B'] },
          ],
        } }, 'Tester', { autonomy: 'yolo', origin });
        assert(receipt.success === true && receipt.started === true && typeof receipt.plan_id === 'string',
          `Expected a background plan receipt: ${JSON.stringify(receipt)}`);
        runtime = registry.getPlan(receipt.plan_id);
        assert(runtime, 'Accepted plan is missing from the registry');
        await bounded(Promise.all([entered.A.promise, entered.B.promise]));
        assert(JSON.stringify(starts.slice().sort()) === '["A","B"]'
          && JSON.stringify(runtime.nodes.map(node => node.state.kind)) === '["running","running","waiting_dependencies"]',
        `Both predecessors must start before either barrier opens: ${JSON.stringify(runtime.nodes)}`);
        gates.A.release();
        await bounded(aSettled.promise);
        assert(JSON.stringify(runtime.nodes.map(node => node.state.kind)) === (failA
          ? '["error","running","blocked"]' : '["done","running","waiting_dependencies"]')
          && JSON.stringify(starts.slice().sort()) === '["A","B"]',
        `C must not run after A alone: ${JSON.stringify(runtime.nodes)}`);
        gates.B.release();
        await bounded(runtime.completion); await bounded(delivered.promise);
        assert(notices.length === 1 && notices[0].kind === 'plan-result', `Expected one plan notice: ${JSON.stringify(notices)}`);
        const result = notices[0].result;
        assert(result.plan_id === receipt.plan_id && result.success === !failA
          && result.status === (failA ? 'partial' : 'completed') && runtime.status === result.status,
        `Wrong terminal aggregate: ${JSON.stringify(result)}`);
        assert(JSON.stringify(result.nodes.map(node => [node.id, node.state.kind])) === (failA
          ? '[["A","error"],["B","done"],["C","blocked"]]' : '[["A","done"],["B","done"],["C","done"]]'),
        `Wrong terminal node table: ${JSON.stringify(result.nodes)}`);
        assert(result.nodes[1].state.material === 'wynik B', 'Independent B result was lost');
        if (failA) {
          assert(JSON.stringify(result.blocked) === '[{"id":"C","blocked_by":["A"]}]'
            && result.nodes[2].state.kind === 'blocked' && JSON.stringify(result.nodes[2].state.blocked_by) === '["A"]'
            && runtime.nodes[2].state.kind === 'blocked' && !runtime.nodes[2].state.execution
            && JSON.stringify(starts.slice().sort()) === '["A","B"]',
          `C must be terminally blocked without an execution: ${JSON.stringify(result)}`);
          assert(result.nodes[0].state.kind === 'error' && result.nodes[0].state.error.includes('controlled plan A failure')
            && registry.list().some(task => task.plan?.nodeId === 'A' && task.result?.outcome?.end.kind === 'failed'),
          `A must fail during real execution: ${JSON.stringify(result.nodes[0])}`);
        } else {
          assert(JSON.stringify(predecessorStatesAtC) === '["done","done"]'
            && JSON.stringify(starts.slice().sort()) === '["A","B","C"]', 'C started before both results settled');
          assert(dependencyMessages.length === 1 && dependencyMessages[0].includes('\nwynik A\n\n')
            && dependencyMessages[0].includes('\nwynik B\n</vault_content>'), `C lost predecessor material: ${JSON.stringify(dependencyMessages)}`);
          assert(result.nodes[0].state.material === 'wynik A' && result.nodes[2].state.material === 'wynik C',
            `Successful result material changed: ${JSON.stringify(result.nodes)}`);
        }
      } finally {
        gates.A.release(); gates.B.release(); off();
        if (runtime?.status === 'active') registry.requestStopPlan(runtime.planId, 'system');
        await registry.flushHistory();
        plugin.subTaskNotifier.setNoticeDeliverer(null);
      }
    },
  };
}

export default dependencyPlanScenario(false);
