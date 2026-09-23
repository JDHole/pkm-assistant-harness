/**
 * @file pulpit_kafle.js - opis siatki bento Pulpitu (Home) + adaptery kafli.
 *   Zamienia dane Home (todayPage, projekty 6 agentow, Grind, Deep Work) na OPIS
 *   dla `BENTO.siatka` (components/shared/bento.js). Wzorce renderu (karty projektow,
 *   stronicowanie, filtry, zegar pikselowy) przeniesione z poligonu (Bento Poligon.md - w archiwum od 19.09,
 *   zestaw A v4) - logika czysta (filtrowanie/sortowanie/mapa) zyje w pulpit_core.js.
 * @agent dexter
 * @pracownia System HQ
 * @exports zbudujOpisPulpitu({ ctx, todayPage, dailies, NOIR, grindAktywny }) -> OPIS (patrz bento.js)
 * @uses ./pulpit_core.js (filtrujProjekty, dniBezRuchu, mapaPulpitu, kolejnyAgent),
 *   ../shared/bento_core.js (ileWierszy - stronicowanie), ../../agents/dexter/strony_core.js
 *   (wybierzStrone), ./TodayHabits.js, ./CalendarMonth.js, ./RecentProjects.js,
 *   ./SideStack.js, ./DeepWorkTimer.js (wszystkie z nowymi opcjami B2, domyslnie wylaczonymi)
 * @reads nic bezposrednio (deleguje do komponentow wyzej - one czytaja app/vault)
 * @writes DOM przez adaptery kafli (deleguje do komponentow); zero stanu globalnego
 *   poza `kafel._*` (filtr/strona/zegar - zyje tak dlugo jak kafel, jak w poligonie)
 * @since 2026-09-13 B2 Pulpit bento (spec: Dexter, wykonawca: sonnet)
 * @tests manual reload Obsidian + Home (smoke wg raportu B2); logika pod spodem
 *   pokryta pulpit_core.test.js (node --test)
 */

"use strict";

const BENTO_CORE = require("../shared/bento_core.js");
const PULPIT_CORE = require("./pulpit_core.js");
const { wybierzStrone } = require("../../agents/dexter/strony_core.js");
const TodayHabits = require("./TodayHabits.js");
const CalendarMonth = require("./CalendarMonth.js");
const RecentProjects = require("./RecentProjects.js");
const SideStack = require("./SideStack.js");
const DeepWorkTimer = require("./DeepWorkTimer.js");

// Kolejnosc cyklu filtra "Agent" (chip w naglowku kafla "proj") - 6 agentow
// RecentProjects.zaladujWszystkie, w tej samej kolejnosci co tam (Promise.all).
const AGENCI_PROJ = ["dexter", "ezra", "claudzik", "sonny", "lexie", "fama"];

// ============================================================================
// POMOCNICZE DOM (wzorzec 1:1 z Bento Poligon.md, dzis w archiwum - stronicowanie w stopce kafla,
// pasek segmentowy) - lokalne, bo poligon ich nie eksportuje (plik demo/testowy).
// ============================================================================

function tworz(doc, tag, klasa, tekst) {
    const e = doc.createElement(tag);
    if (klasa) e.className = klasa;
    if (tekst != null) e.textContent = tekst;
    return e;
}

/** Pasek stronicowania w stopce kafla - budowany RAZ (idempotentnie), bo bento.js
 *  kasuje tylko `.jd-kafel-tresc` przy kazdym `przerysuj()`, nie `.jd-kafel-stopka`.
 *  Stan strony na `kafel._strona` - zyje tak dlugo jak kafel (do pelnej przebudowy
 *  siatki, nowa siatka = nowe kafle = strona 1). */
function skonfigurujStronicowanie(kafel) {
    if (kafel._paginacja) return kafel._paginacja;
    if (!kafel.stopka) return null;
    const doc = kafel.el.ownerDocument;
    const pasek = tworz(doc, "div", "jd-strony");
    const btnPrev = tworz(doc, "button", "jd-strony-btn", "‹");
    const info = tworz(doc, "span", "jd-strony-info", "");
    const btnNext = tworz(doc, "button", "jd-strony-btn", "›");
    btnPrev.addEventListener("click", () => {
        kafel._strona = Math.max(1, (kafel._strona || 1) - 1);
        kafel.przerysuj();
    });
    btnNext.addEventListener("click", () => {
        kafel._strona = (kafel._strona || 1) + 1;
        kafel.przerysuj();
    });
    pasek.appendChild(btnPrev); pasek.appendChild(info); pasek.appendChild(btnNext);
    kafel.stopka.appendChild(pasek);
    kafel._paginacja = { info, btnPrev, btnNext };
    return kafel._paginacja;
}

function ustawPasekStron(pasekStron, strona, stron) {
    if (!pasekStron) return;
    pasekStron.info.textContent = strona + " / " + stron;
    pasekStron.btnPrev.disabled = strona <= 1;
    pasekStron.btnNext.disabled = strona >= stron;
}

/** Pasek pikselowy 10 segmentow - wspolny dla kart projektow (i poligonu). */
function zbudujPasekSegmentowy(doc, wypelnione, barwa) {
    const pasek = tworz(doc, "div");
    pasek.style.cssText = "display:grid; grid-template-columns:repeat(10,1fr); gap:1px; height:5px;";
    for (let i = 0; i < 10; i++) {
        const seg = tworz(doc, "div");
        seg.style.background = i < wypelnione ? barwa : "var(--jd-border)";
        pasek.appendChild(seg);
    }
    return pasek;
}

// ============================================================================
// KAFEL "nawyki" - pasek chipow (TodayHabits.js, bez zmian - juz bez .jd-panel)
// ============================================================================

function kafelNawyki(ctx, todayPage) {
    return {
        tytul: "Nawyki dziś",
        typ: "lista",
        // N4 (19.09): chipy wypelniaja CALA tresc kafla (jd-home.css) - sprite w
        // rogu (ten sam mechanizm co kafel "dw", `def.sprite !== false` w bento.js)
        // wchodzilby pod/na chipy, wiec wylaczony tak samo jak tam.
        sprite: false,
        render(tresc) {
            TodayHabits.render(tresc, ctx, todayPage);
        }
    };
}

// ============================================================================
// KAFEL "kalend" - CalendarMonth.js { naglowek:false }, tytul kafla = miesiac +
// "nawyki X/N" (legenda CalendarMonth wylaczona - mowi to samo krocej w tytule).
// ============================================================================

function jestNawykiemZrobionym(val) {
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === "number") return val > 0;
    return val === "done" || val === true;
}

/** "nawyki X/N" dla dzisiejszej daily (X = wypelnione z CONF.HABITS_MATRIX) - ta
 *  sama logika co CalendarMonth.js/countHabits, zduplikowana bo tamta nie eksportuje
 *  (kilka linii, nie warto poszerzac kontraktu modulu dla jednego wywolania). */
function etykietaNawykowDzis(ctx, todayPage) {
    const matrix = (ctx.CONF && ctx.CONF.HABITS_MATRIX) || [];
    if (!todayPage || matrix.length === 0) return "";
    let n = 0;
    matrix.forEach((habit) => {
        let val = todayPage[habit.key];
        if (habit.fallback && (val === null || val === undefined)) val = todayPage[habit.fallback];
        if (jestNawykiemZrobionym(val)) n++;
    });
    return "nawyki " + n + "/" + matrix.length;
}

function odswiezTytulKalendarza(kafel, ctx, todayPage) {
    if (!kafel._kalendarz || !kafel.naglowek) return;
    const tytulEl = kafel.naglowek.querySelector(".jd-kafel-tytul");
    if (!tytulEl) return;
    const etykieta = etykietaNawykowDzis(ctx, todayPage);
    tytulEl.textContent = kafel._kalendarz.tytul() + (etykieta ? " · " + etykieta : "");
}

function kafelKalendarz(ctx, todayPage) {
    return {
        tytul: "Kalendarz",
        typ: "kalendarz",
        // CalendarMonth.render zwraca prev/next ktore SAME przebudowuja `.jd-calendar`
        // wewnatrz `tresc` (rerender wewnetrzny, bez wolania bento.js) - resize nie
        // ma czego dorenderowywac (siatka dni skaluje sie sama przez CSS).
        przerysujNaRozmiar: false,
        akcje: [
            { tekst: "◀", tytul: "Poprzedni miesiąc", onClick(ev, kafel) { if (!kafel._kalendarz) return; kafel._kalendarz.prev(); odswiezTytulKalendarza(kafel, ctx, todayPage); } },
            { tekst: "▶", tytul: "Następny miesiąc", onClick(ev, kafel) { if (!kafel._kalendarz) return; kafel._kalendarz.next(); odswiezTytulKalendarza(kafel, ctx, todayPage); } }
        ],
        render(tresc, kafel) {
            tresc.style.cssText = "flex:1 1 auto; min-height:0;";
            kafel._kalendarz = CalendarMonth.render(tresc, ctx, { naglowek: false });
            odswiezTytulKalendarza(kafel, ctx, todayPage);
        }
    };
}

// ============================================================================
// KAFEL "proj" - dane RAZ (RecentProjects.zaladujWszystkie, cache w domknieciu),
// filtry (3 chipy w naglowku), karty 84px w 1 kolumnie, strony w stopce.
// ============================================================================

/** Chip sortowania z DWIE etykietami (pelna/skrocona) - kafel "proj" w mapie
 *  "sredni" (1/3 szerokosci) z 3 chipami zjadal tytul (review opusa 13.09).
 *  CSS (`@container kafel max-width:360px`, sekcja PULPIT BENTO) przelacza,
 *  ktora wersja jest widoczna - JS nic tu nie mierzy. */
function chipDwuwersjowy(doc, pelna, krotka) {
    const chip = tworz(doc, "span", "jd-chip jd-chip-2w");
    chip.appendChild(tworz(doc, "span", "pelna", pelna));
    chip.appendChild(tworz(doc, "span", "krotka", krotka));
    chip.style.cursor = "pointer";
    return chip;
}

/** Filtry projektow (naglowek kafla): 2 chipy sortowania (klik) + 1 chip agenta
 *  (HOVER + wybor z dymka - Kuba 13.09: "to ma byc hover i wybor, nie
 *  przeklikiwanie kazdego" - `kolejnyAgent`/`AGENCI_PROJ` zostaja w pulpit_core.js
 *  na uzytek testow, ale UI ich juz nie uzywa). Budowane RAZ (idempotentnie, jak
 *  skonfigurujStronicowanie). Stan na `kafel._trybProj`/`kafel._agentProj` (null =
 *  "wszyscy"). Uzywamy klasy CSS `.active` (jd-skin.css: `.jd-skin .jd-chip.active`) -
 *  NIE `.aktywny` jak w poligonie (tam bez efektu wizualnego, literowka sprzed tej
 *  dostawy - tu poprawiona). */
function skonfigurujFiltryProjektow(kafel) {
    if (kafel._filtryProj) return kafel._filtryProj;
    if (!kafel.naglowek) return null;
    const doc = kafel.naglowek.ownerDocument;
    // `.jd-kafel-akcje` juz istnieje w naglowku (bento.js) - pusty (kafel "proj" nie
    // ma `def.akcje`) - chipy filtrow wchodza tam zamiast tworzyc nowy kontener.
    const kontener = kafel.naglowek.querySelector(".jd-kafel-akcje") || kafel.naglowek;

    const chipNajnowsze = chipDwuwersjowy(doc, "Najnowsze", "Nowe");
    const chipNajdluzej = chipDwuwersjowy(doc, "Najdłużej", "Stare");

    // Wrapper (chip + dymek) jako JEDNA calosc position:relative - mouseleave
    // z WRAPPERA (nie samego chipa) chowa dymek, inaczej przejscie kursora z chipa
    // NA dymek (osobny element w DOM) zamykalby go w polowie drogi.
    const agentWrap = tworz(doc, "span", "jd-kafel-dymek-wrap");
    const chipAgent = tworz(doc, "span", "jd-chip", "wszyscy");
    chipAgent.style.cursor = "default";
    const dymek = tworz(doc, "div", "jd-kafel-dymek");
    dymek.hidden = true;

    function pozycjaDymka(slug, nazwa) {
        const poz = tworz(doc, "div", "jd-kafel-dymek-poz");
        const kropka = tworz(doc, "span", "jd-kafel-dymek-kropka");
        if (slug) kropka.style.background = "var(--" + slug + "-color)";
        poz.appendChild(kropka);
        poz.appendChild(tworz(doc, "span", null, nazwa));
        poz.addEventListener("click", () => {
            kafel._agentProj = slug;
            odswiez();
            dymek.hidden = true;
            kafel._strona = 1;
            kafel.przerysuj();
        });
        return poz;
    }
    dymek.appendChild(pozycjaDymka(null, "wszyscy"));
    AGENCI_PROJ.forEach((slug) => dymek.appendChild(pozycjaDymka(slug, slug)));
    const LICZBA_POZYCJI = AGENCI_PROJ.length + 1; // + "wszyscy"
    // Wysokosc jednej pozycji dymka (zmierzona: padding 3px 6px + font .72em) -
    // uzywana TYLKO do policzenia ile wierszy sie zmiesci, nie do rysowania.
    const WYSOKOSC_POZYCJI_PX = 22;

    // N5 (19.09): gdy pod naglowkiem jest mniej miejsca niz cala kolumna dymka
    // (7 pozycji x ~22px), przelacz na uklad KOLUMNOWY (grid-auto-flow:column) -
    // inaczej dymek zostaje uciety przez `.jd-kafel{overflow:hidden}` w niskim
    // kaflu. Liczba wierszy z dostepnej wysokosci (kafel.el.bottom - wrap.bottom,
    // -4px marginesu od dolnej krawedzi) - BENTO_CORE.ileWierszy (ta sama funkcja
    // co stronicowanie proj/todo), `max` ograniczony do liczby pozycji (bez sensu
    // wiecej wierszy niz elementow).
    agentWrap.addEventListener("mouseenter", () => {
        const kafelRect = kafel.el.getBoundingClientRect();
        const wrapRect = agentWrap.getBoundingClientRect();
        const dostepna = kafelRect.bottom - wrapRect.bottom - 4;
        const wiersze = BENTO_CORE.ileWierszy(dostepna, WYSOKOSC_POZYCJI_PX, 1, LICZBA_POZYCJI);
        // Uklad kolumnowy przez KLASE, nie inline `display` (review Dextera 19.09):
        // inline `display:grid` bije regule `.jd-kafel-dymek[hidden]{display:none}`
        // i dymek w niskim kaflu nie schowalby sie nigdy.
        const kolumny = wiersze < LICZBA_POZYCJI;
        dymek.classList.toggle("jd-kafel-dymek-kolumny", kolumny);
        dymek.style.gridTemplateRows = kolumny ? `repeat(${wiersze}, auto)` : "";
        dymek.hidden = false;
    });
    agentWrap.addEventListener("mouseleave", () => { dymek.hidden = true; });
    agentWrap.appendChild(chipAgent);
    agentWrap.appendChild(dymek);

    kafel._trybProj = "najnowsze";
    kafel._agentProj = null;

    function odswiez() {
        chipNajnowsze.classList.toggle("active", kafel._trybProj === "najnowsze");
        chipNajdluzej.classList.toggle("active", kafel._trybProj === "najdluzej");
        chipAgent.classList.toggle("active", kafel._agentProj != null);
        chipAgent.textContent = kafel._agentProj || "wszyscy";
        chipAgent.style.color = kafel._agentProj ? "var(--" + kafel._agentProj + "-color)" : "";
    }
    chipNajnowsze.addEventListener("click", () => { kafel._trybProj = "najnowsze"; odswiez(); kafel._strona = 1; kafel.przerysuj(); });
    chipNajdluzej.addEventListener("click", () => { kafel._trybProj = "najdluzej"; odswiez(); kafel._strona = 1; kafel.przerysuj(); });

    kontener.appendChild(chipNajnowsze); kontener.appendChild(chipNajdluzej); kontener.appendChild(agentWrap);
    odswiez();
    kafel._filtryProj = { chipNajnowsze, chipNajdluzej, chipAgent, dymek };
    return kafel._filtryProj;
}

function zbudujKarteProjektu(doc, p, teraz, ctx) {
    // Karta na pelna szerokosc, 84px (wzorzec poligonu v3): gorny wiersz
    // tytul+procent (procent duzym drukiem, brak dla projektow bez numerycznego
    // postepu - briefy/posty), dolny agent+kind/status+dni bez ruchu (+warn),
    // pasek 10 segmentow na cala szerokosc.
    const karta = tworz(doc, "div");
    karta.style.cssText = "display:flex; flex-direction:column; justify-content:center; gap:4px; min-height:84px; height:84px; border-left:3px solid var(--" + p.agent + "-color); padding:4px 10px; box-sizing:border-box; min-width:0; cursor:pointer;";

    const gorny = tworz(doc, "div");
    gorny.style.cssText = "display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0;";
    const nazwa = tworz(doc, "div", null, p.title);
    nazwa.title = p.title;
    nazwa.style.cssText = "font-size:.8em; color:var(--" + p.agent + "-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;";
    gorny.appendChild(nazwa);
    if (typeof p.pct === "number") {
        const procent = tworz(doc, "div", null, p.pct + "%");
        procent.style.cssText = "font-family:var(--px-dspf, 'VT323', 'Pixelify Sans', monospace); font-size:1.6em; line-height:1; color:var(--px-acc); flex:0 0 auto;";
        gorny.appendChild(procent);
    }

    const dni = PULPIT_CORE.dniBezRuchu(p.mtime, teraz);
    const opisRodzaj = p.kind || p.status || p.platform || "";
    let opisDolny = p.agent + (opisRodzaj ? " · " + opisRodzaj : "") + " · " + dni + " dni bez ruchu";
    if (p.warn) opisDolny += " · ⚠ " + p.warn;
    const dolny = tworz(doc, "div", null, opisDolny);
    dolny.style.cssText = "font-size:.62em; color:var(--jd-text-mu); text-transform:uppercase;";

    const pasek = zbudujPasekSegmentowy(doc, typeof p.pct === "number" ? Math.round(p.pct / 10) : 0, "var(--" + p.agent + "-color)");

    karta.appendChild(gorny); karta.appendChild(dolny); karta.appendChild(pasek);
    karta.addEventListener("click", () => {
        if (p.clickType === "openFile") {
            const f = ctx.app.vault.getAbstractFileByPath(p.clickTarget);
            if (f) ctx.app.workspace.getLeaf().openFile(f);
            else if (typeof Notice === "function") new Notice("Nie znaleziono: " + p.clickTarget);
        } else if (p.clickType === "setView" && ctx.setView) {
            ctx.setView(p.clickTarget);
        }
    });
    return karta;
}

function renderujProjekty(tresc, kafel, lista, ctx) {
    const doc = tresc.ownerDocument;
    const pasekStron = skonfigurujStronicowanie(kafel);
    const teraz = Date.now();

    const przefiltrowane = PULPIT_CORE.filtrujProjekty(lista, kafel._trybProj || "najnowsze", kafel._agentProj || null, teraz);

    // Jedna kolumna, karta 84px (kafel.rozmiar() = JUZ tylko `.jd-kafel-tresc`,
    // nie liczac naglowka/stopki - wzorzec poligonu).
    const rozmiarStrony = BENTO_CORE.ileWierszy(kafel.rozmiar().h, 84, 1);
    const wynik = wybierzStrone(przefiltrowane, kafel._strona || 1, rozmiarStrony);
    kafel._strona = wynik.strona;

    const listaEl = tworz(doc, "div");
    listaEl.style.cssText = "flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:6px;";
    if (wynik.wiersze.length === 0) {
        const puste = tworz(doc, "div", null, "Brak projektów.");
        puste.style.cssText = "opacity:.5; text-align:center; padding:20px 0; font-size:.85em;";
        listaEl.appendChild(puste);
    } else {
        wynik.wiersze.forEach((p) => listaEl.appendChild(zbudujKarteProjektu(doc, p, teraz, ctx)));
    }
    tresc.appendChild(listaEl);

    ustawPasekStron(pasekStron, wynik.strona, wynik.stron);
}

function kafelProjekty(ctx, zaladujProjekty) {
    return {
        tytul: "Projekty",
        typ: "lista",
        stopka: true,
        przerysujNaRozmiar: true,
        render(tresc, kafel) {
            // Wersja PRZED await (spec B2 sekcja 2) - jesli w miedzyczasie nadejdzie
            // nowy przerysuj() (np. klik filtra tuz po resize), ten stary render nie
            // dopisze juz nieaktualnego DOM po powrocie z `zaladujProjekty()`.
            const wersjaStartu = kafel.wersja;
            skonfigurujFiltryProjektow(kafel);
            skonfigurujStronicowanie(kafel);
            return zaladujProjekty().then((lista) => {
                if (kafel.wersja !== wersjaStartu) return;
                renderujProjekty(tresc, kafel, lista, ctx);
            });
        }
    };
}

// ============================================================================
// KAFEL "todo" - dane RAZ (SideStack.zaladujDzienneTodo, cache w domknieciu -
// wzorzec `zaladujProjekty" nizej), SideStack.renderDailyTodo dostaje gotowa
// liste (`opts.todos`) - resize NIE czyta/nie zapisuje dysku (bloker 3, review
// opusa 13.09: `przerysujNaRozmiar:true` woalo load+scan+save na kazdej klatce).
// Strony w stopce liczone z wysokosci kafla (BENTO_CORE.ileWierszy, wiersz 30px -
// musi zgadzac sie z wysokoscia wiersza w SideStack.js).
// ============================================================================

function kafelTodo(ctx) {
    // Cache {dailyFile, todos, sources} - zyje w domknieciu adaptera (jak
    // projektyCache w zbudujOpisPulpitu), NIE na `kafel` (kafel ginie/wstaje na
    // nowo przy kazdej pelnej przebudowie Home, to jest ok - nowy fetch wtedy).
    let todosCache = null;
    let todosObietnica = null;

    function zaladujTodo() {
        if (todosCache) return Promise.resolve(todosCache);
        if (!todosObietnica) {
            const todayISO = window.moment().format("YYYY-MM-DD");
            todosObietnica = SideStack.zaladujDzienneTodo(ctx.app, todayISO).then((dane) => {
                todosCache = dane;
                todosObietnica = null;
                return dane;
            });
        }
        return todosObietnica;
    }

    return {
        tytul: "Dzienne TODO",
        typ: "lista",
        stopka: true,
        przerysujNaRozmiar: true,
        render(tresc, kafel) {
            const wersjaStartu = kafel.wersja;
            const pasekStron = skonfigurujStronicowanie(kafel);
            // N2 fix (19.09): limit NIE jest juz liczony tutaj (kafel.rozmiar().h
            // to CALA tresc.clientHeight, bez odjecia naglowka/stopki, ktore
            // SideStack.js buduje WEWNATRZ tej samej tresci - stad przyciety
            // ostatni wiersz). SideStack.renderDailyTodo liczy limit SAM, z
            // REALNIE zmierzonych wysokosci (PULPIT_CORE.wierszyTodo).
            return zaladujTodo().then((dane) => {
                if (kafel.wersja !== wersjaStartu) return;
                const wynik = SideStack.renderDailyTodo(tresc, ctx, {
                    bezPanelu: true,
                    strona: kafel._strona || 1,
                    todos: dane.todos,
                    dailyFile: dane.dailyFile,
                    sources: dane.sources,
                    // Builder ("Stwórz/Rozbuduj") podmienil liste NA DYSKU - cache
                    // tutaj trzyma STARA referencje (bloker 3) - uniewazniamy i
                    // przerysowujemy RAZ (kafel.przerysuj() -> swiezy zaladujTodo()).
                    naPrzeladuj: () => {
                        todosCache = null;
                        todosObietnica = null;
                        kafel.przerysuj();
                    }
                });
                return Promise.resolve(wynik).then((info) => {
                    if (kafel.wersja !== wersjaStartu) return;
                    if (info) {
                        kafel._strona = info.strona;
                        ustawPasekStron(pasekStron, info.strona, info.stron);
                    }
                });
            });
        }
    };
}

// ============================================================================
// KAFEL "grind" - tylko gdy SideStack.czyGrindAktywny(app) (decyzja PRZED
// zbudujOpisPulpitu, patrz widgetHome.js) - render nie sprawdza aktywnosci sam.
// ============================================================================

function kafelGrind(ctx) {
    return {
        tytul: "Grind",
        typ: "inne",
        render(tresc) {
            return SideStack.renderGrind(tresc, ctx, { bezPanelu: true });
        }
    };
}

// ============================================================================
// KAFEL "dw" - DeepWorkTimer.render({bezPanelu:true, zegar:"px"}) - zegar
// pikselowy (zegar_px.js), guziki/modale bez zmian.
// `przerysujNaRozmiar: false` (hotfix 13.09, Kuba: "3x zestaw guzikow" po
// resize) - DeepWorkTimer.render jest ciezki (DWState.load, XP, modale); resize
// skalowania zegara zalatwia SAM zegar_px.js (opcja `obserwuj:true`, wlasny
// ResizeObserver), zero powodu przebudowywac caly komponent na kazda klatke.
// ============================================================================

function kafelDeepWork(ctx) {
    return {
        tytul: "Deep Work",
        typ: "licznik",
        // Bez sprite'a NOIR (Kuba 13.09, szkic 2x2) - prawy dolny róg to teraz box
        // "czas" (cyfry+napis+pasek na cala szerokosc), sprite by w niego wchodzil.
        // Glif naglowka zostaje (bento.js: `def.sprite !== false` osobno od glifu).
        sprite: false,
        przerysujNaRozmiar: false,
        render(tresc, kafel) {
            const wersjaStartu = kafel.wersja;
            // bento.js juz szeregowo serializuje rendery per kafel (przerysuj()
            // nie nadpisze `tresc` w trakcie tego renderu) - guard tu to defense-
            // in-depth zgodnie ze spec (sekcja 1 hotfixu), nie jedyna ochrona.
            return DeepWorkTimer.render(tresc, ctx, { bezPanelu: true, zegar: "px" }).then(() => {
                if (kafel.wersja !== wersjaStartu) return;
            });
        }
    };
}

// Most Status zarządza własnym cache i jednym odświeżaniem na 30 s. Home tylko
// prosi o render do własnego korzenia, więc dwie instancje Home nie dzielą DOM.
function kafelUsage(ctx) {
    let cleanup = null;
    let cleanupRegistered = false;
    return {
        tytul: "Użycie subskrypcji",
        typ: "stat",
        sprite: false,
        przerysujNaRozmiar: false,
        render(tresc) {
            if (cleanup) { cleanup(); cleanup = null; }
            if (!cleanupRegistered && ctx.UTILS && typeof ctx.UTILS.rejestrujSprzatanie === "function") {
                ctx.UTILS.rejestrujSprzatanie(tresc, () => {
                    if (cleanup) { cleanup(); cleanup = null; }
                });
                cleanupRegistered = true;
            }
            const plugin = ctx.app.plugins.getPlugin("most-status");
            if (!plugin || typeof plugin.renderUsageTile !== "function") {
                tresc.createDiv({ cls: "most-usage-tile", text: "Monitor użycia nie jest załadowany." });
                return;
            }
            cleanup = plugin.renderUsageTile(tresc);
        }
    };
}

// ============================================================================
// OPIS calosci - mapy z pulpit_core.mapaPulpitu (grind zalezne), kafle wg wyzej.
// ============================================================================

/**
 * Buduje OPIS dla `BENTO.siatka` (Pulpit Home, B2).
 * @param {{ctx:object, todayPage:object|null, dailies:*, NOIR:object|null, grindAktywny:boolean}} args
 *   `ctx` = shared context Home (app, dv, CONF, UTILS, XP_ENGINE, getCurrentView, setView,
 *   refreshContent). `dailies` (zakres 7 dni) trzymany w sygnaturze dla zgodnosci z
 *   wywolaniem w widgetHome.js - zaden kafel Pulpitu go dzis nie potrzebuje (Trendy
 *   wyciete, CalendarMonth czyta dni sam z vaulta).
 * @returns {object} OPIS - patrz components/shared/bento.js (mapy, wagi, kafle, noir, glif).
 */
function zbudujOpisPulpitu({ ctx, todayPage, dailies, NOIR, grindAktywny }) {
    const { mapy, wagi } = PULPIT_CORE.mapaPulpitu(!!grindAktywny);

    // "proj": dane ladowane RAZ przy budowie tego OPISU (jeden fetch na przebudowe
    // Home - refreshContent tworzy nowy OPIS -> nowe domkniecie -> nowy fetch).
    let projektyCache = null;
    let projektyObietnica = null;
    function zaladujProjekty() {
        if (projektyCache) return Promise.resolve(projektyCache);
        if (!projektyObietnica) {
            projektyObietnica = RecentProjects.zaladujWszystkie(ctx.app).then((lista) => {
                projektyCache = lista;
                return lista;
            });
        }
        return projektyObietnica;
    }

    const kafle = {
        nawyki: kafelNawyki(ctx, todayPage),
        kalend: kafelKalendarz(ctx, todayPage),
        proj: kafelProjekty(ctx, zaladujProjekty),
        todo: kafelTodo(ctx),
        dw: kafelDeepWork(ctx),
        usage: kafelUsage(ctx)
    };
    if (grindAktywny) {
        kafle.grind = kafelGrind(ctx);
    }

    return {
        noir: NOIR || null,
        glif: "home",
        mapy,
        wagi,
        kafle
    };
}

module.exports = { zbudujOpisPulpitu };
