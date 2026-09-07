/**
 * `harnessProviders.ts` — przekierowanie dostawców czatu na fake-serwery harnessa (tryb --offline).
 *
 * ŻYJE W HARNESS, nie w produkcji. Podmieniamy WYŁĄCZNIE ADRES — cała reszta (budowa żądania,
 * dekoder strumienia, akumulacja, parser tagów myślenia) to PRAWDZIWY kod dostawcy. Bez flagi
 * `--offline` te wpisy nie są rejestrowane → prawdziwi dostawcy i prawdziwe adresy.
 *
 * Trzy platformy, bo trzy różne dialekty strumienia, które chcemy przepuścić przez pętlę bez sieci:
 *  • DeepSeek — SSE w kształcie OpenAI, domyślny model scenariuszy (`fake-llm-server`);
 *  • LM Studio — SSE w kształcie OpenAI + parser `<think>` (ten sam fake-serwer);
 *  • Ollama — NDJSON pod `<host>/api/chat` + natywne `message.thinking` (`fake-ollama-server`).
 *
 * Adresy (losowe porty fake-serwerów) są znane dopiero w runtime → trzymamy je w module-scope
 * i wstrzykujemy setterami PRZED `onload()`.
 *
 * ⚠️ Dostawcy są BEZSTANOWI i nie mają `stream()` — nie da się już podsłuchać odpowiedzi
 * podklasą adaptera. Podsłuch (`tapModel`) wpina się w `ChatModel.stream` przez OPAKOWANIE
 * MODELU, po jego utworzeniu (patrz `runTurn.ts`).
 */
import { CHAT_PROVIDERS } from '../../modules/models/index.js';
import type {
    ChatProvider,
    ChatProviderInfo,
    ChatRequest,
    OpenAiCompletion,
    ProviderId,
    StreamHandlers,
} from '../../modules/models/index.js';

let _endpoint: string | null = null;
let _lmStudioEndpoint: string | null = null;
let _ollamaHost: string | null = null;

/** Ustawia wspólny endpoint fake-serwera (wołane z run.ts po starcie serwera, przed onload). */
export function setHarnessLlmEndpoint(url: string | null | undefined): void {
    _endpoint = url || null;
}

/** Bieżący endpoint harnessa (null = nie ustawiony → fallback na prawdziwy adres dostawcy). */
export function getHarnessLlmEndpoint(): string | null {
    return _endpoint;
}

/**
 * Ustawia endpoint LM Studio (pełny URL kończący się na `/chat/completions`).
 * `null` = wróć do wspólnego endpointu harnessa, a gdy i jego nie ma — do adresu domyślnego.
 */
export function setHarnessLmStudioEndpoint(url: string | null | undefined): void {
    _lmStudioEndpoint = url || null;
}

/** Ustawia hosta Ollamy (sam origin, np. `http://127.0.0.1:53124`). `null` = adres domyślny. */
export function setHarnessOllamaHost(origin: string | null | undefined): void {
    _ollamaHost = origin || null;
}

/**
 * Kopia dostawcy z podmienionym adresem. `info` liczy się LENIWIE (przy każdym odczycie),
 * bo adres harnessa jest znany dopiero po starcie fake-serwera.
 */
function withEndpoint(base: ChatProvider, resolveEndpoint: () => string | null): ChatProvider {
    return {
        get info(): ChatProviderInfo {
            const endpoint = resolveEndpoint();
            return endpoint ? { ...base.info, defaultEndpoint: endpoint } : base.info;
        },
        listModels: (ctx, http) => base.listModels(ctx, http),
        buildRequest: (req, ctx, stream) => base.buildRequest(req, { ...ctx, endpoint: ctx.endpoint ?? resolveEndpoint() ?? undefined }, stream),
        parseCompletion: (body, req, ctx) => base.parseCompletion(body, req, ctx),
        createStreamDecoder: (req, ctx) => base.createStreamDecoder(req, ctx),
    };
}

/** DeepSeek na fake-serwerze harnessa (albo prawdziwy, gdy endpoint nieustawiony). */
export function makeHarnessDeepseekProvider(): ChatProvider {
    return withEndpoint(CHAT_PROVIDERS.deepseek, () => _endpoint);
}

/** LM Studio: własny endpoint scenariusza → wspólny endpoint harnessa → adres domyślny. */
export function makeHarnessLmStudioProvider(): ChatProvider {
    return withEndpoint(CHAT_PROVIDERS.lm_studio, () => _lmStudioEndpoint || _endpoint);
}

/** Ollama: host scenariusza → adres domyślny (`/api/chat` doklei dostawca). */
export function makeHarnessOllamaProvider(): ChatProvider {
    return withEndpoint(CHAT_PROVIDERS.ollama, () => _ollamaHost);
}

/** Komplet podmian dla trybu offline — klucz rejestru → instancja dostawcy. */
export function harnessProviderOverrides(): Partial<Record<ProviderId, ChatProvider>> {
    return {
        deepseek: makeHarnessDeepseekProvider(),
        lm_studio: makeHarnessLmStudioProvider(),
        ollama: makeHarnessOllamaProvider(),
    };
}

// ── Podsłuch odpowiedzi ──────────────────────────────────────────────────────
//
// `runAgentLoop` konsumuje odpowiedź modelu i zapisuje myślenie do transkryptu, ale NIE
// wystawia go w wyniku pętli — a budowa kolejnego żądania go nie przepisuje. Czyli z zewnątrz
// nie da się sprawdzić, GDZIE wylądowało wydzielone myślenie. Ten podsłuch to jedyny punkt
// obserwacji: zapisuje kompletną odpowiedź oddaną przez PRODUKCYJNY kod, niczego nie zmieniając.

/** Jedna podsłuchana odpowiedź modelu (dokładnie ta, którą model oddał pętli). */
export interface HarnessCompletionRecord {
    platform: string;
    completion: OpenAiCompletion;
}

const _completions: HarnessCompletionRecord[] = [];

/** Czyści podsłuch (scenariusz woła przed turą, którą chce obejrzeć). */
export function clearHarnessCompletions(): void {
    _completions.length = 0;
}

/** Podsłuchane odpowiedzi — wszystkie albo tylko z jednej platformy, w kolejności tur. */
export function getHarnessCompletions(platform?: string): HarnessCompletionRecord[] {
    return platform ? _completions.filter((r) => r.platform === platform) : _completions.slice();
}

/** Owija `handlers.done` zapisem do podsłuchu. Zwrotka handlera wołacza przechodzi bez zmian. */
function tapHandlers(platform: string, handlers: StreamHandlers): StreamHandlers {
    return {
        ...handlers,
        done: async (resp: OpenAiCompletion) => {
            _completions.push({ platform, completion: resp });
            return handlers.done?.(resp);
        },
    };
}

/** Model, którego dotyka podsłuch — tyle powierzchni, ile harness naprawdę woła. */
export interface TappableModel {
    stream(req: ChatRequest, handlers?: StreamHandlers): Promise<OpenAiCompletion>;
    [key: string]: unknown;
}

/**
 * Opakowuje model podsłuchem `handlers.done`. Dostawcy są bezstanowi i nie mają `stream()`,
 * więc jedyne miejsce, w którym da się zobaczyć finalną odpowiedź, to sam `ChatModel`.
 */
export function tapModel<T extends TappableModel>(model: T, platform: string): T {
    const original = model.stream.bind(model);
    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === 'stream') {
                return (req: ChatRequest, handlers: StreamHandlers = {}) => original(req, tapHandlers(platform, handlers));
            }
            return Reflect.get(target, prop, receiver) as unknown;
        },
    });
}
