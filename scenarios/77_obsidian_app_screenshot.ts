import { requestImageParts, textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { fakeCaptureCalls, fakeCaptureResizes, resetFakeCapture, setFakeCapture } from '../test-support/electron.js';
import { chatFixture } from './_chat_fixture.js';
import { assert } from './_asserts.js';
import type { FixturePayload, Scenario } from './_asserts.js';

const origin = { agentName: 'Tester', sessionPath: 'Chats/screenshot.md', sessionEpoch: 'screenshot', tabKey: 'screenshot' };
const requests: FixturePayload[] = [];
let active = false;

export default ({
  file: '77_obsidian_app_screenshot', name: 'obsidian app screenshot',
  opis: 'Zrzut przez czat oraz odmowa przy widocznej karcie No-Go.', agent: 'Tester', autonomy: 'edge', approve: 'auto',
  liveSkip: 'Wymaga atrapy zrzutu i deterministycznego modelu.',
  fixtures: [
    { path: '.pkm-assistant/settings.json', content: JSON.stringify({ pkmAssistant: {
      chat: { platform: 'lm_studio', apiKeys: {}, models: { lm_studio: 'gpt-5' }, hosts: {}, temperature: 0.7, maxTokens: 4096 },
      obsidianAppEnabled: true, no_go_folders: ['Sekrety'], traceEnabled: true, fileLogEnabled: true,
      modelLibrary: { main: [{ platform: 'lm_studio', model: 'gpt-5', isDefault: true }] },
    } }) },
    { path: '.pkm-assistant/agents/tester.yaml', content: 'name: Tester\nmodel: lm_studio/gpt-5\naccess_policy_version: 2\nadmin_access: false\ndefault_permissions:\n  memory: true\n  guidance_mode: true\ndisabled_tools: []\ndefault_autonomy: edge\nmcp_servers:\n  - vault\n  - memory\n  - core\n  - app\n' },
  ],
  setup() { resetFakeCapture(); requests.length = 0; active = false; },
  offlineScript({ request }: FixturePayload) {
    if (!active) return textTurn('Gotowe.');
    requests.push(request);
    return request.messages.some((message: FixturePayload) => message.role === 'tool')
      ? textTurn('Zakończono.') : toolCallTurn('obsidian_app', { action: 'screenshot' });
  },
  async asserts({ plugin }: FixturePayload) {
    try {
      active = true;
      setFakeCapture({ width: 3000, height: 2000, bytes: new Uint8Array([255, 216, ...Array(30).fill(123), 255, 217]) });
      const allowed = plugin.app.vault.getAbstractFileByPath('Notatki/powitanie.md');
      assert(allowed != null, 'Brak dozwolonej notatki.');
      const leaves: FixturePayload[] = [];
      plugin.app.workspace.iterateAllLeaves((leaf: FixturePayload) => leaves.push(leaf));
      if (leaves.length === 0) leaves.push(plugin.app.workspace.getLeaf());
      for (const leaf of leaves) await leaf.openFile(allowed);
      let approvals = 0;
      plugin.approvalManager.setApprovalHandler(() => { approvals++; return { result: 'approve', reason: '' }; });
      const first = chatFixture(plugin, origin);
      first.view.currentAutonomy = 'edge';
      await first.view.send_message({ injectedText: 'Zrób zrzut.' });
      assert(first.errors.length === 0, `Błędy czatu: ${first.errors.map(String)}`);
      assert(requests.length === 2, `Liczba zapytań: ${requests.length}`);
      const images = requestImageParts(requests[1]);
      assert(images.length === 1 && images[0].role === 'user' && images[0].url.startsWith('data:image/jpeg;base64,'), `Obrazy: ${JSON.stringify(images)}, wiadomości: ${JSON.stringify(requests[1].messages.slice(-3))}`);
      const tools = requests[1].messages.filter((m: FixturePayload) => m.role === 'tool');
      assert(tools.length === 1 && !/base64|data:image/.test(JSON.stringify(tools)), `Wynik narzędzia: ${JSON.stringify(tools)}`);
      assert(JSON.stringify(fakeCaptureResizes()) === JSON.stringify([{ width: 1568, height: 1045 }]), `Resize: ${JSON.stringify(fakeCaptureResizes())}`);
      assert(first.events.some((event: FixturePayload) => event.type === 'mcp_call') && !JSON.stringify(first.events).includes('base64,'), `Zdarzenia sesji: ${JSON.stringify(first.events)}`);
      assert(first.persisted.some((entry: string) => entry.includes('[image image/jpeg')) && !first.persisted.join('').includes('e3t7e3t7e3t7'), `Zapis sesji: ${first.persisted.join('')}`);
      assert(approvals === 1, `Liczba zgód: ${approvals}`);
      assert(fakeCaptureCalls() === 1, `Liczba zrzutów: ${fakeCaptureCalls()}`);

      resetFakeCapture();
      setFakeCapture({ width: 3000, height: 2000, bytes: new Uint8Array([255, 216, ...Array(30).fill(123), 255, 217]) });
      requests.length = 0;
      const file = plugin.app.vault.getAbstractFileByPath('Sekrety/tajne.md');
      assert(file != null, 'Brak pliku No-Go w fixture.');
      const secretLeaf = plugin.app.workspace.getLeaf(true);
      await secretLeaf.openFile(file);
      secretLeaf.view.containerEl = { isShown: () => true };
      const second = chatFixture(plugin, origin);
      second.view.currentAutonomy = 'edge';
      await second.view.send_message({ injectedText: 'Zrób drugi zrzut.' });
      assert(second.errors.length === 0 && requests.length === 2, `Błędy lub zapytania: ${second.errors.map(String)}, ${requests.length}`);
      const rejected = requests[1].messages.filter((m: FixturePayload) => m.role === 'tool');
      assert(rejected.length === 1 && JSON.stringify(rejected).includes('restricted_content_visible'), `Odmowa: ${JSON.stringify(rejected)}`);
      assert(fakeCaptureCalls() === 0 && requestImageParts(requests[1]).length === 0, `Zrzuty: ${fakeCaptureCalls()}, obrazy: ${JSON.stringify(requestImageParts(requests[1]))}`);
    } finally { active = false; resetFakeCapture(); plugin.subTaskNotifier.setNoticeDeliverer(null); }
  },
} satisfies Scenario);
