/**
 * 54_zapis_raz_i_izolacja: pojedynczy zapis, sprawdzony efekt i właściwa sesja.
 *
 * Co realnie sprawdza: produkcyjny sub zapisuje plik raz, kończy się limitem, a efekt ze
 * stanem celu `matches` zostaje przekazany prowadzącemu. W trakcie biegu aktywny agent jest
 * przełączany, by wykryć przeciek bloku biegu suba do obcej sesji.
 *
 * Inwarianty:
 *   1. write wykonał się dokładnie raz i plik ma literalną treść,
 *   2. outcome rejestru i effect handoff mają limit/partial oraz check matches,
 *   3. blok `subagent_call` trafia do sesji właściciela, a Podglądacz nie ma sesji.
 */
import fs from 'node:fs';
import path from 'node:path';
import { textTurn, toolCallTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert, listVaultFiles, readVaultFile, subTraceEvents } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const OWNER = 'Tester';
const OTHER = 'Podgladacz';
const FILE = 'Notatki/limit-write-once.md';
const CONTENT = 'zapis wykonany raz przez suba';
const OWNER_SESSION = '.pkm-assistant/agents/tester/memory/sessions/active';
const OTHER_SESSION = '.pkm-assistant/agents/podgladacz/memory/sessions/active';
const state = { writes: 0, switched: 0 };

function isSub(request: FixturePayload): boolean {
  const system = (request?.messages || []).find((message: FixturePayload) => message?.role === 'system');
  const content = Array.isArray(system?.content) ? system.content.map((part: FixturePayload) => part?.text || '').join('\n') : system?.content;
  return typeof content === 'string' && /Jesteś sub-agentem /.test(content);
}

function agentYaml(name: string, description: string): string {
  return [
    `name: ${name}`,
    `description: ${description}`,
    'personality: |',
    `  Jesteś ${name}, agent testowy harnessa.`,
    'access_policy_version: 2',
    'admin_access: false',
    'default_permissions:',
    '  memory: true',
    '  guidance_mode: true',
    'disabled_tools: []',
    'default_autonomy: yolo',
    'mcp_servers:',
    '  - vault',
    '  - memory',
    '  - core',
    '',
  ].join('\n');
}

export default ({
  file: '54_zapis_raz_i_izolacja',
  name: 'jeden zapis, sprawdzony efekt i właściwa sesja',
  opis: 'limit po jednym zapisie zachowuje efekt i blok biegu w sesji zlecającego',
  agent: OWNER,
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 3,
  liveSkip: 'wymaga wymuszonego zapisu, limitu suba i przełączenia agenta w trakcie',

  fixtures: [
    { path: '.pkm-assistant/agents/tester.yaml', content: agentYaml(OWNER, 'Właściciel zlecenia scenariusza.') },
    { path: '.pkm-assistant/agents/podgladacz.yaml', content: agentYaml(OTHER, 'Agent przełączony w trakcie biegu.') },
  ],

  async setup({ plugin }: FixturePayload) {
    state.writes = 0;
    state.switched = 0;
    const limits = plugin.env.settingsStore.raw.pkmAssistant.limits ??= {};
    limits.subagent_max_iterations_worker = 1;
    limits.model_synthesis_timeout_ms = 0;
    Object.assign(plugin.env.settings.pkmAssistant.limits ??= {}, limits);
    const originalExecute = plugin.mcpClient.executeToolCall.bind(plugin.mcpClient);
    plugin.mcpClient.executeToolCall = async (call: FixturePayload, ...rest: FixturePayload[]) => {
      if (call?.name === 'write') state.writes += 1;
      return originalExecute(call, ...rest);
    };
    plugin.subTaskRegistry.events.on('task:created', () => {
      plugin.agentManager.switchAgent(OTHER);
      state.switched += 1;
    });
  },

  offlineScript: (ctx: FixturePayload) => {
    if (isSub(ctx.request)) {
      return toolCallTurn('write', { path: FILE, content: CONTENT, mode: 'create' });
    }
    if (lastToolResults(ctx.request).length === 0) return toolCallTurn('delegate', { task: 'Zapisz notatkę raz i oddaj dorobek.', aspect: 'worker' });
    return textTurn('Zlecenie przekazane do suba.');
  },

  async asserts({ result, plugin, vaultRoot }: FixturePayload) {
    assert(result?.finalText === 'Zlecenie przekazane do suba.', `Odpowiedź tury głównej=${JSON.stringify(result?.finalText)}.`);
    assert(state.writes === 1, `Licznik wywołań write=${state.writes}, oczekiwano 1.`);
    assert(fs.readFileSync(path.join(vaultRoot, FILE), 'utf8') === CONTENT, `Treść ${FILE} nie jest literalnym wynikiem zapisu.`);
    assert(state.switched === 1 && plugin.agentManager.getActiveAgent()?.name === OTHER, `Przełączenie na ${OTHER} nie zaszło: ${state.switched}.`);
    const tasks = plugin.subTaskRegistry.list();
    const task = tasks[0];
    assert(tasks.length === 1 && task?.result?.outcome, `Rejestr ma ${tasks.length} biegów albo brak outcome.`);
    assert(task.result.outcome.end.kind === 'limit' && task.result.outcome.end.reason === 'iteration-limit', `outcome.end=${JSON.stringify(task.result.outcome.end)}.`);
    assert(task.result.outcome.completeness === 'partial' && task.result.outcome.hasMaterial === true, `outcome.completeness/hasMaterial=${JSON.stringify(task.result.outcome)}.`);
    const effect = task.result.outcome.effects.find((item: FixturePayload) => item.tool === 'write');
    assert(effect?.outcome === 'returned' && effect.check === 'matches', `Efekt zapisu=${JSON.stringify(effect)}.`);
    assert(typeof task.result.handoff === 'string' && task.result.handoff.includes(FILE), `Handoff nie zawiera ${FILE}: ${JSON.stringify(task.result.handoff)}.`);
    assert(task.result.handoff.includes('matches'), `Handoff nie przekazał literalnego stanu matches: ${task.result.handoff}.`);
    const ownerFiles = listVaultFiles(vaultRoot, OWNER_SESSION).filter((file: string) => file.endsWith('.md'));
    assert(ownerFiles.length === 1, `Sesja właściciela ma ${ownerFiles.length} plików: ${ownerFiles.join(', ')}.`);
    const journal = readVaultFile(vaultRoot, ownerFiles[0]);
    assert(/subagent[ _]call/.test(journal), `Brak bloku subagent_call w sesji właściciela: ${ownerFiles[0]}.`);
    const otherFiles = listVaultFiles(vaultRoot, OTHER_SESSION).filter((file: string) => file.endsWith('.md'));
    assert(otherFiles.length === 0, `Sesja ${OTHER} otrzymała obcy dziennik: ${otherFiles.join(', ')}.`);
    const events = await subTraceEvents({ plugin, vaultRoot }, task.name);
    assert(events.some((event) => event.type === 'tool.post' && event.fields.tool === 'write' && event.fields.status === 'ok'), `Trace nie ma write/ok: ${JSON.stringify(events.map((event) => event.fields))}.`);
    assert(events.filter((event) => event.type === 'loop.end').length === 1, 'Trace suba nie ma dokładnie jednego loop.end.');
  },
} satisfies Scenario);
