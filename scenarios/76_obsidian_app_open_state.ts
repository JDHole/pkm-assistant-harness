import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert, assertToolErrored } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

let stateResult: FixturePayload = null;
let step = 0;

export default ({
  file: '76_obsidian_app_open_state',
  name: 'obsidian app open state',
  opis: 'Otwórz notatkę, sprawdź stan i odmowę No-Go.',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  liveSkip: 'Scenariusz wymaga dokładnej kolejności wywołań.',
  fixtures: [
    { path: '.pkm-assistant/settings.json', content: JSON.stringify({ pkmAssistant: {
      chat: { platform: 'deepseek', apiKeys: {}, models: { deepseek: 'deepseek-chat' }, hosts: {}, temperature: 0.7, maxTokens: 4096 },
      obsidianAppEnabled: true, no_go_folders: ['Sekrety'], traceEnabled: true, fileLogEnabled: true,
      modelLibrary: { main: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }] },
    } }) },
    { path: '.pkm-assistant/agents/tester.yaml', content: 'name: Tester\naccess_policy_version: 2\nadmin_access: false\ndefault_permissions:\n  memory: true\n  guidance_mode: true\ndisabled_tools: []\ndefault_autonomy: edge\nmcp_servers:\n  - vault\n  - memory\n  - core\n  - app\n' },
  ],
  setup() { stateResult = null; step = 0; },
  offlineScript(ctx: FixturePayload) {
    const results = lastToolResults(ctx.request);
    if (step++ === 0) return toolCallTurn('obsidian_app', { action: 'open', path: 'Notatki/powitanie.md' });
    if (step === 2) return toolCallTurn('obsidian_app', { action: 'state' });
    if (step === 3) {
      stateResult = JSON.parse(results[0]);
      return toolCallTurn('obsidian_app', { action: 'open', path: 'Sekrety/tajne.md' });
    }
    return textTurn('Otworzono notatkę; dostęp do Sekretów jest zabroniony.');
  },
  asserts({ result, plugin }: FixturePayload) {
    const calls = result.toolCallDetails.filter((entry: FixturePayload) => entry.name === 'obsidian_app');
    assert(calls.length === 3, `Oczekiwano trzech wywołań: ${JSON.stringify(calls)}`);
    const opened = JSON.parse(calls[0].resultPreview);
    assert(opened.ok === true && opened.verified === true && opened.effect === 'changed', `Wynik open: ${JSON.stringify(opened)}`);
    const state = stateResult;
    assert(state?.data, `Wynik state: ${JSON.stringify(state)}`);
    assert(state.data.active_path === 'Notatki/powitanie.md', `Stan: ${JSON.stringify(state)}`);
    assert(state.data.tabs.some((tab: FixturePayload) => tab.path === 'Notatki/powitanie.md' && tab.active === true), `Karty: ${JSON.stringify(state.data.tabs)}`);
    assertToolErrored(result, 'obsidian_app');
    assert(plugin.app.workspace.getActiveFile()?.path === 'Notatki/powitanie.md', 'Odmowa zmieniła aktywny plik.');
  },
} satisfies Scenario);
