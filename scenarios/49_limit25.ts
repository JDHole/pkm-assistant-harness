/**
 * 49_limit25: limit 25 kroków suba nie jest meldowany jako sukces.
 *
 * Co realnie sprawdza: na żywym pluginie 25 odpowiedzi z odczytem kończy bieg jako
 * `limit/partial`, zarówno przez blokującą drogę produkcyjnego MCPClient dla zlecenia
 * z suba, jak i dla tła widocznego w SubTaskRegistry.
 *
 * Inwarianty:
 *   1. blokująca odpowiedź delegate ma success:false, outcome limit/partial i partial_result,
 *   2. outcome rejestru tła jest identyczny jak blokującego, niezależnie od statusu zgodności,
 *   3. trace każdego biegu kończy się `iteration-limit` po 25 iteracjach,
 *   4. skrypt suba zwrócił 25 udanych odczytów, bez syntetycznej odpowiedzi.
 *
 * Blokująca ścieżka używa MCPClient.executeToolCall z delegationDepth: 1. Zaufane znaczniki
 * runtime wstrzykuje produkcyjny klient; argumenty modelu nie zawierają pól `_invocation*`.
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { assert, subTraceEvents, loopEnd, toolPosts } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const TASK = 'Odczytaj notatkę 25 razy i zachowaj wynik.';
const FILE = 'Notatki/powitanie.md';
const MAX_ITERATIONS = 25;
const state: { reads: number; transcripts: string[] } = { reads: 0, transcripts: [] };

function isSub(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((message: FixturePayload) => message?.role === 'system');
  const content = Array.isArray(system?.content) ? system.content.map((part: FixturePayload) => part?.text || '').join('\n') : system?.content;
  return typeof content === 'string' && /Jesteś sub-agentem /.test(content);
}

function lastTask(plugin: FixturePayload): FixturePayload {
  const tasks = plugin.subTaskRegistry.list();
  return tasks[tasks.length - 1];
}

function ownTrace(events: FixturePayload[], task: FixturePayload): FixturePayload[] {
  return events.filter((event) => event.raw.includes(`[trace] ${task.id} |`));
}

export default ({
  file: '49_limit25',
  name: 'limit 25 bez fałszywego sukcesu',
  opis: 'limit kroków suba zachowuje dorobek i nigdy nie zwraca success:true',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'wymaga dokładnie 25 odpowiedzi narzędzia w obu ścieżkach delegacji',

  async setup({ plugin }: FixturePayload) {
    state.reads = 0;
    state.transcripts = [];
    assert(plugin?.mcpClient?.executeToolCall, 'Brak produkcyjnego MCPClient.executeToolCall.');
    const settings = plugin.env.settingsStore.raw.pkmAssistant;
    settings.limits ??= {};
    settings.limits.subagent_max_iterations_worker = MAX_ITERATIONS;
    settings.limits.model_synthesis_timeout_ms = 0;
    settings.limits.max_delegation_depth = 2;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, settings.limits);
  },

  offlineScript: (ctx: FixturePayload) => {
    if (isSub(ctx.request)) state.transcripts.push(JSON.stringify(ctx.request.messages));
    if (!isSub(ctx.request)) return textTurn('Tura kontrolna zakończona.');
    state.reads += 1;
    if (state.reads <= MAX_ITERATIONS * 2) return toolCallTurn('read', { path: FILE });
    return textTurn('Nieoczekiwana odpowiedź po budżecie.');
  },

  async asserts({ plugin, vaultRoot }: FixturePayload) {
    const blocked = await plugin.mcpClient.executeToolCall(
      { id: 'limit-blocking', name: 'delegate', arguments: { task: TASK } },
      'Tester',
      { delegationDepth: 1, autonomy: 'yolo' },
    );
    const blockingTask = lastTask(plugin);
    assert(blockingTask?.result?.outcome, 'Blokująca delegacja nie zapisała outcome w rejestrze.');
    assert(blocked.success === false, `Blokujący delegate.success=${blocked.success}, oczekiwano false; odpowiedź=${JSON.stringify(blocked)}.`);
    assert(blocked.outcome?.end?.kind === 'limit', `Blokujący outcome.end=${JSON.stringify(blocked.outcome?.end)}.`);
    assert(blocked.outcome?.completeness === 'partial', `Blokujący completeness=${blocked.outcome?.completeness}.`);
    assert(typeof blocked.partial_result === 'string' && blocked.partial_result.includes(FILE), `Brak literalnego partial_result z ${FILE}: ${JSON.stringify(blocked.partial_result)}.`);
    assert(blockingTask.result.outcome.end.kind === 'limit', `Rejestr blokującego biegu ma end=${JSON.stringify(blockingTask.result.outcome.end)}.`);
    assert(blockingTask.result.outcome.completeness === 'partial', `Rejestr blokującego biegu ma completeness=${blockingTask.result.outcome.completeness}.`);
    assert(blockingTask.result.outcome.hasMaterial === true, 'Odczyty nie zostały policzone jako materiał.');
    assert(blockingTask.result.outcome.hasAnswer === false, 'Bieg bez odpowiedzi został oznaczony jako hasAnswer=true.');
    assert(state.transcripts.some((transcript) => transcript.includes('To jest notatka-rekwizyt w atrapie vaulta harnessa.')), 'Pełny transkrypt żądania modelu blokującego biegu nie zawiera wyniku read.');
    const blockingTrace = ownTrace(await subTraceEvents({ plugin, vaultRoot }, blockingTask.name), blockingTask);
    const blockingEnd = loopEnd(blockingTrace);
    assert(blockingEnd?.stop === 'backstop' && blockingEnd.iters === MAX_ITERATIONS, `Trace blokującego biegu: ${JSON.stringify(blockingEnd)}.`);
    assert(toolPosts(blockingTrace).filter((post) => post.tool === 'read' && post.status === 'ok').length === MAX_ITERATIONS, `Trace blokującego biegu nie ma ${MAX_ITERATIONS} kroków read/ok.`);
    assert(blockingTask.steps.filter((step: FixturePayload) => step.type === 'tool.post' && step.fields?.tool === 'read' && step.fields?.status === 'ok').length === MAX_ITERATIONS, `Rejestr blokującego biegu nie ma ${MAX_ITERATIONS} kroków read/ok.`);

    state.reads = 0;
    const transcriptStart = state.transcripts.length;
    const background = await plugin.mcpClient.executeToolCall(
      { id: 'limit-background', name: 'delegate', arguments: { task: TASK } },
      'Tester',
      { autonomy: 'yolo' },
    );
    assert(background.success === true && background.started === true && typeof background.task_id === 'string', `Brak pokwitowania tła: ${JSON.stringify(background)}.`);
    const backgroundTask = plugin.subTaskRegistry.getTask(background.task_id);
    assert(backgroundTask, `Rejestr nie ma biegu tła ${background.task_id}.`);
    const started = Date.now();
    while (backgroundTask.status === 'running' && Date.now() - started < 10000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert(backgroundTask.status === 'done', `Status biegu tła=${backgroundTask.status}, oczekiwano terminalnego wpisu done zgodnościowego.`);
    assert(backgroundTask.result?.outcome?.end?.kind === 'limit', `Tło ma outcome.end=${JSON.stringify(backgroundTask.result?.outcome?.end)}.`);
    assert(backgroundTask.result?.outcome?.completeness === 'partial', `Tło ma completeness=${backgroundTask.result?.outcome?.completeness}.`);
    assert(JSON.stringify(backgroundTask.result.outcome) === JSON.stringify(blockingTask.result.outcome), `Outcome tła różni się od blokującego: background=${JSON.stringify(backgroundTask.result.outcome)}, blocking=${JSON.stringify(blockingTask.result.outcome)}.`);
    assert(backgroundTask.result?.outcome?.hasMaterial === true && backgroundTask.result?.outcome?.hasAnswer === false, `Tło ma niezgodne miary dorobku: ${JSON.stringify(backgroundTask.result?.outcome)}.`);
    assert(backgroundTask.result?.handoff?.includes(FILE), `Bieg tła nie zachował odczytu w handoff: ${JSON.stringify(backgroundTask.result?.handoff)}.`);
    assert(state.transcripts.slice(transcriptStart).some((transcript) => transcript.includes('To jest notatka-rekwizyt w atrapie vaulta harnessa.')), 'Pełny transkrypt żądania modelu biegu w tle nie zawiera wyniku read.');
    const backgroundTrace = ownTrace(await subTraceEvents({ plugin, vaultRoot }, backgroundTask.name), backgroundTask);
    const backgroundEnd = loopEnd(backgroundTrace);
    assert(backgroundEnd?.stop === 'backstop' && backgroundEnd.iters === MAX_ITERATIONS, `Trace tła: ${JSON.stringify(backgroundEnd)}.`);
    assert(toolPosts(backgroundTrace).filter((post) => post.tool === 'read' && post.status === 'ok').length === MAX_ITERATIONS, `Trace tła nie ma ${MAX_ITERATIONS} kroków read/ok.`);
    assert(backgroundTask.steps.filter((step: FixturePayload) => step.type === 'tool.post' && step.fields?.tool === 'read' && step.fields?.status === 'ok').length === MAX_ITERATIONS, `Rejestr tła nie ma ${MAX_ITERATIONS} kroków read/ok.`);
    assert(state.reads === MAX_ITERATIONS, `Fake model zwrócił ${state.reads} odpowiedzi suba w tle, oczekiwano ${MAX_ITERATIONS}.`);
  },
} satisfies Scenario);
