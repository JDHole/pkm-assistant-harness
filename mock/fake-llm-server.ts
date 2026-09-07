/**
 * fake-llm-server.js — mini serwer SSE OpenAI-compatible (FAZA B, tryb --offline).
 *
 * PO CO: zweryfikować transport strumienia + akumulację `handle_chunk` + parser tool_calls END-TO-END
 * BEZ sieci i BEZ klucza. Serwer nasłuchuje na losowym porcie localhost, odpowiada na
 * `POST /chat/completions` STREAMINGIEM SSE (`data: {...}\n\n` … `data: [DONE]\n\n`).
 *
 * Skryptowalny: `script` = tablica TUR. Każda tura to lista „delt" (payloady `choices[0].delta`
 * w kształcie OpenAI streaming). Serwer wysyła je po kolei jako osobne zdarzenia SSE (osobny
 * write + drobne opóźnienie), żeby przejść PRAWDZIWĄ ścieżką: wiele chunków → narastający
 * `responseText` → `transport strumienia` rozcina po `\n` → `ResponseAdapter.handle_chunk` sklejа
 * `tool_calls[0].function.arguments` z kawałków (to jest crash-test akumulacji).
 *
 * Domyślny skrypt selftestu (`defaultSelftestScript`):
 *   Tura 0: tool_call `read` na "Notatki/powitanie.md" — nazwa i argumenty ROZBITE na kilka delt.
 *   Tura 1: finalna odpowiedź tekstowa (bez tool_calls) — też rozbita na kilka delt.
 * To dowodzi: transport strumienia → deepseek adapter → parser → pętla, jedna iteracja z
 * narzędziem + naturalne domknięcie.
 *
 * ZERO zależności zewnętrznych (czysty `node:http`).
 */
import http from 'http';

// TS-any: scripted fake-model turns intentionally accept open-ended OpenAI-compatible JSON payloads.
type Runtime = any;

/** SSE-encode jednego zdarzenia `data: <json>\n\n`. */
function sseData(obj: Runtime): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t?.unref?.(); });

/**
 * Uruchamia serwer. Zwraca uchwyt z `url` (endpoint /chat/completions), `origin`, `port`,
 * `getRequestCount()`, `close()`.
 *
 * @param {Object} opts
 * @param {Array<Array<Object>>} opts.script - tablica tur; każda tura = lista delt (payloady chunków).
 * @param {number} [opts.chunkDelayMs=3] - opóźnienie między deltami (symulacja strumienia).
 * @returns {Promise<{url:string, origin:string, port:number, getRequestCount:()=>number, close:()=>Promise<void>}>}
 */
export function startFakeLlmServer({ script = [], chunkDelayMs = 3 }: Runtime = {}): Promise<Runtime> {
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url!.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${req.url}` } }));
      return;
    }

    // Zbierz body. W trybie statycznym ignorowane; w trybie DYNAMICZNYM (tura=funkcja albo
    // `script` to funkcja) parsujemy je, żeby responder mógł odczytać wynik poprzedniego
    // narzędzia (np. artifact_create zwraca `id`, którego artifact_update potrzebuje w kolejnej
    // turze — dokładnie jak żywy model czyta wynik z transkryptu).
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const turnIndex = requestCount;
      requestCount += 1;

      let request: Runtime = null;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* body nie-JSON */ }
      const ctx = { turnIndex, request };

      // `script` może być: funkcją (responder na turę), albo tablicą tur; każda tura = tablica
      // delt LUB funkcja `(ctx)=>delty`. Poza zakresem tablicy → powtórz ostatnią turę.
      // Responder może być ASYNCHRONICZNY (zwrócić promisę) — wtedy odpowiedź czeka na jego
      // rozstrzygnięcie. Scenariusz 31 tak „przytrzymuje" odpowiedź dla suba, żeby `timeout_ms`
      // wygrał wyścig z konstrukcji, a nie dlatego, że zdążył przed wysłaniem żądania.
      let turn: Runtime;
      if (typeof script === 'function') {
        turn = await script(ctx);
      } else if (Array.isArray(script) && script.length > 0) {
        turn = script[Math.min(turnIndex, script.length - 1)];
      }
      const deltas = (typeof turn === 'function' ? await turn(ctx) : turn) || [
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      ];

      // F5: tura może zamiast delt oddać ŻĄDANIE BŁĘDU HTTP (`errorTurn`). Nie da się tego
      // zasymulować deltami: `transport strumienia` sprawdza status odpowiedzi PRZED parsowaniem
      // SSE, więc awaria modelu to inny status, a nie inna treść strumienia.
      const httpError = (deltas as Runtime)?.__harnessHttpError;
      if (httpError) {
        res.writeHead(httpError.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: httpError.message || 'fake model failure' } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        for (const delta of deltas) {
          res.write(sseData(delta));
          if (chunkDelayMs > 0) await sleep(chunkDelayMs);
        }
        res.write('data: [DONE]\n\n');
      } catch { /* klient zerwał połączenie (np. abort po [DONE]) — OK */ }
      res.end();
    });
  });

  return new Promise<Runtime>((resolve, reject) => {
    server.on('error', reject);
    // Losowy wolny port na loopbacku (izolacja: nie wychodzi poza maszynę).
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as Runtime;
      const port = addr.port;
      const origin = `http://127.0.0.1:${port}`;
      server.unref?.(); // nie trzymaj procesu żywym samym serwerem
      resolve({
        url: `${origin}/chat/completions`,
        origin,
        port,
        getRequestCount: () => requestCount,
        close: () => new Promise<void>((res) => {
          // Force-destroy keep-alive sockety (undici trzyma połączenie fetch otwarte) — bez tego
          // server.close() wisi na żywym połączeniu, a proces zderza się z libuv przy exit (Windows).
          try { server.closeAllConnections?.(); } catch { /* Node <18.2 */ }
          server.close(() => res());
        }),
      });
    });
  });
}

/**
 * Buduje domyślny skrypt selftestu. Tura 0 = tool_call `read` na podaną ścieżkę (nazwa +
 * argumenty ROZBITE na delty). Tura 1 = finalna odpowiedź tekstowa (bez narzędzi).
 *
 * @param {Object} [opts]
 * @param {string} [opts.readPath='Notatki/powitanie.md']
 * @param {string} [opts.finalText] - treść finalnej odpowiedzi (domyślnie krótkie streszczenie).
 * @returns {Array<Array<Object>>}
 */
export function defaultSelftestScript({ readPath = 'Notatki/powitanie.md', finalText }: Runtime = {}): Runtime[] {
  const id0 = 'chatcmpl-harness-0';
  const id1 = 'chatcmpl-harness-1';
  const args = JSON.stringify({ path: readPath }); // np. {"path":"Notatki/powitanie.md"}
  // Rozbij argumenty na 3 kawałki, żeby handle_chunk MUSIAŁ je skleić.
  const cut1 = Math.floor(args.length / 3);
  const cut2 = Math.floor((args.length * 2) / 3);
  const argA = args.slice(0, cut1);
  const argB = args.slice(cut1, cut2);
  const argC = args.slice(cut2);

  const toolCall = (delta: Runtime, finish: Runtime = null): Runtime => ({
    id: id0,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  });

  const turn0 = [
    toolCall({ role: 'assistant', content: '' }),
    // pierwsza delta tool_call: id + type + name (arguments pusty)
    toolCall({ tool_calls: [{ index: 0, id: 'call_harness_read', type: 'function', function: { name: 'read', arguments: '' } }] }),
    // kolejne delty: TYLKO fragmenty arguments (function bez name — jak prawdziwy OpenAI/DeepSeek stream)
    toolCall({ tool_calls: [{ index: 0, function: { arguments: argA } }] }),
    toolCall({ tool_calls: [{ index: 0, function: { arguments: argB } }] }),
    toolCall({ tool_calls: [{ index: 0, function: { arguments: argC } }] }),
    toolCall({}, 'tool_calls'),
  ];

  const text = finalText
    || 'Notatka „Powitanie" to rekwizyt harnessa: opisuje testowy vault i wypunktowuje zadania (przeczytać projekt, streścić notatkę).';
  // Rozbij tekst na 4 kawałki treści (streaming), potem finish.
  const q = Math.ceil(text.length / 4);
  const textParts = [text.slice(0, q), text.slice(q, 2 * q), text.slice(2 * q, 3 * q), text.slice(3 * q)];
  const textChunk = (delta: Runtime, finish: Runtime = null): Runtime => ({
    id: id1,
    object: 'chat.completion.chunk',
    created: 2,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  });
  const turn1 = [
    textChunk({ role: 'assistant', content: '' }),
    ...textParts.filter(Boolean).map((p) => textChunk({ content: p })),
    textChunk({}, 'stop'),
  ];

  return [turn0, turn1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Buildery delt SSE dla scenariuszy (FAZA C). Każdy zwraca „turę" = tablicę delt
// w kształcie OpenAI streaming, którą fake-serwer wysyła po kolei. Dzięki temu
// scenariusz opisuje zachowanie „modelu" deklaratywnie, a strumień przechodzi
// PRAWDZIWĄ ścieżką adaptera DeepSeek (akumulacja `handle_chunk`).
// ─────────────────────────────────────────────────────────────────────────────

let _idSeq = 0;
const nextChunkId = () => `chatcmpl-harness-${Date.now()}-${_idSeq++}`;

/** Owija deltę w kształt chunku SSE (choices[0].delta [+ finish_reason]). */
function chunk(id: string, delta: Runtime, finish: Runtime = null): Runtime {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-chat',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  };
}

/** Potnij string na `n` w miarę równych kawałków (min 1). */
function sliceInto(str: Runtime, n: number): string[] {
  const s = String(str);
  if (n <= 1 || s.length <= n) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * Tura z JEDNYM wywołaniem narzędzia (nazwa + argumenty rozbite na kawałki, żeby przejść
 * przez akumulację `handle_chunk`). To poprawny, „grzeczny" tool_call.
 * @param {string} name - nazwa narzędzia
 * @param {Object|string} args - argumenty (obiekt → JSON.stringify)
 * @param {Object} [opts]
 * @param {string} [opts.callId] - id wywołania (default losowe)
 * @param {number} [opts.split=3] - na ile kawałków rozbić string argumentów
 * @param {string} [opts.text=''] - treść emitowana PRZED wywołaniem (modele rozumujące
 *   wypowiadają się przed narzędziem; tędy wjeżdża m.in. blok `<think>` do scenariusza 25)
 * @param {number} [opts.textSplit=4] - na ile kawałków rozbić tę treść
 * @returns {Array<Object>}
 */
export function toolCallTurn(name: string, args: Runtime = {}, { callId, split = 3, text = '', textSplit = 4 }: Runtime = {}): Runtime[] {
  const id = nextChunkId();
  const cid = callId || `call_${name}_${Math.random().toString(36).slice(2, 8)}`;
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
  const parts = sliceInto(argsStr, split);
  const textParts = text ? sliceInto(text, textSplit).filter((p) => p.length > 0) : [];
  return [
    chunk(id, { role: 'assistant', content: '' }),
    ...textParts.map((p) => chunk(id, { content: p })),
    chunk(id, { tool_calls: [{ index: 0, id: cid, type: 'function', function: { name, arguments: '' } }] }),
    ...parts.map((p) => chunk(id, { tool_calls: [{ index: 0, function: { arguments: p } }] })),
    chunk(id, {}, 'tool_calls'),
  ];
}

/**
 * Tura ze SKLEJONYMI wywołaniami (bug DeepSeek Reasoner). Emituje delty tak, że akumulacja
 * `handle_chunk` (zawsze indeks 0, konkatenacja name+arguments) zlepia N wywołań w JEDNO:
 * name = "readlist", arguments = '{"path":...}{"folder":...}'. Parser pętli musi je rozkleić.
 * @param {Array<{name:string, args:(Object|string)}>} calls
 * @param {Object} [opts]
 * @param {string} [opts.callId]
 * @returns {Array<Object>}
 */
export function gluedToolCallTurn(calls: Runtime[], { callId }: Runtime = {}): Runtime[] {
  const id = nextChunkId();
  const cid = callId || `call_glued_${Math.random().toString(36).slice(2, 8)}`;
  const deltas: Runtime[] = [chunk(id, { role: 'assistant', content: '' })];
  calls.forEach((c: Runtime, i: number) => {
    const argsStr = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {});
    // Pierwsza delta niesie id+type; kolejne tylko name+arguments (wszystkie na index 0 → sklejka).
    const tc = i === 0
      ? { index: 0, id: cid, type: 'function', function: { name: c.name, arguments: argsStr } }
      : { index: 0, function: { name: c.name, arguments: argsStr } };
    deltas.push(chunk(id, { tool_calls: [tc] }));
  });
  deltas.push(chunk(id, {}, 'tool_calls'));
  return deltas;
}

/**
 * Tura z finalną odpowiedzią tekstową (bez narzędzi) — domyka pętlę naturalnie.
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [opts.splitText=1] - na ile kawałków rozbić tekst (streaming)
 * @returns {Array<Object>}
 */
export function textTurn(text: Runtime, { split = 1 }: Runtime = {}): Runtime[] {
  const id = nextChunkId();
  const parts = sliceInto(String(text ?? ''), split).filter((p) => p.length > 0);
  return [
    chunk(id, { role: 'assistant', content: '' }),
    ...parts.map((p) => chunk(id, { content: p })),
    chunk(id, {}, 'stop'),
  ];
}

/**
 * F5: tura, która NIE jest strumieniem, tylko awarią modelu — serwer odpowiada statusem HTTP
 * spoza 200 i JSON-owym błędem, jak prawdziwe API na 500/503.
 *
 * PO CO osobny kształt: transport strumienia sprawdza status odpowiedzi ZANIM
 * dotknie treści SSE, więc awarii modelu nie da się udać żadnym układem delt. Bez tego nie ma
 * jak sprawdzić end-to-end, co plugin robi z biegiem suba, który realnie padł.
 *
 * ⚠️ 500 (nie 429) świadomie — 429 jest RETRYABLE w `chat_adapter_base`, więc adapter zrobiłby
 * trzy podejścia z backoffem i scenariusz przestałby być deterministyczny.
 */
export function errorTurn({ status = 500, message = 'fake model failure' }: Runtime = {}): Runtime {
  return { __harnessHttpError: { status, message } };
}

/**
 * Z parsowanego request-body wyciąga treści OSTATNIEJ paczki wyników narzędzi (role:'tool').
 * Dynamiczny responder (np. scenariusz artefaktu) czyta stąd `id`/`path` z poprzedniej tury.
 * @param {Object|null} request - sparsowane body żądania (ctx.request)
 * @returns {string[]} treści wiadomości `tool` z końcowej paczki (puste = brak)
 */
export function lastToolResults(request: Runtime): string[] {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'tool') {
      const c = messages[i].content;
      out.unshift(typeof c === 'string' ? c : JSON.stringify(c));
    } else if (out.length > 0) {
      break; // skończyła się końcowa paczka wyników
    }
  }
  return out;
}
