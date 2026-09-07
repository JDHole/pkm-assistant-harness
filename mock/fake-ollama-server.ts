/**
 * fake-ollama-server.ts — mini serwer NDJSON w kształcie Ollamy (Poligon F1, tryb offline).
 *
 * PO CO: `fake-llm-server.ts` gada po SSE w kształcie OpenAI (`data: {...}` + `data: [DONE]`),
 * a Ollama gada INACZEJ: `POST /api/chat` odpowiada strumieniem gołych obiektów JSON, po jednym
 * na linię (NDJSON), a koniec sygnalizuje `done_reason` zamiast `[DONE]`. Adapter Ollamy
 * (`modules/models/adapters/chat/ollama.ts`) ma z tego powodu WŁASNE wpięcie parsera myślenia
 * — i to jego chcemy przepuścić przez pełny łańcuch (transport strumienia → handle_chunk →
 * pętla), a nie tylko przez test jednostkowy.
 *
 * Skryptowalny turami, dokładnie jak fake-llm-server: `script` = tablica TUR, każda tura to
 * lista LINII (obiektów JSON), które serwer wysyła po kolei jako osobne zapisy zakończone `\n`.
 * `transport strumienia` rozcina strumień po `\n`, więc każda linia = jedno zdarzenie `message`.
 *
 * ZERO zależności zewnętrznych (czysty `node:http`). Nasłuchuje wyłącznie na loopbacku.
 */
import http from 'http';

// TS-any: skryptowane tury fake-modelu to celowo otwarte payloady JSON w kształcie Ollamy.
type Runtime = any;

const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t?.unref?.(); });

/** Uchwyt działającego serwera. */
export interface FakeOllamaServer {
  /** Origin (`http://127.0.0.1:PORT`) — TO wstrzykuje się jako `host` adaptera Ollamy. */
  origin: string;
  /** Pełny URL endpointu czatu (`<origin>/api/chat`) — wygodny w komunikatach. */
  url: string;
  port: number;
  getRequestCount(): number;
  close(): Promise<void>;
}

export interface FakeOllamaServerOptions {
  /** Tablica tur; każda tura = lista obiektów JSON (linii NDJSON). Poza zakresem → powtórz ostatnią. */
  script?: Runtime[];
  /** Opóźnienie między liniami (symulacja strumienia). */
  chunkDelayMs?: number;
}

/**
 * Uruchamia serwer NDJSON udający Ollamę.
 *
 * @param opts.script - tury (patrz `ollamaTextTurn`).
 * @param opts.chunkDelayMs - opóźnienie między liniami (domyślnie 3 ms).
 */
export function startFakeOllamaServer({ script = [], chunkDelayMs = 3 }: FakeOllamaServerOptions = {}): Promise<FakeOllamaServer> {
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    // `/api/tags` woła tylko UI ustawień (lista modeli) — w pętli nigdy nie leci. Odpowiadamy
    // pustą listą zamiast 404, żeby przypadkowe wywołanie nie sypało błędem w logu.
    if (req.method === 'GET' && req.url!.includes('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.method !== 'POST' || !req.url!.includes('/api/chat')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${req.method} ${req.url}` }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const turnIndex = requestCount;
      requestCount += 1;

      let request: Runtime = null;
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* body nie-JSON */ }
      const ctx = { turnIndex, request };

      let turn: Runtime;
      if (typeof script === 'function') turn = (script as Runtime)(ctx);
      else if (Array.isArray(script) && script.length > 0) turn = script[Math.min(turnIndex, script.length - 1)];
      const lines: Runtime[] = (typeof turn === 'function' ? turn(ctx) : turn) || ollamaTextTurn('ok');

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        for (const linia of lines) {
          res.write(`${JSON.stringify(linia)}\n`);
          if (chunkDelayMs > 0) await sleep(chunkDelayMs);
        }
      } catch { /* klient zerwał połączenie (abort po done_reason) — OK */ }
      res.end();
    });
  });

  return new Promise<FakeOllamaServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as Runtime;
      const port = addr.port;
      const origin = `http://127.0.0.1:${port}`;
      server.unref?.(); // nie trzymaj procesu żywym samym serwerem
      resolve({
        origin,
        url: `${origin}/api/chat`,
        port,
        getRequestCount: () => requestCount,
        close: () => new Promise<void>((done) => {
          // Jak w fake-llm-server: force-destroy keep-alive socketów (undici trzyma połączenie
          // otwarte), inaczej `server.close()` wisi i proces zderza się z libuv przy exit.
          try { server.closeAllConnections?.(); } catch { /* Node <18.2 */ }
          server.close(() => done());
        }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Buildery tur. Każdy zwraca listę LINII NDJSON — serwer wysyła je po kolei.
// Kształt 1:1 z `/api/chat`: `{model, created_at, message:{role, content, thinking?}, done}`,
// a ostatnia linia niesie `done: true` + `done_reason` — adapter Ollamy parsuje porcję i uznaje
// koniec po którymkolwiek z tych pól, sprawdzeniem STRUKTURALNYM po WYPARSOWANYM JSON-ie, nie
// substringiem na surowym tekście (`ChatModelOllamaAdapter.is_end_of_stream`, F2.14/W4-02).
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'qwen3-harness';
const CREATED_AT = '2026-07-31T10:00:00.000Z';

/** Potnij string na `n` w miarę równych kawałków (min 1). */
function sliceInto(str: unknown, n: number): string[] {
  const s = String(str ?? '');
  if (n <= 1 || s.length <= n) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Linia z fragmentem WIDOCZNEJ treści. */
export function ollamaContentLine(content: string): Runtime {
  return { model: MODEL, created_at: CREATED_AT, message: { role: 'assistant', content }, done: false };
}

/** Linia z fragmentem NATYWNEGO myślenia (`/api/chat` z `think: true` → `message.thinking`). */
export function ollamaThinkingLine(thinking: string): Runtime {
  return { model: MODEL, created_at: CREATED_AT, message: { role: 'assistant', thinking, content: '' }, done: false };
}

/** Ostatnia linia tury — to ona kończy strumień (`done_reason`). */
export function ollamaDoneLine(): Runtime {
  return {
    model: MODEL,
    created_at: CREATED_AT,
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    total_duration: 1_000_000,
    load_duration: 100_000,
    prompt_eval_count: 12,
    prompt_eval_duration: 500_000,
    eval_count: 34,
    eval_duration: 400_000,
  };
}

export interface OllamaTextTurnOptions {
  /** Na ile linii rozbić widoczną treść (streaming). */
  split?: number;
  /** Natywne myślenie modelu rozumującego — leci PRZED treścią, w osobnym polu. */
  thinking?: string;
  /** Na ile linii rozbić myślenie. */
  thinkingSplit?: number;
}

/**
 * Tura tekstowa (bez narzędzi): opcjonalne natywne myślenie, potem widoczna treść, na końcu
 * linia domykająca. Tool calle celowo POMINIĘTE — scenariusze Poligonu potrzebują od Ollamy
 * wyłącznie toru „myślenie vs treść".
 */
export function ollamaTextTurn(text: string, { split = 1, thinking = '', thinkingSplit = 1 }: OllamaTextTurnOptions = {}): Runtime[] {
  const lines: Runtime[] = [];
  if (thinking) {
    for (const part of sliceInto(thinking, thinkingSplit)) {
      if (part.length > 0) lines.push(ollamaThinkingLine(part));
    }
  }
  for (const part of sliceInto(text, split)) {
    if (part.length > 0) lines.push(ollamaContentLine(part));
  }
  lines.push(ollamaDoneLine());
  return lines;
}
