/**
 * 26_settings_pancerz — regresja incydentu z 2026-07-28 (utrata ustawień z kluczami).
 *
 * CO SIĘ WTEDY STAŁO: `load_settings` ufał `exists()`. Przy czkawce dysku sieciowego (Google
 * Drive) plik „nie istniał", więc load robił `save_settings({})` i nadpisywał userowi ustawienia
 * — razem z kluczami API — pustką. Pancerz (E3.7, `core/PKMEnv.ts` `load_settings`) postawił
 * trzy zasady, których ten scenariusz pilnuje na ŻYWYM boocie pluginu:
 *
 *   1. **Load NICZEGO nie nadpisuje.** Plik ustawień tworzy dopiero pierwszy realny zapis.
 *   2. **Nieczytelny plik idzie na odkładkę** `.pkm-assistant/settings.corrupt-<ts>.json`
 *      (kopia 1:1 — materiał do ręcznego odzyskania), nigdy do kosza.
 *   3. **Śmieci nie awansują na kopię zapasową.** `settings.last-good.json` i dzienny backup
 *      w `.pkm-assistant/backups/` powstają WYŁĄCZNIE z treści, która się sparsowała
 *      (warunek `Object.keys(parsed).length > 0` w `load_settings`).
 *
 * A potem plugin ma po prostu wstać i działać — na defaultach, bez wywrotki.
 *
 * ⚠️ MOSTEK KLUCZA: runner wstrzykuje klucz DeepSeeka do gałęzi `chat`. Po utracie ustawień
 * gałąź istnieje, ale jest PUSTA (od clean-room fabryczne kontenery z `config/defaultSettings.ts`
 * są w każdym worku — na nich stoi reguła „hydratacja sekretu niczego nie dotwarza"), więc
 * `setup()` odtwarza minimalny wpis modelu — dokładnie to, co po incydencie musiał zrobić user:
 * wpisać klucz od nowa. I mostek, i `setup()` piszą do SUROWEGO worka (`settingsStore.raw`),
 * z pominięciem obserwującego proxy — inaczej mutacja zaplanowałaby zapis ustawień na dysk
 * i zafałszowała dowód z punktu 1.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  assert,
  assertFinalText,
  fileUnchanged,
  fileAbsent,
  listVaultFiles,
  readVaultFile,
} from './_asserts.js';

import { defaultSettings } from '../../config/defaultSettings.js';
import { DEFAULT_AUTONOMY } from '../../core/index.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SETTINGS_REL = '.pkm-assistant/settings.json';
const LAST_GOOD_REL = '.pkm-assistant/settings.last-good.json';

/**
 * Uszkodzony JSON: urwany w połowie obiektu, z komentarzem-nie-JSON-em. Kształt jest celowo
 * „prawie prawdziwy" (klucz API w środku), żeby dowód na odkładce miał sens — pancerz istnieje
 * po to, by user mógł te wartości odzyskać ręcznie.
 */
/** Klucz z uszkodzonego pliku — dowód „ta treść NIE wjechała do worka" (patrz `setup`). */
const KLUCZ_Z_USZKODZONEGO = 'sk-NIE-DO-STRACENIA-1234567890';

/** Migawka gałęzi `chat` sprzed odtworzenia modelu w `setup()` — materiał dla asercji 5. */
const stan: { chatPoDegradacji: FixturePayload } = { chatPoDegradacji: null };

const USZKODZONE_USTAWIENIA = [
  '{',
  '  "pkmAssistant": { "chat": {',
  '    "platform": "deepseek",',
  `    "apiKeys": { "deepseek": "${KLUCZ_Z_USZKODZONEGO}" },`,
  '  // <-- tu dysk sieciowy uciął zapis, dalej jest smiec',
  '  "pkmAssistant": { "no_go_folders": ["Sekrety"',
].join('\n');

const ODPOWIEDZ = 'Plugin wstal na defaultach, mimo uszkodzonego pliku ustawien.';

export default ({
  file: '26_settings_pancerz',
  name: 'pancerz ustawien',
  opis: 'uszkodzony settings.json: load nic nie nadpisuje, powstaje odkładka corrupt, śmieci nie awansują na last-good, plugin działa na defaultach',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'mechanizm ładowania ustawień nie zależy od modelu — bieg na żywym DeepSeeku niczego by nie dodał',

  fixtures: [
    { path: SETTINGS_REL, content: USZKODZONE_USTAWIENIA },
  ],

  snapshotFiles: [SETTINGS_REL],
  evidenceFiles: [SETTINGS_REL, LAST_GOOD_REL],

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  /** Odtworzenie minimalnej konfiguracji modelu (patrz „MOSTEK KLUCZA" w nagłówku). */
  async setup({ plugin }) {
    const worek = plugin?.env?.settingsStore.raw as FixturePayload;
    if (!worek) throw new Error('Brak settingsStore.raw — bootstrap środowiska nieukończony?');
    // Dowód „to naprawdę są defaulty": gałąź `chat` ISTNIEJE (fabryczne kontenery z
    // `config/defaultSettings.ts` — na nich stoi reguła o hydratacji sekretów), ale nie niesie
    // ANI JEDNEJ wartości z uszkodzonego pliku. Sprawdzamy WARTOŚCI, nie samo istnienie gałęzi:
    // pusty `platform`, brak wyboru modelu i brak klucza z pliku (ten jeden wpis w `apiKeys`,
    // który tu jest, wstrzyknął mostek runnera linijkę wcześniej).
    const chat = worek.pkmAssistant?.chat ?? {};
    // Migawka SPRZED odtworzenia modelu — asercja 5 sprawdza na niej, że to naprawdę fabryka.
    stan.chatPoDegradacji = { ...chat, apiKeys: { ...(chat.apiKeys ?? {}) } };
    const przeciekloDoWorka = Boolean(chat.platform)
      || Object.keys(chat.models ?? {}).length > 0
      || JSON.stringify(worek.pkmAssistant ?? {}).includes(KLUCZ_Z_USZKODZONEGO);
    if (przeciekloDoWorka) {
      throw new Error(
        'Ustawienia wczytały się MIMO uszkodzonego pliku — fixture nie zadziałał albo pancerz '
        + `wziął dane z innego źródła (chat: ${JSON.stringify(chat)}). `
        + 'Scenariusz sprawdzałby wtedy co innego niż deklaruje.',
      );
    }
    worek.pkmAssistant = {
      ...(worek.pkmAssistant ?? {}),
      chat: {
        platform: 'deepseek',
        models: { deepseek: 'deepseek-chat' },
        apiKeys: { deepseek: 'harness-offline-dummy' },
        hosts: {},
      },
    };
  },

  async asserts({ result, vaultRoot, before, plugin }) {
    // ── 1. Plugin wstał (bez wywrotki na nieczytelnym pliku) ──
    assert(plugin?._ready === true, 'Plugin nie doszedł do _ready — uszkodzony settings.json wywalił bootstrap.');
    assert(plugin?.env?.state === 'loaded', `env.state = ${plugin?.env?.state}, oczekiwano "loaded".`);
    assert(
      (plugin?.agentManager?.agents?.size ?? 0) >= 2,
      `Agenci się nie wczytali (${plugin?.agentManager?.agents?.size ?? 0}) — bootstrap padł po drodze.`,
    );

    // ── 2. Load NICZEGO nie nadpisał (sedno incydentu) ──
    // Migawki `before` powstają PO boocie, więc nadpisanie w fazie load byłoby w nich
    // niewidzialne — fazę bootu dowodzi porównanie TREŚCI z fixturem, fileUnchanged fazę tury.
    assert(
      readVaultFile(vaultRoot, SETTINGS_REL) === USZKODZONE_USTAWIENIA,
      'LOAD NADPISAŁ USTAWIENIA PODCZAS BOOTU — to jest dokładnie wtopa z 2026-07-28. '
      + 'Uszkodzony settings.json ma zostać nietknięty (materiał do ręcznego odzyskania).',
    );
    fileUnchanged(
      before, vaultRoot, SETTINGS_REL,
      'settings.json zmienił się w trakcie tury — uszkodzony plik miał zostać nietknięty.',
    );

    // ── 3. Odkładka corrupt powstała, z treścią 1:1 ──
    const odkladki = listVaultFiles(vaultRoot, '.pkm-assistant')
      .filter((p) => /\.pkm-assistant\/settings\.corrupt-\d+\.json$/.test(p));
    assert(
      odkladki.length === 1,
      `Oczekiwano DOKŁADNIE jednej odkładki settings.corrupt-*.json, jest ${odkladki.length}: ${odkladki.join(', ') || '(brak)'}`,
    );
    assert(
      readVaultFile(vaultRoot, odkladki[0]) === USZKODZONE_USTAWIENIA,
      `Odkładka "${odkladki[0]}" nie jest kopią 1:1 uszkodzonego pliku — user nie odzyska z niej klucza.`,
    );

    // ── 4. Śmieci NIE awansują na kopię zapasową ──
    fileAbsent(
      vaultRoot, LAST_GOOD_REL,
      'settings.last-good.json powstał z NIECZYTELNEJ treści — kopia zapasowa zostałaby zaśmiecona '
      + 'i przy kolejnym starcie nie byłoby z czego wracać.',
    );
    const backupy = listVaultFiles(vaultRoot, '.pkm-assistant/backups');
    assert(
      backupy.length === 0,
      `Dzienny backup powstał z nieczytelnej treści: ${backupy.join(', ')}`,
    );

    // ── 5. Plugin pracuje na DEFAULTACH (a nie na resztkach uszkodzonego pliku) ──
    //
    // Dowodem jest gałąź `chat` W MIGAWCE ZE `setup()` — czyli sprzed odtworzenia modelu przez
    // usera: uszkodzony plik miał tam platformę „deepseek", a po degradacji siedzą DOKŁADNIE
    // wartości fabryczne. Drugim dowodem jest `defaultAutonomy: 'edge'` — klucz siedzi w worku
    // fabrycznym WPROST (suwak autonomii w Ustawieniach ma co pokazać), a osobna asercja pilnuje,
    // że nawet gdyby go zabrakło, efektywna autonomia dalej jest `edge`: wszyscy czytelnicy
    // spadają na `DEFAULT_AUTONOMY`.
    const pkm = plugin?.env?.settings?.pkmAssistant || {};
    const fabrycznyChat = defaultSettings().pkmAssistant?.chat ?? {};
    const poDegradacji = stan.chatPoDegradacji ?? {};
    assert(
      poDegradacji.platform === fabrycznyChat.platform
      && poDegradacji.temperature === fabrycznyChat.temperature
      && poDegradacji.maxTokens === fabrycznyChat.maxTokens
      && Object.keys(poDegradacji.models ?? {}).length === 0,
      'Ustawienia po degradacji nie wyglądają na fabryczne — gałąź `chat` nie zgadza się z '
      + `\`config/defaultSettings.ts\` (jest ${JSON.stringify(poDegradacji)}, fabryka: ${JSON.stringify(fabrycznyChat)}).`,
    );
    assert(
      pkm.defaultAutonomy === 'edge',
      'Worek fabryczny nie niesie `pkmAssistant.defaultAutonomy` — suwak autonomii w Ustawieniach '
      + `nie ma czego pokazać po degradacji (jest ${JSON.stringify(pkm.defaultAutonomy)}).`,
    );
    assert(
      (pkm.defaultAutonomy ?? DEFAULT_AUTONOMY) === 'edge',
      'Efektywna autonomia po degradacji do defaultów nie jest „edge" — plugin po utracie ustawień '
      + 'pracowałby luźniej, niż user kiedykolwiek zgodził się pracować.',
    );
    assert(
      pkm.no_go_folders === undefined,
      'Z uszkodzonego pliku przeciekła wartość no_go_folders — parser miał odrzucić CAŁOŚĆ, '
      + `a nie sklejać strzępy: ${JSON.stringify(pkm.no_go_folders)}`,
    );

    // ── 6. …i normalnie prowadzi turę ──
    const finalText = assertFinalText(result, 'Pętla nie zwróciła odpowiedzi — plugin na defaultach nie działa.');
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`,
    );

    // ── 7. Domknięcie: plik ustawień dalej nietknięty PO całej turze ──
    fileUnchanged(
      before, vaultRoot, SETTINGS_REL,
      'settings.json zmienił się w trakcie tury — coś zapisało ustawienia mimo braku zmiany od usera.',
    );
  },
} satisfies Scenario);
