/**
 * @file widgetHome.js — Główny dashboard systemu JDHole OS (entry point Home)
 * @agent system
 * @pracownia system (root view)
 * @exports (entry point - renderuje do trwałego hosta panelu, patrz components/shared/trwaly_host.js)
 * @uses _loader, xp_engine, components/home/{HeroBanner,AgentDock,TodayHabits,CalendarMonth,RecentProjects,SideStack,DeepWorkTimer,pulpit_kafle}.js, components/shared/bento.js, wszystkie widgety CC agentów
 * @reads daily fm (agent_log[], xp_*, habit_*), 99_System/State/{deep_work,season,xp_queue}.json, weekly notes
 * @writes auto-create dzisiejszej daily note (cicho przy starcie), state Home (window.jdHomeState), ctx.setView() switching agent CCs
 * @since 2026-04-18 v5.0 (Two-Panel Command Center, Refactor 2026 -63% LOC, single-page agent CC switching)
 * @since 2026-08-29 v5.1 - montaż przez trwały host (inicjatywa "Stabilny Obraz 2026"):
 *        DOM Home stoi w .view-content panelu i przeżywa re-render dataview;
 *        przebudowa tylko przy zmianie zrodel (Daily / State / _state.json System HQ)
 * @tests manual reload Obsidian
 */
// 99_System/Scripts/views/widgetHome.js
// GŁÓWNY DASHBOARD SYSTEMU JDHOLE_OS
// Wersja 5.0 (Two-Panel Command Center)

const BASE = app.vault.adapter.basePath;
const CONF = require(BASE + "/99_System/Scripts/config.js");
const UTILS = require(BASE + "/99_System/Scripts/utils.js");
const XP_ENGINE = require(BASE + "/99_System/Scripts/xp_engine.js");

// Import Agentów
const IRIS = require(BASE + "/99_System/Scripts/agents/iris.js");
const JASKIER = require(BASE + "/99_System/Scripts/agents/jaskier.js");
const DEXTER = require(BASE + "/99_System/Scripts/agents/dexter.js");
const PERSIVAL = require(BASE + "/99_System/Scripts/agents/persival.js");
const SONNY = require(BASE + "/99_System/Scripts/agents/sonny.js");
const EZRA = require(BASE + "/99_System/Scripts/agents/ezra.js");
const KAIA = require(BASE + "/99_System/Scripts/agents/kaia.js");
const KaiaCC = require(BASE + "/99_System/Scripts/views/widgetKaiaCommandCenter.js");
const JaskierCC = require(BASE + "/99_System/Scripts/views/widgetJaskierCommandCenter.js");
const CentrumZdrowia = require(BASE + "/99_System/Scripts/views/widgetCentrumZdrowia.js");
const FamaCC = require(BASE + "/99_System/Scripts/views/widgetFamaCommandCenter.js");
const LexieCC = require(BASE + "/99_System/Scripts/views/widgetLexieCommandCenter.js");
const SilasCC = require(BASE + "/99_System/Scripts/views/widgetSilasCommandCenter.js");
const SonnyCC = require(BASE + "/99_System/Scripts/views/widgetSonnyCommandCenter.js");
// Biblioteka Materialow 2026: Command Center v2 za flaga CONF.SONNY_CC ("v1" | "v2").
// Obie wersje require'owane, przelaczenie i odwrot = jedna linia w config.js.
// require v2 w try/catch: v2 i jego zaleznosci (percepcja_store -> media_store) sa w budowie,
// a blad na poziomie modulu zabilby CALY Home (wszystkie karty, nie tylko Sonny'ego).
// v2 nie wstaje -> Sonny leci na v1, powod w konsoli.
let SonnyCC2 = null;
try {
    SonnyCC2 = require(BASE + "/99_System/Scripts/views/widgetSonnyCC2.js");
} catch (e) {
    console.error("[Home] widgetSonnyCC2.js nie zaladowal sie - Sonny zostaje na v1:", e);
}
const DexterCC = require(BASE + "/99_System/Scripts/views/widgetDexterCommandCenter.js");
const LaboratoriumCC = require(BASE + "/99_System/Scripts/views/widgetLaboratorium.js");
const Gymnazjum = require(BASE + "/99_System/Scripts/views/widgetGymnazjum.js");
const DevDesktop = require(BASE + "/99_System/Scripts/views/widgetDevDesktop.js");
const BeeboCC = require(BASE + "/99_System/Scripts/views/widgetBeeboCC.js");
const SalvatoreCC = require(BASE + "/99_System/Scripts/views/widgetSalvatoreCC.js");
const XpBoard = require(BASE + "/99_System/Scripts/views/widgetXpBoard.js");

// Import Komponentów
const HeroBanner = require(BASE + "/99_System/Scripts/components/home/HeroBanner.js");
const AgentDock = require(BASE + "/99_System/Scripts/components/home/AgentDock.js");
const TodayHabits = require(BASE + "/99_System/Scripts/components/home/TodayHabits.js");
const CalendarMonth = require(BASE + "/99_System/Scripts/components/home/CalendarMonth.js");
const RecentProjects = require(BASE + "/99_System/Scripts/components/home/RecentProjects.js");
const SideStack = require(BASE + "/99_System/Scripts/components/home/SideStack.js");
const DWState = require(BASE + "/99_System/Scripts/components/home/DeepWorkState.js");
const DailyScan = require(BASE + "/99_System/Scripts/components/daily/DailyScan.js");
const NocnaTab = require(BASE + "/99_System/Scripts/components/home/NocnaTab.js");
const HasiokTab = require(BASE + "/99_System/Scripts/components/home/HasiokTab.js");
// B2 Pulpit bento (13.09): silnik siatki + opis/adaptery kafli Pulpitu. Zakladka
// "Trendy" WYCIETA z Pulpitu (decyzja Kuby 13.09) - jej komponent stracil tu require
// i uzycie; plik zostaje na dysku (sierota, sprzatanie w E6 - spec B2 sekcja 9).
const BENTO = require(BASE + "/99_System/Scripts/components/shared/bento.js");
const PULPIT = require(BASE + "/99_System/Scripts/components/home/pulpit_kafle.js");
// B3 (13.09): WU.sprzataj(contentContainer) w refreshContent()/stop() gasi
// KAZDA siatke bento wpieta gdziekolwiek w karcie agenta (dzis Dexter/Zdrowie -
// widgetDexterCommandCenter.js rejestruje swoj `content` przez
// WU.rejestrujSprzatanie) - hook generyczny, kolejne CC (B4) go dostana bez
// zmian tutaj.
const WU = require(BASE + "/99_System/Scripts/components/shared/widget_utils.js");

const HOST = require(BASE + "/99_System/Scripts/components/shared/trwaly_host.js");
// N1 (19.09, Kontrakt Ekranu): logika czysta "dwa prostokaty -> px nakladki
// .status-bar" - wspolna dla KAZDEGO korzenia .jd-ekran (nie tylko Home), patrz
// komentarz przy ResizeObserverze nizej.
const EKRAN_CORE = require(BASE + "/99_System/Scripts/components/shared/ekran_core.js");

// --- CSS ---
UTILS.loadCSS(BASE, "jd-base.css", app);
// Kontrakt ekranu (2026-09-12) - warstwa .jd-ekran/.jd-ekran-tresc/.jd-kafel-scroll,
// musi wejsc PRZED jd-home.css zeby jd-home.css mogl dokladac reguly na .jd-ekran.
UTILS.loadCSS(BASE, "jd-ekran.css", app);
UTILS.loadCSS(BASE, "jd-home.css", app);
// Skin "Ognisko" (inicjatywa Skin Ognisko 2026). Fonty osobno, bo sa wkompilowane
// base64 - loadCSS wstrzykuje <style> do head, wiec relatywne url() nie trafiloby
// w vault. jd-pixel.css idzie ostatni: wygrywa remisy specyficznosci.
UTILS.loadCSS(BASE, "jd-pixel-fonts.css", app);
UTILS.loadCSS(BASE, "jd-pixel.css", app);
// Skin SSOT Sonnyego (E1, 12.09): OSTATNI w kaskadzie - jego palety --px-* i tokeny --jd-*
// wygrywaja z jd-pixel.css (ten sam selektor .jd-skin[data-agent], pozniejszy wygrywa).
// Docelowo palety z jd-pixel.css wyjezdzaja (E3+), jd-pixel zostaje ze sceneria.
UTILS.loadCSS(BASE, "jd-skin.css", app);
// B2 hotfix (13.09, review opusa blocker 1): `--{agent}-color` (karty projektow,
// kafel "proj") dzis wstrzykiwane TYLKO przy wejsciu w CC agenta (loadAgentCSS ->
// injectColorVars). Pulpit uzywa tych zmiennych od razu, bez odwiedzenia zadnego
// CC w tej sesji - idempotentne (guard na #jd-color-vars w utils.js).
UTILS.injectColorVars(CONF.COLORS || {});

const PIXEL = require(BASE + "/99_System/Scripts/components/sprites.js");
// E1c 13.09: sceny Noir Sonny'ego, Ognisko = fallback. noir_sprites.js ustawia
// window.NOIR przy require (kontrakt pliku) - try/catch, bo awaria dialektu
// nie moze zabic calego Home (Ognisko dalej dziala bez niego).
let NOIR = null;
try {
    require(BASE + "/99_System/Scripts/components/noir_sprites.js");
    NOIR = window.NOIR || null;
} catch (e) { console.warn("[widgetHome] noir_sprites:", e); }

// --- BUDOWA WIDGETU (wolana przez trwaly host) ---------------------------
// Cale dawne cialo skryptu. Silnik trwalego hosta odpala je TYLKO przy realnej
// przebudowie (pierwsze wejscie albo zmiana zrodel), a nie przy kazdym
// re-renderze dataview - dlatego wszystko, co pisze do vaulta, siedzi tutaj,
// a nie na poziomie modulu.
async function buduj(hostEl, kontekst) {
    // Swiezy obiekt dv z biezacego wykonania bloku (spec: sekcja o swiezosci dv).
    // Przykrywa `dv` z zewnetrznego zakresu, wiec caly kod nizej - lacznie z
    // dv.pages() w renderDashboard i polem `dv` w SHARED CONTEXT - odpytuje
    // indeks przez aktualne api, nie przez to zlapane przy pierwszym renderze.
    const dv = kontekst.dv;
    // Host jest juz wyczyszczony przez silnik.
    const root = hostEl;

    // --- [D] AGENT-XP DRAIN — wpisy "agent" z XP Log.md do agregatow ---
    // Zastapil drenaz xp_queue.json (martwa kolejka bez producentow + petla
    // podwojnego naliczania - pelny kontekst: F0_Diagnoza_Silnika_XP w XP Overhaul 2026).
    // Idempotentny: status wiersza w logu, wiec re-render Home niczego nie duplikuje.
    (async () => {
        try { await XP_ENGINE.processAgentXpLog(app); }
        catch (e) { console.warn("[widgetHome] processAgentXpLog failed:", e); }
    })();

    // DataviewJS przeladowuje CALY widget przy kazdej zmianie frontmatter daily note.
    // Bez tego kazdy reload zostawia wiszace setInterval ogniska i po godzinie
    // pracy mamy kilkadziesiat timerow malujacych niewidoczne canvasy.
    if (window.jdPixelScene) {
        try { window.jdPixelScene.stop(); } catch (_) { /* nic */ }
        window.jdPixelScene = null;
    }

    // --- AUTO-CREATE TODAY'S DAILY NOTE (bez otwierania) ---
    (async () => {
        const todayPath = `${CONF.PATHS.daily_folder}/${UTILS.today()}.md`;
        if (!app.vault.getAbstractFileByPath(todayPath)) {
            try {
                const tplPath = "99_System/Templates/Daily Note.md";
                const tplFile = app.vault.getAbstractFileByPath(tplPath);
                if (tplFile) {
                    let content = await app.vault.read(tplFile);
                    const today = UTILS.today();
                    const dayName = window.moment(today).locale("pl").format("dddd");
                    content = content.replace(/\{\{date:YYYY-MM-DD\}\}/g, today);
                    content = content.replace(/\{\{date:dddd\}\}/g, dayName);
                    await app.vault.create(todayPath, content);
                }
            } catch (e) { /* silent — nie blokuj Home jeśli się nie uda */ }
        }
    })();

    // .jd-skin = korzen skinu. data-agent przelacza cala palete (13 wariantow
    // w jd-pixel.css) i sceneria czyta z niego kolory przez getComputedStyle.
    // .jd-ekran = kontrakt ekranu (2026-09-12): container zajmuje caly panel
    // liscia, nigdy nie scrolluje strony, reaguje na wlasna szerokosc.
    const container = root.createDiv({ cls: "jd-home-container jd-skin jd-ekran" });

    // ResizeObserver na container: --jd-ekran-h/-w do dyspozycji CSS, oraz
    // klasa jd-ekran-niski (< 900px wysokosci hosta) - gestsze odstepy.
    // Nowa instancja container powstaje przy kazdej przebudowie hosta (trwaly
    // host), stary container z DOM odchodzi razem ze swoim observerem.
    let ro = null;
    try {
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    // Rozmiar z border-box (review Dextera 19.09): od N1 korzen ma dolny
                    // padding (--jd-ekran-stopka), wiec contentRect kurczylby sie o stopke,
                    // a zmiana paddingu budzilaby obserwatora drugi raz (blad konsoli
                    // "ResizeObserver loop completed"). Przed N1 padding = 0, wiec
                    // znaczenie --jd-ekran-h/-w zostaje to samo: rozmiar hosta.
                    const bb = entry.borderBoxSize && entry.borderBoxSize[0];
                    const h = bb ? bb.blockSize : entry.contentRect.height;
                    const w = bb ? bb.inlineSize : entry.contentRect.width;
                    container.style.setProperty("--jd-ekran-h", h + "px");
                    container.style.setProperty("--jd-ekran-w", w + "px");
                    container.classList.toggle("jd-ekran-niski", h < 900);

                    // N1 (19.09): `.status-bar` Obsidiana plywa w prawym dolnym rogu
                    // OKNA i bywa wezszy niz korzen (patrz ekran_core.js) - gdy
                    // przecina dolna krawedz `.jd-ekran`, kafle/tresc konczyly sie
                    // POD paskiem. Mechanizm WSPOLNY dla kazdego .jd-ekran (nie tylko
                    // Home) - EKRAN_CORE nic nie wie o Home, tylko o dwoch
                    // prostokatach; ten obserwator jest dzis JEDYNYM miejscem, ktore
                    // mierzy rozmiar korzenia, wiec pomiar pasek robimy tu obok.
                    // `container.ownerDocument` (NIE globalny `document`) - w oknie
                    // popout paska w ogole nie ma. Korzen w karcie w tle ma rect 0x0
                    // (Obsidian nie layoutuje nieaktywnych kart/liczi) - wtedy w
                    // ogole NIE dotykamy zmiennej, zeby nie nadpisac poprzedniej
                    // dobrej wartosci zerem (Home wtedy po prostu nie jest widoczny).
                    const rootRect = container.getBoundingClientRect();
                    if (rootRect.width > 0 && rootRect.height > 0) {
                        const pasek = container.ownerDocument.querySelector(".status-bar");
                        const naklad = EKRAN_CORE.nakladkaStopki(rootRect, pasek ? pasek.getBoundingClientRect() : null);
                        // +4px "co najmniej NAD paskiem" (spec N1) - TYLKO gdy realnie
                        // rezerwujemy miejsce; brak nakladki zostaje dokladnie 0px
                        // (zero zmiany layoutu, gdy pasek nie zawadza).
                        container.style.setProperty("--jd-ekran-stopka", (naklad > 0 ? Math.ceil(naklad) + 4 : 0) + "px");
                    }
                }
            });
            ro.observe(container, { box: "border-box" });
        }
    } catch (e) {
        console.warn("[widgetHome] ResizeObserver kontraktu ekranu nie wstal:", e);
    }

    // --- STATE ---
    // Persist currentView w window — DataviewJS auto-reloaduje CAŁY widget przy zmianie
    // frontmatter daily note. Bez persist user zawsze ląduje w DASHBOARD.
    if (typeof window.jdHomeCurrentView === "undefined") window.jdHomeCurrentView = "DASHBOARD";
    let currentView = window.jdHomeCurrentView;

    // GLOBAL DEEP WORK STATE
    if (!window.jdDWState) {
        window.jdDWState = {
            isRunning: false,
            startTime: null,
            accumulatedMs: 0,
            isOnBreak: false,
            isSelectingBreak: false,
            breakEndTime: null,
            breakDurationMin: 15
        };
    } else {
        if (typeof window.jdDWState.accumulatedMs === 'undefined') window.jdDWState.accumulatedMs = 0;
        if (typeof window.jdDWState.isSelectingBreak === 'undefined') window.jdDWState.isSelectingBreak = false;
    }

    // --- SHARED CONTEXT ---
    const ctx = {
        // `dv` leci dalej celowo: widgety CC ładowane przez require() NIE MAJA dostępu
        // do modułu "obsidian" (require w ich kontekście go nie zna), więc bez tego
        // nie potrafią wyrenderować markdownu i cicho pokazują goły tekst.
        // Home jest jedynym miejscem w kontekście DataviewJS, gdzie `dv` istnieje.
        app, dv, CONF, UTILS, XP_ENGINE,
        getCurrentView: () => currentView,
        setView: async (id) => {
            currentView = id;
            window.jdHomeCurrentView = id;
            // Rail dostepny z kazdej zakladki (E0): klik w agenta z Nocnej/XP/
            // Hasioka wraca na Pulpit, bo tam zyje .jd-agent-view.
            if (id !== "DASHBOARD" && aktywnaZakladkaId !== "pulpit" && typeof pokazPulpit === "function") {
                pokazPulpit();
            }
            await refreshContent();
        },
        refreshContent: () => refreshContent()
    };

    // --- MAIN RENDERER ---
    let sidebarContainer;
    let mainPanel;
    let heroContainer;
    let scenaHero;
    let contentContainer;
    let stage;
    // Siatka bento Pulpitu (B2, 13.09) - uchwyt z BENTO.siatka(), gaszony w
    // refreshContent() (przed contentContainer.innerHTML="") i w stop() Home.
    let siatkaPulpitu = null;
    // Rail agentow E0 (12.09): pokazZakladke/aktywnaZakladkaId zyja W render(),
    // ale ctx.setView jest zdefiniowany WYZEJ, przed render() - stad hoist.
    // pokazPulpit przypisywany w render() przy definicji pokazZakladke.
    let pokazPulpit = null;
    let aktywnaZakladkaId = "pulpit";
    // Obserwator banera agenta (E1, review B6) - montuje .jd-baner-scena z
    // powrotem po tym, jak selfRefresh widgetu CC (widget_utils.js makeSelfRefresh)
    // zrobi container.empty()+re-render Z OMINIECIEM renderAgentView. Trzymany
    // tu (zakres buduj), zeby refreshContent i stop() mogly go disconnectowac.
    let banerObserver = null;

    // Ognisko Deep Work rosnie z minutami sesji (5 stadiow) - smaczek nr 1 skinu.
    // Zrodlo prawdy to window.jdDWState, ten sam co timer w SideStack.
    function dwMinutesToday() {
        const st = window.jdDWState || {};
        let ms = st.accumulatedMs || 0;
        if (st.isRunning && st.startTime) ms += Date.now() - st.startTime;
        return Math.floor(ms / 60000);
    }

    // Przebudowa scenerii - E1 (12.09, Baner Agenta): sceneria nie siedzi juz
    // pod calym stage'em, tylko w KONKRETNYM banerze (cel) - hero na Pulpicie
    // albo naglowek CC agenta. Jedno miejsce montazu PIXEL.scene w calym pliku;
    // wolane z wielu miejsc (hero na zmiane widoku, kazdy renderAgentView).
    // Kuba 12.09 (po pierwszym smoke E1): "gradienty niech dalej sie przebijaja
    // pod oknami" - NIEBO (pasy + poswiata + welon) zostaje pod CALYM stage'em
    // jak przed E0, w banerze siedza TYLKO sprite'y (warstwa "sceneria").
    // Dwie polowki sceny, jeden stop w window.jdPixelScene.
    let scenaNiebo = null;
    let scenaSprity = null;
    function zatrzymajScene() {
        for (const s of [scenaNiebo, scenaSprity]) {
            if (s) { try { s.stop(); } catch (_) { /* nic */ } }
        }
        scenaNiebo = null;
        scenaSprity = null;
        window.jdPixelScene = null;
    }
    function rebuildNiebo(klucz) {
        if (scenaNiebo) { try { scenaNiebo.stop(); } catch (_) { /* nic */ } scenaNiebo = null; }
        if (!stage) return;
        // Kuba 19.09 (przeglad E1): "Caly vibe widgetu ma sie zmienic pod agenta. Tlo
        // kazdy agent ma miec w swoim stylu." Od 12.09 niebo pod trescia bylo na sztywno
        // w palecie Pulpitu (HOME) - zle odczytane "Pulpit za wzor: gradient pod
        // wszystkimi okienkami": wzorem mial byc MECHANIZM (gradient pod oknami), nie
        // kolory. Teraz: widok agenta = paleta nieba tego agenta z jd-skin.css
        // (--px-s1..s4 per agent), zakladki Home = paleta HOME jak dotad.
        const kluczNieba = currentView === "DASHBOARD" ? "HOME" : currentView;
        let wrap = stage.querySelector(":scope > .jd-niebo-wspolne");
        if (!wrap) {
            wrap = stage.ownerDocument.createElement("div");
            wrap.className = "jd-niebo-wspolne jd-skin";
            stage.appendChild(wrap);
        }
        wrap.dataset.agent = kluczNieba;
        wrap.innerHTML = "";
        stage.querySelectorAll(":scope > .jd-px-sky, :scope > .jd-px-veil").forEach(n => n.remove());
        try {
            scenaNiebo = PIXEL.scene(wrap, kluczNieba, { warstwy: ["niebo", "welon"] });
        } catch (e) {
            console.warn("[widgetHome] niebo nie wstalo:", e, klucz);
        }
    }
    // Mapa zakladka Home -> klucz sceny NOIR. Sceny per AGENT (JASKIER/DEXTER/...)
    // wrocily 19.09 (Kuba: "Banner ma pokazywac scenki pod konkretnego agenta") -
    // wariant B z 13.09 ("agenci samo niebo") mial byc przejsciowy do B3 i tam zostal.
    const ZAKLADKA_KLUCZ = { pulpit: "HOME", nocna: "NOCNA", xp: "XP", hasiok: "HASIOK" };
    // Loguje fallback NOIR->HOME raz na klucz (nie przy kazdym kliku zakladki).
    const zgloszoneFallbackiNoir = new Set();
    function kluczSceny(klucz) {
        if (NOIR && NOIR.SCENES && !NOIR.SCENES[klucz]) {
            if (!zgloszoneFallbackiNoir.has(klucz)) {
                zgloszoneFallbackiNoir.add(klucz);
                console.info("[widgetHome] brak sceny NOIR " + klucz + ", fallback HOME");
            }
            return "HOME";
        }
        return klucz;
    }
    let ostatniCelSprity = null;
    // E1c wariant B: rebuildScene(cel, kluczZakladki) - hero (4 zakladki: Pulpit/
    // Nocna/XP/Hasiok) dostaje kluczZakladki i pelna scene (niebo+sceneria+dialekt
    // NOIR, fallback HOME gdy NOIR nie ma jeszcze danej zakladki). Baner agenta CC
    // (zamontujBaner) wola BEZ drugiego argumentu - samo niebo w palecie agenta,
    // bez sprite'ow (Kuba po smoke: "podoba mi sie, ze tlo pod kazdym agentem
    // zmienia sie na jego kolory"); sceny per agent wracaja w B3/B4.
    function rebuildScene(cel, kluczZakladki) {
        const heroTryb = !!kluczZakladki;
        const klucz = heroTryb ? kluczSceny(ZAKLADKA_KLUCZ[kluczZakladki] || "HOME")
                                : (currentView === "DASHBOARD" ? "HOME" : currentView);
        // Paleta mogla sie zmienic (data-agent) - niebo przebudowane zawsze.
        rebuildNiebo(klucz);
        if (scenaSprity) { try { scenaSprity.stop(); } catch (_) { /* nic */ } scenaSprity = null; }
        // DOM sprite'ow z poprzedniego banera tez znika (smoke Kuby 12.09: namiot
        // i ognisko HOME zostawaly na pasku XP po wejsciu w agenta - stop() gasil
        // tylko animacje, statyczne sprite'y stały dalej).
        if (ostatniCelSprity && ostatniCelSprity !== cel) {
            try { ostatniCelSprity.querySelectorAll(".jd-px-sky, .jd-px-scene, .jd-px-veil").forEach(n => n.remove()); } catch (_) { /* nic */ }
        }
        ostatniCelSprity = cel || null;
        window.jdPixelScene = { stop: zatrzymajScene };
        if (!cel) return;
        cel.querySelectorAll(".jd-px-sky, .jd-px-scene, .jd-px-veil").forEach(n => n.remove());
        try {
            const maSceneNoir = !!(NOIR && NOIR.SCENES && NOIR.SCENES[klucz]);
            const opts = {
                // Baner ma WLASNE niebo (gradient) (Kuba 12.09: "baner kompletnie
                // nie ma tla"); welon tylko na stage'u, zeby ziarno nie dublowalo
                // sie na banerze. Sceneria (sprite'y) TYLKO w trybie hero (4
                // zakladki) - baner agenta CC dostaje sama warstwe "niebo"
                // (wariant B, 13.09).
                warstwy: (heroTryb || maSceneNoir) ? ["niebo", "sceneria"] : ["niebo"],
                deepWorkMinutes: dwMinutesToday(),
                // Wysokosc banera z realnego layoutu (110px / 84px na niskim
                // ekranie, patrz .jd-baner w jd-home.css) - fallback gdyby CSS
                // jeszcze nie policzyl wysokosci (cel dopiero wpiety do DOM).
                sceneHeight: cel.clientHeight || 110
            };
            // Dialekt NOIR wszedzie, gdzie Sonny dal scene dla klucza: 4 zakladki Home
            // (klucz rozwiazany przez kluczSceny) i baner kazdego agenta (19.09). Agent
            // bez sceny NOIR zostaje z samym niebem - bez mieszania ze starym Ogniskiem.
            if (maSceneNoir) {
                opts.dialekt = { nazwa: "noir", sprites: NOIR.sprites, SCENES: NOIR.SCENES, ANIM: NOIR.ANIM, mapaTokenow: NOIR.mapaTokenow };
            }
            scenaSprity = PIXEL.scene(cel, klucz, opts);
            // Diagnostyka 13.09 (Kuba: "samo niebo bez blokow", konsola pusta,
            // bramka wizualna zielona) - jedna linia na kazda przebudowe sceny.
            console.info("[widgetHome] scena", klucz, heroTryb ? "hero" : "agent",
                opts.warstwy.join("+"), opts.dialekt ? "noir" : "ognisko",
                "h=" + cel.clientHeight, "props=" + cel.querySelectorAll(".jd-px-prop").length,
                "canvas=" + cel.querySelectorAll("canvas").length);
        } catch (e) {
            // Sceneria to warstwa dekoracyjna - jej awaria nie moze zabic Home.
            console.warn("[widgetHome] sceneria nie wstala:", e);
        }
    }

    async function render() {
        container.innerHTML = "";

        // 0. RAMKA — .jd-px-stage zostaje jako obudowa (border/tlo), ale od E1
        //    (12.09, Baner Agenta) NIE nosi juz wlasnej scenerii - ta przenosi
        //    sie do banera hero (Pulpit) i banera CC (agent), patrz nizej.
        container.dataset.agent = currentView;
        stage = container.createDiv({ cls: "jd-px-stage" });
        const ui = stage.createDiv({ cls: "jd-px-ui" });

        // 0a. RAIL AGENTOW — na poziomie CALEJ powloki (E0, 12.09): kolumna po
        //     lewej, dostepna z kazdej zakladki (Pulpit/Nocna/XP/Hasiok), nie
        //     tylko z Pulpitu. Budowany RAZ na przebudowe render(); stan .active
        //     po zmianie widoku aktualizuje updateDockActiveState (nizej).
        sidebarContainer = ui.createDiv({ cls: "jd-rail-section" });
        AgentDock.render(sidebarContainer, ctx);

        // 0b. GLOWNA KOLUMNA — pasek zakladek + hero (widoczny wszedzie) + panes.
        const glowna = ui.createDiv({ cls: "jd-home-glowna jd-ekran-tresc" });

        // 0c. ZAKLADKI GLOWNE — Pulpit / Nocna zmiana / XP.
        //     Pulpit = cale dotychczasowe body Home, bez zmiany logiki: hero i
        //     dwupanel po prostu dostaja kontener. Nocna zmiana i XP budowane
        //     LENIWIE, przy pierwszym kliknieciu — inaczej kazdy render Home (a ten
        //     leci przy KAZDEJ zmianie frontmatteru daily note) skanowalby caly
        //     vault przez dv.pages() i czytal poczte oraz log XP z dysku za darmo.
        //     Zakladka nie jest persystowana w window: po reloadzie zawsze Pulpit.
        const mainTabs = glowna.createDiv({ cls: "jd-home-tabs-header" });
        const btnTabPulpit = mainTabs.createEl("button", { cls: "jd-home-tab-btn active", text: "\u{1F3E0} Pulpit" });
        const btnTabNocna = mainTabs.createEl("button", { cls: "jd-home-tab-btn", text: "\u{1F319} Nocna zmiana" });
        const btnTabXp = mainTabs.createEl("button", { cls: "jd-home-tab-btn", text: "⭐ XP" });
        // Hasiok Globalny etap 1 (decyzja Kuby 18.08): inbox wrzutek wyjechal
        // z widgetu Famy do paska Home — ogolny dla wszystkich, jak XP i Nocna.
        const btnTabHasiok = mainTabs.createEl("button", { cls: "jd-home-tab-btn", text: "\u{1F4E5} Hasiok" });
        // Daily/Weekly (decyzja Kuby 13.08) to LINKI, nie zakladki: otwieraja biezaca
        // note w NOWEJ karcie okna glownego - Home zostaje otwarty obok.
        const btnTabDaily = mainTabs.createEl("button", { cls: "jd-home-tab-btn", text: "\u{1F4C5} Daily" });
        const btnTabWeekly = mainTabs.createEl("button", { cls: "jd-home-tab-btn", text: "\u{1F5D3}\u{FE0F} Weekly" });

        // HERO BANNER — kontener PRZED panes (DOM: taby, hero, panes). Wypelniany
        // (HeroBanner.render) dopiero nizej, po przypisaniu ctx.pokazXpTab -
        // pozycja w drzewie ustalona juz tutaj, tresc dojdzie pozniej.
        heroContainer = glowna.createDiv({ cls: "jd-hero-section" });
        // Baner HOME (E1, 12.09): scena wpiec TYLKO na Pulpicie/Dashboard - na
        // agenta wraca do jednej linii (scena wtedy zyje w naglowku CC, patrz
        // renderAgentView). scenaHero tworzona RAZ, przed .jd-hero-banner (rendra
        // je HeroBanner.render nizej), zeby scena byla PIERWSZYM dzieckiem.
        scenaHero = heroContainer.createDiv({ cls: "jd-baner-scena" });
        if (currentView === "DASHBOARD") {
            heroContainer.classList.add("jd-baner", "jd-baner-home");
            rebuildScene(scenaHero, aktywnaZakladkaId);
        }

        // panePulpit = od razu main panel (rail poszedl na poziom powloki, 0a) -
        // Pulpit nie ma juz wlasnego two-panel/sidebar-section.
        const panePulpit = glowna.createDiv({ cls: "jd-home-pane jd-main-panel" });
        const paneNocna = glowna.createDiv({ cls: "jd-home-pane" });
        const paneXp = glowna.createDiv({ cls: "jd-home-pane" });
        const paneHasiok = glowna.createDiv({ cls: "jd-home-pane" });
        paneNocna.style.display = "none";
        paneXp.style.display = "none";
        paneHasiok.style.display = "none";
        let nocnaZbudowana = false;
        let xpZbudowane = false;
        let hasiokZbudowany = false;

        // Cztery prawdziwe zakladki (Daily/Weekly to linki) — jeden przelacznik,
        // zeby stan active nie rozjezdzal sie przy dokladaniu kolejnych.
        const zakladki = [
            { id: "pulpit", btn: btnTabPulpit, pane: panePulpit },
            { id: "nocna", btn: btnTabNocna, pane: paneNocna },
            { id: "xp", btn: btnTabXp, pane: paneXp },
            { id: "hasiok", btn: btnTabHasiok, pane: paneHasiok }
        ];
        function pokazZakladke(btn) {
            for (const z of zakladki) {
                const aktywny = z.btn === btn;
                z.btn.classList.toggle("active", aktywny);
                z.pane.style.display = aktywny ? "" : "none";
                if (aktywny) aktywnaZakladkaId = z.id;
            }
            // Wariant B (13.09): hero ma osobna scene NOIR per zakladka - ale
            // tylko gdy hero w ogole ma baner (currentView===DASHBOARD; na widoku
            // agenta hero jest plaskie, patrz refreshContent - klik zakladki tego
            // nie zmienia, przywraca to dopiero powrot na Pulpit).
            if (currentView === "DASHBOARD") rebuildScene(scenaHero, aktywnaZakladkaId);
        }
        // Hoistowana w outer scope (ctx.setView jest zdefiniowany PRZED render()
        // i woly ta referencje, zeby klik w agenta z Nocnej/XP/Hasioka wracal
        // na Pulpit - tam zyje .jd-agent-view).
        pokazPulpit = () => pokazZakladke(btnTabPulpit);

        btnTabPulpit.onclick = async () => {
            pokazZakladke(btnTabPulpit);
            // Pulpit = powrot na dashboard (decyzja Kuby 16.08). Wczesniej robil to
            // kafel Home w docku agentow; przycisk ma robic to, co obiecuje nazwa.
            if (currentView !== "DASHBOARD") await ctx.setView("DASHBOARD");
        };
        btnTabNocna.onclick = async () => {
            pokazZakladke(btnTabNocna);
            if (nocnaZbudowana) return;
            nocnaZbudowana = true;
            paneNocna.createDiv({ text: "wczytuję…", attr: { style: "opacity:0.6; padding:12px;" } });
            try {
                await NocnaTab.render(paneNocna, ctx);
            } catch (e) {
                // Awaria zakladki nie moze zabic Home — Pulpit ma dzialac dalej.
                // Komunikat siedzi W ZAKLADCE, nie w stopce Home: renderErrorBox
                // dokleja sie pod caly widget, wiec przy dlugim pulpicie Kuba
                // zobaczylby pusta zakladke i zadnego powodu.
                console.error("[widgetHome] Nocna zmiana nie wstala:", e);
                nocnaZbudowana = false;
                paneNocna.innerHTML = "";
                paneNocna.createDiv({
                    text: `⚠️ Nocna zmiana nie wstała: ${(e && e.message) ? e.message : String(e)}`,
                    attr: { style: "padding:14px; color:var(--text-error, #e5534b);" }
                });
            }
        };
        btnTabXp.onclick = async () => {
            pokazZakladke(btnTabXp);
            if (xpZbudowane) return;
            xpZbudowane = true;
            paneXp.createDiv({ text: "wczytuję…", attr: { style: "opacity:0.6; padding:12px;" } });
            try {
                paneXp.innerHTML = "";
                await XpBoard.renderXpBoard(paneXp, ctx);
            } catch (e) {
                console.error("[widgetHome] XP Board nie wstal:", e);
                xpZbudowane = false;
                paneXp.innerHTML = "";
                paneXp.createDiv({
                    text: `⚠️ XP Board nie wstał: ${(e && e.message) ? e.message : String(e)}`,
                    attr: { style: "padding:14px; color:var(--text-error, #e5534b);" }
                });
            }
        };
        // Wejscie do XP Board z hero banera (klik w pasek sezonu) — ta sama
        // zakladka co przycisk XP, zeby bylo jedno wejscie i jeden stan.
        ctx.pokazXpTab = () => btnTabXp.onclick();

        btnTabHasiok.onclick = async () => {
            pokazZakladke(btnTabHasiok);
            if (hasiokZbudowany) return;
            hasiokZbudowany = true;
            paneHasiok.createDiv({ text: "wczytuję…", attr: { style: "opacity:0.6; padding:12px;" } });
            try {
                await HasiokTab.render(paneHasiok, ctx);
            } catch (e) {
                // Awaria zakladki nie moze zabic Home (wzorzec NocnaTab/XP).
                console.error("[widgetHome] Hasiok nie wstal:", e);
                hasiokZbudowany = false;
                paneHasiok.innerHTML = "";
                paneHasiok.createDiv({
                    text: `⚠️ Hasiok nie wstał: ${(e && e.message) ? e.message : String(e)}`,
                    attr: { style: "padding:14px; color:var(--text-error, #e5534b);" }
                });
            }
        };

        // Daily/Weekly leca do OSOBNYCH OKIEN (decyzja Kuby 13.08: "wole osobne
        // okienka niz karty") - wzorzec czytadla z pamiecia pozycji per rodzaj noty.
        const POP_SCIEZKA = BASE + "/99_System/Scripts/components/shared/popout.js";
        btnTabDaily.onclick = async () => {
            const POP = require(POP_SCIEZKA);
            const sciezka = `20_Kalendarz/Daily/${window.moment().format("YYYY-MM-DD")}.md`;
            if (app.vault.getAbstractFileByPath(sciezka)) {
                await POP.otworzOknoWymieniajac(app, sciezka, "kalendarz_daily");
                return;
            }
            // Noty jeszcze nie ma: komenda core daily-notes tworzy ja Z SZABLONU
            // w nowej karcie (reczna kopia = nierozwiniete {{date}}, lekcja 12.08),
            // po czym karta wyjezdza do okna popout.
            try {
                const leaf = app.workspace.getLeaf("tab");
                app.workspace.setActiveLeaf(leaf, { focus: true });
                app.commands.executeCommandById("daily-notes");
                if (typeof app.workspace.moveLeafToPopout === "function") {
                    app.workspace.moveLeafToPopout(leaf);
                }
            } catch (e) {
                new Notice("⚠️ Nie mogę otworzyć dzisiejszej daily: " + (e && e.message ? e.message : e));
            }
        };
        btnTabWeekly.onclick = async () => {
            const POP = require(POP_SCIEZKA);
            // Tydzien systemowy: niedziela-sobota (decyzja Kuby 13.08).
            const tydzien = UTILS.tydzienSystemowy();
            const sciezka = `20_Kalendarz/Weekly/${tydzien}.md`;
            if (!app.vault.getAbstractFileByPath(sciezka)) {
                // Noty jeszcze nie ma: tworzymy z wzorca w kodzie, bo core Templates
                // nie umie policzyc konca tygodnia ani ISO-tygodnia z przesunieciem.
                // Ksztalt 1:1 z 99_System/Templates/Weekly Note.md.
                const start = UTILS.poczatekTygodniaSystemowego();
                const koniec = window.moment(start).add(6, "days").format("YYYY-MM-DD");
                const tresc = [
                    "---",
                    "type: weekly",
                    `date_start: ${start}`,
                    `date_end: ${koniec}`,
                    `week: ${tydzien}`,
                    "tags:",
                    "  - typ/weekly",
                    'podsumowanie: ""',
                    'jaskier_glos_tygodnia: ""',
                    "---",
                    "",
                    `# Tydzien ${tydzien}`,
                    "",
                    "```dataviewjs",
                    'await dv.view("99_System/Scripts/views/widgetWeekly");',
                    "```",
                    ""
                ].join("\n");
                try {
                    await app.vault.create(sciezka, tresc);
                    new Notice(`🗓️ Utworzyłem notę ${tydzien}`);
                } catch (e) {
                    new Notice("⚠️ Nie mogę utworzyć noty weekly: " + (e && e.message ? e.message : e));
                    return;
                }
            }
            await POP.otworzOknoWymieniajac(app, sciezka, "kalendarz_weekly");
        };

        // HERO BANNER — PRZENIESIONY z Pulpitu (E0, 12.09): widoczny na KAZDEJ
        // zakladce, nie tylko Pulpicie. Zawsze jedna linia (mechanika
        // jd-hero-zwiniety wycieta - patrz refreshContent i dymek domen w
        // HeroBanner.js). Render dopiero TERAZ (PO ctx.pokazXpTab przypisanym
        // wyzej przy btnTabXp) - klik w hero otwiera zakladke XP przez callback;
        // kontener juz stoi we wlasciwym miejscu drzewa (przed panes).
        await HeroBanner.render(heroContainer, ctx);

        // Pulpit = od razu main panel (rail poszedl na poziom powloki, 0a).
        mainPanel = panePulpit;
        contentContainer = mainPanel;
        await refreshContent();
    }

    async function refreshContent() {
        // Cala tresc (i ew. baner agenta w niej) idzie do kosza - obserwator
        // patrzylby na odczepiony DOM, gdyby zyl dalej (review B6).
        if (banerObserver) { try { banerObserver.disconnect(); } catch (_) { /* nic */ } banerObserver = null; }
        // B3 (13.09): sprzata rejestr potomkow ZANIM Pulpit odczepi ich DOM.
        // Dzieki temu cleanup kafla Usage odsubskrybowuje monitor deterministycznie.
        WU.sprzataj(contentContainer);
        // Siatka bento Pulpitu (B2) - gasi ResizeObservery/sprite'y noir kafli
        // PRZED wyrzuceniem DOM (inaczej stop() nizej patrzylby na juz odpiete
        // drzewo, jak banerObserver wyzej).
        if (siatkaPulpitu) { try { siatkaPulpitu.stop(); } catch (_) { /* nic */ } siatkaPulpitu = null; }
        contentContainer.innerHTML = "";

        // Przelaczenie agenta = nowa paleta + nowa sceneria. Cache palet trzeba
        // wyczyscic, bo trzyma kolory per data-agent.
        if (container.dataset.agent !== currentView) {
            container.dataset.agent = currentView;
            PIXEL.flushPalette();
            // Baner HOME (E1): scena w hero tylko na Dashboard. Na agenta hero
            // wraca do jednej linii bez sceny - ta zyje w naglowku CC nizej
            // (renderAgentView montuje ja sam, bo jego DOM jest budowany od zera
            // przy kazdym refreshContent).
            if (currentView === "DASHBOARD") {
                heroContainer.classList.add("jd-baner", "jd-baner-home");
                rebuildScene(scenaHero, aktywnaZakladkaId);
            } else {
                heroContainer.classList.remove("jd-baner", "jd-baner-home");
                rebuildScene(null);
            }
        }

        // Hero E0 (12.09): ZAWSZE jedna linia, na kazdej zakladce/widoku - nie
        // zwija sie juz wzgledem DASHBOARD (mechanika jd-hero-zwiniety wycieta,
        // patrz HeroBanner.js - dymek domen na klik zamiast automatycznego zwiniecia).

        if (currentView === "DASHBOARD") {
            await renderDashboard(contentContainer);
        } else if (currentView === "XP_BOARD") {
            // Fallback: glowne wejscie to zakladka XP w pasku (2026-08-16), ale
            // window.jdHomeCurrentView moze trzymac "XP_BOARD" z poprzedniej sesji
            // okna - bez tego case'a taki stan konczylby sie pustym panelem.
            await XpBoard.renderXpBoard(contentContainer, { app, CONF, UTILS, XP_ENGINE });
        } else {
            await renderAgentView(currentView, contentContainer);
        }
        updateDockActiveState();
    }

    function updateDockActiveState() {
        const btns = container.querySelectorAll(".jd-rail-agent");
        btns.forEach(b => {
            if (b.dataset.id === currentView) b.classList.add("active");
            else b.classList.remove("active");
        });
    }

    // --- DASHBOARD (Pulpit) ---
    // B2 Pulpit bento (13.09, decyzja Kuby "wszystko w bento box"): siatka kafli
    // BENTO.siatka zamiast dawnego gridu 2-kolumnowego. Uklad/adaptery kafli
    // (nawyki/kalend/proj/todo/grind/dw) zyja w pulpit_kafle.js (zestaw A v4
    // zatwierdzony na poligonie); zakladka Trendy WYCIETA (decyzja Kuby).
    async function renderDashboard(parent) {
        const todayISO = window.moment().format("YYYY-MM-DD");
        const startISO = window.moment().subtract(6, 'days').format("YYYY-MM-DD");

        // Zakladka trendow wycieta -> zakres poprzedniego tygodnia juz niepotrzebny.
        // `dailies` zostaje (liczy `todayPage`; sygnatura zbudujOpisPulpitu ja przyjmuje
        // dla zgodnosci z kontraktem B2 - patrz komentarz w pulpit_kafle.js).
        const dailies = dv.pages(`"${CONF.PATHS.daily_folder}"`)
            .where(p => p.file.name >= startISO && p.file.name <= todayISO)
            .sort(p => p.file.name);

        // Dzisiejsza daily page (ostatnia w sortowanym 7-dniowym zakresie)
        const todayPage = dailies.array().find(p => p.file.name === todayISO)
            || dailies.array().slice(-1)[0] || null;

        const grindAktywny = SideStack.czyGrindAktywny(app);
        const OPIS = PULPIT.zbudujOpisPulpitu({ ctx, todayPage, dailies, NOIR, grindAktywny });
        siatkaPulpitu = BENTO.siatka(parent, OPIS);
        await siatkaPulpitu.gotowe();
    }
    // BANER AGENTA (E1, dyspozycja Kuby 12.09; review B6): montaz idempotentny,
    // wolany z renderAgentView PO renderze CC ORAZ z banerObserver nizej. Wolanie
    // z obserwatora jest konieczne, bo selfRefresh widgetow CC (makeSelfRefresh w
    // widget_utils.js:60-66) robi container.empty()+re-render z POMINIECIEM
    // renderAgentView - bez tego nowy .jd-cc-header wstaje bez baneru, a stara
    // scena zostaje odpiete od DOM (interwaly dalej tykaja w tle).
    function zamontujBaner(card, agentId) {
        // Juz zamontowany (albo wlasnie zamontowany przez poprzednie wywolanie) - nic nie rob.
        if (card.querySelector(".jd-cc-header.jd-baner .jd-baner-scena")) return;
        const header = card.querySelector(".jd-cc-header");
        if (header) {
            header.classList.add("jd-baner");
            const tlo = document.createElement("div");
            tlo.className = "jd-baner-scena";
            header.prepend(tlo);
            rebuildScene(tlo);
            return;
        }
        // Widgety bez wlasnego naglowka CC (Beebo, Salvatore) - baner doklejony
        // recznie na poczatek karty. TYLKO gdy karta ma juz jakies dziecko (CC
        // realnie wyrenderowany) - inaczej doklejalibysmy do pustej karty w
        // trakcie container.empty() z selfRefresh (review B6).
        if (card.children.length === 0) return;
        const baner = document.createElement("div");
        baner.className = "jd-cc-header jd-baner";
        const tlo = document.createElement("div");
        tlo.className = "jd-baner-scena";
        baner.appendChild(tlo);
        const tytul = document.createElement("div");
        tytul.className = "jd-cc-title";
        tytul.textContent = agentId.charAt(0) + agentId.slice(1).toLowerCase();
        baner.appendChild(tytul);
        card.prepend(baner);
        rebuildScene(tlo);
    }

    // --- AGENT VIEW ---
    async function renderAgentView(agentId, parent) {
        // Nowa karta = nowy DOM do obserwowania; stary obserwator patrzylby
        // na odpiete drzewo (review B6).
        if (banerObserver) { try { banerObserver.disconnect(); } catch (_) { /* nic */ } banerObserver = null; }
        const card = parent.createDiv({ cls: "jd-agent-view" });

        const todayPath = `${CONF.PATHS.daily_folder}/${UTILS.today()}.md`;
        let dailyFile = app.vault.getAbstractFileByPath(todayPath);

        if (!dailyFile) {
            // Brak Daily Note - ekran zastepczy bez baneru agenta (nie ma jeszcze CC do wpiecia baneru).
            const box = card.createDiv({ attr: { style: "text-align:center; padding:50px;" } });
            box.createDiv({ text: "⚠️ Brak Daily Note!", attr: { style: "opacity:0.6; margin-bottom:10px;" } });
            const btn = UTILS.createButton("✨ Utwórz Dziś", async () => {
                await app.commands.executeCommandById("periodic-notes:open-daily-note");
                setTimeout(() => refreshContent(), 500);
            });
            box.appendChild(btn);
            return;
        }
        const fm = app.metadataCache.getFileCache(dailyFile)?.frontmatter || {};

        // Widgety CC są stateful (Refresh Bug Fix 2026) — same zarządzają re-renderem
        // przez selfRefresh (components/shared/widget_utils.js). NIE przekazujemy
        // onReload — akcja wewnątrz widgetu NIE ma resetować całego Home SPA.
        switch (agentId) {
            case "JASKIER":
                await JaskierCC.renderJaskierCC(card, ctx, dailyFile, fm);
                break;
            case "IRIS":
                await CentrumZdrowia.renderCentrumZdrowia(card, ctx, dailyFile, fm);
                break;
            case "DEXTER":
                await DexterCC.renderDexterCC(card, ctx, dailyFile, fm);
                break;
            case "PERSIVAL":
                await Gymnazjum.renderGymnazjum(card, ctx, dailyFile, fm);
                break;
            case "SONNY":
                await ((CONF.SONNY_CC === "v2" && SonnyCC2) ? SonnyCC2 : SonnyCC).renderSonnyCC(card, ctx, dailyFile, fm);
                break;
            case "EZRA":
                await LaboratoriumCC.renderLaboratorium(card, { app, dv }, dailyFile, fm);
                break;
            case "SILAS":
                await SilasCC.renderSilasCC(card, ctx, dailyFile, fm);
                break;
            case "FAMA":
                await FamaCC.renderFamaCC(card, ctx, dailyFile, fm);
                break;
            case "LEXIE":
                await LexieCC.renderLexieCC(card, ctx, dailyFile, fm);
                break;
            case "KAIA":
                await KaiaCC.renderKaiaCC(card, ctx, dailyFile, fm);
                break;
            case "CLAUDZIK":
                await DevDesktop.renderDevDesktop(card, ctx, dailyFile, fm);
                break;
            case "BEEBO":
                await BeeboCC.renderBeeboCC(card, ctx, dailyFile, fm);
                break;
            case "SALVATORE":
                await SalvatoreCC.renderSalvatoreCC(card, ctx, dailyFile, fm);
                break;
            // INBOX usunięty — przejęty przez Jaskier CC (Organizator tab)
        }

        // BANER AGENTA (E1, dyspozycja Kuby 12.09): sceneria z dolu Home
        // przenosi sie do naglowka CC - kazdy agent dostaje wlasna scenke
        // dokladnie tam, gdzie zyje tytul + zakladki. DOM CC jest budowany od
        // zera przy kazdym wejsciu (card.innerHTML wyzej w switch/CC widgetach),
        // wiec montaz jest BEZWARUNKOWY - stary .jd-cc-header i tak juz nie zyje.
        zamontujBaner(card, agentId);

        // Obserwator na card: lapie selfRefresh widgetow CC (container.empty()
        // + re-render z pominieciem tej funkcji, review B6) i domontowuje baner
        // z zewnatrz. Debounce przez requestAnimationFrame - jeden przebieg na
        // klatke, mimo wielu mutacji DOM w tym samym re-renderze; idempotencja
        // zamontujBaner przerywa petle (prepend .jd-baner-scena tez jest mutacja).
        let rafId = null;
        banerObserver = new MutationObserver(() => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                zamontujBaner(card, agentId);
            });
        });
        banerObserver.observe(card, { childList: true, subtree: true });
    }


    // --- ERROR BOX (ochrona renderu) ---
    // Bez tego jeden undefined w renderze = pusty Home bez zadnego komunikatu.
    function renderErrorBox(e) {
        console.error("[widgetHome] blad renderowania widgetu:", e);
        try {
            const box = root.createDiv({ attr: { style: "border:1px solid #e5534b; background:rgba(229,83,75,0.12); border-radius:8px; padding:12px 14px; margin:10px 0;" } });
            box.createDiv({
                text: `⚠️ Błąd renderowania widgetu: ${(e && e.message) ? e.message : String(e)}`,
                attr: { style: "font-weight:700; color:#e5534b; margin-bottom:6px;" }
            });
            const stackLines = String((e && e.stack) || "").split("\n");
            const firstFrame = (stackLines[1] || stackLines[0] || "").trim();
            if (firstFrame) {
                box.createDiv({
                    text: firstFrame,
                    attr: { style: "font-family:var(--font-monospace); font-size:0.78em; opacity:0.75; white-space:pre-wrap; word-break:break-all;" }
                });
            }
        } catch (_) { /* jesli nawet error box nie wstanie - zostaje console.error */ }
    }

    // --- START ---
    try {
        await render();
    } catch (e) {
        renderErrorBox(e);
    }

    // Silnik wola stop() przed kazda przebudowa i przy sprzataniu hosta.
    // Bez tego setInterval ogniska tykalby dalej na wyrzuconym canvasie.
    return {
        stop: () => {
            // ResizeObserver kontraktu ekranu - bez disconnect kazda przebudowa
            // hosta zostawialaby obserwator na odczepionym drzewie (review 12.09).
            if (ro) { try { ro.disconnect(); } catch (_) { /* nic */ } ro = null; }
            if (banerObserver) { try { banerObserver.disconnect(); } catch (_) { /* nic */ } banerObserver = null; }
            WU.sprzataj(contentContainer);
            // Siatka bento Pulpitu (B2) - patrz komentarz analogiczny w refreshContent().
            if (siatkaPulpitu) { try { siatkaPulpitu.stop(); } catch (_) { /* nic */ } siatkaPulpitu = null; }
            if (window.jdPixelScene) {
                try { window.jdPixelScene.stop(); } catch (_) { /* nic */ }
                window.jdPixelScene = null;
            }
        }
    };
}

// --- MONTAZ -------------------------------------------------------------
// Zrodla WASKO (kontrakt trwalego hosta): daily notes, stan systemu i kanban
// System HQ. Zmiana czegokolwiek innego w vaultcie nie rusza obrazu Home.
(async () => {
    try {
        await HOST.zamontuj(dv, {
            klucz: "home",
            zrodla: [
                "20_Kalendarz/Daily",
                "99_System/State",
                "40_Pracownie/System HQ/_state.json"
            ],
            buduj
        });
    } catch (e) {
        // Awaria samego silnika hosta (nie renderu - ten ma wlasny error box).
        console.error("[widgetHome] trwaly host nie wstal:", e);
        dv.container.createDiv({
            text: `⚠️ Trwały host nie wstał: ${(e && e.message) ? e.message : String(e)}`,
            attr: { style: "padding:14px; color:var(--text-error, #e5534b);" }
        });
    }
})();
