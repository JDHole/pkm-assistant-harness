/**
 * @file pulpit_core.test.js - testy modulu pulpit_core.js (node --test, assert/strict).
 * @agent dexter
 * @exports brak (uruchamiane: node --test pulpit_core.test.js)
 * @uses node:test, node:assert/strict, ./pulpit_core.js (testowany modul), ../shared/bento_core.js
 *   (tylko do zweryfikowania, ze mapy z mapaPulpitu parsuja sie bez bledow - parsujMape)
 * @since 2026-09-13 B2 Pulpit bento (spec: Dexter, wykonawca: sonnet)
 * @since 2026-09-19 N2/N4 (Pulpit bento e0 - status bar/todo/dw/nawyki/dymek):
 *   testy wierszyTodo + wagi.waski (wykonawca: sonnet)
 * @tests filtrujProjekty (najnowsze/najdluzej/agent, niemutowanie, pusta lista);
 *   dniBezRuchu (0, 24 dni, mtime w przyszlosci -> 0, wejscie nie-skonczone);
 *   mapaPulpitu (oba warianty parsuja sie bez bledow, ten sam zbior nazw poza "grind",
 *   wagi.waski bez grinda / brak z grindem);
 *   kolejnyAgent (cykl null->pierwszy->...->null, agent spoza listy, pusta lista);
 *   wierszyTodo (wysokosc 0, mniej niz jeden wiersz, dokladna wielokrotnosc,
 *   o 1px za malo, chrome > tresc, wejscie nie-skonczone, wlasny min)
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { filtrujProjekty, dniBezRuchu, mapaPulpitu, kolejnyAgent, wierszyTodo } = require("./pulpit_core.js");
const BENTO_CORE = require("../shared/bento_core.js");

// ===== filtrujProjekty =====

const PROJEKTY = [
    { title: "A", agent: "dexter", pct: 50, mtime: 5000 },
    { title: "B", agent: "sonny", pct: 100, mtime: 9000 },
    { title: "C", agent: "dexter", pct: 20, mtime: 1000 },
    { title: "D", agent: "claudzik", mtime: 3000 } // brak pct (brief/post) - liczy sie jako aktywny
];

test("filtrujProjekty: najnowsze -> sort mtime malejaco, cala lista", () => {
    const wynik = filtrujProjekty(PROJEKTY, "najnowsze", null, 10000);
    assert.deepEqual(wynik.map((p) => p.title), ["B", "A", "D", "C"]);
});

test("filtrujProjekty: najdluzej -> tylko pct<100 albo brak pct, sort mtime rosnaco", () => {
    const wynik = filtrujProjekty(PROJEKTY, "najdluzej", null, 10000);
    // B (pct 100) odpada; reszta rosnaco po mtime: C(1000) D(3000) A(5000)
    assert.deepEqual(wynik.map((p) => p.title), ["C", "D", "A"]);
});

test("filtrujProjekty: agent -> tylko dany agent, sort mtime malejaco", () => {
    const wynik = filtrujProjekty(PROJEKTY, "agent", "dexter", 10000);
    assert.deepEqual(wynik.map((p) => p.title), ["A", "C"]);
});

test("filtrujProjekty: nie mutuje wejsciowej listy", () => {
    const kopia = PROJEKTY.map((p) => Object.assign({}, p));
    filtrujProjekty(PROJEKTY, "najnowsze", null, 10000);
    filtrujProjekty(PROJEKTY, "najdluzej", null, 10000);
    filtrujProjekty(PROJEKTY, "agent", "sonny", 10000);
    assert.deepEqual(PROJEKTY, kopia);
});

test("filtrujProjekty: pusta lista -> pusta tablica dla kazdego trybu", () => {
    assert.deepEqual(filtrujProjekty([], "najnowsze", null, 10000), []);
    assert.deepEqual(filtrujProjekty([], "najdluzej", null, 10000), []);
    assert.deepEqual(filtrujProjekty([], "agent", "dexter", 10000), []);
    assert.deepEqual(filtrujProjekty(undefined, "najnowsze", null, 10000), []);
});

// ===== dniBezRuchu =====

test("dniBezRuchu: ta sama chwila -> 0", () => {
    assert.equal(dniBezRuchu(10000, 10000), 0);
});

test("dniBezRuchu: 24 dni temu -> 24", () => {
    const teraz = 30 * 86400000;
    const mtime = teraz - 24 * 86400000;
    assert.equal(dniBezRuchu(mtime, teraz), 24);
});

test("dniBezRuchu: mtime <= 0 (brak stat.mtime) -> 0, nie 'dni od epoki' (review opusa)", () => {
    const teraz = Date.now();
    assert.equal(dniBezRuchu(0, teraz), 0);
    assert.equal(dniBezRuchu(null, teraz), 0);
    assert.equal(dniBezRuchu(-5, teraz), 0);
});

test("dniBezRuchu: mtime w przyszlosci -> 0 (nie ujemna)", () => {
    assert.equal(dniBezRuchu(20000, 10000), 0);
});

test("dniBezRuchu: wejscie nie-skonczone -> 0", () => {
    assert.equal(dniBezRuchu(NaN, 10000), 0);
    assert.equal(dniBezRuchu(10000, undefined), 0);
    assert.equal(dniBezRuchu(Infinity, 10000), 0);
});

// ===== mapaPulpitu =====

test("mapaPulpitu: bez grinda - obie mapy parsuja sie bez bledow", () => {
    const opis = mapaPulpitu(false);
    const szeroki = BENTO_CORE.parsujMape(opis.mapy.szeroki);
    const sredni = BENTO_CORE.parsujMape(opis.mapy.sredni);
    assert.deepEqual(szeroki.bledy, []);
    assert.deepEqual(sredni.bledy, []);
});

test("mapaPulpitu: z grindem - obie mapy parsuja sie bez bledow", () => {
    const opis = mapaPulpitu(true);
    const szeroki = BENTO_CORE.parsujMape(opis.mapy.szeroki);
    const sredni = BENTO_CORE.parsujMape(opis.mapy.sredni);
    assert.deepEqual(szeroki.bledy, []);
    assert.deepEqual(sredni.bledy, []);
});

test("mapaPulpitu: zbior nazw kafli identyczny poza 'grind' (tylko w wariancie z grindem)", () => {
    const bezGrinda = mapaPulpitu(false);
    const zGrindem = mapaPulpitu(true);

    const porSzeroki = BENTO_CORE.porownajZbiory(bezGrinda.mapy.szeroki, zGrindem.mapy.szeroki);
    assert.deepEqual(porSzeroki.brak, []);
    assert.deepEqual(porSzeroki.nadmiar, ["grind"]);

    const porSredni = BENTO_CORE.porownajZbiory(bezGrinda.mapy.sredni, zGrindem.mapy.sredni);
    assert.deepEqual(porSredni.brak, []);
    assert.deepEqual(porSredni.nadmiar, ["grind"]);
});

test("mapaPulpitu: usage jest w kazdym rozmiarze i nie znika przy Grind", () => {
    [false, true].forEach((grind) => {
        const opis = mapaPulpitu(grind);
        [opis.mapy.szeroki, opis.mapy.sredni, opis.mapy.waski].forEach((mapa) => {
            assert.ok(mapa.some((wiersz) => wiersz.split(/ +/).includes("usage")));
            assert.deepEqual(BENTO_CORE.parsujMape(mapa).bledy, []);
        });
    });
});

test("mapaPulpitu: usage jest osobnym pelnoszerokim rzedem, bez zmiany zatwierdzonych pol", () => {
    const bezGrinda = mapaPulpitu(false);
    assert.deepEqual(bezGrinda.mapy.szeroki.slice(0, -1), [
        "nawyki nawyki nawyki todo", "kalend kalend proj todo", "kalend kalend proj dw"
    ]);
    assert.deepEqual(bezGrinda.mapy.sredni.slice(0, -1), [
        "nawyki nawyki todo", "kalend kalend todo", "kalend kalend proj", "kalend kalend proj", "dw dw proj"
    ]);
    assert.deepEqual(bezGrinda.mapy.waski.slice(0, -1), [
        "nawyki nawyki", "kalend todo", "kalend todo", "kalend proj", "dw proj"
    ]);
    [bezGrinda.mapy.szeroki, bezGrinda.mapy.sredni, bezGrinda.mapy.waski].forEach((mapa) => {
        const ostatni = mapa[mapa.length - 1].trim().split(/ +/);
        assert.ok(ostatni.every((nazwa) => nazwa === "usage"));
    });
});

// Mapa "waski" (19.09, Kuba: "przy waskim widoku TODO jest kompletnie nieczytelne,
// kalendarz rowniez"): jawna, DWIE kolumny - auto-mapa w jednej kolumnie dawala 5 pasow
// po 130 px przy rozwinietym panelu bocznym (bento 778 px).
[false, true].forEach((grind) => {
    const nazwa = grind ? "z grindem" : "bez grinda";
    test("mapaPulpitu: " + nazwa + " - mapa waski jawna, dwie kolumny, bez bledow", () => {
        const opis = mapaPulpitu(grind);
        assert.ok(Array.isArray(opis.mapy.waski), "mapy.waski musi byc jawna");
        assert.deepEqual(BENTO_CORE.parsujMape(opis.mapy.waski).bledy, []);
        opis.mapy.waski.forEach((w) => assert.equal(w.trim().split(/ +/).length, 2));
    });
    test("mapaPulpitu: " + nazwa + " - mapa waski ma te same kafle co szeroka", () => {
        const opis = mapaPulpitu(grind);
        const por = BENTO_CORE.porownajZbiory(opis.mapy.szeroki, opis.mapy.waski);
        assert.deepEqual(por.brak, []);
        assert.deepEqual(por.nadmiar, []);
    });
    test("mapaPulpitu: " + nazwa + " - wagi.waski: tyle rzedow co wierszy mapy, nawyki najnizsze", () => {
        const opis = mapaPulpitu(grind);
        assert.equal(opis.wagi.waski.rzedy.length, opis.mapy.waski.length);
        assert.ok(opis.wagi.waski.rzedy[0] < opis.wagi.waski.rzedy[1]);
    });
});

test("mapaPulpitu: kazde wywolanie zwraca NOWE tablice/obiekty (zero wspoldzielonych referencji, review opusa)", () => {
    const m1 = mapaPulpitu(false);
    const m2 = mapaPulpitu(false);
    assert.notEqual(m1.mapy.szeroki, m2.mapy.szeroki);
    assert.notEqual(m1.mapy.sredni, m2.mapy.sredni);
    assert.notEqual(m1.wagi.szeroki, m2.wagi.szeroki);
    assert.notEqual(m1.wagi.szeroki.rzedy, m2.wagi.szeroki.rzedy);
    assert.notEqual(m1.wagi.sredni.rzedy, m2.wagi.sredni.rzedy);
    // Wartosci identyczne (kopia, nie inna mapa) - tylko tozsamosc obiektu inna.
    assert.deepEqual(m1, m2);
    // Mutacja jednego wyniku nie wyciekla do modulowej stalej / drugiego wywolania.
    m1.mapy.szeroki.push("intruz");
    m1.wagi.szeroki.rzedy.push(999);
    const m3 = mapaPulpitu(false);
    assert.deepEqual(m3, m2);
});

// ===== kolejnyAgent =====

test("kolejnyAgent: cykl null -> pierwszy -> ... -> null", () => {
    const lista = ["dexter", "sonny", "claudzik"];
    let aktualny = null;
    aktualny = kolejnyAgent(aktualny, lista);
    assert.equal(aktualny, "dexter");
    aktualny = kolejnyAgent(aktualny, lista);
    assert.equal(aktualny, "sonny");
    aktualny = kolejnyAgent(aktualny, lista);
    assert.equal(aktualny, "claudzik");
    aktualny = kolejnyAgent(aktualny, lista);
    assert.equal(aktualny, null);
});

test("kolejnyAgent: agent spoza listy -> traktowany jak null (wraca do pierwszego)", () => {
    assert.equal(kolejnyAgent("nieznany", ["dexter", "sonny"]), "dexter");
});

test("kolejnyAgent: pusta lista -> zawsze null", () => {
    assert.equal(kolejnyAgent(null, []), null);
    assert.equal(kolejnyAgent("dexter", []), null);
});

// ===== wierszyTodo (N2, 19.09) =====

test("wierszyTodo: wysokosc 0 -> min (1)", () => {
    assert.equal(wierszyTodo(0, 0, 30), 1);
});

test("wierszyTodo: dostepna wysokosc mniejsza niz jeden wiersz -> 1", () => {
    // tresc=40, chrome=20 -> dostepna=20, wierszPx=30 (20 < 30).
    assert.equal(wierszyTodo(40, 20, 30), 1);
});

test("wierszyTodo: dokladna wielokrotnosc wiersza -> dokladna liczba (nie o jeden mniej)", () => {
    // tresc=110, chrome=20 -> dostepna=90 = 3*30 dokladnie.
    assert.equal(wierszyTodo(110, 20, 30), 3);
});

test("wierszyTodo: o 1 px za malo na kolejny wiersz -> jeden mniej, NIGDY przyciety", () => {
    // tresc=109, chrome=20 -> dostepna=89 (1px za malo na 3*30=90) -> 2, nie 3.
    assert.equal(wierszyTodo(109, 20, 30), 2);
});

test("wierszyTodo: chrome wiekszy niz tresc (zdegenerowany uklad) -> min, nie ujemna", () => {
    assert.equal(wierszyTodo(10, 50, 30), 1);
});

test("wierszyTodo: wejscie nie-skonczone -> min", () => {
    assert.equal(wierszyTodo(NaN, 20, 30), 1);
    assert.equal(wierszyTodo(100, 20, NaN), 1);
    assert.equal(wierszyTodo(100, 20, 0), 1);
    assert.equal(wierszyTodo(100, 20, -5), 1);
});

test("wierszyTodo: chrome nie-skonczony (NaN/undefined) traktowany jak 0, nie wywala calosci", () => {
    assert.equal(wierszyTodo(90, NaN, 30), 3);
    assert.equal(wierszyTodo(90, undefined, 30), 3);
});

test("wierszyTodo: wlasny min (np. 3) respektowany, gdy dostepna wysokosc daje mniej", () => {
    assert.equal(wierszyTodo(0, 0, 30, 3), 3);
    // Dostepna wysokosc wystarcza na wiecej niz min - min nie ogranicza w gore.
    assert.equal(wierszyTodo(20 + 5 * 30, 20, 30, 3), 5);
});
