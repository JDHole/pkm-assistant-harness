/**
 * _asserts.js — helpery asercji dla scenariuszy-łamaczy (S26 FAZA C).
 *
 * Dwa rodzaje funkcji:
 *   1. PARSERY (czyste): `parseTrace`, `loopEnd`, `toolPosts`, `toolResult` — czytają trace/wynik.
 *   2. ASERCJE (rzucające `AssertionError` z polskim komunikatem): `assertTraceHas/Lacks`,
 *      `fileExists/Absent/Unchanged`, `assertToolErrored/Ok` itd.
 *
 * Asercje RZUCAJĄ na pierwszym niepowodzeniu — runner łapie i raportuje komunikat + dowód
 * (fragment trace + stan fs). Inwarianty > słowa modelu (H4): sprawdzamy „plik powstał/nie",
 * „pętla stanęła jak trzeba", „blokada zadziałała", NIE treść odpowiedzi.
 */
import fs from 'fs';
import path from 'path';

// TS-any: payloady trace/wyniku i fixture scenariuszy są otwarte, składane przez produkcyjny harness runtime.
export type FixturePayload = any;
export type TraceFields = Record<string, string>;
export type TraceEvent = { type: string; fields: TraceFields; raw: string };
export type TraceEvents = TraceEvent[];
export type Scenario = {
  asserts(ctx: FixturePayload): FixturePayload;
  offlineScript?: FixturePayload;
  setup?: (ctx: FixturePayload) => FixturePayload;
  [key: string]: FixturePayload;
};

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

let checkCount = 0;

export function resetCheckCount(): void {
  checkCount = 0;
}

export function getCheckCount(): number {
  return checkCount;
}

function countCheck(): void {
  checkCount++;
}

export function fail(msg: string): never {
  countCheck();
  throw new AssertionError(msg);
}

export function assert(cond: unknown, msg: string): asserts cond {
  countCheck();
  if (!cond) fail(msg);
}

// ─── Trace: parsowanie ──────────────────────────────────────────────────────

/** Zamień "k1=v1 k2=v2" na obiekt. Wartości ze spacjami (np. args) doklejane do ostatniego klucza. */
function parseFields(fieldsStr: string): TraceFields {
  const out: TraceFields = {};
  if (!fieldsStr) return out;
  let lastKey = null;
  for (const tok of fieldsStr.split(' ')) {
    const eq = tok.indexOf('=');
    if (eq > 0 && /^\w+$/.test(tok.slice(0, eq))) {
      lastKey = tok.slice(0, eq);
      out[lastKey] = tok.slice(eq + 1);
    } else if (lastKey != null) {
      out[lastKey] += ` ${tok}`;
    }
  }
  return out;
}

/**
 * Sparsuj trace.log do listy zdarzeń dla danego labelu.
 * Format linii: `[ts] [INFO] [trace] <label> | <type> | k=v k=v`.
 *
 * `opts.prefix` (Poligon F2) dopuszcza etykiety Z IDENTYFIKATOREM WYWOŁANIA: zapytanie o
 * `sub/pkm-sub` łapie też `sub/pkm-sub#3`, ale NIE `sub/pkm-subtelny` (dopasowanie kończy się
 * na `#`). Bez flagi — dopasowanie dokładne, jak dotąd.
 *
 * @param {string} pathOrContent - ścieżka do trace.log ALBO surowa treść (jeśli zawiera `\n[`)
 * @param {string} label - etykieta scope (np. `harness/Tester#12-00-00`)
 * @param {{prefix?: boolean}} [opts] - `prefix: true` → dopuść sufiks `#<id wywołania>`
 * @returns {Array<{type:string, fields:Object, raw:string}>}
 */
export function parseTrace(pathOrContent: string, label: string, opts: { prefix?: boolean } = {}): TraceEvents {
  let content = '';
  if (typeof pathOrContent === 'string' && pathOrContent.includes('\n')) {
    content = pathOrContent;
  } else {
    try { content = fs.readFileSync(pathOrContent, 'utf8'); } catch { content = ''; }
  }
  const events: TraceEvents = [];
  const head = '[trace] ';
  for (const line of content.split('\n')) {
    const pos = line.indexOf(head);
    if (pos === -1) continue;
    const segs = line.slice(pos + head.length).split(' | ');
    const lineLabel = segs[0];
    if (lineLabel !== label && !(opts.prefix && lineLabel.startsWith(`${label}#`))) continue;
    events.push({ type: segs[1], fields: parseFields(segs[2] || ''), raw: line });
  }
  return events;
}

/** Jedno miejsce z relatywną ścieżką pliku trace (ta sama, którą runner podaje do `parseTrace`). */
const TRACE_LOG_REL = '.pkm-assistant/logs/trace.log';

/**
 * Zdarzenia trace spod etykiety SUB-AGENTA (`sub/<nazwa>`).
 *
 * PO CO OSOBNY HELPER: `ctx.trace` runnera niesie WYŁĄCZNIE etykietę pętli głównej — każda pętla
 * sub-agenta pisze pod własnym scope. Trzeba więc czytać plik trace wprost, a wcześniej wymusić
 * flush sinka (sub domyka się chwilę przed asercją, jego linie mogą jeszcze siedzieć w buforze).
 * Trzy scenariusze miały po własnej kopii tego kodu.
 *
 * ⚠️ Dopasowanie jest PREFIKSOWE (Poligon F2): etykieta suba niesie numer wywołania
 * (`sub/pkm-sub#3`), żeby dało się rozdzielić N równoległych workerów z jednego `delegate`.
 * Zapytanie o nazwę zwraca zdarzenia WSZYSTKICH jej wywołań — kto liczy przebiegi, liczy
 * `loop.start`/`loop.end`, nie linie.
 *
 * @param {Object} ctx - kontekst asercji (`{plugin, vaultRoot}`); bez `plugin` po prostu brak flushu
 * @param {string} subName - NAZWA suba BEZ prefiksu (helper dokleja `sub/`)
 */
export async function subTraceEvents(ctx: FixturePayload, subName: string): Promise<TraceEvents> {
  try { await ctx?.plugin?.traceLog?.sink?.flush?.(); } catch { /* best-effort */ }
  return parseTrace(path.join(String(ctx?.vaultRoot ?? ''), TRACE_LOG_REL), `sub/${subName}`, { prefix: true });
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Zdarzenia `tool.post` znormalizowane (i/chars/blocks/batch_ms jako liczby). */
export function toolPosts(events: TraceEvents) {
  return events.filter((e) => e.type === 'tool.post').map((e) => ({
    i: num(e.fields.i),
    tool: e.fields.tool,
    status: e.fields.status,
    chars: e.fields.chars != null ? num(e.fields.chars) : null,
    blocks: e.fields.blocks != null ? num(e.fields.blocks) : null,
    batch_ms: num(e.fields.batch_ms),
  }));
}

/** Ostatnie `loop.end` → {stop, iters, total_ms}. Null gdy brak. */
export function loopEnd(events: TraceEvents) {
  const ends = events.filter((e) => e.type === 'loop.end');
  if (ends.length === 0) return null;
  const f = ends[ends.length - 1].fields;
  return { stop: f.stop, iters: num(f.iters), total_ms: num(f.total_ms) };
}

/** Indeks pierwszego zdarzenia danego typu (−1 gdy brak). */
export function traceIndexOf(events: TraceEvents, type: string): number {
  return events.findIndex((e) => e.type === type);
}

// ─── Trace: asercje ─────────────────────────────────────────────────────────

/**
 * Zdarzenie typu `type` spełniające `predicate` MUSI istnieć.
 * @param {Array} events
 * @param {string} type
 * @param {(fields:Object)=>boolean} [predicate]
 * @param {string} [msg]
 */
export function assertTraceHas(events: TraceEvents, type: string, predicate: ((fields: TraceFields) => boolean) | null = null, msg: string | null = null): void {
  countCheck();
  const found = events.some((e) => e.type === type && (!predicate || predicate(e.fields)));
  if (!found) {
    fail(msg || `Oczekiwano zdarzenia trace "${type}"${predicate ? ' spełniającego warunek' : ''}, ale go nie ma.`);
  }
}

/** Zdarzenie typu `type` spełniające `predicate` NIE MOŻE istnieć. */
export function assertTraceLacks(events: TraceEvents, type: string, predicate: ((fields: TraceFields) => boolean) | null = null, msg: string | null = null): void {
  countCheck();
  const found = events.some((e) => e.type === type && (!predicate || predicate(e.fields)));
  if (found) {
    fail(msg || `Zdarzenie trace "${type}" wystąpiło, a NIE powinno.`);
  }
}

/** Znajdź `tool.post` po nazwie (i opcjonalnie statusie). Rzuca gdy brak. */
export function assertToolPost(events: TraceEvents, toolName: string, status: string | null = null, msg: string | null = null) {
  countCheck();
  const posts = toolPosts(events).filter((p) => p.tool === toolName && (status == null || p.status === status));
  if (posts.length === 0) {
    const seen = toolPosts(events).map((p) => `${p.tool}:${p.status}`).join(', ') || '(brak)';
    fail(msg || `Brak tool.post dla "${toolName}"${status ? ` ze statusem ${status}` : ''}. Widziane: ${seen}`);
  }
  return posts;
}

// ─── Wynik pętli (runAgentLoop) ─────────────────────────────────────────────

/** Znajdź wpis toolCallDetails po nazwie (ostatni, jeśli wiele). Null gdy brak. */
export function toolResult(result: FixturePayload, toolName: string): FixturePayload | null {
  const details = Array.isArray(result?.toolCallDetails) ? result.toolCallDetails : [];
  const matches = details.filter((d: FixturePayload) => d.name === toolName);
  return matches.length ? matches[matches.length - 1] : null;
}

/** Podgląd wyniku narzędzia (resultPreview) jako string. '' gdy brak. */
export function toolResultText(result: FixturePayload, toolName: string): string {
  return toolResult(result, toolName)?.resultPreview || '';
}

/**
 * Werdykt Kuby 2026-09-02: KAŻDY scenariusz na żywym modelu ma sam rozpoznać bieg, w którym
 * model nie podjął ŻADNEJ próby narzędzia (do tej pory umiał to tylko `03_izolacja_pkm`, i to
 * per-narzędziowo). Taki bieg niczego nie dowodzi — ani że mechanizm działa, ani że pękł —
 * więc nie może liczyć się jako RED (fałszywe znalezisko) ani GREEN (fałszywy sukces).
 * Runner woła to PRZED `asserts()` (tylko `--live`) i nadaje osobny status `NO_ATTEMPT`.
 *
 * Sygnał STRUKTURALNY z wyniku pętli (`RunAgentLoopResult`): `toolsUsed` (nazwa dopisywana
 * przy wywołaniu) i `toolCallDetails` (wpis dopisywany po wykonaniu). Oba puste = model nie
 * zawołał niczego. Nie czytamy słów modelu ani NIEOBECNOŚCI trace (lekcja `report.test.ts`:
 * brak danych ≠ zaobserwowane nieużycie).
 */
export function isNoAttemptRun(result: FixturePayload): boolean {
  const used = Array.isArray(result?.toolsUsed) ? result.toolsUsed : [];
  const details = Array.isArray(result?.toolCallDetails) ? result.toolCallDetails : [];
  return used.length === 0 && details.length === 0;
}

export const NO_ATTEMPT_MESSAGE =
  'Żywy model nie podjął ŻADNEJ próby narzędzia — bieg niczego nie dowodzi (ani sukcesu, ani porażki mechanizmu).';

/**
 * AUD-testy-028: TWARDY sygnał porażki narzędzia — token STRUKTURALNY, nie słowo z treści.
 * `MCPClient.executeToolCall` dokłada `isError:true` KAŻDEMU nieudanemu wynikowi, dla
 * WSZYSTKICH narzędzi wbudowanych, jednym punktem normalizacji (8b, AUD-bledy-027/058/025;
 * `core/utils/toolResultStatus.ts` — patrz `modules/tools/MCPClient.ts`). Ten znacznik pokrywa
 * WSZYSTKIE drogi porażki: `{success:false}` narzędzi wbudowanych, `{isError:true}` własne
 * artefaktów/external MCP, i denial/permission `throw` złapany we WŁASNYM catchu klienta
 * (`MCPClient` w praktyce nigdy nie oddaje wyjątku dalej — patrz `harness/README.md`, sekcja
 * „Trace"). Token ląduje w `resultPreview` (pierwsze 500 znaków wyniku), a pole `isError` leży
 * blisko początku serializowanego obiektu — mieści się w oknie podglądu.
 *
 * Dawny kształt tej stałej dopuszczał alternatywę PO SŁOWACH z treści wyniku (`no-?go`,
 * `workspace`, `outside`, `denied`, …) — więc UDANY odczyt notatki, której treść PRZYPADKIEM
 * zawiera jedno z tych słów (np. frontmatter `tagi: [harness, no-go]` notatki-rekwizytu), mylił
 * się z odmową: `assertToolErrored` przepuszczał sukces za blokadę, a `assertToolOk` wywalał
 * fałszywą czerwień na udanym wyniku ze słowem „workspace"/„not_found" w treści.
 */
const HARD_ERROR_SIGNAL = /"isError"\s*:\s*true/;

/** Czy `resultPreview` narzędzia niesie TWARDY sygnał porażki (`isError:true`). Eksportowana,
 *  żeby scenariusze, które same iterują `toolCallDetails` (np. wiele wywołań tego samego
 *  narzędzia — wzór `42_sciezka_kanoniczna`), kluczowały na TYM SAMYM sygnale co `_asserts.ts`,
 *  zamiast trzymać własną, rozjeżdżającą się kopię regexa. */
export function hasToolErrorSignal(text: string): boolean {
  return HARD_ERROR_SIGNAL.test(text);
}

/**
 * Narzędzie `toolName` MUSI mieć wynik-błąd (blokada/odmowa/porażka) — klucz na `isError:true`.
 * `needle` zostaje jako DODATKOWY, opcjonalny warunek: scenariusz, który chce doprecyzować
 * POWÓD odmowy (konkretny komunikat/kod), podaje własny wzorzec — ale sam nie decyduje o tym,
 * czy wynik JEST błędem (wzór 05/06/07/36: `assertToolErrored(result, 'write', /outside|.../)`).
 * @param {Object} result - wynik runAgentLoop
 * @param {string} toolName
 * @param {RegExp} [needle] - dodatkowy wymagany wzorzec w treści wyniku
 */
export function assertToolErrored(result: FixturePayload, toolName: string, needle: RegExp | null = null): FixturePayload {
  countCheck();
  const tr = toolResult(result, toolName);
  if (!tr) fail(`Oczekiwano wywołania narzędzia "${toolName}", ale go nie było.`);
  const text = tr.resultPreview || '';
  if (!hasToolErrorSignal(text)) {
    fail(`Narzędzie "${toolName}" NIE zwróciło błędu/blokady (oczekiwano isError:true). Wynik: ${clip(text)}`);
  }
  if (needle && !needle.test(text)) {
    fail(`Wynik "${toolName}" nie pasuje do wzorca ${needle}. Wynik: ${clip(text)}`);
  }
  return tr;
}

/** Narzędzie `toolName` MUSI mieć wynik-sukces (brak `isError:true`). */
export function assertToolOk(result: FixturePayload, toolName: string, needle: RegExp | null = null): FixturePayload {
  countCheck();
  const tr = toolResult(result, toolName);
  if (!tr) fail(`Oczekiwano wywołania narzędzia "${toolName}", ale go nie było.`);
  const text = tr.resultPreview || '';
  if (hasToolErrorSignal(text)) {
    fail(`Narzędzie "${toolName}" zwróciło błąd, a oczekiwano sukcesu. Wynik: ${clip(text)}`);
  }
  if (needle && !needle.test(text)) {
    fail(`Wynik "${toolName}" nie pasuje do wzorca ${needle}. Wynik: ${clip(text)}`);
  }
  return tr;
}

/** finalText pętli MUSI być niepusty. */
export function assertFinalText(result: FixturePayload, msg: string | null = null): string {
  countCheck();
  const t = (result?.finalText || '').trim();
  if (t.length === 0) fail(msg || 'finalText jest pusty (oczekiwano odpowiedzi modelu).');
  return t;
}

/** finalText NIE MOŻE zawierać danego wzorca (np. treści sekretu). */
export function assertFinalTextLacks(result: FixturePayload, needle: RegExp, msg: string | null = null): void {
  countCheck();
  const t = result?.finalText || '';
  if (needle.test(t)) fail(msg || `finalText zawiera zakazany wzorzec ${needle}.`);
}

// ─── System plików vaulta ───────────────────────────────────────────────────

function abs(vaultRoot: string, rel: string): string {
  return path.join(vaultRoot, String(rel).replace(/\\/g, '/'));
}

/** Czy plik istnieje w vaulcie. */
export function exists(vaultRoot: string, rel: string): boolean {
  return fs.existsSync(abs(vaultRoot, rel));
}

/** Plik MUSI istnieć. */
export function fileExists(vaultRoot: string, rel: string, msg: string | null = null): void {
  countCheck();
  if (!exists(vaultRoot, rel)) fail(msg || `Plik "${rel}" MIAŁ powstać, ale go nie ma.`);
}

/** Plik NIE MOŻE istnieć. */
export function fileAbsent(vaultRoot: string, rel: string, msg: string | null = null): void {
  countCheck();
  if (exists(vaultRoot, rel)) fail(msg || `Plik "${rel}" ISTNIEJE, a NIE powinien (blokada nie zadziałała).`);
}

/** Odczytaj plik vaulta (rzuca gdy brak). */
export function readVaultFile(vaultRoot: string, rel: string): string {
  countCheck();
  const p = abs(vaultRoot, rel);
  if (!fs.existsSync(p)) fail(`Nie mogę odczytać "${rel}" — plik nie istnieje.`);
  return fs.readFileSync(p, 'utf8');
}

/** Migawka pliku {rel, exists, content, mtimeMs} — do porównania przed/po. */
export function snapshot(vaultRoot: string, rel: string) {
  const p = abs(vaultRoot, rel);
  try {
    const st = fs.statSync(p);
    return { rel, exists: true, content: fs.readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs };
  } catch {
    return { rel, exists: false, content: null, mtimeMs: null };
  }
}

/**
 * Plik MUSI być nietknięty względem migawki `before` (treść ORAZ mtime).
 * @param {Object} before - migawka z `snapshot()` (albo mapa {rel: snapshot})
 * @param {string} vaultRoot
 * @param {string} rel
 */
export function fileUnchanged(before: FixturePayload, vaultRoot: string, rel: string, msg: string | null = null): void {
  countCheck();
  const snap = before && before.rel === rel ? before : (before && before[rel]) || null;
  if (!snap) fail(`Brak migawki „przed" dla "${rel}" — nie mogę sprawdzić niezmienności.`);
  if (!snap.exists) fail(`Migawka „przed" mówi, że "${rel}" nie istniał — nie ma czego porównać.`);
  const now = snapshot(vaultRoot, rel);
  if (!now.exists) fail(`Plik "${rel}" ZNIKNĄŁ, a miał zostać nietknięty.`);
  if (now.content !== snap.content) {
    fail(msg || `Treść "${rel}" ZMIENIONA, a miała zostać nietknięta (create-only/izolacja naruszona).`);
  }
  if (now.mtimeMs !== snap.mtimeMs) {
    fail(msg || `mtime "${rel}" zmieniony (${snap.mtimeMs} → ${now.mtimeMs}) — plik był zapisywany.`);
  }
}

/** Wylistuj pliki (rekurencyjnie) pod katalogiem vaulta. Zwraca ścieżki względne (posix). */
export function listVaultFiles(vaultRoot: string, relDir = ''): string[] {
  const base = abs(vaultRoot, relDir);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(vaultRoot, full).replace(/\\/g, '/'));
    }
  };
  walk(base);
  return out;
}

function clip(s: unknown, n = 300): string {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
