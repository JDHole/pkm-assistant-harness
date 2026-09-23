/**
 * @file pulpit_core.js - czysta logika Pulpitu bento (zero fs, zero DOM, zero Obsidiana).
 *   Scalanie/filtrowanie/sortowanie listy projektow (6 agentow, RecentProjects.zaladujWszystkie)
 *   i wybor mapy bento Pulpitu (z/bez kafla Grind). Testowane czystym Node (pulpit_core.test.js).
 *   Render nad tym rdzeniem: components/home/pulpit_kafle.js.
 * @agent dexter
 * @pracownia System HQ
 * @exports filtrujProjekty, dniBezRuchu, mapaPulpitu, kolejnyAgent, wierszyTodo
 * @uses brak - funkcje czyste, dostaja dane od wolajacego (pulpit_kafle.js)
 * @reads nic (operuje wylacznie na argumentach)
 * @writes nic
 * @since 2026-09-13 B2 Pulpit bento (spec: Dexter, wykonawca: sonnet)
 * @tests pulpit_core.test.js (node --test pulpit_core.test.js)
 */

"use strict";

/**
 * Filtruje/sortuje liste projektow (scalona z 6 loaderow RecentProjects.zaladujWszystkie).
 * @param {object[]} lista - {title, agent, status, warn?, pct?, path, mtime, clickType, clickTarget, kind?, platform?}[]
 * @param {"najnowsze"|"najdluzej"|"agent"} tryb
 *   "najnowsze": sort mtime malejaco (najswiezsze pierwsze).
 *   "najdluzej": tylko projekty NIEUKONCZONE (pct brak albo pct < 100 - projekt bez
 *     numerycznego postepu, np. brief/post, liczy sie jako "w toku"), sort mtime
 *     rosnaco (najdluzej bez ruchu pierwsze).
 *   "agent": tylko projekty danego agenta (parametr `agent`), sort mtime malejaco.
 * @param {string|null} agent - slug agenta; w trybie "agent" wymagany, w pozostalych
 *   trybach dodatkowy filtr (gdy podany, zawsze zawezony do tego agenta).
 * @param {number} teraz - ms (Date.now()), nieuzywane bezposrednio tutaj (przekazywane
 *   do symetrii z dniBezRuchu w wolajacym), zostawione w sygnaturze dla stabilnego API.
 * @returns {object[]} NOWA tablica - `lista` nigdy nie jest mutowana.
 */
function filtrujProjekty(lista, tryb, agent, teraz) {
    let wynik = (Array.isArray(lista) ? lista : []).slice();

    if (agent) {
        wynik = wynik.filter((p) => p && p.agent === agent);
    }

    if (tryb === "najdluzej") {
        wynik = wynik.filter((p) => p && (typeof p.pct !== "number" || p.pct < 100));
        wynik.sort((a, b) => (Number(a.mtime) || 0) - (Number(b.mtime) || 0));
    } else {
        // "najnowsze" i "agent" - obie malejaco po mtime (swiezosc).
        wynik.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
    }

    return wynik;
}

/**
 * Ile pelnych dni minelo od `mtime` do `teraz`. mtime w przyszlosci (zegar rozjechany,
 * dane testowe) -> 0, nigdy ujemna. Nie-skonczone ALBO <=0 (0/null/brak stat.mtime -
 * bez tego "brak danych" liczylby sie jako "od epoki Unixa", ~20000+ dni - bug review
 * opusa 13.09) -> 0.
 * @param {number} mtime - ms (Date.now() w momencie ostatniego zapisu).
 * @param {number} teraz - ms (Date.now() "dzis").
 * @returns {number} liczba calkowita >= 0.
 */
function dniBezRuchu(mtime, teraz) {
    const m = Number(mtime);
    const t = Number(teraz);
    if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(t)) return 0;
    const dni = Math.floor((t - m) / 86400000);
    return dni > 0 ? dni : 0;
}

// Mapy bento Pulpitu (zestaw A v4 z poligonu, Bento Poligon.md OPIS_A - poligon w archiwum od 19.09) - patrz
// spec B2 sekcja 3/4. `grind` (gdy aktywny) zajmuje TYLKO gorny wiersz kolumny
// "todo" (ten sam, ktory bez grinda zajmuje "todo" - `todo` sie zwiera do
// dolnego wiersza), reszta mapy identyczna w obu wariantach.
const SZEROKI_BEZ_GRINDA = ["nawyki nawyki nawyki todo", "kalend kalend proj todo", "kalend kalend proj dw", "usage usage usage usage"];
const SZEROKI_Z_GRINDEM = ["nawyki nawyki nawyki grind", "kalend kalend proj todo", "kalend kalend proj dw", "usage usage usage usage"];
const SREDNI_BEZ_GRINDA = ["nawyki nawyki todo", "kalend kalend todo", "kalend kalend proj", "kalend kalend proj", "dw dw proj", "usage usage usage"];
const SREDNI_Z_GRINDEM = ["nawyki nawyki grind", "kalend kalend todo", "kalend kalend proj", "kalend kalend proj", "dw dw proj", "usage usage usage"];
const WAGI_SZEROKI = { rzedy: [1, 3, 3, 1], kolumny: [1, 1, 1, 1] };
// [2,2,2,2,2] (nie [1,2,2,2,2]) - bramka wizualna 13.09 (1360x720, mapa "sredni"):
// pierwszy rzad ~60px za niski na pasek nawykow (8 chipow, overflow +72px).
const WAGI_SREDNI = { rzedy: [2, 2, 2, 2, 2, 1] };
// Mapa "waski" JAWNA, DWIE kolumny (19.09, Kuba: "przy waskim widoku dzienne TODO jest
// kompletnie nieczytelne, zreszta kalendarz rowniez"). Zmierzone na zywym Home: przy
// rozwinietym panelu czatu bento ma 778 px i auto-mapa w jednej kolumnie dawala 5 pasow
// po 130 px. Teraz: nawyki na cala szerokosc (niski rzad), lewa kolumna kalendarz + Deep
// Work, prawa TODO + Projekty. Grind (gdy aktywny) bierze gorny wiersz prawej kolumny.
const WASKI_BEZ_GRINDA = ["nawyki nawyki", "kalend todo", "kalend todo", "kalend proj", "dw proj", "usage usage"];
const WASKI_Z_GRINDEM = ["nawyki nawyki", "kalend grind", "kalend todo", "kalend proj", "dw proj", "usage usage"];
// 1.3 (nie 1): ponizej 760 px szerokosci kafla chipy nawykow ida w 4x2 i w rzedzie wagi 1
// (72 px) robily sie za cienkie [measured 19.09, Home 680 px].
const WAGI_WASKI = { rzedy: [1.3, 2, 2, 2, 2, 1] };

/**
 * Wybiera mapy bento Pulpitu wg tego, czy Grind Plan jest aktywny (SideStack.czyGrindAktywny).
 * `mapy.waski` jest JAWNA (dwie kolumny, 19.09) - auto-mapa w jednej kolumnie byla
 * nieczytelna; `wagi.waski` (nawyki niski rzad, reszta po rowno) w obu wariantach.
 * Zwraca ZAWSZE nowe tablice/obiekty (`.slice()`/spread) - NIGDY referencje do
 * modulowych stalych, zeby wolajacy (bento.js muutuje `mapy`/`wagi` we wlasnym
 * stanie - `normalizujMapy`/wagiAktywne) nigdy nie dotknal wspoldzielonego stanu
 * miedzy dwoma osobnymi budowami siatki (review opusa 13.09).
 * @param {boolean} grindAktywny
 * @returns {{mapy:{szeroki:string[], sredni:string[], waski:string[]}, wagi:{szeroki:object, sredni:object, waski:object}}}
 */
function mapaPulpitu(grindAktywny) {
    const szeroki = grindAktywny ? SZEROKI_Z_GRINDEM : SZEROKI_BEZ_GRINDA;
    const sredni = grindAktywny ? SREDNI_Z_GRINDEM : SREDNI_BEZ_GRINDA;
    const wagi = {
        szeroki: { rzedy: WAGI_SZEROKI.rzedy.slice(), kolumny: WAGI_SZEROKI.kolumny.slice() },
        sredni: { rzedy: WAGI_SREDNI.rzedy.slice() }
    };
    const waski = grindAktywny ? WASKI_Z_GRINDEM : WASKI_BEZ_GRINDA;
    wagi.waski = { rzedy: WAGI_WASKI.rzedy.slice() };
    return {
        mapy: { szeroki: szeroki.slice(), sredni: sredni.slice(), waski: waski.slice() },
        wagi
    };
}

/**
 * Ile wierszy listy TODO miesci sie W CALOSCI w dostepnej wysokosci tresci kafla
 * "todo" (N2, 19.09) - w odroznieniu od kafla "proj" (`.jd-kafel-tresc` to TAM sama
 * lista, bento.js/BENTO_CORE.ileWierszy dostaje czysta wysokosc), kafel "todo"
 * buduje WEWNATRZ tresci wlasny naglowek (guzik "+ Rozbuduj") i stopke (pasek
 * postepu X/Y) - SideStack.js renderDailyTodo. Bez odjecia ich REALNIE ZMIERZONEJ
 * wysokosci ostatni wiersz listy bywal przyciety w polowie (scrollHeight >
 * clientHeight w .jd-kafel-tresc - zmierzone 19.09).
 * @param {number} wysokoscTresc - tresc.clientHeight (CALA, z naglowkiem/stopka
 *   WEWNATRZ - patrz wyzej).
 * @param {number} wysokoscChrome - suma zmierzonych wysokosci naglowka + stopki
 *   ZYJACYCH WEWNATRZ tresci todo (offsetHeight obu, zmierzone PO ich zbudowaniu,
 *   PRZED wierszami listy).
 * @param {number} wierszPx - wysokosc jednego wiersza listy.
 * @param {number} [min=1]
 * @returns {number} liczba calkowita >= min. NIGDY nie pokazuje przycietego
 *   wiersza (floor, nie round); NIGDY < min (choc chrome > wysokoscTresc -
 *   zdegenerowany uklad dostaje przynajmniej `min` wierszy, nie 0/ujemna).
 */
function wierszyTodo(wysokoscTresc, wysokoscChrome, wierszPx, min) {
    const m = Number.isFinite(min) && min > 0 ? Math.floor(min) : 1;
    const t = Number(wysokoscTresc);
    const w = Number(wierszPx);
    if (!Number.isFinite(t) || !Number.isFinite(w) || w <= 0) return m;
    const c = Number(wysokoscChrome);
    const dostepna = Math.max(0, t - (Number.isFinite(c) ? c : 0));
    const ile = Math.floor(dostepna / w);
    return Math.max(m, ile);
}

/**
 * Nastepny agent w cyklu chipa filtra "Agent" (kafel proj): null ("wszyscy") -> lista[0]
 * -> lista[1] -> ... -> null. Agent spoza listy (rozjazd stanu) traktowany jak null.
 * @param {string|null} aktualny
 * @param {string[]} lista - kolejnosc cyklu (sluzy agentow obecnych w danych).
 * @returns {string|null}
 */
function kolejnyAgent(aktualny, lista) {
    const l = Array.isArray(lista) ? lista : [];
    const idx = aktualny == null ? -1 : l.indexOf(aktualny);
    if (idx === -1) return l.length > 0 ? l[0] : null;
    if (idx === l.length - 1) return null;
    return l[idx + 1];
}

module.exports = { filtrujProjekty, dniBezRuchu, mapaPulpitu, kolejnyAgent, wierszyTodo };
