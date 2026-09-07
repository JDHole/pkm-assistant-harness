/**
 * report.js — raport biegu na stdout + wynik maszynowy `--json` (FAZA B).
 *
 * Parsuje `trace.log` (format `TraceLog`: `[ts] [INFO] [trace] <label> | <type> | k=v k=v`) i składa:
 *   - czytelny raport: agent/model/autonomia, per-iteracja narzędzia (nazwa+status+ms), stop-reason,
 *     iteracje, tokeny in/out, chunki, ścieżki temp-vault + trace.log, decyzje zgód.
 *   - `--json`: JEDEN obiekt (result + ścieżki + przebieg z trace) — wejście dla przyszłych
 *     scenariuszy / oceniacza (Piętro 3).
 */

/** Wyciąga zdarzenia trace dla danego labelu z surowej treści pliku. */
import type { ExploratoryTurn } from './runTurn.js';
// F2.9 (rejestr ryzyk 01.09): ten sam sygnał strukturalny co scenariusze-łamacze — jedno źródło
// prawdy o „czy model w ogóle spróbował narzędzia", zamiast dwóch rozjeżdżających się kopii.
import { isNoAttemptRun } from '../scenarios/_asserts.js';

// TS-any: JSON report is an intentionally open machine-readable payload.
type Runtime = any;

export interface TraceEvent {
  type: string;
  fields: string;
  raw: string;
}

export interface ToolPost {
  i: number | null;
  tool: string;
  status: string;
  ms: number | null;
  chars: number | null;
  blocks: number | null;
}

export interface TraceSummary {
  loopStarted: boolean;
  toolPosts: ToolPost[];
  modelDones: Array<{ i: number | null; in: number | null; out: number | null }>;
  blocked: Array<{ i: number | null; dropped: string }>;
  stoppedBy: string | null;
  iters: number | null;
  totalMs: number | null;
  backstopAfter: number | null;
}

export interface ReportContext {
  turn: ExploratoryTurn;
  traceSummary: TraceSummary;
  traceEvents: TraceEvent[];
  tempVault: string;
  tracePath: string;
  keepVault: boolean;
  offline: boolean;
}

/** Jedna pozycja DoD: werdykt + (przy nie-PASS z braku danych) powód, żeby FAIL nie był niemy. */
export interface DodItem {
  pass: boolean;
  reason?: string;
}

/** Werdykt DoD FAZY B — dwa stany (PASS/FAIL), bo trzeciego harness dziś nie zna. */
export type DodMap = Record<string, DodItem>;

export function parseTrace(content: string, label: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  if (!content) return events;
  const marker = `[trace] ${label} | `;
  for (const line of content.split('\n')) {
    const pos = line.indexOf(marker);
    if (pos === -1) continue;
    const rest = line.slice(pos + marker.length);
    const segs = rest.split(' | ');
    const type = segs[0];
    const fields = segs[1] || '';
    events.push({ type, fields, raw: line });
  }
  return events;
}

const num = (fields: string, key: string): number | null => {
  const m = fields.match(new RegExp(`\\b${key}=(-?\\d+)`));
  return m ? Number(m[1]) : null;
};
const str = (fields: string, key: string): string => {
  const m = fields.match(new RegExp(`\\b${key}=([^\\s]+)`));
  return (m ? m[1] : null) as string;
};

/** Buduje strukturę „przebieg" z eventów trace (do raportu i --json). */
export function summarizeTrace(events: TraceEvent[]): TraceSummary {
  const toolPosts: ToolPost[] = [];   // { i, tool, status, ms, chars, blocks }
  const modelDones: TraceSummary['modelDones'] = [];  // { i, in, out }
  const blocked: TraceSummary['blocked'] = [];     // { i, dropped }
  let stoppedBy: string | null = null;
  let iters: number | null = null;
  let totalMs: number | null = null;
  let backstopAfter: number | null = null;
  let loopStarted = false;

  for (const ev of events) {
    switch (ev.type) {
      case 'loop.start':
        loopStarted = true;
        break;
      case 'model.done':
        modelDones.push({ i: num(ev.fields, 'i'), in: num(ev.fields, 'in'), out: num(ev.fields, 'out') });
        break;
      case 'tool.pre':
        break;
      case 'tool.post':
        toolPosts.push({
          i: num(ev.fields, 'i'),
          tool: str(ev.fields, 'tool'),
          status: str(ev.fields, 'status'),
          ms: num(ev.fields, 'batch_ms'),
          chars: num(ev.fields, 'chars'),
          blocks: num(ev.fields, 'blocks'),
        });
        break;
      case 'tool.blocked':
        blocked.push({ i: num(ev.fields, 'i'), dropped: str(ev.fields, 'dropped') });
        break;
      case 'backstop':
        backstopAfter = num(ev.fields, 'after');
        break;
      case 'loop.end':
        stoppedBy = str(ev.fields, 'stop');
        iters = num(ev.fields, 'iters');
        totalMs = num(ev.fields, 'total_ms');
        break;
      default:
        break;
    }
  }

  return { loopStarted, toolPosts, modelDones, blocked, stoppedBy, iters, totalMs, backstopAfter };
}

const rule = '──────────────────────────────────────────────────────────────';
const bar = '══════════════════════════════════════════════════════════════';

/** Powód nie-PASS dla pozycji DoD, których nie da się ocenić bez trace. */
const TRACE_UNAVAILABLE = 'trace niedostępny - nie ma z czego czytać przebiegu';

/**
 * AUD-testy-029: bramka `harness:selftest` nie patrzyła na WYNIK narzędzi — tylko na to, że
 * pętla w ogóle wystartowała/skończyła. `read` zwracające `{success:false}` (zepsute narzędzie,
 * NIE odmowa uprawnień — to zwykły `catch` w środku tool.execute) zostawiał `tool.post` w trace
 * jako `status=ok`, bo `AgentLoop.ts` liczy `status: r.error ? 'error' : 'ok'` WYŁĄCZNIE po tym,
 * czy egzekutor RZUCIŁ — a `MCPClient.executeToolCall` w praktyce NIGDY nie rzuca (własny `catch`
 * zamienia każdą porażkę, także `Permission denied`, na zwykły zwrot). Samo dopisanie pozycji DoD
 * czytającej `toolPosts[].status` tej klasy mutacji więc NIE łapie (zweryfikowane w audycie).
 *
 * Prawdziwy sygnał leży w TREŚCI wyniku, nie w trace: `MCPClient` dokłada `isError:true` KAŻDEMU
 * nieudanemu wynikowi, dla wszystkich narzędzi wbudowanych, jednym punktem normalizacji
 * (`core/utils/toolResultStatus.ts` — patrz `modules/tools/MCPClient.ts`, sekcja 8b). Ten znacznik
 * ląduje w `toolCallDetails[].resultPreview` (pierwsze 500 znaków zserializowanego wyniku, pole
 * `isError` leży blisko początku obiektu — mieści się w oknie). Kluczujemy na DOKŁADNYM tokenie
 * JSON (`"isError":true`), nie na słowach z treści — inaczej powtórzylibyśmy pułapkę
 * `assertToolErrored` z `harness/scenarios/_asserts.ts` (AUD-testy-028: udany odczyt notatki,
 * której treść PRZYPADKIEM zawiera słowo z listy, przechodzi za odmowę).
 */
const TOOL_ERROR_MARKER = '"isError":true';

/**
 * F2.9 (rejestr ryzyk 01.09): próg długości `finalText` dla pozycji DoD 'finalText niepusty'.
 * Dawny kształt (`finalText.length > 0`) przechodził na JEDNYM tokenie ("Po", "OK", "Gotowe.") —
 * DoD świecił zielono bez dowodu, że model w ogóle spojrzał na zlecenie.
 *
 * DLACZEGO 40: jednotokenowe potwierdzenia mieszczą się grubo poniżej tej granicy (2-10 znaków),
 * podczas gdy NAWET najkrótsze pełne zdanie odmowy czy wyjaśnienia ("Nie mogę tego zrobić.",
 * "Brakuje mi uprawnień do zapisu.") już ją przekracza. 40 znaków odróżnia więc realną,
 * choćby minimalną, wypowiedź od gołego potwierdzenia bez treści — nie mierzy „jakości"
 * odpowiedzi, tylko to, że coś w ogóle zostało powiedziane.
 */
const MIN_FINAL_TEXT_LENGTH = 40;

/**
 * Czy narzędzie `read` — kluczowe narzędzie biegu selftestu (fake-serwer offline ZAWSZE każe
 * turze 0 wywołać `read` na `Notatki/powitanie.md`) — zostało wywołane i skończyło się błędem.
 * Świadomie WARUNKOWE na wywołaniu: `buildDod` jest wspólne z generycznym biegiem eksploracyjnym
 * (`run.js --agent X --prompt "..."`), którego prompt może w ogóle nie potrzebować `read` — brak
 * wywołania nie może być czerwienią, inaczej bramka fałszywie blokowałaby biegi bez tego narzędzia.
 */
function readToolFailed(details: ExploratoryTurn['result']['toolCallDetails']): { called: boolean; failed: boolean; preview?: string } {
  const readCalls = (details || []).filter((d) => d.name === 'read');
  const failedCall = readCalls.find((d) => typeof d.resultPreview === 'string' && d.resultPreview.includes(TOOL_ERROR_MARKER));
  return { called: readCalls.length > 0, failed: !!failedCall, preview: failedCall?.resultPreview };
}

/**
 * Czy bieg zostawił po sobie trace, z którego da się cokolwiek odczytać.
 * `false` = trace wyłączony (`traceEnabled:false`), plik nie powstał albo nie ma w nim ANI JEDNEGO
 * zdarzenia tej etykiety. Brak danych to brak danych — nie wolno z niego wnioskować „model nic nie zrobił".
 */
export function isTraceAvailable(ctx: ReportContext): boolean {
  return ctx.traceEvents.length > 0;
}

/**
 * DoD FAZY B — JEDNO źródło werdyktu dla raportu tekstowego, `--json`.ok i kodu wyjścia biegu.
 * Pozycje czytane z trace przy jego braku są FAIL Z POWODEM (nie cichy PASS i nie niemy FAIL):
 * nieoceniony inwariant nie ma prawa przechodzić za zielony.
 */
export function buildDod(ctx: ReportContext): DodMap {
  const { turn, traceSummary } = ctx;
  const finalText = (turn.result?.finalText || '').trim();
  const traceAvailable = isTraceAvailable(ctx);
  const fromTrace = (pass: boolean): DodItem => (traceAvailable ? { pass } : { pass: false, reason: TRACE_UNAVAILABLE });
  // AUD-testy-029: niezależne od trace — czyta WYNIK narzędzia z `turn.result`, więc działa
  // nawet gdy trace jest wyłączony (a wtedy pozostałe cztery pozycje i tak są FAIL z powodu).
  const read = readToolFailed(turn.result?.toolCallDetails);
  // F2.9: „finalText niepusty" nie ma prawa świecić zielono na gołym „Po"/„OK" — pozycja
  // przechodzi, gdy TEKST ma realną długość ALBO model podjął choć jedną próbę narzędzia (liczy
  // się też próba ODBITA — `isNoAttemptRun` patrzy strukturalnie na `toolsUsed`/`toolCallDetails`,
  // nie na to, czy próba się powiodła). Niezależne od trace, jak `read` wyżej.
  // W6-01: warunek konieczny NIEZALEŻNY od próby narzędzia — pusty finalText to zawsze FAIL.
  // Bez tego `attemptedTool` (prawie zawsze true w selftescie, bo model zawsze próbuje `read`)
  // przepuszczał kompletnie pustą odpowiedź jako zielony wynik.
  const attemptedTool = !isNoAttemptRun(turn.result);
  const finalTextDod: DodItem = finalText.length === 0
    ? { pass: false, reason: 'pusty finalText — bieg nie oddał żadnej odpowiedzi' }
    : (finalText.length >= MIN_FINAL_TEXT_LENGTH || attemptedTool)
      ? { pass: true }
      : {
          pass: false,
          reason: `finalText za krótki (${finalText.length} zn., próg ${MIN_FINAL_TEXT_LENGTH}) i żadnej próby narzędzia. Odpowiedź modelu: "${finalText}"`,
        };
  return {
    'loop.start w trace': fromTrace(traceSummary.loopStarted),
    'finalText niepusty': finalTextDod,
    'stoppedBy z trace': fromTrace(!!traceSummary.stoppedBy),
    'loop.end obecny': fromTrace(traceSummary.totalMs != null),
    'narzędzie "read" bez błędu (gdy wywołane)': read.failed
      ? { pass: false, reason: `read zwróciło błąd: ${read.preview}` }
      : { pass: true },
  };
}

/** Kod wyjścia z werdyktu DoD: wszystko PASS ⇒ 0, cokolwiek FAIL ⇒ 1 (wzór z FAZY A i scenariuszy). */
export function dodToExitCode(dod: DodMap): number {
  return Object.values(dod).every((d) => d.pass) ? 0 : 1;
}

/**
 * Składa czytelny raport (string) biegu eksploracyjnego.
 * @param {Object} ctx - { turn, traceSummary, tempVault, tracePath, keepVault, offline }
 */
export function buildTextReport(ctx: ReportContext): string {
  const { turn, traceSummary, tempVault, tracePath, keepVault, offline } = ctx;
  const r = turn.result;
  const L: string[] = [];
  const line = (s = ''): number => L.push(s);

  line();
  line(bar);
  line('  HARNESS „Szklane Pudło" — FAZA B: bieg eksploracyjny');
  line(bar);
  line(`  agent           : ${turn.agent?.name || '(?)'}`);
  line(`  model           : ${turn.model?.modelKey || '(?)'}  ${offline ? '[OFFLINE fake-serwer]' : '[ŻYWY DeepSeek]'}`);
  line(`  autonomia        : ${turn.autonomy}`);
  line(`  narzędzia (def)  : ${turn.toolCount} widocznych dla agenta`);
  line(rule);

  // Per-iteracja: narzędzia (nazwa + status + ms). Grupujemy tool.post po numerze iteracji.
  const byIter = new Map<number, ToolPost[]>();
  for (const tp of traceSummary.toolPosts) {
    const key = tp.i ?? 0;
    if (!byIter.has(key)) byIter.set(key, []);
    byIter.get(key)!.push(tp);
  }
  if (byIter.size === 0) {
    // Zero tool.post znaczy co innego, gdy trace JEST (model naprawdę nie wołał narzędzi),
    // a co innego, gdy trace'a NIE MA (nie widać przebiegu — teza o turze byłaby zmyślona).
    line(isTraceAvailable(ctx)
      ? '  narzędzia        : (żadne — model odpowiedział tekstem od razu)'
      : '  narzędzia        : (trace niedostępny - nie oceniam użycia narzędzi)');
  } else {
    line('  przebieg narzędzi (per iteracja):');
    for (const [i, tools] of [...byIter.entries()].sort((a, b) => a[0] - b[0])) {
      for (const tp of tools) {
        const sizeInfo = tp.blocks != null ? `${tp.blocks} blok(ów)` : `${tp.chars ?? '?'} zn.`;
        line(`     iter ${i}: ${tp.tool.padEnd(16)} [${tp.status}]  ${tp.ms ?? '?'}ms  (${sizeInfo})`);
      }
    }
  }
  for (const b of traceSummary.blocked) {
    line(`     iter ${b.i}: BLOCKED → ${b.dropped}`);
  }
  line(rule);

  // Zgody (approval decyzje)
  if (turn.approvals.length > 0) {
    line('  decyzje zgód (approval handler):');
    for (const a of turn.approvals) {
      line(`     ${a.tool} ${a.path ? `„${a.path}" ` : ''}→ ${a.decision.toUpperCase()}  (agent: ${a.agent})`);
    }
    line(rule);
  }

  const usage = r.usage || {};
  const usageEstimated = usage._estimated ? ' (estymata — API nie zwrócił usage w streamingu)' : '';
  line(`  stop-reason     : ${r.stoppedBy}${traceSummary.backstopAfter != null ? ` (backstop po ${traceSummary.backstopAfter})` : ''}`);
  line(`  iteracje        : ${r.iterations}`);
  line(`  narzędzia użyte : ${r.toolsUsed?.length ? r.toolsUsed.join(', ') : '(brak)'}`);
  line(`  tokeny          : in=${usage.prompt_tokens ?? 0}  out=${usage.completion_tokens ?? 0}${usageEstimated}`);
  line(`  chunki (stream) : ${turn.chunkCount}`);
  line(`  czas pętli      : ${traceSummary.totalMs != null ? (traceSummary.totalMs / 1000).toFixed(2) + 's' : '?'}`);
  line(rule);
  line('  finalText:');
  const finalText = (r.finalText || '').trim();
  const preview = finalText.length > 600 ? finalText.slice(0, 600) + ' […]' : finalText;
  for (const l of (preview || '(pusty)').split('\n')) line(`     ${l}`);
  line(rule);
  line(`  temp-vault      : ${tempVault}${keepVault ? '  (zachowany: --keep-vault)' : '  (usunięty po biegu)'}`);
  line(`  trace.log       : ${tracePath}`);
  line(bar);

  // ── DoD FAZY B (selftest inwarianty) — ta sama mapa, z której liczy się kod wyjścia i --json.ok ──
  const dod = buildDod(ctx);
  line('  DoD:');
  for (const [k, v] of Object.entries(dod)) line(`     [${v.pass ? 'PASS' : 'FAIL'}] ${k}${v.reason ? `  (${v.reason})` : ''}`);
  line(`  → ${dodToExitCode(dod) === 0 ? 'DoD FAZY B: GREEN' : 'DoD FAZY B: RED'}`);
  line(bar);
  line();

  return L.join('\n');
}

/** Składa maszynowy wynik --json (JEDEN obiekt). */
export function buildJsonReport(ctx: ReportContext): Runtime {
  const { turn, traceSummary, traceEvents, tempVault, tracePath, offline } = ctx;
  const r = turn.result;
  // `ok` LICZONE z DoD tą samą funkcją co kod wyjścia procesu (ok ⇔ exit 0), nigdy stała.
  // `dod` w payloadzie, żeby konsument JSON-a widział KTÓRA pozycja jest czerwona i dlaczego.
  const dod = buildDod(ctx);
  return {
    ok: dodToExitCode(dod) === 0,
    dod,
    mode: offline ? 'offline' : 'live',
    agent: turn.agent?.name || null,
    model: turn.model?.modelKey || null,
    autonomy: turn.autonomy,
    toolDefsVisible: turn.toolCount,
    result: {
      finalText: r.finalText || '',
      toolsUsed: r.toolsUsed || [],
      toolCallDetails: r.toolCallDetails || [],
      usage: r.usage || {},
      iterations: r.iterations,
      stoppedBy: r.stoppedBy,
    },
    chunkCount: turn.chunkCount,
    approvals: turn.approvals,
    trace: {
      label: turn.traceLabel,
      path: tracePath,
      summary: traceSummary,
      events: traceEvents.map((e: TraceEvent) => ({ type: e.type, fields: e.fields })),
    },
    tempVault,
  };
}
