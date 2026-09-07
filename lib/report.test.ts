/**
 * report.test.ts - strażnik czujnika harnessa (AUD-bledy-033, AUD-bledy-039).
 *
 * Dwa inwarianty, które przed 2026-08-23 nie trzymały:
 *  1. werdykt DoD FAZY B ma DOKĄD polecieć - kod wyjścia biegu i `--json`.ok liczą się
 *     z TEJ SAMEJ mapy DoD (`buildDod` -> `dodToExitCode`), więc czerwone DoD nie może
 *     wyjść zerem ani zameldować `ok:true`;
 *  2. raport nie wnioskuje „model nie użył narzędzi" z BRAKU trace - brak danych to brak
 *     danych, nie obserwacja.
 *
 * Import przez przestrzeń nazw (`* as report`) jest CELOWY: gdy któraś funkcja zniknie,
 * strażnik ma paść na czytelnej asercji, a nie na linkowaniu modułu (brakujący named export
 * to SyntaxError, który ubija cały plik testowy razem z pozostałymi asercjami).
 */
import test from 'ava';
import * as report from './report.js';
import type { ReportContext, TraceEvent, TraceSummary } from './report.js';

const EMPTY_SUMMARY: TraceSummary = {
    loopStarted: false,
    toolPosts: [],
    modelDones: [],
    blocked: [],
    stoppedBy: null,
    iters: null,
    totalMs: null,
    backstopAfter: null,
};

const ev = (type: string, fields = ''): TraceEvent => ({ type, fields, raw: `[trace] harness/turn | ${type} | ${fields}` });

/** Wpis `toolCallDetails` w zakresie, jaki czyta `readToolFailed` (patrz `report.ts`). */
interface ToolCallDetailLike {
    name?: string;
    resultPreview?: string;
}

interface CtxOptions {
    events?: TraceEvent[];
    summary?: Partial<TraceSummary>;
    finalText?: string;
    toolsUsed?: string[];
    toolCallDetails?: ToolCallDetailLike[];
}

/**
 * Domyślny finalText jest CELOWO >=40 znaków (F2.9 próg `MIN_FINAL_TEXT_LENGTH`) - fixture'y,
 * które nie override'ują finalText/toolsUsed (np. `greenCtx`), mają przedstawiać ZDROWY bieg,
 * a nie przypadkiem łapać się na nowej bramce przez zbyt krótki tekst domyślny.
 */
const DEFAULT_FINAL_TEXT = 'Przeczytałem notatkę i przygotowałem krótkie podsumowanie treści.';

/** Kontekst raportu bez bootowania pluginu - dokładnie to, co dostaje `buildTextReport`/`buildJsonReport`. */
function makeCtx({ events = [], summary = {}, finalText = DEFAULT_FINAL_TEXT, toolsUsed = [], toolCallDetails = [] }: CtxOptions = {}): ReportContext {
    return {
        turn: {
            result: {
                finalText,
                toolsUsed,
                toolCallDetails,
                usage: {},
                iterations: 1,
                stoppedBy: 'natural',
            },
            agent: { name: 'Tester' },
            model: { modelKey: 'deepseek-chat' },
            systemPrompt: '',
            autonomy: 'edge',
            chunkCount: 3,
            approvals: [],
            traceLabel: 'harness/turn',
            toolCount: 7,
        },
        traceSummary: { ...EMPTY_SUMMARY, ...summary },
        traceEvents: events,
        tempVault: 'C:/temp/pkm-harness/x',
        tracePath: 'C:/temp/pkm-harness/x/.pkm-assistant/logs/trace.log',
        keepVault: false,
        offline: true,
    } as unknown as ReportContext;
}

/** Zdrowy bieg: trace ma loop.start i loop.end, żadnego tool.post (model odpowiedział tekstem). */
const greenCtx = (): ReportContext => makeCtx({
    events: [ev('loop.start', 'agent=Tester'), ev('loop.end', 'stop=natural iters=1 total_ms=1200')],
    summary: { loopStarted: true, stoppedBy: 'natural', iters: 1, totalMs: 1200 },
});

/** Bieg bez trace (traceEnabled:false / brak pliku / inna etykieta) - model coś jednak zrobił. */
const noTraceCtx = (): ReportContext => makeCtx({ toolsUsed: ['read'] });

test('dodToExitCode: wszystkie pozycje PASS ⇒ 0', t => {
    t.is(typeof report.dodToExitCode, 'function', 'report.ts nie eksportuje dodToExitCode');
    const dod = report.buildDod(greenCtx());
    t.deepEqual(Object.entries(dod).filter(([, v]) => !v.pass).map(([k]) => k), []);
    t.is(report.dodToExitCode(dod), 0);
});

test('dodToExitCode: choć jeden FAIL ⇒ 1', t => {
    const dod = report.buildDod(noTraceCtx());
    t.true(Object.values(dod).some(v => !v.pass), 'bieg bez trace powinien mieć czerwone pozycje');
    t.is(report.dodToExitCode(dod), 1);
});

test('buildDod: pozycje z trace przy jego braku = FAIL z powodem, nie cichy PASS', t => {
    const dod = report.buildDod(noTraceCtx());
    for (const k of ['loop.start w trace', 'stoppedBy z trace', 'loop.end obecny']) {
        t.false(dod[k].pass, k);
        t.regex(dod[k].reason || '', /trace niedostępny/, k);
    }
    t.true(dod['finalText niepusty'].pass, 'finalText nie zależy od trace');
});

test('buildJsonReport: czerwone DoD ⇒ ok:false (pole liczone, nie stała)', t => {
    t.false(report.buildJsonReport(noTraceCtx()).ok);
    t.true(report.buildJsonReport(greenCtx()).ok);
});

test('buildJsonReport: ok jest spójne z kodem wyjścia (ok ⇔ exit 0)', t => {
    for (const ctx of [greenCtx(), noTraceCtx()]) {
        const json = report.buildJsonReport(ctx);
        t.is(json.ok, report.dodToExitCode(report.buildDod(ctx)) === 0);
    }
});

test('buildTextReport: brak trace ⇒ „trace niedostępny", bez tezy o odpowiedzi tekstem', t => {
    const txt = report.buildTextReport(noTraceCtx());
    t.true(txt.includes('trace niedostępny'), 'raport ma przyznać, że nie ma z czego czytać przebiegu');
    t.false(txt.includes('odpowiedział tekstem od razu'), 'to teza o przebiegu, a przebiegu nie widać');
});

test('buildTextReport: trace jest, ale zero tool.post ⇒ teza o odpowiedzi tekstem zostaje', t => {
    const txt = report.buildTextReport(greenCtx());
    t.true(txt.includes('odpowiedział tekstem od razu'));
    t.false(txt.includes('trace niedostępny'));
});

// ─── AUD-testy-029: DoD FAZY B patrzy też na WYNIK narzędzia `read`, nie tylko na to, że pętla
// wystartowała/skończyła. Do tej naprawy `read` zwracające `{success:false}` (zepsute NARZĘDZIE,
// nie odmowa uprawnień — zwykły `catch` w środku `execute`) zostawiało cały DoD zielony, bo żadna
// z czterech pozycji nie patrzyła na TREŚĆ wyniku, tylko na obecność zdarzeń trace (`loopStarted`/
// `stoppedBy`/`totalMs`) i na niepusty `finalText` — a fake-serwer selftestu i tak oddaje w turze 1
// gotowy tekst NIEZALEŻNIE od tego, co zwróciło narzędzie w turze 0.

const traceOkEvents = (): TraceEvent[] => [ev('loop.start', 'agent=Tester'), ev('loop.end', 'stop=natural iters=1 total_ms=1200')];
const traceOkSummary: Partial<TraceSummary> = { loopStarted: true, stoppedBy: 'natural', iters: 1, totalMs: 1200 };
const READ_DOD_KEY = 'narzędzie "read" bez błędu (gdy wywołane)';

test('buildDod: read zwraca sukces ⇒ nowa pozycja PASS, DoD w całości zielone', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        toolCallDetails: [{ name: 'read', resultPreview: '{"success":true,"content":"Witaj w vaultcie","path":"Notatki/powitanie.md"}' }],
    }));
    t.true(dod[READ_DOD_KEY].pass);
    t.is(report.dodToExitCode(dod), 0);
});

test('AUD-testy-029: read zwraca błąd (isError:true) ⇒ pozycja FAIL, exit != 0 — zepsuty read już NIE przechodzi bramki', t => {
    const ctx = makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        // Kształt normalizacji MCPClient (8b, AUD-bledy-027/058/025): `isError:true` dokładane
        // KAŻDEMU nieudanemu wynikowi wbudowanego narzędzia, obok oryginalnych `success`/`error`.
        toolCallDetails: [{ name: 'read', resultPreview: '{"success":false,"error":"MUTACJA AUDYTU: read padl","isError":true}' }],
    });
    const dod = report.buildDod(ctx);
    t.false(dod[READ_DOD_KEY].pass);
    t.regex(dod[READ_DOD_KEY].reason || '', /MUTACJA AUDYTU: read padl/);
    t.is(report.dodToExitCode(dod), 1);
    t.false(report.buildJsonReport(ctx).ok);
});

test('buildDod: read NIE wywołane (inny prompt/narzędzie) ⇒ pozycja PASS wprost — bieg bez read nie ma prawa fałszywie polec', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        toolCallDetails: [{ name: 'write', resultPreview: '{"success":true,"path":"Notatki/nowa.md"}' }],
    }));
    t.true(dod[READ_DOD_KEY].pass, 'generyczny bieg eksploracyjny bez read nie może polec na tej pozycji');
    t.is(report.dodToExitCode(dod), 0);
});

test('buildDod: słowo "error" W TREŚCI notatki nie myli się z realnym isError:true (klucz na TOKENIE JSON, nie na słowach — AUD-testy-028 ta sama pułapka)', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        toolCallDetails: [{ name: 'read', resultPreview: '{"success":true,"content":"Jak naprawić error w skrypcie","path":"Notatki/log.md"}' }],
    }));
    t.true(dod[READ_DOD_KEY].pass, 'słowo "error" w TREŚCI notatki to nie sygnał porażki narzędzia');
});

// ─── F2.9 (rejestr ryzyk 01.09): 'finalText niepusty' dawniej przechodziło na `length > 0` —
// jeden token ("Po", "OK", "Gotowe.") wystarczał za zielony DoD, bez śladu, że model w ogóle
// zajął się zleconą robotą. Bramka teraz wymaga DŁUGOŚCI (>= MIN_FINAL_TEXT_LENGTH, patrz
// `report.ts`) ALBO choć jednej próby narzędzia — reużywając TEGO SAMEGO sygnału strukturalnego
// co `isNoAttemptRun` z `harness/scenarios/_asserts.ts` (nie duplikat: import wprost).

const FINAL_TEXT_DOD_KEY = 'finalText niepusty';

test('F2.9: jednotokenowa odpowiedź bez ŻADNEJ próby narzędzia ⇒ FAIL, powód cytuje odpowiedź i mówi wprost o braku próby', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        finalText: 'Po', toolsUsed: [], toolCallDetails: [],
    }));
    t.false(dod[FINAL_TEXT_DOD_KEY].pass);
    t.regex(dod[FINAL_TEXT_DOD_KEY].reason || '', /"Po"/, 'powód ma zacytować odpowiedź modelu');
    t.regex(dod[FINAL_TEXT_DOD_KEY].reason || '', /żadnej próby narzędzia/, 'powód ma wprost powiedzieć, że narzędzia nie było');
    t.is(report.dodToExitCode(dod), 1);
});

test('F2.9: DŁUGA odpowiedź (≥40 zn.) bez narzędzi ⇒ PASS — treść sama wystarcza, narzędzie niepotrzebne', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        finalText: 'To jest wystarczająco długa odpowiedź modelu, więc bramka ma prawo przejść.',
        toolsUsed: [], toolCallDetails: [],
    }));
    t.true(dod[FINAL_TEXT_DOD_KEY].pass);
    t.is(report.dodToExitCode(dod), 0);
});

test('F2.9: KRÓTKA odpowiedź, ale choć jedna próba narzędzia (nawet ODBITA/nieudana) ⇒ PASS', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        finalText: 'OK',
        // `write`, nie `read` — żeby nie mieszać z osobną pozycją „read bez błędu". `isError:true`
        // = próba ODBITA (odmowa/porażka), a mimo to LICZY SIĘ jako próba: `isNoAttemptRun`
        // patrzy strukturalnie na obecność wpisu, nie na jego wynik.
        toolCallDetails: [{ name: 'write', resultPreview: '{"success":false,"error":"odmowa","isError":true}' }],
    }));
    t.true(dod[FINAL_TEXT_DOD_KEY].pass, 'próba narzędzia (nawet odbita) wystarcza, niezależnie od długości finalText');
    t.is(report.dodToExitCode(dod), 0);
});

test('F2.9: brak `result` w ogóle (turn.result undefined) ⇒ FAIL z powodem, nie wyjątek', t => {
    const ctx = {
        turn: {
            result: undefined,
            agent: { name: 'Tester' },
            model: { modelKey: 'deepseek-chat' },
            systemPrompt: '',
            autonomy: 'edge',
            chunkCount: 0,
            approvals: [],
            traceLabel: 'harness/turn',
            toolCount: 7,
        },
        traceSummary: { ...EMPTY_SUMMARY, ...traceOkSummary },
        traceEvents: traceOkEvents(),
        tempVault: 'C:/temp/pkm-harness/x',
        tracePath: 'C:/temp/pkm-harness/x/.pkm-assistant/logs/trace.log',
        keepVault: false,
        offline: true,
    } as unknown as ReportContext;
    const dod = report.buildDod(ctx);
    t.false(dod[FINAL_TEXT_DOD_KEY].pass);
    t.truthy(dod[FINAL_TEXT_DOD_KEY].reason);
    t.is(report.dodToExitCode(dod), 1);
});

// ─── W6-01 (review fali 2, 2026-09-04): `attemptedTool` w selftescie jest PRAWIE ZAWSZE true
// (fake-serwer w turze 0 zawsze woła `read` na Notatki/powitanie.md), więc stary warunek
// `(len >= próg || attemptedTool)` przepuszczał kompletnie PUSTY finalText jako zielony, gdy
// tylko jakiekolwiek narzędzie zostało wywołane wcześniej (np. `finalize()` z gałęzi `abort` w
// AgentLoop.ts, która zwraca `finalText: text || ''`). Pozycja miała nazwę „niepusty", ale nie
// egzekwowała jej wcale. Fix: pusty finalText jest teraz warunkiem koniecznym FAIL, NIEZALEŻNIE
// od tego, czy próba narzędzia była.

test('W6-01: pusty finalText + niepusta próba narzędzia (toolCallDetails) ⇒ FAIL, nie cichy PASS', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        finalText: '',
        toolCallDetails: [{ name: 'read', resultPreview: '{"success":true,"content":"Witaj w vaultcie","path":"Notatki/powitanie.md"}' }],
    }));
    t.false(dod[FINAL_TEXT_DOD_KEY].pass, 'pusty finalText nie ma prawa przejść, nawet gdy narzędzie było wywołane i się powiodło');
    t.regex(dod[FINAL_TEXT_DOD_KEY].reason || '', /pusty finalText/, 'powód ma wprost nazwać przyczynę');
    t.is(report.dodToExitCode(dod), 1);
});

test('W6-01: pusty finalText + niepuste toolsUsed (bez toolCallDetails) ⇒ FAIL', t => {
    const dod = report.buildDod(makeCtx({
        events: traceOkEvents(), summary: traceOkSummary,
        finalText: '',
        toolsUsed: ['read'],
    }));
    t.false(dod[FINAL_TEXT_DOD_KEY].pass);
    t.is(report.dodToExitCode(dod), 1);
});
