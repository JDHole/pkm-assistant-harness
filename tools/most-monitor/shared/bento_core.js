/**
 * @file bento_core.js - czysta logika siatki bento (zero fs, zero DOM, zero Obsidiana).
 *   Zamienia mape ASCII (tablica stringow, tokeny = nazwy kafli) na
 *   grid-template-areas + wymiary. Testowane czystym Node (bento_core.test.js).
 *   Render nad tym rdzeniem: components/shared/bento.js.
 * @agent dexter
 * @pracownia System HQ
 * @exports parsujMape, wybierzMape, mapaAuto, porownajZbiory, ileWierszy, udzialKafla, szablonTorow
 * @uses brak - funkcje czyste, dostaja dane od wolajacego (bento.js)
 * @reads nic (operuje wylacznie na argumentach)
 * @writes nic
 * @since 2026-09-13 B1 bento (spec: Dexter, wykonawca: sonnet)
 * @tests bento_core.test.js (node --test bento_core.test.js)
 */

"use strict";

const NAZWA_OK = /^[a-z0-9_-]+$/;

// Tokeny zarezerwowane przez CSS (grid-area/grid-template-areas nadaje im specjalne
// znaczenie) - jako nazwa kafla daloby cichy blad renderu, nie widoczny na etapie
// parsujMape. Lowercase, bo walidacja biegnie PO normalizacji wielkosci liter (nizej).
const ZAREZERWOWANE = new Set(["auto", "span", "none", "inherit", "initial", "unset", "revert", "revert-layer"]);

/**
 * Parsuje mape ASCII (tablica wierszy, tokeny rozdzielone spacjami = nazwy
 * kafli) na obszary siatki + template grid-template-areas.
 * @param {string[]} wiersze - rzedy mapy; kazdy wiersz = tokeny oddzielone spacjami.
 *   Ta sama nazwa w sasiednich komorkach = jeden kafel rozciagniety (prostokat).
 *   Token "." = dziura = BLAD (zasada: zero pustych pol).
 * @returns {{kolumny:number, rzedy:number, obszary:Object<string,{x:number,y:number,w:number,h:number}>,
 *   kolejnosc:string[], template:string, bledy:string[]}}
 *   Przy bledach: template = "", obszary = {} (nie zgaduj).
 */
function parsujMape(wiersze) {
    const bledy = [];
    const lista = Array.isArray(wiersze) ? wiersze : [];

    if (lista.length === 0) {
        bledy.push("pusta mapa");
        return { kolumny: 0, rzedy: 0, obszary: {}, kolejnosc: [], template: "", bledy };
    }

    // Tokenizacja + walidacja ksztaltu prostokatnego (ta sama liczba tokenow w kazdym rzedzie).
    // Lowercase PRZED walidacja/porownaniem - Kuba szkicuje mapy recznie, "Nawyki" i "nawyki"
    // maja byc tym samym obszarem (token "." zostaje "." - lowercase no-op).
    const siatka = lista.map(w => String(w == null ? "" : w).trim().split(/\s+/).filter(t => t.length > 0).map(t => t.toLowerCase()));
    const kolumny = siatka[0].length;
    if (kolumny === 0) {
        bledy.push("pusta mapa");
        return { kolumny: 0, rzedy: 0, obszary: {}, kolejnosc: [], template: "", bledy };
    }
    siatka.forEach((rzad, idx) => {
        if (rzad.length !== kolumny) {
            bledy.push(`rzad ${idx} ma ${rzad.length} tokenow, oczekiwano ${kolumny}`);
        }
    });
    if (bledy.length > 0) {
        return { kolumny: 0, rzedy: 0, obszary: {}, kolejnosc: [], template: "", bledy };
    }

    const rzedy = siatka.length;
    const kolejnosc = [];
    const obszary = {};

    // Zbierz komorki (x,y) na nazwe + sprawdz dziury i nazwy.
    for (let y = 0; y < rzedy; y++) {
        for (let x = 0; x < kolumny; x++) {
            const nazwa = siatka[y][x];
            if (nazwa === ".") {
                bledy.push(`dziura w (${x},${y})`);
                continue;
            }
            if (ZAREZERWOWANE.has(nazwa)) {
                bledy.push(`zarezerwowana nazwa '${nazwa}'`);
                continue;
            }
            if (!NAZWA_OK.test(nazwa)) {
                bledy.push(`niedozwolona nazwa '${nazwa}'`);
                continue;
            }
            if (!obszary[nazwa]) {
                obszary[nazwa] = { x, y, w: 0, h: 0, komorki: [] };
                kolejnosc.push(nazwa);
            }
            obszary[nazwa].komorki.push([x, y]);
        }
    }

    if (bledy.length > 0) {
        return { kolumny: 0, rzedy: 0, obszary: {}, kolejnosc: [], template: "", bledy };
    }

    // Zweryfikuj, ze kazdy obszar jest prostokatem (min/max x i y dajace dokladnie w*h komorek,
    // wszystkie faktycznie obecne).
    for (const nazwa of kolejnosc) {
        const obszar = obszary[nazwa];
        const xs = obszar.komorki.map(c => c[0]);
        const ys = obszar.komorki.map(c => c[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (obszar.komorki.length !== w * h) {
            bledy.push(`obszar ${nazwa} nie jest prostokatem`);
            continue;
        }
        // Sprawdzenie, ze wszystkie komorki prostokata naleza do tego obszaru (nie tylko liczba).
        const zbior = new Set(obszar.komorki.map(c => c[0] + "," + c[1]));
        let ok = true;
        for (let yy = minY; yy <= maxY && ok; yy++) {
            for (let xx = minX; xx <= maxX && ok; xx++) {
                if (!zbior.has(xx + "," + yy)) ok = false;
            }
        }
        if (!ok) {
            bledy.push(`obszar ${nazwa} nie jest prostokatem`);
            continue;
        }
        obszar.x = minX; obszar.y = minY; obszar.w = w; obszar.h = h;
        delete obszar.komorki;
    }

    if (bledy.length > 0) {
        return { kolumny: 0, rzedy: 0, obszary: {}, kolejnosc: [], template: "", bledy };
    }

    // Template grid-template-areas: jeden string wiersza w cudzyslowie na kazdy rzad.
    const template = siatka.map(rzad => `"${rzad.join(" ")}"`).join(" ");

    return { kolumny, rzedy, obszary, kolejnosc, template, bledy: [] };
}

/**
 * Wybiera mape (szeroki/sredni/waski) wg szerokosci .jd-bento w px.
 * @param {{szeroki:string[], sredni?:string[], waski?:string[]}} mapy
 * @param {number} szerokoscPx
 * @param {{sredni:number, waski:number}} [progi]
 * @returns {{klucz:("szeroki"|"sredni"|"waski"), wiersze:string[]}}
 */
const PROGI_DOMYSLNE = { sredni: 1400, waski: 1000 };

function wybierzMape(mapy, szerokoscPx, progi) {
    // Merge, nie zastapienie: progi CZESCIOWE (np. tylko { sredni: 1400 } bez
    // waski) nie moga zostawic drugiego progu jako `undefined` - kazde
    // porownanie `szer > undefined` jest `false`, wiec wszystko lecialoby w waski.
    const p = Object.assign({}, PROGI_DOMYSLNE, progi || {});
    const m = mapy || {};
    const szer = Number(szerokoscPx) || 0;

    if (szer > p.sredni) {
        return { klucz: "szeroki", wiersze: m.szeroki };
    }
    if (szer > p.waski) {
        if (m.sredni) return { klucz: "sredni", wiersze: m.sredni };
        return { klucz: "sredni", wiersze: mapaAuto(m.szeroki, 2) };
    }
    if (m.waski) return { klucz: "waski", wiersze: m.waski };
    return { klucz: "waski", wiersze: mapaAuto(m.szeroki, 1) };
}

/**
 * Generuje mape automatyczna z mapy szerokiej: obszary w kolejnosci pierwszego
 * wystapienia, `kolumny` na rzad. Ostatni niepelny rzad: OSTATNI obszar
 * rozciaga sie na reszte kolumn (zero dziur).
 * @param {string[]} wierszeSzerokie
 * @param {number} kolumny - <= 0 traktowane jako 1.
 * @returns {string[]} wiersze
 */
function mapaAuto(wierszeSzerokie, kolumny) {
    const k = Number(kolumny) > 0 ? Math.floor(Number(kolumny)) : 1;
    const parsed = parsujMape(wierszeSzerokie);
    const nazwy = parsed.kolejnosc;
    if (nazwy.length === 0) return [];

    const wiersze = [];
    for (let i = 0; i < nazwy.length; i += k) {
        const grupa = nazwy.slice(i, i + k);
        if (grupa.length < k) {
            // Ostatni niepelny rzad: ostatni obszar rozciaga sie na reszte kolumn.
            const ostatni = grupa[grupa.length - 1];
            while (grupa.length < k) grupa.push(ostatni);
        }
        wiersze.push(grupa.join(" "));
    }
    return wiersze;
}

/**
 * Porownuje zbior nazw kafli miedzy dwiema mapami (na WIERSZACH map, nie na
 * sparsowanych obszarach - wystarczy tokenizacja).
 * @param {string[]} mapaA
 * @param {string[]} mapaB
 * @returns {{brak:string[], nadmiar:string[]}} brak = nazwy z A nieobecne w B,
 *   nadmiar = nazwy z B nieobecne w A.
 */
function porownajZbiory(mapaA, mapaB) {
    const zbierz = (wiersze) => {
        const s = new Set();
        (Array.isArray(wiersze) ? wiersze : []).forEach(w => {
            String(w == null ? "" : w).trim().split(/\s+/).filter(t => t.length > 0 && t !== ".").forEach(t => s.add(t));
        });
        return s;
    };
    const a = zbierz(mapaA);
    const b = zbierz(mapaB);
    const brak = [...a].filter(n => !b.has(n));
    const nadmiar = [...b].filter(n => !a.has(n));
    return { brak, nadmiar };
}

/**
 * Ile wierszy listy zmiesci sie w danej wysokosci (do stronicowania w kaflu).
 * @param {number} wysokoscPx
 * @param {number} wierszPx - <= 0 traktowane jako `min`.
 * @param {number} [min=1]
 * @param {number} [max=Infinity]
 * @returns {number}
 */
function ileWierszy(wysokoscPx, wierszPx, min = 1, max = Infinity) {
    const w = Number(wierszPx);
    const h = Number(wysokoscPx);
    // Nie-skonczone wejscie (undefined/NaN/Infinity z ktoregokolwiek argumentu) ->
    // `min`, NIGDY NaN (Math.floor/Math.max/Math.min z NaN w argumencie dają NaN).
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h)) return min;
    const ile = Math.floor(h / w);
    return Math.max(min, Math.min(max, ile));
}

/**
 * Udzial kafla w siatce jako ulamek 0..1 szerokosci/wysokosci.
 * @param {{w:number, h:number}} obszar
 * @param {number} kolumny
 * @param {number} rzedy
 * @returns {{szer:number, wys:number}}
 */
function udzialKafla(obszar, kolumny, rzedy) {
    const o = obszar || { w: 0, h: 0 };
    const k = Number(kolumny) || 1;
    const r = Number(rzedy) || 1;
    return { szer: o.w / k, wys: o.h / r };
}

/**
 * Szablon torow (grid-template-rows/columns) z wag - "1fr 3fr 3fr" zamiast
 * jednakowych torow. Zero zgadywania: kazde odejscie od "tablica n liczb > 0"
 * (brak, zla dlugosc, liczba <= 0/NaN gdziekolwiek) spada na ten sam fallback
 * co domyslny CSS `.jd-bento` (`repeat(n, minmax(0, 1fr))`), zeby przelaczanie
 * map nigdy nie zostawialo "dziurawych" wag z poprzedniego builda.
 * @param {number[]} wagi - tablica liczb dodatnich, dlugosc == n.
 * @param {number} n - liczba torow (kolumn albo rzedow) z parsujMape.
 * @returns {string} np. "1fr 3fr 3fr" albo "repeat(3, minmax(0, 1fr))"
 */
function szablonTorow(wagi, n) {
    const liczbaTorow = Number(n) > 0 ? Math.floor(Number(n)) : 0;
    const fallback = `repeat(${liczbaTorow}, minmax(0, 1fr))`;
    if (!Array.isArray(wagi) || wagi.length !== liczbaTorow) return fallback;
    for (let i = 0; i < wagi.length; i++) {
        const w = Number(wagi[i]);
        if (!Number.isFinite(w) || w <= 0) return fallback;
    }
    return wagi.map(w => `${Number(w)}fr`).join(" ");
}

module.exports = { parsujMape, wybierzMape, mapaAuto, porownajZbiory, ileWierszy, udzialKafla, szablonTorow };
