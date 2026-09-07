/**
 * 39_boot_nie_pisze — trzecia część pancerza ustawień: **ZDROWY** settings.json ma przeżyć
 * boot nietknięty, co do bajta.
 *
 * Scenariusze 26 i 27 pilnują wariantów z USZKODZONYM plikiem (defaulty / fallback last-good).
 * Ten pilnuje wariantu codziennego: plik jest w porządku, user nic nie zmienił — więc plugin
 * NIE MA PRAWA go przepisać. Każdy bootowy pisarz ustawień to ta sama klasa ryzyka co incydent
 * z 2026-07-28: gdyby `load_settings` kiedykolwiek zdegradował się do defaultów (dysk sieciowy
 * potrafi skłamać o istnieniu pliku), zaplanowany przy starcie zapis UTRWALIŁBY defaulty na dysku
 * i skasował userowi plik z kluczami API.
 *
 * ŁAPIE KONKRETNIE (znalezisko 2026-07-31, zaszłość SPRZED clean-room): getter kolekcji modeli
 * embeddingu tworzył przy każdym starcie nowy model ze stemplem `<provider>#<Date.now()>` i
 * wpisywał jego klucz do ustawień. Mechanizm efemerycznych modeli ZNIKNĄŁ W CAŁOŚCI w clean-room —
 * `EmbeddingRegistry` nie ma stanu na dysku, więc nie ma czego leczyć ani co psuć przy boocie.
 * Dowodem tego samego ryzyka jest dziś: `EmbeddingRegistry.default` (getter CZYSTY, nie mutuje
 * ustawień, nie planuje zapisu) rozstrzyga dostawcę z ustawień usera.
 *
 * ⚠️ FIXTURE MUSI NEUTRALIZOWAĆ CZYSTO HARNESSOWE I POBOCZNE ZAPISY — inaczej scenariusz
 * świeciłby na czerwono z cudzego powodu:
 *   1. `deepseek_api_key` jest już w pliku z wartością, którą wstrzykuje mostek klucza runnera
 *      (`_runner.ts`). Proxy ustawień (`SettingsStore`) woła `on_change` tylko przy REALNEJ
 *      zmianie wartości, więc identyczne przypisanie jest niewidzialne.
 *   2. `pkmAssistant.modelLibrary` istnieje — bez niego jednorazowa migracja
 *      `_migrateToModelLibrary` zapisałaby ustawienia świadomie i słusznie.
 *
 * ⚠️ MIGAWKI KŁAMIĄ O FAZIE BOOTU: `before` runner robi PO wstaniu pluginu, więc nadpisanie
 * z fazy load/init byłoby w nich niewidzialne. Fazę bootu dowodzi porównanie TREŚCI z fixturem,
 * `fileUnchanged` dowodzi fazy tury. Ta sama pułapka jest opisana w 26 i 27.
 *
 * ⚠️ SAM PLIK NIE WYSTARCZY ZA DOWÓD (zweryfikowane empirycznie na kodzie SPRZED naprawy):
 * ustawienia zapisują się z debounce ~1 s, a cały scenariusz — boot, tura, sprzątanie — bywa
 * szybszy; `cleanupPlugin` na koniec robi `clearTimeout(pendingSaveTimer)`, więc ZAPLANOWANY zapis
 * potrafi nigdy nie dotknąć dysku. Dlatego asercje sprawdzają TRZY rzeczy naraz: treść pliku
 * (zapis, który zdążył wypaść), WISZĄCY `pendingSaveTimer` (zapis zaplanowany, jeszcze niewypadły)
 * i wartość w RAM-owym worku (sama mutacja). Bug sprzed naprawy pokazywał się jako dwa ostatnie.
 *
 * ⚠️ W logu biegu pojawia się `[PKM:VaultIndexer] initialize failed: embed failed: API key not set`
 * — to ZAMIERZONE i jest częścią konstrukcji (patrz komentarz przy `USTAWIENIA`), nie awaria.
 */
import { textTurn } from '../mock/fake-llm-server.js';
import {
  assert,
  assertFinalText,
  fileUnchanged,
  listVaultFiles,
  readVaultFile,
} from './_asserts.js';

import { defaultSettings } from '../../config/defaultSettings.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const SETTINGS_REL = '.pkm-assistant/settings.json';
const LAST_GOOD_REL = '.pkm-assistant/settings.last-good.json';

/** JSON z kluczami w stałej kolejności — porównanie worków nie może zależeć od kolejności pól. */
function stabilnyJson(value: unknown): string {
  return JSON.stringify(value, (_klucz, wartosc: unknown) => {
    if (!wartosc || typeof wartosc !== 'object' || Array.isArray(wartosc)) return wartosc;
    const worek = wartosc as Record<string, unknown>;
    return Object.fromEntries(Object.keys(worek).sort().map((k) => [k, worek[k]]));
  });
}

/**
 * ZDROWE ustawienia usera — kształt 1:1 z tym, co siedzi w produkcyjnym vaulcie: dostawca
 * embeddingu jest WYBRANY, a rejestr (`EmbeddingRegistry`) nie ma żadnego stanu na dysku do
 * leczenia przy starcie — to dokładnie ten splot, który do clean-room odpalał wtopę.
 *
 * Provider `openai` BEZ klucza API jest tu celowy: `EmbeddingModel` odrzuca embedowanie PRZED
 * żądaniem HTTP („API key not set"), więc produkcyjny `VaultIndexer` kończy na statusie `error`
 * bez ANI JEDNEGO strzału w sieć. Wtopa jest provider-agnostyczna — liczy się sam fakt wyboru
 * providera.
 */
const USTAWIENIA = JSON.stringify({
  pkmAssistant: {
    chat: {
      platform: 'deepseek',
      models: { deepseek: 'deepseek-chat' },
      apiKeys: { deepseek: 'harness-offline-dummy' },
      hosts: {},
    },
    embedding: {
      provider: 'openai',
      models: { openai: 'text-embedding-3-small' },
      apiKeys: {},
    },
    komunikatorEnabled: true,
    fileLogEnabled: true,
    traceEnabled: true,
    language: 'pl',
    defaultAutonomy: 'edge',
    no_go_folders: ['Sekrety'],
    modelLibrary: {
      main: [{ platform: 'deepseek', model: 'deepseek-chat', isDefault: true }],
    },
  },
}, null, 2);

const ODPOWIEDZ = 'Boot nie tknal pliku ustawien.';

export default ({
  file: '39_boot_nie_pisze',
  name: 'boot nie pisze ustawień',
  opis: 'zdrowy settings.json z wybranym providerem embeddingów: boot nie planuje zapisu, plik zostaje co do bajta',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 2,
  liveSkip: 'bootowi pisarze ustawień nie zależą od modelu — bieg na żywym DeepSeeku niczego by nie dodał',

  fixtures: [
    { path: SETTINGS_REL, content: USTAWIENIA },
  ],

  snapshotFiles: [SETTINGS_REL],
  evidenceFiles: [SETTINGS_REL, LAST_GOOD_REL],

  offlineScript: [
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot, before, plugin }) {
    // ── 1. Plugin wstał na TYCH ustawieniach (nie na defaultach, nie na last-good) ──
    assert(plugin?._ready === true, 'Plugin nie doszedł do _ready.');
    assert(plugin?.env?.state === 'loaded', `env.state = ${plugin?.env?.state}, oczekiwano "loaded".`);
    assert(
      plugin?.env?.settings?.pkmAssistant?.embedding?.provider === 'openai',
      'Ustawienia nie przyjechały z fixture\'u — scenariusz sprawdzałby co innego niż deklaruje.',
    );

    // ── 2. Ścieżka z wtopą NAPRAWDĘ się wykonała ──
    // Bez tego strażnika scenariusz przechodziłby także wtedy, gdyby plugin po prostu nigdy nie
    // dotknął rejestru modeli embeddingu (np. po cichej zmianie warunku wejścia gdzieś w boocie).
    const rejestr = plugin?.env?.embeddings as FixturePayload;
    assert(rejestr, 'Brak env.embeddings — rejestr modeli embeddingów w ogóle nie powstał.');
    assert(
      rejestr.default?.modelKey === 'openai:text-embedding-3-small',
      `Rejestr nie rozstrzygnął dostawcy z ustawień (modelKey: ${rejestr.default?.modelKey ?? '(brak)'}). `
      + 'Getter `default` nie został wywołany, więc test niczego nie dowodzi.',
    );

    // ── 3. SEDNO: plik ustawień nietknięty od bootu (treść vs fixture) ──
    assert(
      readVaultFile(vaultRoot, SETTINGS_REL) === USTAWIENIA,
      'BOOT PRZEPISAŁ settings.json — plik z kluczami API zmienia się przy każdym starcie, '
      + 'mimo że user niczego nie zmienił. Najbardziej prawdopodobny sprawca: getter `default` '
      + 'rejestru embeddingu mutujący worek ustawień zamiast tylko go czytać. Stan po boocie: '
      + `${readVaultFile(vaultRoot, SETTINGS_REL).slice(0, 400)}`,
    );
    // Żaden zapis nie może też WISIEĆ zaplanowany (debounce ~1 s bywa dłuższy niż cały bieg).
    assert(
      plugin?.env?.settingsStore?.pendingSaveTimer == null,
      'BOOT ZAPLANOWAŁ ZAPIS USTAWIEŃ — `settingsStore.pendingSaveTimer` wisi po turze. Na dysku '
      + 'jeszcze tego nie widać (debounce), ale u usera plik z kluczami API zostałby przepisany '
      + 'sekundę po starcie. Ktoś zmutował OBSERWOWANE proxy ustawień w ścieżce bootowej.',
    );
    // Worek ustawień embeddingu w RAM = FABRYCZNE KONTENERY ⊕ plik usera, i ani jednego klucza
    // więcej. Pancerz merguje `RuntimeConfig.defaults` z tym, co wczytał z dysku (kontrakt
    // `SettingsLoadResult.settings`), więc pusty `hosts: {}` z `config/defaultSettings.ts`
    // jest tu ZAMIERZONY — na tych kontenerach stoi reguła „hydratacja sekretu na
    // czterosegmentowej ścieżce niczego nie dotwarza". Ostrość asercji zostaje: dopisanie
    // przez rejestr czegokolwiek własnego (dawne `<provider>#<Date.now()>`, `default_model_key`)
    // dalej świeci na czerwono, bo porównujemy CAŁY worek, nie wybrane pola.
    const embeddingWRam = plugin?.env?.settings?.pkmAssistant?.embedding as FixturePayload;
    const oczekiwanyEmbedding = {
      ...(defaultSettings().pkmAssistant?.embedding ?? {}),
      provider: 'openai',
      models: { openai: 'text-embedding-3-small' },
      apiKeys: {},
    };
    assert(
      stabilnyJson(embeddingWRam) === stabilnyJson(oczekiwanyEmbedding),
      'Worek `settings.pkmAssistant.embedding` w RAM to nie jest „fabryczne kontenery + plik usera" — '
      + `ktoś dosztukował coś, czego user nie prosił (jest ${stabilnyJson(embeddingWRam)}, `
      + `oczekiwano ${stabilnyJson(oczekiwanyEmbedding)}).`,
    );

    // ── 4. …i nietknięty PO całej turze (migawka `before` domyka fazę tury) ──
    fileUnchanged(
      before, vaultRoot, SETTINGS_REL,
      'settings.json zmienił się w trakcie tury — coś zapisało ustawienia mimo braku zmiany od usera '
      + '(zapis planowany przy boocie ma debounce ~1 s, więc potrafi wypaść dopiero tutaj).',
    );

    // ── 5. Zdrowy plik NIE trafia na odkładkę corrupt (to nie jest ścieżka awaryjna) ──
    const odkladki = listVaultFiles(vaultRoot, '.pkm-assistant')
      .filter((p) => /\.pkm-assistant\/settings\.corrupt-\d+\.json$/.test(p));
    assert(
      odkladki.length === 0,
      `Powstała odkładka dla ZDROWEGO pliku ustawień: ${odkladki.join(', ')}`,
    );
    // Kopia zapasowa powstaje z treści, która się sparsowała — czyli 1:1 z fixturem.
    assert(
      readVaultFile(vaultRoot, LAST_GOOD_REL) === USTAWIENIA,
      'settings.last-good.json nie jest kopią 1:1 zdrowego settings.json — pancerz zapisał co innego, '
      + 'niż wczytał.',
    );

    // ── 6. Plugin normalnie prowadzi turę (nietykalność ustawień nie kosztuje działania) ──
    const finalText = assertFinalText(result, 'Pętla nie zwróciła odpowiedzi.');
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli nie zawiera odpowiedzi modelu: ${JSON.stringify(finalText).slice(0, 200)}`,
    );
  },
} satisfies Scenario);
