/**
 * runTurn.js — złożenie biegu eksploracyjnego (FAZA B).
 *
 * Składa DOKŁADNIE te produkcyjne kawałki, których używa czat (`modules/chat/chat/chat_streaming.js
 * send_message`), tylko bez UI:
 *   - prompt systemowy: `agentManager.getActiveSystemPromptWithMemory({isLocalModel})` — TA SAMA
 *     funkcja co czat (chat_streaming.js:160). Persona + rdzeń + indeks skilli + pamięć + artifactIndex.
 *   - model: `createModelForRole(plugin, 'main', agent)` — TA SAMA ścieżka co czat (chat_model.js:48).
 *   - narzędzia: whitelista jak `_chatResolveTools` (filterByAgent + getToolDefinitions + user MCP
 *     serwery + dedupe). `disabled_tools`/whitelisty agenta DZIAŁAJĄ.
 *   - egzekucja: `mcpClient.executeToolCall(toolCall, agentName, {autonomy})` — wzór SubAgentRunner.js:283.
 *   - zgody: `approvalManager.setApprovalHandler(...)` z polityką z CLI (auto/deny), każda decyzja
 *     wpisana do raportu.
 *   - pętla: `runAgentLoop` z `modules/agent-loop` (store=ArrayMessageStore system+user, trace scope,
 *     limity z getLimits + override).
 *
 * NIE kopiujemy treści promptu ani mechaniki pętli — wołamy produkcyjne funkcje.
 */
import { runAgentLoop, ArrayMessageStore } from '../../modules/agent-loop/index.js';
import { createModelForRole } from '../../modules/models/index.js';
import { tapModel } from './harnessProviders.js';
import type { TappableModel } from './harnessProviders.js';
import { getLimits } from '../../config/limits.js';
import { normalizeAutonomy } from '../../core/index.js';

import type { ParsedToolCall, RunAgentLoopOptions, RunAgentLoopResult } from '../../modules/agent-loop/index.js';
import type { HarnessRuntime } from './boot.js';

type ToolDefinition = NonNullable<ReturnType<NonNullable<RunAgentLoopOptions['resolveTools']>>>[number];
type AutonomyMode = 'yolo' | 'edge' | 'all';
type ApprovalPolicy = 'auto' | 'deny' | string;

interface ToolRegistration {
  name: string;
}

interface AgentLike {
  name: string;
  disabled_tools?: string[];
  preferredServers?: string[];
  preferredTools?: string[];
  model?: string | { platform?: string; model?: string };
  models?: Record<string, string | { platform?: string; model?: string } | undefined>;
}

interface ApprovalAction {
  type?: string;
  targetPath?: string;
  agentName?: string;
}

export interface ApprovalRecord {
  tool: string;
  path: string;
  agent: string;
  decision: 'approve' | 'deny';
}

export interface ExploratoryTurnOptions {
  agentName?: string | null;
  prompt: string;
  autonomy?: string;
  approve?: ApprovalPolicy;
  maxIterations?: number | null;
  runId?: string;
  /**
   * F2: czekać po turze na sub-agentów odpalonych W TLE (default `true`).
   * `false` = oddaj kontrolę od razu — scenariusz sam wie, co robi z wiszącym biegiem.
   */
  awaitSubTasks?: boolean;
  /** F2: budżet czekania na biegi w tle (ms). Default 120 000. */
  awaitSubTasksTimeoutMs?: number;
  /**
   * Dopisek doklejany na KOŃCU zbudowanego promptu systemowego (`bazowy + "\n\n" + suffix`).
   * Odwzorowuje to, co w czacie robią markery inline (`@@skill:` dokleja instrukcję skilla
   * do promptu tury) — harness nie stawia warstwy czatu, więc scenariusz podaje dopisek wprost.
   */
  systemPromptSuffix?: string;
  /**
   * K5: predykat „ta tura jest przerwana" podawany wprost do `runAgentLoop`. Harness nie stawia
   * warstwy czatu, więc scenariusz odgrywa nim guzik Stop (`44_stop_zatrzask`). Domyślnie brak —
   * pętla dostaje wtedy to samo co dotąd (żadnej bramki abortu).
   */
  shouldAbort?: () => boolean;
}

export interface ExploratoryTurn {
  result: RunAgentLoopResult;
  agent: AgentLike;
  model: HarnessRuntime;
  systemPrompt: string;
  autonomy: AutonomyMode;
  chunkCount: number;
  approvals: ApprovalRecord[];
  traceLabel: string;
  toolCount: number;
}

/**
 * Whitelista narzędzi dla agenta — mirror `_chatResolveTools` (chat_streaming.js:512) BEZ side-effectu
 * UI (setContextTokenSources). To produkcyjna ścieżka doboru narzędzi: filterByAgent (disabled_tools +
 * mcp_servers) → systemowe definicje → aktywne narzędzia userowych serwerów → dedupe.
 */
export function resolveToolsForAgent(plugin: HarnessRuntime, agent: AgentLike | null | undefined): ToolDefinition[] {
  const registry = plugin?.toolRegistry;
  if (!agent || !registry) return [];

  const mcpAllowed = registry.filterByAgent(agent) as ToolRegistration[];
  const allowedNames = new Set<string>(mcpAllowed.map((tl: ToolRegistration) => tl.name));
  const systemTools = (registry.getToolDefinitions() as ToolDefinition[])
    .filter((td: ToolDefinition) => allowedNames.has((td.function?.name || td.name) as string));

  const disabledSet = new Set(Array.isArray(agent.disabled_tools) ? agent.disabled_tools : []);
  const sm = plugin.serverManager;
  const preferredServers = sm?.getAllowedServerNamesForAgent
    ? sm.getAllowedServerNamesForAgent(agent)
    : (agent.preferredServers || []);
  const preferredTools = agent.preferredTools || [];
  const mcpActiveTools = ((sm?.getActiveToolDefinitions?.(preferredServers, preferredTools) || []) as ToolDefinition[])
    .filter((td: ToolDefinition) => !disabledSet.has((td.function?.name || td.name) as string));

  const seen = new Set<string>();
  const out: ToolDefinition[] = [];
  for (const def of [...systemTools, ...mcpActiveTools]) {
    const name = def?.function?.name || def?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(def);
  }
  return out;
}

/** Polityka `auto|deny` → jedna decyzja na cały bieg. Jedno miejsce dla obu haków zgód. */
function decisionOf(policy: ApprovalPolicy): 'approve' | 'deny' {
  return policy === 'deny' ? 'deny' : 'approve';
}

/**
 * Buduje handler zgód: polityka `auto` (approve) lub `deny`. Każdą decyzję dopisuje do `sink`.
 * Kontrakt zwrotu: `{result:'approve'|'deny', reason}` (patrz ApprovalManager.requestApproval).
 */
function makeApprovalHandler(policy: ApprovalPolicy, sink: ApprovalRecord[]) {
  const decision = decisionOf(policy);
  return (_app: unknown, action: ApprovalAction) => {
    sink.push({
      tool: action?.type || '(?)',
      path: action?.targetPath || '',
      agent: action?.agentName || '',
      decision,
    });
    return decision === 'approve'
      ? { result: 'approve', reason: '' }
      : { result: 'deny', reason: 'harness --approve deny' };
  };
}

/**
 * Atrapa modala diffa (`MCPClient._requestDiffApproval`, krok 5b egzekucji narzędzia).
 *
 * PO CO: zatwierdzony `write` w trybie `create|replace|patch` poza `yolo` otwiera w Obsidianie
 * `DiffModal` i CZEKA na klik usera. W harnessie `Modal.open()` z atrapy `obsidian` jest no-opem,
 * więc `waitForApproval()` NIGDY by się nie rozstrzygnęło — bieg wisiałby bez końca (dziura
 * odkryta przy scenariuszach partii 3). `MCPClient` ma na to gotowy hak DI `diffModalFactory`.
 *
 * DECYZJA JEST TA SAMA co polityka zgód tury (`approve`): `auto` → klik „Zapisz", `deny` → klik
 * „Odrzuć" (MCPClient traktuje dosłownie wartość `'deny'`). Dzięki temu scenariusz ma JEDEN
 * przełącznik na wszystkie pytania, a nie dwa niezależne. Decyzja ląduje w tym samym `sink`
 * co reszta zgód — przy RED widać w raporcie, że diff w ogóle był pytany.
 */
function makeDiffModalFactory(policy: ApprovalPolicy, sink: ApprovalRecord[]) {
  const decision = decisionOf(policy);
  return (_app: unknown, options: { path?: string; agentName?: string }) => ({
    waitForApproval: async () => {
      sink.push({
        tool: 'diff',
        path: options?.path || '',
        agent: options?.agentName || '',
        decision,
      });
      return decision;
    },
  });
}

/** Domyślny budżet czekania na sub-agentów z tła (ms). */
const DEFAULT_SUBTASK_WAIT_MS = 120_000;

/**
 * F2 („delegacja w tle"): poczekaj, aż rejestr nie ma już biegów `running`.
 *
 * PO CO: od F2 `delegate` domyślnie NIE blokuje tury — pętla główna kończy się, gdy suby
 * jeszcze pracują. Bez tego czekania scenariusz asertowałby na niedokończonym trace, a
 * sprzątanie temp-vaulta ścigałoby się z żywym zapisem sub-agenta.
 *
 * Mechanika: sprawdzenie wstępne + nasłuch `task:finished`, a po każdym „zero biegnących"
 * jeszcze jedna kontrola po krótkiej chwili — pula wielozadaniowa startuje kolejny task
 * DOPIERO po zakończeniu poprzedniego, więc chwilowe zero nie znaczy „koniec".
 *
 * @throws gdy po `timeoutMs` coś nadal biegnie (komunikat niesie listę wiszących id).
 */
export async function awaitBackgroundSubTasks(
  plugin: HarnessRuntime,
  { timeoutMs = DEFAULT_SUBTASK_WAIT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const registry = plugin?.subTaskRegistry;
  if (typeof registry?.list !== 'function') return;

  const running = (): string[] => (registry.list() as Array<{ id: string; status: string }>)
    .filter((task) => task.status === 'running')
    .map((task) => task.id);

  const deadline = Date.now() + timeoutMs;
  let calm = 0;
  for (;;) {
    const wiszace = running();
    if (wiszace.length === 0) {
      calm += 1;
      if (calm >= 2) return; // dwa spokojne odczyty pod rząd = pula naprawdę pusta
    } else {
      calm = 0;
    }
    if (Date.now() > deadline) {
      throw new Error(`awaitBackgroundSubTasks: po ${timeoutMs} ms nadal biegną sub-agenci: ${wiszace.join(', ')}`);
    }
    // Budzik na zdarzeniu (szybka reakcja) ALBO krótki tick (wyłapuje start następnego taska).
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; off?.(); clearTimeout(timer); resolve(); };
      const off = registry.events?.on?.('task:finished', finish) as (() => void) | undefined;
      const timer = setTimeout(finish, 25);
      (timer as unknown as { unref?: () => void })?.unref?.();
    });
  }
}

/**
 * Uruchamia jeden bieg eksploracyjny.
 *
 * @param {Object} plugin - żywy PKMAssistantPlugin (po waitForReady)
 * @param {Object} opts
 * @param {string} opts.agentName - nazwa agenta (--agent); fallback: aktywny
 * @param {string} opts.prompt - treść wiadomości usera (--prompt)
 * @param {string} [opts.autonomy='edge'] - yolo|edge|all
 * @param {string} [opts.approve='auto'] - auto|deny (polityka handlera zgód dla edge/all)
 * @param {number} [opts.maxIterations] - override limitu iteracji
 * @param {string} [opts.runId] - id biegu (label trace)
 * @param {string} [opts.systemPromptSuffix] - dopisek doklejany na końcu promptu systemowego
 * @returns {Promise<{result:Object, agent:Object, model:Object, systemPrompt:string,
 *   autonomy:string, chunkCount:number, approvals:Array, traceLabel:string, toolCount:number}>}
 */
export async function runExploratoryTurn(plugin: HarnessRuntime, opts: ExploratoryTurnOptions): Promise<ExploratoryTurn> {
  const {
    agentName,
    prompt,
    autonomy: rawAutonomy = 'edge',
    approve = 'auto',
    maxIterations,
    runId = Date.now().toString(36),
    systemPromptSuffix = '',
    awaitSubTasks = true,
    awaitSubTasksTimeoutMs = DEFAULT_SUBTASK_WAIT_MS,
    shouldAbort,
  } = opts;

  const autonomy = normalizeAutonomy(rawAutonomy);
  const agentManager = plugin?.agentManager;
  if (!agentManager) throw new Error('agentManager niedostępny (bootstrap nieukończony?)');

  // ── Agent: wybór + aktywacja (system prompt idzie przez activeAgent) ──
  let agent = agentName ? agentManager.getAgent(agentName) : null;
  if (agentName && !agent) {
    const available = agentManager.getAllAgents?.().map((a: AgentLike) => a.name).join(', ') || '(brak)';
    throw new Error(`Agent "${agentName}" nie znaleziony. Dostępni: ${available}`);
  }
  if (agent && agentManager.getActiveAgent()?.name !== agent.name) {
    agentManager.switchAgent(agent.name);
  }
  agent = agentManager.getActiveAgent();
  if (!agent) throw new Error('Brak aktywnego agenta.');

  // Autonomia lustrzana (parytet z czatem: suby dziedziczą plugin.currentAutonomy).
  plugin.currentAutonomy = autonomy;

  // ── Handler zgód (edge/all pytają; yolo omija pytania po stronie PermissionSystem) ──
  const approvals: ApprovalRecord[] = [];
  if (plugin.approvalManager?.setApprovalHandler) {
    plugin.approvalManager.setApprovalHandler(makeApprovalHandler(approve, approvals));
  }
  // Drugie pytanie tej samej tury: modal diffa przy `write`. Bez atrapy bieg wisi (patrz wyżej).
  if (plugin.mcpClient) {
    plugin.mcpClient.diffModalFactory = makeDiffModalFactory(approve, approvals);
  }

  // ── Prompt systemowy: TA SAMA funkcja co czat (chat_streaming.js:160) ──
  const platform = plugin.env?.settings?.pkmAssistant?.chat?.platform || '';
  const isLocalModel = platform === 'ollama' || platform === 'lm_studio';
  // K18: parytet z czatem — prompt budowany dla agenta TEGO biegu, podanego jawnie
  // (nie dla tego, kto akurat jest aktywny w AgentManagerze).
  const basePrompt = await agentManager.getActiveSystemPromptWithMemory({ isLocalModel }, agent);
  const systemPrompt = systemPromptSuffix ? `${basePrompt}\n\n${systemPromptSuffix}` : basePrompt;

  // ── Model: TA SAMA ścieżka co czat (chat_model.js:48) ──
  const rawModel = createModelForRole(plugin, 'main', agent);
  // Podsłuch odpowiedzi wpina się w `ChatModel.stream` przez OPAKOWANIE MODELU — dostawcy są
  // bezstanowi i nie mają `stream()`, więc to jedyne miejsce, gdzie widać finalną odpowiedź.
  //
  // ⚠️ Etykieta podsłuchu to `providerId` ROZSTRZYGNIĘTEGO modelu, nie platforma z ustawień:
  // agent z własnym modelem (`model: lm_studio/qwen3-harness` w YAML-u) gada z INNĄ platformą
  // niż globalny wybór usera, a scenariusz 25 pyta podsłuch właśnie o `lm_studio`.
  const etykietaPodsluchu = (rawModel as { providerId?: string } | null)?.providerId || platform || 'unknown';
  const model = rawModel ? tapModel(rawModel as unknown as TappableModel, etykietaPodsluchu) : rawModel;
  if (!model?.stream) {
    throw new Error('Model nie rozwiązany (brak klucza API lub złe ustawienia). '
      + `platform=${platform}, agent=${agent.name}`);
  }

  // ── Store: system + user (jak SubAgentRunner.js:62) ──
  const store = new ArrayMessageStore([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);

  // ── Trace scope: harness/<agent>#<runId> ──
  const traceLabel = `harness/${agent.name}#${runId}`;
  const trace = plugin.traceLog?.scope?.(traceLabel);

  // ── Limity: getLimits(settings) + override --max-iterations ──
  const baseLimits = getLimits(plugin.env?.settings);
  const limits = {
    maxIterations: (maxIterations && maxIterations > 0) ? maxIterations : baseLimits.chat_max_iterations,
    maxToolResultLength: baseLimits.max_tool_result_length,
  };

  let chunkCount = 0;
  const currentTools = resolveToolsForAgent(plugin, agent);

  const result = await runAgentLoop({
    model: model as unknown as RunAgentLoopOptions['model'],
    store,
    resolveTools: () => resolveToolsForAgent(plugin, agent),
    executeToolCall: (toolCall: ParsedToolCall) => plugin.mcpClient.executeToolCall(toolCall, agent.name, { autonomy }),
    trace,
    limits,
    modelOptions: { agentName: agent.name, agent: agent.name },
    callbacks: { chunk: () => { chunkCount += 1; } },
    ...(typeof shouldAbort === 'function' ? { shouldAbort } : {}),
  });

  // F2: pętla główna mogła skończyć się, zanim suby z tła oddały wynik. Asercje scenariuszy
  // (trace suba, rejestr, skrzynka powiadomień) muszą patrzeć na stan DOMKNIĘTY.
  if (awaitSubTasks) {
    await awaitBackgroundSubTasks(plugin, { timeoutMs: awaitSubTasksTimeoutMs });
  }

  return {
    result,
    agent,
    model,
    systemPrompt,
    autonomy,
    chunkCount,
    approvals,
    traceLabel,
    toolCount: currentTools.length,
  };
}
