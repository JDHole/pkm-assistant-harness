/**
 * 44_stop_zatrzask — Stop kliknięty W TRAKCIE narzędzia naprawdę zatrzymuje turę
 * (klaster K5: AUD-security-037 + AUD-security-038).
 *
 * Guzik Stop ma jedną obietnicę: „od tej chwili nic już się nie dzieje". Do K5 pętla łamała
 * ją w ostatniej iteracji — backstop (finalne zapytanie BEZ narzędzi) był JEDYNYM punktem
 * trasy, który nie pytał `shouldAbort()`. Więc user klikał Stop, gdy leciało narzędzie
 * ostatniej dozwolonej iteracji, a plugin i tak wysyłał do modelu jeszcze jedno pełne
 * zapytanie z całym kontekstem tury, dostawał odpowiedź i domykał turę jako `backstop` —
 * czyli z finalizacją: wpis w oknie kontekstu i w dzienniku sesji. Koszt: jedno wywołanie
 * modelu i wiadomość w historii, których user nie zamawiał.
 *
 * Scenariusz odgrywa dokładnie tę jedną akcję: sufit iteracji = 1 (po narzędziu pętla wchodzi
 * wprost w backstop), a „klik w Stop" dzieje się W TRAKCIE narzędzia — nakładka na egzekutor
 * podnosi flagę przerwania, zanim narzędzie odda wynik.
 *
 * Inwarianty:
 *   1. tura schodzi jako `abort` (nie `backstop`),
 *   2. po Stopie NIE ma ani jednego wywołania modelu więcej (fake-serwer obsłużył dokładnie 1),
 *   3. w trace nie ma zdarzenia `backstop`,
 *   4. wykonało się dokładnie JEDNO narzędzie — to, które biegło w chwili Stopu,
 *   5. odpowiedź przygotowana „na po Stopie" nie wróciła do wołacza.
 *
 * Drugą połowę klastra — że KOLEJNA tura nie odkręca przerwania tury poprzedniej — pinują
 * testy jednostkowe `modules/chat/chat/turnAbort.test.ts` (uchwyt per tura). Harness nie stawia
 * warstwy czatu, więc tamtej ścieżki nie ma tu jak odegrać.
 */
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { assert, loopEnd, toolPosts, assertTraceLacks } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const NOTATKA = 'Notatki/powitanie.md';
const PO_STOPIE = 'ODPOWIEDZ KTOREJ NIKT NIE ZAMAWIAL';

/** Stan biegu: ile żądań obsłużył fake-serwer, ile narzędzi ruszyło, czy „kliknięto Stop". */
const stan = { zapytania: 0, narzedzia: 0, stop: false };

export default ({
  file: '44_stop_zatrzask',
  name: 'stop zatrzask',
  opis: 'Stop w trakcie narzędzia ostatniej iteracji → brak backstopu, brak kolejnych wywołań modelu i narzędzi',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 1,
  liveSkip: 'wymaga sterowanego kliknięcia Stop w trakcie narzędzia — żywy model nie odgrywa tej sekwencji',

  // Predykat „ta tura jest przerwana" — w produkcji trzyma go obiekt tury (`turn.abort`),
  // tutaj podaje go scenariusz, bo harness nie stawia ChatView.
  shouldAbort: () => stan.stop,

  async setup({ plugin }: FixturePayload) {
    assert(plugin?.mcpClient?.executeToolCall, 'Brak plugin.mcpClient.executeToolCall — nie ma czego przechwycić.');
    const oryginal = plugin.mcpClient.executeToolCall.bind(plugin.mcpClient);
    // „User klika Stop, gdy narzędzie jeszcze pracuje": flagę podnosimy PRZED oddaniem wyniku,
    // więc pętla wraca z narzędzia do świata, w którym tura jest już przerwana.
    plugin.mcpClient.executeToolCall = async (...args: FixturePayload[]) => {
      stan.narzedzia += 1;
      stan.stop = true;
      return oryginal(...args);
    };
  },

  offlineScript: (ctx: FixturePayload) => {
    stan.zapytania += 1;
    // Pierwsze zapytanie: narzędzie. Drugie (backstop) nie ma prawa nadejść — a gdyby nadeszło,
    // niesie rozpoznawalny tekst, żeby RED mówił wprost, co przeciekło.
    return ctx.turnIndex === 0
      ? toolCallTurn('read', { path: NOTATKA })
      : textTurn(PO_STOPIE);
  },

  asserts({ result, trace }: FixturePayload) {
    const end = loopEnd(trace);
    assert(end, 'Brak loop.end w trace.');
    assert(
      end.stop === 'abort',
      `Oczekiwano stop=abort, jest stop=${end?.stop}. Stop kliknięty w trakcie narzędzia ostatniej `
      + 'iteracji nie powstrzymał backstopu — tura domknęła się finalizacją, której user nie zamawiał.',
    );
    assert(result.stoppedBy === 'abort', `result.stoppedBy=${result.stoppedBy}, oczekiwano 'abort'.`);

    assertTraceLacks(trace, 'backstop', null, 'W trace jest zdarzenie backstop — pętla weszła w finalne zapytanie mimo Stopu.');

    assert(stan.narzedzia === 1, `Wykonano ${stan.narzedzia} narzędzi, oczekiwano 1 (tylko to, które biegło w chwili Stopu).`);
    assert(toolPosts(trace).length === 1, `W trace ${toolPosts(trace).length} zdarzeń tool.post, oczekiwano 1.`);
    assert(
      stan.zapytania === 1,
      `Fake-serwer obsłużył ${stan.zapytania} żądań modelu, oczekiwano 1 — po Stopie poleciało kolejne wywołanie.`,
    );
    assert(
      !String(result.finalText || '').includes(PO_STOPIE),
      'Do wołacza wróciła odpowiedź wygenerowana PO Stopie — przerwana tura oddała treść do finalizacji.',
    );
  },
} satisfies Scenario);
