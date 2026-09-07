/**
 * 12_poczta_petla — dwa bezpieczniki `kom_send` + duch niezdradzony (S33 Z2 / S28 D6).
 *
 * Co realnie sprawdza (jednym biegiem, bo strażnicy trzymają stan w pamięci managera):
 *   1. RATE-LIMIT (B1) — `kom_send_rate_max: 2` z fixture'owych ustawień. Dwie wysyłki do
 *      Odbiorcy przechodzą, TRZECIA odbija się o limit i NIE tworzy pliku.
 *   2. HOP-LIMIT (B2) — w skrzynce Testera leży podłożona wiadomość z `hop: 2`. `kom_read`
 *      (ścieżka AGENTA) odnotowuje odczyt, więc następna wychodząca dostałaby `hop: 3` —
 *      i strażnik przerywa łańcuch odbić.
 *   3. DUCH (D6) — agent z `komunikator_visible: false` daje DOKŁADNIE ten sam błąd co zwykła
 *      literówka w nazwie i NIE pojawia się na liście dostępnych adresatów. Zero przecieku,
 *      że w ogóle istnieje.
 *
 * Autonomia `yolo`: `kom_send` jest YELLOW (ma toggle approvalu), więc w edge sypałby pytaniami.
 * yolo znosi PYTANIA, ale nie strażników — i dokładnie to tu widać.
 *
 * Inwarianty: 2 pliki w skrzynce Odbiorcy (ani jednego więcej), odmowy z właściwych powodów
 * (i18n, nie gołe klucze), obie odmowy „nieznany adresat" identycznego kształtu, `hop: 0`
 * w normalnie wysłanej wiadomości, skrzynka ducha w ogóle nie powstała, zero pytań o zgodę.
 */
import { toolCallTurn, textTurn } from '../mock/fake-llm-server.js';
import {
  exists, listVaultFiles, readVaultFile, loopEnd, assert,
} from './_asserts.js';

const INBOX = '.pkm-assistant/komunikator/inbox';
const ODBIORCA_INBOX = `${INBOX}/odbiorca`;
const DUCH_INBOX = `${INBOX}/duch`;
const PLANTED_ID = 'msg-1700000000000';
const PLANTED_PATH = `${INBOX}/tester/${PLANTED_ID}.md`;

/** Agent-adresat / agent-duch — minimalne YAML-e w formacie fixture'owych agentów. */
const agentYaml = (name: string, opis: string, extra: string[] = []) => [
  `name: ${name}`,
  `description: ${opis}`,
  'access_policy_version: 2',
  'admin_access: false',
  'default_permissions:',
  '  memory: true',
  '  guidance_mode: true',
  'disabled_tools: []',
  'default_autonomy: edge',
  ...extra,
  '',
].join('\n');

export default ({
  file: '12_poczta_petla',
  name: 'poczta petla',
  opis: 'kom_send: rate-limit + hop-limit blokują, duch i literówka dają ten sam błąd',
  agent: 'Tester',
  autonomy: 'yolo',
  approve: 'auto', // nieistotne — yolo nie pyta; sprawdzamy, że handler NIE był wołany
  maxIterations: 12,
  evidenceFiles: [ODBIORCA_INBOX, DUCH_INBOX, PLANTED_PATH],
  // Sekwencja jest ZAPROJEKTOWANA pod strażników (dokładnie 3 wysyłki do jednego adresata,
  // odczyt konkretnej wiadomości, potem wysyłka do ducha) — żywy model tego nie powtórzy.
  liveSkip: 'strażnicy wymagają ZAPROJEKTOWANEJ sekwencji wysyłek/odczytu (limit 2 + odczyt hop:2) — żywy model nie odtworzy jej deterministycznie',

  fixtures: [
    {
      // Ten sam fixture ustawień co bazowy, tylko z ciasnym limitem poczty (krótki scenariusz).
      path: '.pkm-assistant/settings.json',
      content: JSON.stringify({
        pkmAssistant: {
          chat: {
            platform: 'deepseek',
            apiKeys: {},
            models: { deepseek: 'deepseek-chat' },
            hosts: {},
            temperature: 0.7,
            maxTokens: 4096,
          },
          embedding: { provider: '', models: {}, apiKeys: {}, hosts: {} },
          komunikatorEnabled: true,
          cacheTelemetryEnabled: false,
          fileLogEnabled: true,
          traceEnabled: true,
          language: 'pl',
          defaultAutonomy: 'edge',
          no_go_folders: ['Sekrety'],
          limits: { kom_send_rate_max: 2 },
          modelLibrary: {
            main: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }],
            minion: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }],
            master: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }],
          },
          maxTokens: {
            deepseek: 2048, anthropic: 2048, openai: 2048, xai: 2048, gemini: 2048, ollama: 2048,
          },
        },
      }, null, 2),
    },
    {
      path: '.pkm-assistant/agents/odbiorca.yaml',
      content: agentYaml('Odbiorca', 'Agent-adresat testowy — widoczny w komunikatorze.'),
    },
    {
      path: '.pkm-assistant/agents/duch.yaml',
      content: agentYaml('Duch', 'Agent-duch — wylaczony z komunikatora (D6).', [
        'komunikator_visible: false',
      ]),
    },
    {
      // Podłożona wiadomość „już dwa razy odbita" — format 1:1 z `buildMessageMarkdown`.
      path: PLANTED_PATH,
      content: [
        '---',
        'type: kom-message',
        'od: "Odbiorca"',
        'do: "Tester"',
        'temat: "Odbita dwa razy"',
        'data: "2026-07-30 10:00"',
        'user_read: false',
        'ai_read: false',
        'hop: 2',
        '---',
        '',
        'To jest trzecie ogniwo lancucha odbic. Dalej juz nie powinno isc.',
        '',
      ].join('\n'),
    },
  ],

  offlineScript: [
    // 1-2: mieszczą się w limicie (kom_send_rate_max = 2)
    toolCallTurn('kom_send', { to: 'Odbiorca', subject: 'Pierwsza', content: 'Wiadomosc numer jeden.' }),
    toolCallTurn('kom_send', { to: 'Odbiorca', subject: 'Druga', content: 'Wiadomosc numer dwa.' }),
    // 3: limit wyczerpany → odmowa
    toolCallTurn('kom_send', { to: 'Odbiorca', subject: 'Trzecia', content: 'Wiadomosc numer trzy.' }),
    // odczyt podłożonej wiadomości hop:2 → nakręcenie licznika odbić
    toolCallTurn('kom_read', { id: PLANTED_ID }),
    // 4: hop 2+1 = 3 → łańcuch przerwany (hop sprawdzany PRZED rate-limitem)
    toolCallTurn('kom_send', { to: 'Odbiorca', subject: 'Odpowiedz', content: 'Odpisuje na odbita.' }),
    // duch i literówka — muszą dać ten sam błąd
    toolCallTurn('kom_send', { to: 'Duch', subject: 'Halo', content: 'Czy ktos tam jest?' }),
    toolCallTurn('kom_send', { to: 'NieIstnieje', subject: 'Halo', content: 'Czy ktos tam jest?' }),
    textTurn('Wysłałem co się dało, reszta odbiła się o bezpieczniki.'),
  ],

  asserts({ result, trace, vaultRoot, approvals, plugin }) {
    const sends = (result?.toolCallDetails || [])
      .filter((d: import('./_asserts.js').FixturePayload) => d.name === 'kom_send')
      .map((d: import('./_asserts.js').FixturePayload) => d.resultPreview || '');
    assert(sends.length === 6, `Oczekiwano 6 wywołań kom_send, jest ${sends.length}.`);

    // ── 1. Dwie pierwsze wysyłki utworzyły pliki, trzecia NIE ──
    const wyslane = listVaultFiles(vaultRoot, ODBIORCA_INBOX).filter((p) => p.endsWith('.md'));
    assert(wyslane.length === 2,
      `Skrzynka Odbiorcy ma ${wyslane.length} wiadomości, a miały być DOKŁADNIE 2 (trzecia odbita rate-limitem).`);
    assert(/"success"\s*:\s*true/.test(sends[0]) && /"success"\s*:\s*true/.test(sends[1]),
      `Dwie pierwsze wysyłki miały się udać. [0]=${sends[0].slice(0, 160)} [1]=${sends[1].slice(0, 160)}`);

    // ── 2. Trzecia = RATE-LIMIT (czytelny komunikat, nie goły klucz) ──
    assert(/"success"\s*:\s*false/.test(sends[2]), `Trzecia wysyłka NIE została odrzucona: ${sends[2].slice(0, 200)}`);
    assert(/Za dużo wiadomości|Too many messages/i.test(sends[2]),
      `Trzecia wysyłka odbita, ale nie rate-limitem: ${sends[2].slice(0, 200)}`);
    assert(!/mcp\.kom_send\.rate_limit/.test(sends[2]), `Goły klucz i18n zamiast komunikatu: ${sends[2].slice(0, 200)}`);

    // ── 3. Wysyłka PO odczycie hop:2 = HOP-LIMIT ──
    assert(/"success"\s*:\s*false/.test(sends[3]), `Wysyłka po odczycie hop:2 NIE została odrzucona: ${sends[3].slice(0, 200)}`);
    assert(/łańcuch odbić|Bounce chain/i.test(sends[3]),
      `Wysyłka po odczycie odbita, ale nie hop-limitem: ${sends[3].slice(0, 200)}`);
    assert(!/mcp\.kom_send\.hop_limit/.test(sends[3]), `Goły klucz i18n zamiast komunikatu: ${sends[3].slice(0, 200)}`);

    // ── 4. Duch i literówka: TEN SAM kształt odmowy, zero przecieku o duchu ──
    const duch = sends[4];
    const literowka = sends[5];
    assert(/Nieznany adresat|Unknown recipient/i.test(duch) && /Nieznany adresat|Unknown recipient/i.test(literowka),
      `Odmowy dla ducha i literówki miały być „nieznany adresat". duch=${duch.slice(0, 200)} literówka=${literowka.slice(0, 200)}`);
    const znormalizuj = (tekst: string, nazwa: string) => tekst.split(nazwa).join('<ADRESAT>');
    assert(znormalizuj(duch, 'Duch') === znormalizuj(literowka, 'NieIstnieje'),
      'Odmowa dla ducha ma INNY kształt niż dla literówki — po samym błędzie da się wywnioskować, że duch istnieje.\n'
      + `  duch:      ${duch.slice(0, 240)}\n  literówka: ${literowka.slice(0, 240)}`);
    for (const [etykieta, tekst] of [['duch', duch], ['literówka', literowka]]) {
      const lista = tekst.split(/Dostępni:|Available:/)[1] || '';
      assert(lista.length > 0, `Odmowa (${etykieta}) nie zawiera listy dostępnych adresatów: ${tekst.slice(0, 200)}`);
      assert(!/Duch/.test(lista), `Duch WYCIEKŁ na listę dostępnych adresatów (${etykieta}): ${lista.slice(0, 200)}`);
    }

    // ── 5. Normalna wysyłka niesie `hop: 0` (rozmowa z userem, nie odbicie) ──
    const pierwsza = readVaultFile(vaultRoot, wyslane[0]);
    assert(/^hop: 0$/m.test(pierwsza),
      `Wysłana wiadomość nie ma „hop: 0" we frontmatterze (${wyslane[0]}):\n${pierwsza.slice(0, 300)}`);

    // ── 6. Skrzynka ducha w ogóle nie powstała ──
    assert(!exists(vaultRoot, DUCH_INBOX),
      'Powstała skrzynka ducha — wysyłka do niewidzialnego agenta jednak coś zapisała.');

    // ── 7. K11 (AUD-security-047): duch nie wyciekł do PROMPTU SYSTEMOWEGO ──
    // Odmowa `kom_send` duchowi nie zdradzała, ale lista agentów w bloku `komunikacja`
    // szła z `getAllAgents()` — czyli imię I OPIS ducha widział każdy agent z pocztą,
    // zanim jeszcze cokolwiek wysłał. Pytamy produkcyjną drogę budowy promptu.
    const prompt = String(plugin?.agentManager?.getActiveSystemPrompt?.() || '');
    assert(prompt.length > 0, 'Nie udało się zbudować promptu systemowego — asercja o duchu nic nie sprawdza.');
    assert(/Odbiorca/.test(prompt),
      'Prompt nie niesie listy agentów poczty — asercja o duchu byłaby fałszywie zielona.');
    const sladDucha = (prompt.match(/[^\r\n]*Duch[^\r\n]*/g) || []).join(' | ').slice(0, 300);
    assert(sladDucha.length === 0,
      `Agent-duch WYCIEKŁ do promptu systemowego (nazwa i opis widoczne dla każdego agenta z pocztą): ${sladDucha}`);

    // ── 8. yolo = zero pytań, pętla domknięta naturalnie ──
    assert(Array.isArray(approvals) && approvals.length === 0,
      `yolo nie powinien pytać, a handler dostał ${approvals?.length} żądań: ${JSON.stringify(approvals)}`);
    const end = loopEnd(trace);
    assert(end && end.stop === 'natural', `Oczekiwano stop=natural, jest stop=${end?.stop}.`);
  },
} satisfies import('./_asserts.js').Scenario);
