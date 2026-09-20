# companion/

**Wtyczka-nosiciel `pkm-assistant-dev`.** Werdykt właściciela 2026-09-20: narzędzia CLI
wewnętrzne (agenci Claude Code pytają plugin o stan) nie żyją w repo pluginu `pkm-assistant` -
to narzędzie deweloperskie, nie funkcja dla jego userów. Ta mała, prywatna wtyczka Obsidiana
(id `pkm-assistant-dev`) mieszka w TYM repo (`pkm-assistant-harness`) i jest instalowana
WYŁĄCZNIE w vaulcie właściciela projektu. Rejestruje cztery komendy CLI Obsidiana
(`Plugin#registerCliHandler`, API od 1.12.2), które przy KAŻDYM wywołaniu odpytują żywą
instancję głównego pluginu (`pkm-assistant`) z `app.plugins.plugins`.

**Dla kogo:** wyłącznie właściciel projektu i jego agenci (Claude Code i inni) pracujący nad
`pkm-assistant`. To NIE jest funkcja dla zwykłych userów pluginu.

## Co tu jest

```
companion/
├── manifest.json            # id "pkm-assistant-dev", minAppVersion 1.12.2, isDesktopOnly
├── main.ts                  # klasa wtyczki (extends Plugin) - onload() rejestruje komendy
├── hostPlugin.ts             # resolveHost(app) - zwalidowany widok żywej instancji pkm-assistant
├── memoryStatus.ts           # getConsolidationStatus - status konsolidacji, przeniesiony z pluginu
├── logger.ts                 # lokalny logger (console.debug/warn) - NIE core/utils/Logger.js pluginu
├── deploy.local.example.json # szablon deploy.local.json (ten plik NIE jest gitignored)
├── CLAUDE.md                 # ten plik
└── cli/
    ├── index.ts               # publiczne drzwi tej podpaczki (barrel)
    ├── response.ts            # koperta CliResponse<T> - 1:1 ze źródła, zero zmian
    ├── commands.ts            # buildCliCommands(deps) - cztery specyfikacje komend, host rozwiązywany PRZY KAŻDYM wywołaniu
    ├── register.ts            # registerCliCommands(host, deps) - wiąże specyfikacje z hostem Obsidiana (host = TA wtyczka)
    ├── commands.test.ts
    └── register.test.ts
```

Deploy do vaulta (`lib/companionDeploy.ts`, w tym repo poza `companion/`, bo to build-time
infrastruktura harnessu, nie runtime wtyczki) i entry esbuilda (`esbuild.harness.ts` ->
`buildCompanion()`) są opisane w `README.md` tego repo.

## Public API

- `main.ts` (`default export`) - klasa wtyczki, `new PkmAssistantDevPlugin(app, manifest)`.
  `onload()` jest jedynym efektem ubocznym: rejestruje cztery komendy CLI, best-effort (patrz
  `cli/register.ts`). Zero UI, zero ustawień, zero zapisu.
- `cli/index.ts` eksportuje `registerCliCommands`, typy `CliHost`/`RegisterCliCommandsResult`/
  `CliDeps`/`CliCommandSpec`/`StatusData`/`AgentPromptData`/`MemoryStatusData`/`CliEffect`/
  `CliErrorCode`/`CliResponse`. `buildCliCommands` (w `cli/commands.ts`) świadomie NIE jest w
  barrelu - jedyny konsument spoza `register.ts` to testy tego samego folderu.
- `hostPlugin.ts` eksportuje `resolveHost(app)`, `ResolvedHost`, `CliAgentManager`, `CliIndexStatus`.
- `memoryStatus.ts` eksportuje `getConsolidationStatus(agentMemory)`.

## Prefiks komend i tożsamość

**Prefiks komend = id TEJ wtyczki** (`pkm-assistant-dev`, konwencja `<plugin-id>:<action>` z
`obsidian.d.ts`), NIE id hosta (`pkm-assistant`) - komendę CLI może zarejestrować tylko ten, kto
ją rejestruje (`Plugin#registerCliHandler`), a `pkm-assistant` nie bierze udziału jako
rejestrujący, tylko jako CEL zapytań.

| Komenda | Flagi | Dane (`data`) | Gotowość |
|---|---|---|---|
| `pkm-assistant-dev:status` | `format` | `StatusData` | działa ZAWSZE, nawet gdy hosta nie ma w ogóle |
| `pkm-assistant-dev:selftest` | `format` | raport `buildSelfTestReport` HOSTA (opaque payload) | wymaga hosta gotowego |
| `pkm-assistant-dev:agent-prompt` | `agent` (wymagana), `section`, `format` | `AgentPromptData` | wymaga hosta gotowego |
| `pkm-assistant-dev:memory-status` | `agent` (wymagana, `<name\|all>`), `format` | `MemoryStatusData` | wymaga hosta gotowego |

Wspólne zasady, kody błędów, parsowanie flag, rozwiązywanie imienia agenta i migawka `brain.md`
+ `brain/` w `agent-prompt` są BEZ ZMIAN względem źródła (`modules/cli/CLAUDE.md` w repo pluginu,
zanim to repo je usunie - opis kontraktu poniżej jest jego kopią, na wypadek gdyby zniknął stamtąd).

`format` dopuszcza wyłącznie `json` (domyślna, bez wielkości liter, po `trim()`); nieznane klucze
w `params` są ignorowane; poza `status` brak gotowości hosta LUB brak agent managera -> `not_ready`.
Flaga `agent`: `trim()`; `all` (tylko `memory-status`) rozpoznawane bez wielkości liter. Brak
flagi, pusty string po `trim()` albo literał `'true'` -> `bad_flag`, NIE `agent_not_found`.
Rozwiązywanie imienia: (1) dokładne dopasowanie, (2) bez wielkości liter jeśli JEDNOZNACZNE;
brak -> `agent_not_found`; wiele trafień w kroku 2 -> `agent_ambiguous`.

## `StatusData` - `plugin` (host) + `companion` (ta wtyczka)

```ts
interface StatusData {
    plugin: { id: string; version: string; instanceSince: string | null };
    companion: { id: string; version: string };
    ready: boolean;
    agents: { count: number; active: string | null; names: string[] } | null;
    index: { status: string; indexed: number; total: number; modelKey: string | null; lastError: string | null } | null;
    commands: string[];
}
```

`plugin.instanceSince` zastępuje dawne `loadedAt` (kiedy TA wtyczka się zarejestrowała) -
wtyczka-nosiciel pamięta OSTATNIO WIDZIANĄ żywą instancję hosta (porównanie tożsamości
referencji `===`, w zamknięciu `buildCliCommands` - patrz `createInstanceTracker` w
`cli/commands.ts`) i chwilę, gdy zobaczyła ją PIERWSZY RAZ. Ta sama referencja między
wywołaniami -> ten sam znacznik; nowa instancja hosta (po `plugin:reload id=pkm-assistant`) ->
nowy znacznik. Hosta nie ma -> `instanceSince: null`, `plugin.version: 'unknown'`.

`companion.id`/`companion.version` to tożsamość TEJ wtyczki (z jej własnego `manifest.json`),
przydatna do potwierdzenia, którą wersję companiona agent w ogóle woła.

## Rozwiązywanie hosta (`hostPlugin.ts`)

`resolveHost(app)` jest wołane PRZY KAŻDYM wywołaniu komendy wymagającej gotowości (nigdy raz w
`onload()`) - główny plugin bywa przeładowywany niezależnie od tej wtyczki
(`plugin:reload id=pkm-assistant`), a trzymana referencja wskazywałaby martwą instancję. Host
przychodzi jako `unknown` i jest zawężany NA GRANICY: `typeof`/`in`, sprawdzenie że wszystkie
pięć metod agent managera są funkcjami - dopiero POTEM `as` (po walidacji, nigdy na wiarę).
`instanceof` NIE działa (host żyje w innym bundlu, inny moduł `obsidian`, dwie różne klasy
`Plugin`) - nie używać. Brak hosta, albo host bez KOMPLETU pięciu metod agent managera -
`agentManager: undefined` w `ResolvedHost`; `status` wtedy czyta co jest (ready:false/agents:null),
pozostałe trzy komendy odmawiają `not_ready`.

## Zależności z pluginu

**Typy WYŁĄCZNIE `import type`** z `@plugin/modules/agents/index.js` (`AgentManager`) i
`@plugin/modules/memory/index.js` (`AgentMemory`, `ConsolidationStatus`, `BrainNoteInfo`, ...) -
zero kosztu runtime, `npm run typecheck` ma wywalić się, gdy sygnatura metody w pluginie się
zmieni (to jest cały sens trzymania tego w repo, które kompiluje się na źródłach pluginu przez
alias `@plugin/`).

**Runtime'owe importy TYLKO z lekkich, czystych plików** (bundle wtyczki ma zostać mały - patrz
rozmiar w raporcie zadania, ~52 KB):
- `@plugin/modules/memory/consolidationStatus.js` - `resolveConsolidationThresholds`,
  `shouldTriggerConsolidation`, `resolvePlanDedupThreshold` (JEDNO liczydło progów konsolidacji,
  współdzielone z produkcyjnym `SaveSessionWorkflow._shouldTriggerArchive` - NIE kopiować tej logiki),
- `@plugin/modules/memory/ConsolidationRun.js` - `buildPlan`,
- `@plugin/core/selftest.js` - `buildSelfTestReport` (dynamiczny `await import(...)` w `main.ts`).

**NIGDY barrele modułów runtime'owo** (`@plugin/modules/agents/index.js`,
`@plugin/modules/memory/index.js`) - ciągną całe drzewo modułu (UI, CSS, cały silnik pamięci).
Metody `AgentManager`/`AgentMemory` (`getAllAgents`, `listBrainNotes`, `vault.adapter.list`, ...)
są wołane na ŻYWYCH obiektach zwróconych przez `resolveHost`/`getAgentMemory` - to NIE jest
import, tylko wywołanie metody na referencji, którą i tak już mamy; stąd nie trzeba (i nie
wolno) importować całych klas jako wartości.

### Czego selftest tu NIE wie (świadome pominięcia)

- **`countDocs`** (liczba dokumentów w indeksie Oramy) - żyje w `modules/embedding/orama_engine.ts`,
  który importuje `@orama/orama` na poziomie modułu (prawdziwa biblioteka wektorowa/full-text,
  nie plik pomocniczy). Import runtime'owy stąd wciągnąłby całą Oramę do tej małej wtyczki -
  pominięty świadomie. `buildSelfTestReport` jest na to przygotowany (`sectionSemantics` sprawdza
  `typeof deps.countDocs === 'function'` przed użyciem) - sekcja "Semantics" w raporcie selftestu
  woła po prostu pokazuje `doc_count: 'n/a'` zamiast realnej liczby, reszta sekcji (status
  indeksera, `oramaDb: present/absent`) działa normalnie.
- **`fileLogActive`** (czy plikowy sink Loggera hosta jest aktywny) - żyje jako właściwość
  `log.fileSinkActive` na singletonie `core/utils/Logger.js` pluginu. Ta wtyczka jest OSOBNYM
  bundlem (`dist/companion/main.js`) - gdyby zaimportowała `Logger.js`, dostałaby WŁASNĄ,
  osobną instancję singletona (nigdy nie przeszła przez `log.initFileSink(...)` hosta), więc
  jej `fileSinkActive` byłoby ZAWSZE `false`, niezależnie od realnego stanu hosta - gorsze niż
  brak pola (fałszywe `false` sugerowałoby "log wyłączony", gdy w rzeczywistości jest włączony).
  Sekcja "File log" w raporcie selftestu przez to zawsze pokazuje `sink: inactive` - znana,
  zaakceptowana nieścisłość, udokumentowana tu i w `main.ts`.

## Gotchas

- ⚠️ **`obsidian` nie jest zależnością tego repo.** `companion/main.ts` musi importować
  `{ Plugin, Platform }` z bare specyfiera `'obsidian'` (w RUNTIME to ma być prawdziwy pakiet,
  dostarczony przez hosta - `esbuild.harness.ts` -> `buildCompanion()` znaczy `obsidian` jako
  `external`, dokładnie jak produkcyjny `esbuild.js` pluginu), ale harness nie ma tego pakietu w
  `node_modules` (testuje przez atrapę `test-support/obsidian.ts`, nie przez oficjalny pakiet) i
  nie wolno go dokładać jako nowej zależności npm. Naprawiono JEDNYM, udokumentowanym
  `@ts-expect-error` na tym imporcie (nie globalnym `tsconfig.json` `paths`/`declare module` -
  próba globalnego mapowania `"obsidian"` na atrapę PSUJE typecheck plików pluginu wciąganych
  przez `@plugin/...`, które mają WŁASNY, realny `node_modules/obsidian` i bez tej ingerencji
  rozwiązują się poprawnie). `this.app`/`this.manifest`/`this.registerCliHandler`/
  `this._registeredCliHandlers` i konstruktor dostają WŁASNE, jawne typy (`declare`/jawny
  konstruktor) w `main.ts` - `extends` na nierozwiązanym imporcie nie przenosi żadnych typów
  bazowych (ani pól, ani sygnatury konstruktora).
- ⚠️ **`companion/cli/*.ts` importuje typy CLI (`CliData`/`CliFlag`/`CliFlags`/`CliHandler`) z
  LOKALNEJ atrapy** (`../../test-support/obsidian.js`, ścieżka względna), nie z bare `'obsidian'` -
  te dwa pliki nie potrzebują REALNEGO runtime'u Obsidiana (tylko typów), więc omijają problem
  wyżej w ogóle. Ten sam wzorzec, którym już chodzi `scenarios/47_cli_odczyt.ts`.
- ⚠️ **`AgentMemory` importuje się jako WARTOŚĆ pod `tsx`/AVA harnessu bez atrapy `obsidian`.**
  Zweryfikowane bezpośrednio przed napisaniem `memoryStatus.test.ts`: `AgentMemory.ts` i cały jej
  łańcuch importów w `modules/memory/` nie dotykają `obsidian` jako wartości (jedyny dotyk to
  `modules/memory/SettingsContent.ts`, `import type { Setting } from 'obsidian'` - znika przy
  transpilacji). Dzięki temu testy `getConsolidationStatus` mogły zostać PRAWDZIWYMI testami
  integracyjnymi (realna `AgentMemory` na atrapie adaptera vaulta), zamiast schodzić na kroki
  scenariusza.
- ⚠️ **`peekState` (w `memoryStatus.ts`) to NIE `StateManager.peek()` skopiowany 1:1** - ta
  metoda znika z pluginu (żyła tam wyłącznie dla tego jednego wołacza CLI). Własna, lekka
  reimplementacja: NAJPIERW `read` (ścieżka szczęśliwa - plik istnieje - to JEDNO wywołanie),
  dopiero pad odczytu pyta `exists()` o potwierdzenie `'missing'` vs `'unreadable'`. Kolejność
  jest CELOWO odwrotna względem `probeFile` pluginu (`exists()`-first) - `core/utils/vaultFs.js`
  (skąd `probeFile` pochodzi) jest importowalny WYŁĄCZNIE przez `core/index.js` (złota zasada
  pluginu), a ten barrel jest zbyt ciężki (315 linii, ściąga security/i18n/HTTP/SettingsStore)
  na potrzeby jednej funkcji w małej wtyczce - stąd własna, równoważna logika zamiast importu.
  Efekt końcowy (trzy źródła `file`/`missing`/`unreadable`, zero zapisu) jest identyczny.
- ⚠️ **Deploy jest OPCJONALNY i sterowany plikiem, nie zmiennymi `.env`.** `companion/deploy.local.json`
  (gitignored, NIE tworzony przez `npm run build:companion` ani przez żadną sesję agenta -
  tworzy go właściciel ręcznie z `deploy.local.example.json`) niesie `{vault, configDir}`. Brak
  pliku = jedna linia "deploy pominięty" i sukces builda - deploy jest wygodą dewelopera, nie
  bramką. Logika: `lib/companionDeploy.ts` (w tym repo poza `companion/`, bo to build-time
  infrastruktura harnessu wołana z `esbuild.harness.ts`, nie kod runtime'owy wtyczki).
- ⚠️ **`_registeredCliHandlers` na instancji companiona to pole ATRAPY, nie prawdziwego
  Obsidiana.** Istnieje wyłącznie w `test-support/obsidian.ts` (`Plugin._registeredCliHandlers`)
  po to, żeby scenariusz `47_cli_odczyt.ts` mógł odczytać zarejestrowane handlery bez wołania
  prawdziwego CLI procesu. Żaden kod produkcyjny (`main.ts`, `cli/*.ts`) na tym polu nie polega.

## Powiązane

- `README.md` (root tego repo) - build `dist/companion/main.js`, deploy, alias `@plugin/`.
- `esbuild.harness.ts` - `buildCompanion()`, `pluginAliasPlugin` (alias `@plugin/` bez atrapy
  `obsidian` - w odróżnieniu od `pluginTreePlugin` używanego przez `run.js`/`scenarios.js`).
- `lib/companionDeploy.ts` - `parseDeployConfig`/`companionDeployDir`/`deployCompanion`.
- `scenarios/47_cli_odczyt.ts` - end-to-end na PRAWDZIWYM pluginie jako hoście, w tej samej
  atrapie `app` (offline, brak modelu, migawka drzewa vaulta przed/po = dowód zerowego zapisu).
