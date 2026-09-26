# companion/

**Wtyczka-nosiciel `pkm-assistant-dev`.** Werdykt właściciela 2026-09-20: narzędzia CLI
wewnętrzne (agenci Claude Code pytają plugin o stan) nie żyją w repo pluginu `pkm-assistant` -
to narzędzie deweloperskie, nie funkcja dla jego userów. Ta mała, prywatna wtyczka Obsidiana
(id `pkm-assistant-dev`) mieszka w TYM repo (`pkm-assistant-harness`) i jest instalowana
WYŁĄCZNIE w vaulcie właściciela projektu. Rejestruje pięć komend CLI Obsidiana
(`Plugin#registerCliHandler`, API od 1.12.2), które przy KAŻDYM wywołaniu odpytują żywą
instancję głównego pluginu (`pkm-assistant`) z `app.plugins.plugins`. Cztery z nich (fala 1,
2026-09-20) są czystym odczytem stanu hosta; piąta (`agent-turn`, fala 2, 2026-09-26) uruchamia
JEDNĄ turę produkcyjnej pętli agenta (`runAgentLoop`) na żywym hoście, w trybie bezpiecznym.

**Dla kogo:** wyłącznie właściciel projektu i jego agenci (Claude Code i inni) pracujący nad
`pkm-assistant`. To NIE jest funkcja dla zwykłych userów pluginu.

## Co tu jest

```
companion/
├── manifest.json            # id "pkm-assistant-dev", minAppVersion 1.12.2, isDesktopOnly
├── main.ts                  # klasa wtyczki (extends Plugin) - onload() rejestruje komendy
├── hostPlugin.ts             # resolveHost(app) - zwalidowany widok żywej instancji pkm-assistant; resolvePluginBundleMtime(app)
├── hostPlugin.test.ts
├── memoryStatus.ts           # getConsolidationStatus - status konsolidacji, przeniesiony z pluginu
├── memoryStatus.test.ts
├── agentTurn.ts               # K-agent-turn: logika `agent-turn` - runAgentTurn(host, agent, flags, deps), READONLY_TOOLS, parsery flag
├── agentTurn.test.ts
├── buildInfo.ts               # K3: COMPANION_BUILT_AT/PLUGIN_COMMIT/PLUGIN_TREE_DIRTY - wstrzykiwane esbuild `define`, typeof-guard fallback
├── buildInfo.test.ts
├── obsidianContract.ts         # K5: plik tylko-typowy - obustronna przypisywalność typów CLI atrapy z prawdziwym obsidian.d.ts pluginu
├── logger.ts                 # lokalny logger (console.debug/warn) - NIE core/utils/Logger.js pluginu
├── deploy.local.example.json # szablon deploy.local.json (ten plik NIE jest gitignored)
├── CLAUDE.md                 # ten plik
└── cli/
    ├── index.ts               # publiczne drzwi tej podpaczki (barrel)
    ├── response.ts            # koperta CliResponse<T> - 1:1 ze źródła, zero zmian
    ├── commands.ts            # buildCliCommands(deps) - pięć specyfikacji komend, host rozwiązywany PRZY KAŻDYM wywołaniu
    ├── register.ts            # registerCliCommands(host, deps) - wiąże specyfikacje z hostem Obsidiana (host = TA wtyczka)
    ├── commands.test.ts
    └── register.test.ts
```

Poza `companion/` (ale ściśle powiązane, patrz sekcja "Powiązane" niżej): `lib/pluginBuildInfo.ts`
+ `.test.ts` (K3 - `resolvePluginGitInfo`, wołane z `esbuild.harness.ts`), `lib/companionDeploy.ts`
+ `.test.ts` (deploy do vaulta), `scenarios/47_cli_odczyt.ts` (end-to-end fali 1, czysty odczyt),
`scenarios/48_cli_agent_turn.ts` (end-to-end `agent-turn`, fali 2 - produkcyjna pętla).

Deploy do vaulta (`lib/companionDeploy.ts`, w tym repo poza `companion/`, bo to build-time
infrastruktura harnessu, nie runtime wtyczki) i entry esbuilda (`esbuild.harness.ts` ->
`buildCompanion()`) są opisane w `README.md` tego repo.

## Public API

- `main.ts` (`default export`) - klasa wtyczki, `new PkmAssistantDevPlugin(app, manifest)`.
  `onload()` jest jedynym efektem ubocznym: rejestruje pięć komend CLI, best-effort (patrz
  `cli/register.ts`). Zero UI, zero ustawień, zero zapisu z SIEBIE (`agent-turn` wykonuje
  narzędzia NARZĘDZIA na hoście, patrz sekcja `AgentTurnData` niżej - to zapis HOSTA, nie tej
  wtyczki).
- `cli/index.ts` eksportuje `registerCliCommands`, typy `CliHost`/`RegisterCliCommandsResult`/
  `CliDeps`/`CliCommandSpec`/`StatusData`/`AgentPromptData`/`MemoryStatusData`/`AgentTurnData`/
  `CliEffect`/`CliErrorCode`/`CliResponse`. `buildCliCommands` (w `cli/commands.ts`) świadomie NIE
  jest w barrelu - jedyny konsument spoza `register.ts` to testy tego samego folderu.
- `hostPlugin.ts` eksportuje `resolveHost(app)`, `ResolvedHost`, `CliAgentManager`, `CliIndexStatus`,
  `CliMcpClient`, `CliToolRegistry` (K-agent-turn - wąskie widoki `mcpClient`/`toolRegistry` hosta,
  zwalidowane na granicy jak `CliAgentManager`), `resolvePluginBundleMtime(app)` (K3 - ISO mtime
  bundla HOSTA w vaulcie, `null` gdy nie da się ustalić).
- `agentTurn.ts` eksportuje `runAgentTurn(host, agent, flags, deps)` (orkiestracja `agent-turn`),
  `READONLY_TOOLS`, `resolveAgentTurnTools`, parsery flag (`parsePromptFlag`/`parseToolsFlag`/
  `parseIntegerFlag`) i typy `AgentTurnData`/`AgentTurnHost`/`AgentTurnFlags`/`AgentTurnDeps`.
  `AgentTurnData` jest RE-EKSPORTOWANA z `cli/commands.ts` (właściciel logiki mieszka tu, kontrakt
  danych żyje obok `AgentPromptData`/`MemoryStatusData`, jak reszta fali 1) - patrz sekcja niżej.
- `memoryStatus.ts` eksportuje `getConsolidationStatus(agentMemory)` - status niesie osobno
  `thresholdsExceeded` (stara semantyka `shouldTriggerConsolidation` - sam próg, bez wyłączników)
  i `wouldTrigger`/`include` (produkcyjna decyzja `planAutoConsolidation`, respektuje oba
  wyłączniki auto-konsolidacji, domyślnie WYŁĄCZONE - patrz gotcha "auto-konsolidacja opcjonalna"
  niżej). `resolvePlanDedupThreshold` USUNIĘTE 2026-09-22 (patrz sekcja "Zależności z pluginu").
- `buildInfo.ts` eksportuje `COMPANION_BUILT_AT`/`COMPANION_PLUGIN_COMMIT`/`COMPANION_PLUGIN_TREE_DIRTY`
  (K3, patrz gotcha "dwa bundle - jedno liczydło" niżej).

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
| `pkm-assistant-dev:agent-turn` | `agent`/`prompt` (wymagane), `tools` (`readonly\|none`, domyślnie `readonly`), `max-iterations` (1-20, domyślnie 8), `timeout` (sekundy 10-600, domyślnie 180), `format` | `AgentTurnData` | wymaga hosta gotowego + `mcpClient` + `toolRegistry` (patrz sekcja niżej) |

Wspólne zasady, kody błędów, parsowanie flag, rozwiązywanie imienia agenta i migawka `brain.md`
+ `brain/` w `agent-prompt` są BEZ ZMIAN względem źródła (`modules/cli/CLAUDE.md` w repo pluginu,
zanim to repo je usunie - opis kontraktu poniżej jest jego kopią, na wypadek gdyby zniknął stamtąd).
`agent-turn` (fala 2) ROZSZERZA tę pulę o `busy`/`model_unavailable`/`turn_failed` (`response.ts`)
i o własne flagi (`prompt`/`tools`/`max-iterations`/`timeout`) - patrz sekcja `AgentTurnData` niżej.

`format` dopuszcza wyłącznie `json` (domyślna, bez wielkości liter, po `trim()`); nieznane klucze
w `params` są ignorowane; poza `status` brak gotowości hosta LUB brak agent managera -> `not_ready`.
Flaga `agent`: `trim()`; `all` (tylko `memory-status`) rozpoznawane bez wielkości liter. Brak
flagi, pusty string po `trim()` albo literał `'true'` -> `bad_flag`, NIE `agent_not_found`.
Rozwiązywanie imienia: (1) dokładne dopasowanie, (2) bez wielkości liter jeśli JEDNOZNACZNE;
brak -> `agent_not_found`; wiele trafień w kroku 2 -> `agent_ambiguous`.

## `StatusData` - `plugin` (host) + `companion` (ta wtyczka)

```ts
interface StatusData {
    plugin: { id: string; version: string; instanceSince: string | null; bundleMtime: string | null };
    companion: { id: string; version: string; builtAt: string; pluginCommit: string; pluginTreeDirty: boolean };
    companionStale: boolean | null;
    ready: boolean;
    agents: { count: number; active: string | null; names: string[] } | null;
    index: { status: string; indexed: number; total: number; modelKey: string | null; lastError: string | null } | null;
    commands: string[];
}
```

`plugin.instanceSince` zastępuje dawne `loadedAt` (kiedy TA wtyczka się zarejestrowała) -
wtyczka-nosiciel pamięta OSTATNIO WIDZIANĄ żywą instancję hosta jako SŁABĄ referencję (`WeakRef`,
porównanie tożsamości przez `deref()`, w zamknięciu `buildCliCommands` - patrz
`createInstanceTracker` w `cli/commands.ts`) i chwilę, gdy zobaczyła ją PIERWSZY RAZ. Ta sama
referencja między wywołaniami -> ten sam znacznik; nowa instancja hosta (po
`plugin:reload id=pkm-assistant`) -> nowy znacznik. `WeakRef`, NIE twarda referencja: po
zniknięciu hosta ta wtyczka (żyjąca dalej niezależnie od niego) nie ma prawa trzymać całego jego
grafu (AgentManager, indeks, pamięci agentów) przy życiu w nieskończoność - GC może posprzątać, gdy
nikt inny już nie trzyma hosta. Hosta nie ma -> `instanceSince: null`, `plugin.version: 'unknown'`.

`plugin.bundleMtime` to ISO mtime pliku `<configDir>/plugins/pkm-assistant/main.js` w vaulcie
(`hostPlugin.ts`, `resolvePluginBundleMtime` - czyta `app.vault.configDir` + `adapter.stat`,
WOŁANE PRZY KAŻDYM `status`, nie cache'owane) - `null`, gdy nie da się ustalić (brak configDir,
brak pliku, adapter bez `stat`).

`companion.id`/`companion.version` to tożsamość TEJ wtyczki (z jej własnego `manifest.json`),
przydatna do potwierdzenia, którą wersję companiona agent w ogóle woła. `companion.builtAt`/
`pluginCommit`/`pluginTreeDirty` i `companionStale` - patrz gotcha "dwa bundle - jedno liczydło"
niżej.

## `AgentTurnData` - jedna tura produkcyjnej pętli agenta, tryb bezpieczny (`agentTurn.ts`)

```ts
interface AgentTurnData {
    agent: string;                 // kanoniczne imię (rozwiązane jak w agent-prompt)
    model: string | null;          // model.modelKey ?? model.modelId ?? null
    tools: 'readonly' | 'none';
    toolsOffered: string[];        // nazwy narzędzi REALNIE podanych modelowi
    systemPrompt: string;
    finalText: string;
    toolCalls: Array<{ name: string; args: unknown; ok: boolean; resultPreview: string; error?: string }>;
    usage: { promptTokens: number; completionTokens: number; estimated: boolean };
    iterations: number;
    stoppedBy: 'natural' | 'backstop' | 'abort' | 'timeout';
    approvals: [];                 // ZAWSZE pusta - tryb bez zgód (yolo); pole zostaje dla kontraktu prompt-eval
    session: 'none';               // stała - nic nie zapisujemy do pamięci persony/sesji czatu
    durationMs: number;
}
```

Wywołanie: `pkm-assistant-dev:agent-turn agent=<imię> prompt=<tekst> [tools=readonly|none]
[max-iterations=<n>] [timeout=<sekundy>] [format=json]`. `agent`/`prompt`: `trim()`, wymagane -
brak, pusty string po `trim()` albo literał `'true'` -> `bad_flag` (ten sam wzorzec co
`agent`/`section` gdzie indziej). `tools`: `readonly` (domyślna) albo `none`, bez względu na
wielkość liter. `max-iterations`: liczba całkowita 1-20 (domyślnie 8). `timeout`: liczba całkowita
sekund 10-600 (domyślnie 180) - budżet CAŁEJ tury.

**Limity 1:1 z czatem (K-adwersarialna, poprawka 2026-09-26):** `maxToolResultLength`/
`maxToolResultLengthPerTool`/`perCallTimeoutMs`/`stallTimeoutMs` liczy `computeAgentTurnLimits`
(`agentTurn.ts`) z `getLimits(hostRaw.env?.settings)` - DOKŁADNIE to, co `chat_streaming.ts:676-694`
podaje do `runAgentLoop`; WYŁĄCZNIE `maxIterations` przychodzi z flagi CLI (czat liczy go RAZ na
turę z `getLimits()`, `agent-turn` nie ma pojęcia "kontynuacji"). `stallTimeoutMs` jest
WYJĄTKIEM: czat NIE podaje go do `runAgentLoop` w ogóle (ma osobny, zewnętrzny `StreamWatchdog`
napędzany UI/chunkami), ale WARUNEK platformy (`chat_streaming.ts:639-642`: `xai` nie streamuje,
cisza mid-flight tam normalna, watchdog wyłączony) jest tym samym warunkiem, jakiego potrzebuje
WBUDOWANY watchdog ciszy `runAgentLoop` (`limits.stallTimeoutMs`) - `agent-turn`, bez własnej
warstwy UI, używa go wprost jako jedynego dostępnego mu odpowiednika. `hostRaw.env`/`.settings`
zwalidowane NA GRANICY (`isRecord`) - zły kształt/brak -> `getLimits(null)`, same defaulty.

**Termin CAŁEGO biegu jest WYŚCIGIEM, nie flagą (K-adwersarialna, poprawka 2026-09-26):**
`Promise.race` między `runAgentLoop(...)` a budzikiem (`deps.setTimer`). Wywołanie narzędzia,
które WISI (np. zawieszony HTTP embeddingu w `search` scope=memory) blokowałoby
`await runAgentLoop(...)` W NIESKOŃCZONOŚĆ, mimo że `model.stopStream()` już poszedł -
`stopStream` ubija WYŁĄCZNIE stream modelu, nie egzekucję narzędzia w toku. Budzik wygrywa
wyścig -> `model.stopStream()` (na wszelki wypadek), zwrot NATYCHMIAST ze `stoppedBy:'timeout'`,
`finalText:''`, `toolCalls` z LOKALNEJ księgowości (`onIterationStart`/`onToolResults` - patrz
niżej), blokada "jeden bieg naraz" ZWOLNIONA (`finally` w `commands.ts`, tuż po powrocie tej
funkcji). Bieg NIE jest anulowany - kontynuuje W TLE z `shouldAbort()===true` (kończy się sam,
gdy/jeśli jego zawieszone wywołanie narzędzia w końcu wróci; `tools=readonly` gwarantuje, że
osierocony ogon nigdy niczego nie zapisze) - jego późniejsze rozstrzygnięcie (sukces ALBO
wyjątek) jest POŁKNIĘTE (`.then(ok, ok)` w `agentTurn.ts` - obie gałęzie obsłużone, zero
`unhandled rejection`). Gdy pętla wygrywa wyścig normalnie, `stoppedBy:'abort'` z samej pętli
(gdyby się kiedyś pojawiło) mapuje się na `'timeout'` tylko, gdy budzik REALNIE strzelił w tym
samym takcie - obrona w głąb, nie główna ścieżka.

**Bezpieczeństwo bez zgód:** `autonomy:'yolo'` (patrz `core/security/PermissionSystem.ts`,
`requiresApproval` zwraca `false` zawsze w tym trybie) - `approvalManager`/`diffModalFactory`
hosta NIGDY nie są odpytywane, więc `agent-turn` świadomie ich NIE podmienia (w odróżnieniu od
`lib/runTurn.ts` harnessu). JEDYNA bariera to whitelista narzędzi TEGO pliku: `tools=none` ->
`resolveTools` zwraca `[]`; `tools=readonly` -> `toolRegistry.filterByAgent(agent)` (JEDNA OŚ
NARZĘDZIOWA pluginu - `disabled_tools`/`mcp_servers` agenta DZIAŁAJĄ) PRZECIĘTE ze stałą
eksportowaną `READONLY_TOOLS = ['read', 'list', 'search']`, z wykluczeniem narzędzi serwerów
ZEWNĘTRZNYCH (`tool.serverName` obecne = MCP usera, nigdy nie wpuszczane). Egzekutor podany do
`runAgentLoop` sprawdza nazwę narzędzia względem tej listy PRZED `mcpClient.executeToolCall` -
narzędzie spoza listy (model halucynuje np. `write` mimo `tools=readonly`) dostaje rzucony
wyjątek (`Tool "<name>" is not allowed in agent-turn (tools=<mode>)`), `mcpClient` NIE jest w
ogóle wołany. Bariera trzyma NAWET gdy `toolRegistry.filterByAgent(agent)` sam z siebie zezwala
na to narzędzie (agent z pełnym dostępem w ustawieniach hosta) - `READONLY_TOOLS` jest GÓRNYM
sufitem TEJ komendy, nie tylko odbiciem uprawnień agenta.

**`toolCalls[].ok`/`.error` - źródło prawdy to WŁASNA księgowość, nie `AgentLoop`'owe `error:true`
(K-adwersarialna, poprawka 2026-09-26 - dawniej `ok: !detail.error` KŁAMAŁO).**
`MCPClient.executeToolCall` W PRAKTYCE NIGDY nie rzuca - łapie WŁASNE wyjątki i oddaje
`{isError:true, error}` (`MCPClient.ts` ok. l.1195-1204), więc `AgentLoop.ts` (który o `isError`
nic nie wie - ustawia `error:true` w `toolCallDetails` WYŁĄCZNIE po złapanym rzucie) widziałby
odmowę No-Go/permission jako sukces. `agent-turn` podaje więc `runAgentLoop` własny hak
`onToolResults` (lokalny, BEZ zapisu - dozwolone punktem 7 specyfikacji zadania), który per
wywołanie: rzut (whitelista wyżej) -> `ok:false`; `result` to JSON z `isError:true` -> `ok:false`,
`error` z pola `error`/`message`; inaczej -> `ok:true`. Ten sam hak (razem z `onIterationStart`,
licznikiem iteracji) jest JEDYNYM źródłem `toolCalls` w gałęzi timeoutu (wyżej) - w gałęzi
normalnego zakończenia jego werdykty są zipowane POZYCYJNIE z `loopResult.toolCallDetails`
(oba iterują TEN SAM `results` z `Promise.all`, w tej samej kolejności, per iteracja) - `ok`/
`error` z księgowości, `resultPreview`/`name`/`args` z detali pętli (bez duplikowania jej
obcinania/formatowania).

**Agent JAWNY, zero efektów ubocznych w UI usera:** `agent` jest rozwiązywany jak w `agent-prompt`
(dokładne dopasowanie -> bez wielkości liter jeśli JEDNOZNACZNE -> `agent_not_found`/
`agent_ambiguous`) i przekazywany JAWNIE do `getActiveSystemPromptWithMemory({}, agent)` i do
resolvera modelu - `agent-turn` NIGDY nie woła `agentManager.switchAgent` (przełączyłoby agenta
widocznego w oknie czatu usera) ani nie czyta `getActiveAgent()`. Model: `createModelForRole(hostRaw,
'main', agent, null, true)` - `skipCache:true` daje ŚWIEŻĄ instancję modelu, NIEWSPÓŁDZIELONĄ z
otwartą rozmową usera (bez tego dwa jednoczesne biegi - czat usera i `agent-turn` tego samego
agenta - dzieliłyby jeden adapter w trakcie `stream()`). Model `null`/bez `.stream` ->
`model_unavailable`.

**Pamięć: zero zapisu do sesji/persony.** Store to `ArrayMessageStore([system, user])` - `agent-turn`
NIE podaje `hooks.onUsage`/`beforeContinue`/`onToolCallsParsed` do `runAgentLoop` (te haki w
czacie piszą do sesji/TokenTrackera na dysku) i nie woła `appendToActiveSession`. `hooks.onIterationStart`/
`onToolResults` SĄ podane, ale WYŁĄCZNIE do lokalnej księgowości w pamięci procesu (licznik
iteracji, `ok`/`error` per narzędzie - patrz akapit wyżej) - zero zapisu na dysk, zero
persystencji między wywołaniami CLI. `session:'none'` w `AgentTurnData` jest stałą, nie pomiarem
- to jest KONTRAKT, nie obserwacja.

**Jeden bieg naraz - blokada jest PER INSTANCJA companiona, nie globalna.** Drugi równoległy
`agent-turn` (na TEJ SAMEJ instancji) -> błąd `busy`; pierwszy bieg nienaruszony. Blokada
(`createRunLock()` w `commands.ts`) żyje w ZAMKNIĘCIU `buildCliCommands` (jak
`createInstanceTracker`), NIE globalnie w module - zwalniana w `finally`, także po wyjątku i po
wygranej budzika w wyścigu wyżej (bieg osierocony w tle NIE trzyma jej dłużej). **Przeładowanie
wtyczki-nosiciela w trakcie biegu** (`plugin:reload id=pkm-assistant-dev`, albo Obsidian
przeładowujący WSZYSTKIE wtyczki) tworzy NOWĄ instancję `PkmAssistantDevPlugin` -> nowy
`onload()` -> nowe wywołanie `buildCliCommands` -> NOWA, PUSTA blokada w NOWYM zamknięciu. Stary
bieg (jeśli jeszcze trwał) i jego stara blokada idą do GC razem ze starą instancją - `agent-turn`
wywołany na NOWEJ instancji zaraz po reloadzie NIGDY nie dostanie `busy` z powodu biegu
sprzed przeładowania, nawet jeśli ten bieg fizycznie jeszcze pracuje w tle (osierocony bieg z
wygranej budzika działa DOKŁADNIE tak samo - kontynuuje niewidoczny dla nikogo, `tools=readonly`
gwarantuje że nic nie zapisze).

**Koperta `verified`/`effect`:** TEN SAM mechanizm migawki `brain.md` + `brain/` przed/po co
`agent-prompt` (`snapshotBrain`/`brainStatVerdict` w `commands.ts`) - `getActiveSystemPromptWithMemory`
potrafi nie tylko SAMONAPRAWIĆ, ale i UTWORZYĆ OD ZERA `brain.md`, gdy agent go jeszcze nie ma
(`AgentMemory.getBrain()` ok. l.1381-1391: `probeFile(...) === 'missing'` -> zapis świeżego
indeksu) - to NIE jest blokowane ani specjalnie sygnalizowane osobnym kodem błędu, tylko
uczciwie RAPORTOWANE przez `effect:'changed'` (migawka `null` przed -> plik po), dokładnie jak
przy samonaprawie istniejącego indeksu. Koperta mierzy to zamiast obiecywać czystość na wiarę, w
tym na gałęzi błędu (np. `model_unavailable` PO udanej budowie promptu niesie zmierzony `effect`,
nie `'unchanged'` z automatu).

**Maska sekretów na wyjściu (K-adwersarialna, poprawka 2026-09-26):** komunikaty `turn_failed`
(rzucone w `agentTurn.ts` - budowa promptu, model, pętla) i `internal` TEJ komendy (złapany
wyjątek w `commands.ts`, np. `resolveHost()` rzucił) przechodzą przez `maskSensitiveData`
(`core/security/SensitiveDataGuard.js`, plik BEZ importów - zero kosztu runtime, ta sama maska,
której `MCPClient`/`SubAgentRunner`/`ExternalMcpManager` już używają na błędach narzędzi) -
surowy fragment żądania/nagłówka (`Authorization: Bearer sk-...`) z warstwy transportu modelu
nie ma prawa wyjść w JSON-ie. Maskowanie jest SPECYFICZNE dla `agent-turn` (wołane w JEJ WŁASNYM
catchu w `commands.ts`, nie w dzielonym `errorMessage()`/`runGuardedAlways`/`runGuardedReady`) -
pozostałe cztery komendy fali 1 (zakaz zadania: nie ruszać ich poza liczeniem nazw) mają
`internal`/`error.message` BEZ ZMIAN.

## Rozwiązywanie hosta (`hostPlugin.ts`)

`resolveHost(app)` jest wołane PRZY KAŻDYM wywołaniu komendy wymagającej gotowości (nigdy raz w
`onload()`) - główny plugin bywa przeładowywany niezależnie od tej wtyczki
(`plugin:reload id=pkm-assistant`), a trzymana referencja wskazywałaby martwą instancję. Host
przychodzi jako `unknown` i jest zawężany NA GRANICY: `typeof`/`in`, sprawdzenie że wszystkie
pięć metod agent managera są funkcjami - dopiero POTEM `as` (po walidacji, nigdy na wiarę).
`instanceof` NIE działa (host żyje w innym bundlu, inny moduł `obsidian`, dwie różne klasy
`Plugin`) - nie używać. Brak hosta, albo host bez KOMPLETU pięciu metod agent managera -
`agentManager: undefined` w `ResolvedHost`; `status` wtedy czyta co jest (ready:false/agents:null),
pozostałe trzy komendy (fala 1) odmawiają `not_ready`.

`ResolvedHost.mcpClient`/`toolRegistry` (K-agent-turn) idą TYM SAMYM wzorcem - `raw.mcpClient`/
`raw.toolRegistry` zwężone NA GRANICY (`executeToolCall`/`filterByAgent`+`getToolDefinitions` jako
funkcje), `undefined` gdy brak/niekompletne. Pola są ADDYTYWNE: cztery komendy fali 1 ich NIE
czytają (`not_ready` liczy WYŁĄCZNIE `agentManager`, jak dotąd) - tylko `agent-turn` odmawia
`not_ready` też przy ich braku. `agentManager` potrzebny `agent-turn` do budowy promptu
(`getActiveSystemPromptWithMemory`) nie jest częścią `CliAgentManager`/`AGENT_MANAGER_METHODS` -
dopisanie go TAM rozszerzyłoby bramkę gotowości też dla pozostałych czterech komend, więc
`commands.ts` waliduje tę JEDNĄ metodę osobno, lokalnie, tuż przed użyciem (`toAgentTurnAgentManager`).

## Zależności z pluginu

**Typy WYŁĄCZNIE `import type`** z `@plugin/modules/agents/index.js` (`AgentManager`) i
`@plugin/modules/memory/index.js` (`AgentMemory`, `ConsolidationStatus`, `BrainNoteInfo`, ...) -
zero kosztu runtime, `npm run typecheck` ma wywalić się, gdy sygnatura metody w pluginie się
zmieni (to jest cały sens trzymania tego w repo, które kompiluje się na źródłach pluginu przez
alias `@plugin/`).

**Runtime'owe importy TYLKO z lekkich, czystych plików** (bundle wtyczki ma zostać mały - patrz
rozmiar w raporcie zadania, ~52 KB):
- `@plugin/modules/memory/consolidationStatus.js` - `resolveConsolidationThresholds`,
  `shouldTriggerConsolidation`, `planAutoConsolidation` (JEDNO liczydło progów konsolidacji i
  planu auto-triggera, współdzielone z produkcyjnym `SaveSessionWorkflow.applyDecision` przez
  jej prywatny `_planAutoConsolidation` - NIE kopiować tej logiki). Wszystko inne z tamtego pliku
  jest WŁASNOŚCIĄ tej wtyczki i mieszka w `memoryStatus.ts`: typy `ConsolidationStatus` /
  `MemoryStateSource`. Próg dedupu podawany do `buildPlan` NIE jest już osobną formułą tej
  wtyczki (dawne `resolvePlanDedupThreshold`, USUNIĘTE 2026-09-22) - to dziś dokładnie
  `resolveConsolidationThresholds(...).brainNotesLimit`, jedno liczydło z produkcyjnym
  `modules/chat/consolidationRunner.ts:610`,
- `@plugin/modules/memory/ConsolidationRun.js` - `buildPlan`,
- `@plugin/core/selftest.js` - `buildSelfTestReport` (dynamiczny `await import(...)` w `main.ts`).
- K-agent-turn: `@plugin/modules/agent-loop/AgentLoop.js` - `runAgentLoop`,
  `@plugin/modules/agent-loop/MessageStore.js` - `ArrayMessageStore`,
  `@plugin/modules/models/modelResolver.js` - `createModelForRole` (wszystkie trzy dynamiczne
  `await import(...)` w `main.ts`, `CliDeps.loadAgentTurnRuntime`). Pliki NAJWĘŻSZE, jakie
  produkcja w ogóle ma (nie barrele `@plugin/modules/agent-loop/index.js`/
  `@plugin/modules/models/index.js`), ale **NIE są "lekkie" w sensie, w jakim jest nim
  `consolidationStatus.js`/`SensitiveDataGuard.js` niżej** (K-adwersarialna, poprawka
  2026-09-26 - wcześniejsza wersja tego akapitu obiecywała "lekko", to było niedokładne):
  `modelResolver.js` importuje `./registry.js`, a TEN importuje WSZYSTKICH DZIEWIĘCIU dostawców
  modeli (`providers/anthropic.js`/`deepseek.js`/`gemini.js`/`groq.js`/`lm_studio.js`/
  `ollama.js`/`open_router.js`/`openai.js`/`xai.js`) plus `./ChatModel.js` (który sam importuje
  `core/index.js`, cały barrel core) i `./requestGate.js`; `AgentLoop.js` też importuje
  `core/index.js` (przez `countTokensSimple`) i `core/i18n/index.js`. Innymi słowy: dociągnięcie
  produkcyjnej pętli/resolvera modelu do companiona ZAWSZE ciągnie transport HTTP wszystkich
  platform i core barrel - to jest CENA `agent-turn` (bundla już nie da się utrzymać w okolicy
  ~52 KB z fali 1), zaakceptowana świadomie, bo alternatywą byłoby kopiowanie logiki pętli/
  resolvera (zakazane - "NIE kopiujemy treści promptu ani mechaniki pętli", nagłówek
  `lib/runTurn.ts`). Zakaz barreli `@plugin/modules/agents/index.js`/`@plugin/modules/memory/index.js`
  jako WARTOŚCI runtime'owych zostaje bez zmian - `agent-turn` importuje z nich WYŁĄCZNIE typy
  (`import type { Agent }`), zero runtime'u. Patrz gotcha "pętla i resolver modelu są
  zbundlowane osobno" niżej.

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
  po prostu pokazuje `doc_count: 'n/a'` zamiast realnej liczby, reszta sekcji (status
  indeksera, `oramaDb: present/absent`) działa normalnie.
- **`fileLogActive`** (czy plikowy sink Loggera hosta jest aktywny) - żyje jako właściwość
  `log.fileSinkActive` na singletonie `core/utils/Logger.js` pluginu. Ta wtyczka jest OSOBNYM
  bundlem (`dist/companion/main.js`) - gdyby zaimportowała `Logger.js`, dostałaby WŁASNĄ,
  osobną instancję singletona (nigdy nie przeszła przez `log.initFileSink(...)` hosta), więc
  jej `fileSinkActive` byłoby ZAWSZE `false`, niezależnie od realnego stanu hosta - gorsze niż
  brak pola (fałszywe `false` sugerowałoby "log wyłączony", gdy w rzeczywistości jest włączony).
  Sekcja "File log" w raporcie selftestu przez to zawsze pokazuje `sink: inactive` - znana,
  zaakceptowana nieścisłość, udokumentowana tu i w `main.ts`.
  **Wprost: `pkm-assistant-dev:selftest` ma TRWALE o jeden `warn` więcej niż self-test klikany
  bezpośrednio w Obsidianie** - `core/selftest.ts` (`sectionFileLog`) liczy `enabled` z ustawień
  hosta (domyślnie `true`, `fileLogEnabled !== false`) niezależnie od tego, kto woła, ale `active`
  WYŁĄCZNIE z `deps.fileLogActive`, którego ta wtyczka nigdy nie podaje (patrz wyżej) - kombinacja
  `enabled:true, active:false` to zawsze `WARN` ("Enabled in settings but sink not active."), NAWET
  gdy sink hosta naprawdę pisze na dysk. To NIE jest regresja pluginu ani fałszywy alarm do
  ścigania - to znany, trwały artefakt tego, że `companion/` czyta stan hosta z zewnątrz, osobnym
  bundlem, bez dostępu do jego żywego singletona Loggera.

## Gotchas

- ⚠️ **`yolo` + whitelista `READONLY_TOOLS` w `agentTurn.ts` to JEDYNA bariera `agent-turn`.**
  `autonomy:'yolo'` sprawia, że `PermissionSystem.requiresApproval` nigdy nie pyta (patrz
  `core/security/PermissionSystem.ts`) - `agent-turn` świadomie NIE podmienia
  `approvalManager.setApprovalHandler`/`mcpClient.diffModalFactory` hosta (współdzielone z żywym
  czatem usera - podmiana handlera zgód w trakcie jego rozmowy byłaby efektem ubocznym poza
  zakresem tego wywołania CLI, patrz `lib/runTurn.ts` harnessu, który TO robi, bo tam nie ma
  żywego usera do zepsucia). Efekt: NIC poza sprawdzeniem nazwy narzędzia w
  `makeExecuteToolCall` (`agentTurn.ts`, PRZED `host.mcpClient.executeToolCall`) nie stoi między
  modelem a wykonaniem narzędzia. **Nie usuwaj tego sprawdzenia** i nie dorzucaj do
  `READONLY_TOOLS` niczego poza `read`/`list`/`search` bez świadomej decyzji właściciela - to
  jedyna granica bezpieczeństwa całej komendy.
- ⚠️ **Pętla i resolver modelu są ZBUNDLOWANE OSOBNO w companionie - własna kopia `requestGate`,
  własny singleton Loggera/i18n.** `agentTurn.ts` dociąga `runAgentLoop`/`createModelForRole`
  dynamicznym importem ze ŹRÓDEŁ pluginu (patrz "Zależności z pluginu" wyżej) - esbuild bundluje
  je do `dist/companion/main.js` jako WŁASNY, ODDZIELNY moduł, NIE link do żywego bundla hosta.
  `modules/models/requestGate.js` (bramka współbieżności platform lokalnych, `ollama`/`lm_studio`,
  limit domyślnie 1) więc żyje w companionie jako OSOBNA instancja - **tura companiona NIE
  kolejkuje się z żywym czatem hosta** (i odwrotnie): dwa jednoczesne requesty do tej samej
  platformy lokalnej (jeden z okna czatu usera, jeden z `agent-turn`) mogą obie przejść przez
  SWOJE bramki naraz, zamiast czekać w jednej wspólnej kolejce. Na mostku lokalnym (LM
  Studio/Ollama) NIE odpalaj serii `agent-turn` w trakcie żywej rozmowy w oknie - kolejka
  jednowątkowego mostu i tak je zserializuje, ale bez korzyści z priorytetów bramki hosta.
- ⚠️ **Auto-konsolidacja opcjonalna (naprawa 2026-09-22) - `memory-status` dawniej KŁAMAŁ.**
  Plugin dodał na main dwa wyłączniki auto-konsolidacji (`memoryV3AutoConsolidateSessions`/
  `memoryV3AutoConsolidateBrain`, domyślnie OBA `false`) i `planAutoConsolidation` jako
  produkcyjne źródło prawdy dla `SaveSessionWorkflow.applyDecision` - `getConsolidationStatus`
  tej wtyczki liczyła `wouldTrigger` starym `shouldTriggerConsolidation` (który wyłączników z
  definicji nie zna), więc CLI mówiło "konsolidacja by się odpaliła" nawet gdy oba wyłączniki
  były WYŁĄCZONE (produkcja nic by nie zrobiła). Naprawa: `ConsolidationStatus` niesie dziś DWA
  pola osobno - `thresholdsExceeded` (stara semantyka, `shouldTriggerConsolidation`, BEZ WZGLĘDU
  na wyłączniki) i `wouldTrigger`/`include` (`planAutoConsolidation`, respektuje oba wyłączniki).
  Przy domyślnych ustawieniach `thresholdsExceeded:true` + `wouldTrigger:false` jest ZAMIERZONYM,
  poprawnym wynikiem, nie sprzecznością do ścigania. Przy okazji zniknęła też stara, osobna
  formuła progu dedupu (`resolvePlanDedupThreshold`, bez podłogi z ustawień) - `buildPlan`
  dostaje dziś `resolveConsolidationThresholds(...).brainNotesLimit`, jedno liczydło z
  `consolidationRunner.ts:610` (przed naprawą różniło się liczbowo, np. `state=30`/`ustawienie=50`
  dawało companionowi `30` zamiast produkcyjnych `50`). Testy: `memoryStatus.test.ts`.
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
- ⚠️ **Atrapa typów CLI kontra PRAWDZIWY `obsidian.d.ts` - pilnowane przez `obsidianContract.ts`
  (K5, recenzja adwersaryjna).** Do tego pliku nic nie porównywało atrapy (`test-support/
  obsidian.ts`) z prawdziwym Obsidianem - gdyby się rozjechały (Obsidian zmienia kształt
  `CliFlag`, dokłada parametr do `registerCliHandler`), ten repo kompilowałby się i testował
  dalej zielono, mimo że produkcyjna wtyczka w PRAWDZIWYM Obsidianie już by nie pasowała.
  `obsidianContract.ts` jest plikiem TYLKO-TYPOWYM (zero kodu runtime): importuje `CliData`/
  `CliFlag`/`CliFlags`/`CliHandler`/`Plugin` z `@plugin/node_modules/obsidian/obsidian.js`
  (prawdziwy `obsidian.d.ts` REPO PLUGINU, przez istniejący alias `@plugin/` - `obsidian` nie
  jest zależnością TEGO repo, ale `moduleResolution: "bundler"` w `tsconfig.json` rozwiązuje
  specyfier `.js` na towarzyszący `.d.ts`, tak jak dla zwykłych plików `.ts` pluginu) i wymusza
  OBUSTRONNĄ przypisywalność z odpowiadającymi typami atrapy, plus zgodność sygnatury
  `registerCliHandler`. Naruszenie w KTÓRĄKOLWIEK stronę wywala `npm run typecheck` W TYM PLIKU
  (`Type 'false' does not satisfy the constraint 'true'`), niezależnie od reszty repo.
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
- ⚠️ **Dwa bundle, jedno liczydło - prawda TYLKO na poziomie źródeł i CHWILI BUILDA (K3,
  recenzja adwersaryjna).** `memoryStatus.ts` i `main.ts` importują progi konsolidacji/plan/raport
  selftestu runtime'owo z `@plugin/...`, ale to, co WCHODZI do `dist/companion/main.js`, jest
  WKOMPILOWANE w chwili `npm run build:companion` - esbuild bundluje te funkcje ze ŹRÓDEŁ pluginu
  na dysku, NIE linkuje do `dist/main.js` pluginu w vaulcie. Jeśli plugin zostanie przebudowany
  PÓŹNIEJ (nowa formuła progów, nowy kształt raportu selftestu), TA wtyczka o tym nie wie, dopóki
  ktoś nie odpali `build:companion` ponownie - **po KAŻDYM buildzie pluginu przebuduj też
  wtyczkę**. TO SAMO dotyczy TERAZ TEŻ `agent-turn` (K-agent-turn): `runAgentLoop`/
  `createModelForRole` wkompilowują się do `dist/companion/main.js` dokładnie tak samo jak progi
  konsolidacji - zmiana kontraktu pętli/resolvera modelu w pluginie (nowe pole `RunAgentLoopOptions`,
  inna drabinka `createModelForRole`) NIE dotrze do `agent-turn` bez ponownego `build:companion`,
  mimo że `npm run typecheck` TEGO repo złapie niezgodność typów od razu (kompiluje się na
  źródłach pluginu przez `@plugin/`). `StatusData.companionStale` (`cli/commands.ts`) to wykrywa: `true`, gdy
  `plugin.bundleMtime` (mtime `dist/main.js` pluginu w vaulcie, `hostPlugin.ts`
  `resolvePluginBundleMtime`) jest PÓŹNIEJSZY niż `companion.builtAt` (znacznik WŁASNEGO builda
  tej wtyczki, wstrzyknięty przez esbuild `define` w `buildCompanion()` - `lib/pluginBuildInfo.ts`
  + `companion/buildInfo.ts`) - **`companionStale:true` znaczy, że wyniki `memory-status`/
  `selftest` mogą liczyć/opisywać STARĄ formułę/kształt**, nie dzisiejszą. `null`, gdy nie da się
  ustalić (brak `configDir`, brak pliku bundla pluginu w vaulcie). Poza prawdziwym buildem
  esbuilda (testy AVA, scenariusze - inny wpis esbuilda bez tego `define`) `companion.builtAt`/
  `pluginCommit` spadają na fallback `'unknown'`, `pluginTreeDirty` na `false` - `typeof` guard w
  `buildInfo.ts`, nigdy nie rzuca.

## Powiązane

- `README.md` (root tego repo) - build `dist/companion/main.js`, deploy, alias `@plugin/`.
- `esbuild.harness.ts` - `buildCompanion()`, `pluginAliasPlugin` (alias `@plugin/` bez atrapy
  `obsidian` - w odróżnieniu od `pluginTreePlugin` używanego przez `run.js`/`scenarios.js`).
- `lib/companionDeploy.ts` - `parseDeployConfig`/`companionDeployDir`/`deployCompanion`.
- `lib/pluginBuildInfo.ts` - `resolvePluginGitInfo(pluginRootDir)` (K3 - commit + czystość drzewa
  pluginu w chwili `build:companion`, wołane z `esbuild.harness.ts` -> `define`).
- `scenarios/47_cli_odczyt.ts` - end-to-end na PRAWDZIWYM pluginie jako hoście, w tej samej
  atrapie `app` (offline, brak modelu, migawka drzewa vaulta przed/po = dowód zerowego zapisu).
- `scenarios/48_cli_agent_turn.ts` - end-to-end `agent-turn` na PRAWDZIWYM pluginie: fake-serwer
  offline wymusza `read` (wykonane) -> `write` halucynowany (odrzucony PRZED `mcpClient`) ->
  tekst; migawka drzewa vaulta dopuszcza WYŁĄCZNIE zmiany, które koperta `effect` jawnie
  raportuje (samonaprawa `brain.md`/`brain/`).
