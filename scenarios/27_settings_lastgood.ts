/**
 * 27_settings_lastgood — druga połowa pancerza ustawień: FALLBACK na kopię zapasową
 * + regresja fixa `parsedFromRaw` (2026-07-31, znalezisko Poligonu ze scenariusza 26).
 *
 * Scenariusz 26 sprawdza wariant „uszkodzony settings.json BEZ kopii zapasowej" (defaulty,
 * odkładka, śmieci nie awansują). Ten scenariusz sprawdza wariant z DOBRĄ kopią:
 *
 *   1. **Fallback działa.** Uszkodzony `settings.json` + zdrowy `settings.last-good.json`
 *      → plugin wstaje na wartościach z kopii zapasowej, nie na defaultach.
 *   2. **REGRESJA fixa `parsedFromRaw`:** przed fixem warunek backupu patrzył na `parsed`
 *      (który pochodził z last-good), a pisał `raw` (zepsutą treść z settings.json) —
 *      dobra kopia zapasowa ginęła nadpisana śmieciem. Po fixie last-good ma przeżyć
 *      boot NIETKNIĘTY (treść + mtime).
 *   3. Reszta pancerza bez zmian: uszkodzony plik na odkładkę 1:1, load niczego nie
 *      nadpisuje, dzienny backup NIE powstaje (bo `raw` się nie sparsował).
 *
 * Mostek klucza runnera działa tu normalnie — gałąź `pkmAssistant.chat` przyjeżdża
 * z last-good, więc (inaczej niż w 26) nie trzeba żadnego `setup()`.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  assert,
  assertFinalText,
  fileUnchanged,
  listVaultFiles,
  readVaultFile,
} from './_asserts.js';

import type { Scenario } from './_asserts.js';

const SETTINGS_REL = '.pkm-assistant/settings.json';
const LAST_GOOD_REL = '.pkm-assistant/settings.last-good.json';

/** Urwany JSON — ta sama klasa uszkodzenia co w scenariuszu 26 (czkawka dysku sieciowego). */
const USZKODZONE_USTAWIENIA = [
  '{',
  '  "pkmAssistant": { "chat": {',
  '    "platform": "deepseek",',
  '    "apiKeys": { "deepseek": "sk-SMIEC-PO-CZKAWCE-DYSKU" },',
  '  // <-- urwane w pol zdania, dalej nic sie nie parsuje',
].join('\n');

/**
 * Zdrowa kopia zapasowa = standardowe ustawienia fixture'a z DWOMA znacznikami
 * pochodzenia (`no_go_folders`, `language`), po których asercje poznają, że plugin
 * naprawdę wstał z last-good, a nie z defaultów ani ze strzępów uszkodzonego pliku.
 */
const LAST_GOOD_USTAWIENIA = JSON.stringify({
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
    fileLogEnabled: true,
    traceEnabled: true,
    language: 'pl',
    defaultAutonomy: 'edge',
    no_go_folders: ['SekretyZKopiiZapasowej'],
    modelLibrary: {
      main: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }],
    },
  },
}, null, 2);

const ODPOWIEDZ = 'Plugin wstal na kopii zapasowej last-good.';

export default ({
  file: '27_settings_lastgood',
  name: 'fallback last-good',
  opis: 'uszkodzony settings.json + zdrowy last-good: plugin wstaje z kopii zapasowej, a kopia przeżywa boot nietknięta (regresja fixa parsedFromRaw)',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'mechanizm ładowania ustawień nie zależy od modelu — bieg na żywym DeepSeeku niczego by nie dodał',

  fixtures: [
    { path: SETTINGS_REL, content: USZKODZONE_USTAWIENIA },
    { path: LAST_GOOD_REL, content: LAST_GOOD_USTAWIENIA },
  ],

  snapshotFiles: [SETTINGS_REL, LAST_GOOD_REL],
  evidenceFiles: [SETTINGS_REL, LAST_GOOD_REL],

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, before, plugin }) {
    // ── 1. Plugin wstał ──
    assert(plugin?._ready === true, 'Plugin nie doszedł do _ready — fallback na last-good nie uratował bootu.');
    assert(plugin?.env?.state === 'loaded', `env.state = ${plugin?.env?.state}, oczekiwano "loaded".`);

    // ── 2. REGRESJA parsedFromRaw: kopia zapasowa przeżyła boot NIETKNIĘTA ──
    // Uwaga: migawki `before` runner robi PO boocie, więc klobber z fazy load może w nich
    // już siedzieć — dowodem jest porównanie TREŚCI z fixturem, nie fileUnchanged.
    assert(
      readVaultFile(vaultRoot, LAST_GOOD_REL) === LAST_GOOD_USTAWIENIA,
      'KOPIA ZAPASOWA NADPISANA PODCZAS BOOTU — to jest bug sprzed fixa parsedFromRaw: warunek '
      + 'backupu patrzył na parsed (z last-good), a pisał raw (zepsutą treść settings.json). '
      + 'Po takiej wtopie user nie ma już z czego wracać.',
    );
    // …a fileUnchanged domyka fazę TURY (nic nie ruszyło kopii po boocie).
    fileUnchanged(
      before, vaultRoot, LAST_GOOD_REL,
      'Kopia zapasowa zmieniła się w trakcie tury — coś pisze do last-good poza load_settings.',
    );

    // ── 3. Ustawienia przyszły z last-good (nie defaulty, nie strzępy uszkodzonego pliku) ──
    const pkm = plugin?.env?.settings?.pkmAssistant || {};
    assert(
      Array.isArray(pkm.no_go_folders) && pkm.no_go_folders[0] === 'SekretyZKopiiZapasowej',
      `Znacznik pochodzenia nie zgadza się z last-good: no_go_folders = ${JSON.stringify(pkm.no_go_folders)} `
      + '— plugin nie wstał z kopii zapasowej.',
    );
    assert(
      plugin?.env?.settings?.pkmAssistant?.chat?.platform === 'deepseek',
      'Gałąź czatu nie przyjechała z last-good — fallback niepełny.',
    );

    // ── 4. Uszkodzony plik nietknięty (treść vs fixture = faza bootu) + odkładka 1:1 ──
    assert(
      readVaultFile(vaultRoot, SETTINGS_REL) === USZKODZONE_USTAWIENIA,
      'Boot nadpisał uszkodzony settings.json — materiał do ręcznego odzyskania przepadł '
      + '(regresja: bezwarunkowy save() w PKMEnv.load / migracja modelLibrary).',
    );
    fileUnchanged(
      before, vaultRoot, SETTINGS_REL,
      'settings.json zmienił się w trakcie tury — uszkodzony plik miał zostać nietknięty.',
    );
    const odkladki = listVaultFiles(vaultRoot, '.pkm-assistant')
      .filter((p) => /\.pkm-assistant\/settings\.corrupt-\d+\.json$/.test(p));
    assert(
      odkladki.length === 1,
      `Oczekiwano DOKŁADNIE jednej odkładki settings.corrupt-*.json, jest ${odkladki.length}: ${odkladki.join(', ') || '(brak)'}`,
    );
    assert(
      readVaultFile(vaultRoot, odkladki[0]) === USZKODZONE_USTAWIENIA,
      `Odkładka "${odkladki[0]}" nie jest kopią 1:1 uszkodzonego pliku.`,
    );

    // ── 5. Dzienny backup NIE powstał (raw się nie sparsował, więc nie awansuje) ──
    const backupy = listVaultFiles(vaultRoot, '.pkm-assistant/backups');
    assert(
      backupy.length === 0,
      `Dzienny backup powstał mimo nieczytelnego settings.json: ${backupy.join(', ')}`,
    );

    // ── 6. Tura działa normalnie na ustawieniach z kopii ──
    const finalText = assertFinalText(result, 'Pętla nie zwróciła odpowiedzi — plugin na last-good nie działa.');
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`,
    );
  },
} satisfies Scenario);
