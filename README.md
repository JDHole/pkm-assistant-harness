# Harness „Szklane Pudło" (S26) — testowanie pluginu bez Obsidiana

Narzędzie **wewnętrzne** (dev-only, nie wchodzi do `dist/main.js`). Odpala **prawdziwy plugin**
— ten sam `PKMAssistantPlugin` z `src/main.js`, pełny bootstrap `initialize()`, prawdziwi agenci z YAML,
prawdziwy łańcuch uprawnień, prawdziwa pętla `agent-loop` i trace — w czystym Node, na
tymczasowym vaulcie-atrapie. Podstawione jest wyłącznie to, czego poza Obsidianem fizycznie
nie ma: moduł `obsidian` (mock przez esbuild alias) i szczypta DOM. **Zero forka logiki — testujemy dokładnie ten kod, który dostaje user.**

Spec i decyzje: `Refaktor/Sprinty/S26_Harness_Szklane_Pudlo_SPEC.md`.
Wizja-rodzic: `Nauka/Wizje/WIZJA_Szklane_Pudlo.md` (to jest piętro 2 piramidy).

## Komendy

```bash
npm run harness              # build + dry-boot: plugin wstaje w Node, raport DoD (bez modelu)
npm run harness:selftest     # pełny cykl pętli z fake-serwerem SSE (offline, bez klucza, 0 kosztów)
npm run harness:scenarios    # 34 scenariuszy-łamaczy [OFFLINE deterministyczny] — regression suite
npm run harness:scenarios:live   # te same scenariusze na ŻYWYM DeepSeeku (wymaga klucza, płatne grosze)
npm run harness:build        # sam build (harness/dist/)
```

**Harness jest linterowany jak reszta repo (werdykt Kuby 2026-09-02).** `npm run lint` obejmuje
`harness/**/*.{js,ts}` — WSPÓLNY blok `no-restricted-imports` razem z `modules/`, `src/`,
`config/` i `utils/` (`eslint.config.js:170`, ta sama złota zasada egzekwowana wzorcami
`deepImportPatterns`: poza modułem importujemy tylko przez `modules/<nazwa>/index.js` i
`core/index.js`), nie osobny blok. Dwa wyjątki są PER-PLIKOWE, w osobnych blokach niżej:
`eslint.config.js:216` dla `harness/scenarios/33_skill_marker.ts` (wolno deep-importować
WYŁĄCZNIE `modules/chat/chat/InlineChipPlugin.js`) i `:234` dla
`harness/scenarios/35_artefakt_approval.ts` (WYŁĄCZNIE `modules/artifacts/artifactButtons.js` i
`artifactSummon.js`) — symbole świadomie usunięte z barreli w S30 Z4, których potrzebują te dwa
scenariusze (dopisanie ich z powrotem do barreli byłoby poszerzaniem produkcyjnego API pod
testy). Każdy INNY deep-import z harnessu jest błędem lintu. Uzasadnienie każdego wyjątku siedzi
w komentarzu nad blokiem tego pliku w `eslint.config.js`.

Bieg eksploracyjny (dowolny prompt, żywy model):

```bash
node harness/dist/run.js --agent Tester --prompt "przeczytaj Notatki/powitanie.md i streść"
```

Flagi: `--agent <nazwa>` `--prompt "<...>"` `--autonomy yolo|edge|all` (default edge)
`--approve auto|deny` `--max-iterations N` `--offline` (fake-serwer zamiast żywego API)
`--keep-vault` (nie kasuj temp-vaulta — do inspekcji) `--json` (wynik maszynowy)
`--dry-boot`. Scenariusze: `--only NN`, `--live`.

**Kody wyjścia (bramka, nie ozdoba):** `0` = całe DoD biegu na PASS, `1` = choć jedna pozycja DoD
czerwona albo bieg się wywrócił, `2` = brak klucza przy biegu żywym. Od 2026-08-23 dotyczy to tak
samo dry-boota, **selftestu (FAZA B — wcześniej wychodził zerem zawsze)** i scenariuszy; `--json`
niesie ten sam werdykt w polach `ok` i `dod`. Pozycja DoD czytana z trace przy trace wyłączonym
lub nieobecnym jest FAIL z powodem, nie cichy PASS — strażnik: `harness/lib/report.test.ts`.

**F2.9 (rejestr ryzyk 01.09):** pozycja DoD `finalText niepusty` dawniej przechodziła na
`length > 0` — jeden token modelu ("Po", "OK", "Gotowe.") świecił zielono bez żadnego dowodu, że
zlecona robota w ogóle została podjęta. Bramka dziś sprawdza w tej kolejności: (1) `finalText`
kompletnie PUSTY (po przycięciu) jest ZAWSZE FAIL, niezależnie od tego, czy narzędzie było
wywoływane — **warunek konieczny**, egzekwuje to, co nazwa pozycji obiecuje (W6-01, review fali 2
2026-09-04: stary warunek `(len >= próg || attemptedTool)` przepuszczał pusty finalText jako
zielony, gdy tylko padła jakakolwiek próba narzędzia — a w `harness:selftest` próba jest ZAWSZE,
więc pozycja była niefalsyfikowalna). (2) Dopiero dla NIEPUSTEGO `finalText`: **≥ 40 znaków**
(stała `MIN_FINAL_TEXT_LENGTH` w `harness/lib/report.ts`, z komentarzem uzasadniającym akurat tę
liczbę) **ALBO** bieg podjął choć jedną próbę narzędzia — LICZY SIĘ też próba ODBITA
(nieudana/zablokowana), bo `isNoAttemptRun` (reużyty wprost z `harness/scenarios/_asserts.ts`, nie
duplikowany) patrzy strukturalnie na obecność wpisu w `toolsUsed`/`toolCallDetails`, nie na jego
wynik. Gdy żaden z warunków nie jest spełniony, pozycja jest FAIL z powodem cytującym odpowiedź
modelu i liczbę znaków. Strażnik: `harness/lib/report.test.ts` (pusty finalText z niepustą próbą
narzędzia, jednotokenowa odpowiedź bez narzędzi, długa odpowiedź bez narzędzi, krótka odpowiedź z
jedną — nawet odbitą — próbą narzędzia, brak `result`).

**Statusy scenariuszy (`harness/scenarios/_runner.ts`), pełny słownik:** `GREEN` = `asserts()`
przeszło i wykonało co najmniej jedno zliczane sprawdzenie, `RED` = padła asercja albo błąd
infrastruktury/biegu, `SKIP` = scenariusz pominięty w `--live` (deklaruje `liveSkip` — wymusza
zachowanie, o którym żywy model decyduje sam), `EMPTY` = `asserts()` przeszło bez rzucenia błędu,
ale nie wykonało ŻADNEGO zliczanego sprawdzenia — cichy fałszywy PASS, gdyby liczyć tylko brak
wyjątku, `NO_ATTEMPT` (tylko `--live`, od 2026-09-03) = żywy model nie wywołał ANI JEDNEGO
narzędzia — bieg niczego nie dowodzi (ani sukcesu, ani porażki mechanizmu), więc nie jest ani
`RED` (to nie znalezisko w pluginie), ani `GREEN`. Rozpoznaje to RUNNER przed `asserts()`, dla
KAŻDEGO scenariusza (`isNoAttemptRun` w `_asserts.ts`, sygnał strukturalny: puste `toolsUsed`
i `toolCallDetails` z wyniku pętli) — werdykt Kuby 2026-09-02; wcześniej umiał to tylko
`03_izolacja_pkm`, per-narzędziowo. Raport pokazuje, co model powiedział zamiast próby, ogon
trace i zostawia temp-vault. **Fail-closed:** kod wyjścia `1` pada nie tylko przy `RED`, ale też
przy `EMPTY` i `NO_ATTEMPT` (`anyRed || anyEmpty || anyNoAttempt || total === 0`, `_runner.ts`)
— scenariusz, który niczego nie zweryfikował, liczy się w bramce jako oblany, nie jako sukces.

**ŻADNA komenda harnessa nie jest częścią `npm test`** — `npm test` zostaje darmowe i offline.
Sam KOD harnessu za to jest pod bramkami jak reszta repo (werdykt 2026-09-03): `npm test` zbiera
`harness/**/*.test.ts` (nie tylko `harness/lib/`), `npm run lint` pilnuje w nim złotej zasady
importów (harness to pierwszy konsument pluginu „z zewnątrz", więc wchodzi przez barrele; dwa
scenariusze z celowym deep-importem czystych helperów mają per-plikowe wyjątki w
`eslint.config.js`), `npm run typecheck` obejmował go od TS-5. Poza `lint:obsidian` — powód
w `eslint.obsidian.config.js`.
Scenariusze `--live` i bieg eksploracyjny bez `--offline` robią realne requesty do DeepSeek
(koszt: ułamki centa za bieg — DeepSeek jest tani, ale świadomie).

## Klucz API (bieg żywy)

Plik `harness/.env.local` (gitignored — NIGDY nie commitować, nie wklejać do czatów):

```
DEEPSEEK_API_KEY=sk-...
```

Szablon: `harness/.env.example`. Bez klucza biegi żywe kończą się czytelnym komunikatem
i `exit 2` (odróżnialne od crashu). Klucz jest mostkowany w locie do
`pkmAssistant.chat.apiKeys.deepseek` (produkcyjny `modelResolver` czyta tylko stamtąd) — zapisem do
SUROWEGO worka (`env.settingsStore.raw`), nie przez obserwowane proxy: klucz wkłada harness, nie user,
a mutacja proxy zaplanowałaby zapis `settings.json` i zafałszowała scenariusze pancerza (26/27/39).

## Jak to działa (architektura w pigułce)

```
run.js / scenarios.js  (Node)
  ├─ dom-shim  (globale, których Node nie ma)
  ├─ kopia vault-fixture → %TEMP%\pkm-harness\<timestamp>\   (izolacja: prawdziwy vault niewidzialny)
  ├─ mock app (vault+adapter na fs, metadataCache-lite, workspace no-op)
  └─ new PKMAssistantPlugin(mockApp, manifest) → onload() → initialize() → waitForReady()
       └─ bieg: runAgentLoop z PRODUKCYJNYMI: promptem systemowym
          (agentManager.getActiveSystemPromptWithMemory — ta sama funkcja co czat),
          listą narzędzi (filterByAgent — whitelisty działają), egzekucją
          (mcpClient.executeToolCall z autonomią), trace (plugin.traceLog)
```

Build: `esbuild.harness.ts` — alias `obsidian → harness/mock/obsidian.ts`, platform=node.
Każdy build harnessa jest przy okazji load-testem bundla (łapie cykle importów barreli —
lekcja z E2.8).

## Scenariusze — jak czytać i jak dodać

Scenariusz = plik `harness/scenarios/NN_nazwa.ts`: `{name, opis, agent, autonomy, approve,
maxIterations, fixtures (nadpisy plików vaulta), setup({plugin, vaultRoot, app}) (opcjonalny
hook PO boocie a PRZED turą modelu — do rzeczy, których w vaulcie nie ma, np. podpięcie atrapy
zewnętrznego serwera MCP przez DI), offlineScript (skrypt fake-serwera SSE), livePrompt (prompt
dla żywego modelu), liveSkip (powód pominięcia w `--live`),
asserts({result, trace, vaultRoot, before, approvals, turn, plugin})}` + rejestracja w `scenarios/index.ts`.

### Co scenariusz ma pod ręką poza fake-serwerem SSE

| Narzędzie | Skąd | Po co |
|---|---|---|
| `setHarnessRequestUrlRoutes(routes)` / `clearHarnessRequestUrlRoutes()` | `mock/obsidian.js` | Drugi kanał wyjścia pluginu na świat: `requestUrl` (wyszukiwarka webowa, generowanie obrazów, STT). Trasa = `{match: substring \| RegExp \| (url)=>bool, handler(req) => {status?, text?, json?, arrayBuffer?, headers?}}`. **Żaden realny HTTP nie leci** — handler zwraca gotowy obiekt, a router dopełnia brakujące pola (`text`↔`json`, status 200). Bez trasy leci blokada: `599` + ostrzeżenie w logu (zaślepka GitHuba i updater zdjęte 2026-09-04, D1 — nie ma już żadnej trasy domyślnej). |
| `startFakeOllamaServer({script})` + `ollamaTextTurn(text, {thinking})` | `mock/fake-ollama-server.js` | Ollama gada NDJSON pod `<host>/api/chat` i kończy na `done_reason`, nie na `data: [DONE]` — `fake-llm-server` (SSE OpenAI) jej nie udaje. Tury tekstowe z natywnym myśleniem; tool calli ten serwer świadomie nie umie. |
| `setHarnessLmStudioEndpoint(url)` / `setHarnessOllamaHost(origin)` | `lib/harnessProviders.ts` | Adres fake-serwera dla platform lokalnych. **Żadnych podklas**: dostawcy są bezstanowi, więc harness owija ich obiektem, który podmienia WYŁĄCZNIE endpoint (`withEndpoint`), a resztę — budowę żądania, dekoder strumienia, parser myślenia — bierze z produkcji. Podmianę wkłada `boot.ts` do `plugin.runtimeConfig.chat.providers` PRZED `onload()` (C-02: `runtime.config === plugin.runtimeConfig`). LM Studio bez jawnego ustawienia bierze wspólny endpoint harnessa, więc `offlineScript` działa mu od ręki. |
| `getHarnessCompletions(platform)` / `clearHarnessCompletions()` | `lib/harnessProviders.ts` | Podsłuch KOMPLETNEJ odpowiedzi modelu, gdy wynik pętli jej nie wystawia — dziś jedyna droga do `reasoning_content` (patrz scenariusz 25). Wpina się przez OPAKOWANIE MODELU (`tapModel` w `lib/runTurn.ts` owija `ChatModel.stream`), bo dostawcy nie mają `stream()`. Etykieta platformy to `providerId` ROZSTRZYGNIĘTEGO modelu, więc agent z własnym modelem w YAML-u (`model: lm_studio/…`) trafia pod swoją platformę, a nie pod globalny wybór usera. Niczego nie zmienia po drodze. |
| `errorTurn({status, message})` | `mock/fake-llm-server.js` | Tura, która zamiast strumienia oddaje AWARIĘ HTTP modelu (default 500). Osobny kształt jest konieczny: transport strumienia sprawdza status odpowiedzi ZANIM dotknie SSE, więc padniętego modelu nie da się udać żadnym układem delt. ⚠️ Nie używaj 429 — `ChatModel` ponawia go z backoffem (koniec determinizmu). |
| `runExploratoryTurn(plugin, {..., systemPromptSuffix})` | `lib/runTurn.js` | Druga (i kolejna) tura odpalana ręcznie z `asserts`, na tym samym temp-vaulcie. `systemPromptSuffix` dokleja tekst na końcu promptu systemowego — odwzorowanie tego, co w czacie robią markery inline (`@@skill:`). |

Stan globalny (trasy routera, adresy lokalnych platform, podsłuch) `_runner.js` **zeruje przed
każdym scenariuszem i w `finally` po nim** — scenariusze biegną w jednym procesie, więc nic nie
może przeciec do następnego.

**Zasada asercji:** sprawdzamy **inwarianty kodu** (plik powstał/nie powstał/nietknięty,
`stoppedBy=backstop`, blokada zadziałała, zero pytań w yolo), nie słowa modelu — żywy model
jest niedeterministyczny i to jest OK. Dziwne zachowanie modelu przy zielonych inwariantach
= znalezisko do zgłoszenia, nie zepsuty test.

**Zasada znalezisk:** jeśli scenariusz obnaża buga PRODUKCJI — scenariusz zostaje RED
z dowodem (fragment trace + stan fs). NIE naprawiamy produkcji „przy okazji" w harnessie.

Pierwsza fala (FAZA C, numeracja 01-14) — 14 z 34 scenariuszy łącznie (reszta niżej):
smoke pętli · backstop · izolacja `.pkm-assistant` · No-Go · create-only pamięci ·
edge+deny · yolo-nie-omija-uprawnień · artefakt plan (create+patch) · todo (create+check) ·
sklejone tool_calls DeepSeeka (deterministyczna reprodukcja historycznego buga E2.1) ·
**11 głębia delegacji** (sub próbuje zlecać dalej → strażnik `max_delegation_depth` odmawia,
drugi runner nie startuje) · **12 pętla poczty** (`kom_send`: rate-limit + licznik odbić `hop`,
a duch z `komunikator_visible:false` daje ten sam błąd co literówka i nie wycieka na listę) ·
**13 external RED** (narzędzie cudzego serwera MCP = obowiązkowa zgoda w `edge`, a do serwera
nie wychodzi żaden znacznik `_invocation*` — sprawdzane na atrapie klienta MCP przez `setup()`).

Scenariusze 11-13 są **offline-only** (`liveSkip`): wymagają wymuszenia zachowania, o którym
żywy model decyduje sam (wywołanie `delegate` z wnętrza suba, zaprojektowana sekwencja wysyłek,
atrapa zewnętrznego serwera).

Do tego **14 pisarze sesji (S36)** — event-log przeżywa autozapis i restart (`AgentMemory.saveSession` + świeża instancja `AgentMemory` na tym samym temp-vaultcie).

**Poligon F1 (numeracja 25+):**
- **25 parser myślenia** — myślenie modelu rozumującego nie wycieka do odpowiedzi, na DWÓCH
  torach naraz: LM Studio (inline `<think>…</think>`, znacznik ROZCIĘTY między chunki) i Ollama
  (natywne `message.thinking`, własny fake-serwer NDJSON odpalany z `asserts`). Sprawdza też, że
  tool call wysłany PO bloku myślenia dalej się parsuje i wykonuje. Offline-only.
- **26 pancerz ustawień** — regresja incydentu 2026-07-28: uszkodzony `settings.json` nie zostaje
  nadpisany przez load, ląduje na odkładce `settings.corrupt-<ts>.json`, śmieci NIE awansują na
  `settings.last-good.json` ani na dzienny backup, a plugin wstaje na defaultach i prowadzi turę.
- **27-35** — kolejne partie Poligonu (ostatnia dobra kopia ustawień, cykl i puls pamięci, przepis
  skilla, szablon suba, deep research, marker skilla, sprzątanie poczty, approval artefaktu).
  Opis każdego siedzi w nagłówku jego pliku — tu go świadomie nie duplikujemy.
- **36 web z pochodzeniem** — cała warstwa webowa na atrapach routera `requestUrl`: `web_search`
  przez Jinę, `web_read` na adresie Z WYNIKÓW (przechodzi) i na adresie WYMYŚLONYM przez model
  (odbija się o `urlRegistry` — wektor eksfiltracji przez URL). Plus parsowanie odpowiedzi
  pozostałych 4 dostawców (Tavily/Brave/Serper/SearXNG) wołanych wprost przez `executeWebSearch`,
  z inwariantem „obsłużył SAM, bez zejścia na podłogę Jiny".
- **37 semantyka i indeks** — prawdziwy `VaultIndexer` na wstrzykniętym, deterministycznym
  embedderze (worek słów + hasz): indeks publikuje się jako `plugin.oramaDb`, `search
  {mode:'semantic'}` realnie idzie przez wektory (`mode_used`), indeks NIE zawiera
  `.pkm-assistant/` ani No-Go, a `scope:'memory'` zostaje bez semantyki i mówi o tym notą —
  zachowanie KONTRAKTOWE (izolacja pamięci), nie luka.
- **38 multimodal offline** — `generate_image` na atrapie platformy: bajty w vaulcie są 1:1 z tymi
  z odpowiedzi, obok powstaje notatka z osadzeniem `![[…]]`. Plus STT (`transcribeAudio` wołane
  jak z czatu — to nie jest narzędzie MCP): ścieżka udana i trzy czytelne błędy. Vision świadomie
  poza zakresem (żyje w warstwie czatu).

Asercje dostają też `plugin` — ŻYWY obiekt pluginu tego biegu (przed cleanupem). Scenariusz może
po turze wołać produkcyjne API na tym samym temp-vaultcie (`14_sesja_pisarze` symuluje tak autozapis
`AgentMemory.saveSession` i restart Obsidiana przez świeżą instancję `AgentMemory`).

⚠️ **Czego harness NIE robi sam: nie pisze pliku `sessions/active/`.** Bieg to `runExploratoryTurn`
→ `runAgentLoop`, czyli pętla BEZ czatu, a pisarzem zdarzeń w produkcji jest
`modules/chat/chat/chat_streaming.js`. Scenariusz, który potrzebuje pliku sesji, odgrywa rolę czatu
sam — produkcyjnym `AgentMemory.appendToActiveSession` (wzorzec: `14_sesja_pisarze`).

## Trace — okno w proces myślenia

Każdy bieg pisze `.pkm-assistant/logs/trace.log` w temp-vaultcie (przy `--keep-vault` zostaje):
`loop.start → model.done → tool.pre/tool.blocked/tool.post → backstop? → loop.end`.
To jest Szklane Pudło piętro 1 (E2.2) karmiące piętro 2: asercje scenariuszy parsują trace
(`scenarios/_asserts.js: parseTrace`).

Gotcha: `MCPClient.executeToolCall` nigdy nie rzuca — błędy wracają jako `{isError:true}`
w wyniku, więc `tool.post` ma status `ok` także przy odmowie. Asercje blokad kluczują na
stanie fs + treści wyniku, nie na statusie tool.post.

## Znane granice atrapy (świadomie płytkie)

- `metadataCache` v1-lite: `getFileCache→{frontmatter}`, `resolvedLinks={}` — wystarcza,
  bo RetrievalEngine/VaultIndexer mają fallbacki; rozbudować, gdy scenariusz tego zażąda.
- UI (Modal/ItemView/Setting) konstruuje się, nie renderuje — harness nie testuje UI.
- Boot ~0,15 s (było ~3,2 s do 2026-08-23): oba okna czekania na starcie wycięte z produkcji —
  konfigurowalny sen startowy zniknął razem ze starym środowiskiem, a ślepy sen 3000 ms przed
  ładowaniem danych zastąpiło zdarzenie `workspace.onLayoutReady` (`waitForLayoutReady`
  w `core/layoutReady.ts`). Atrapa woła ten callback przez `queueMicrotask`, więc dry-boot
  mierzy dziś głównie realną robotę.
- Agenci: fixture `Tester` (pełen dostęp) + `Ciasny` (tylko przypisane foldery, disabled
  write/delete/create_folder) + `Jaskier` (wszyty w plugin — zawsze dochodzi). Scenariusz
  potrzebujący agenta na innej platformie dokłada własny YAML przez `fixtures` z polem
  `model: <platforma>/<model>` (wzór: `25_think_parser`).
- Embeddingi: brak providera w fixture → semantyka degraduje do `no_provider` (uczciwa nota,
  jak w produkcji bez konfiguracji). Scenariusz, który POTRZEBUJE żywej semantyki, podstawia
  własny model pod `env.embeddings.default` i stawia swój `VaultIndexer`
  (wzór: `37_semantyka_indeks`). Bieg z prawdziwym providerem = osobna decyzja (ew. Ollama).
