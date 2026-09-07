/**
 * 34_komunikator_sprzatanie — pełne życie wiadomości: leży → agent czyta → OBA ptaszki → kasacja.
 *
 * Komunikator v3 (S28) nie ma retencji ani timera. „Sprzątanie" (D5) to REAKCJA NA MUTACJĘ
 * FLAGI: gdy wiadomość dostanie DRUGI ptaszek (`user_read && ai_read`), manager liczy
 * `allRead` i emituje `communicator:message_all_read`. Na tym evencie siedzi kolejka modali
 * sprzątania, a klik „Usuń" to po prostu `deleteMessage` — twarde `adapter.remove`, bez kosza.
 * Agent NIE MA narzędzia kasowania poczty: kasuje wyłącznie user (D3/D5).
 *
 * Scenariusz przechodzi ten łańcuch na ŻYWYM pluginie, w dwóch tożsamościach:
 *   setup     — Ciasny wysyła do Testera przez `KomunikatorManager.sendMessage` (ścieżka UI:
 *               user pisze z panelu; narzędzia agenta zawsze działają w kontekście WOŁAJĄCEGO,
 *               więc jedna tura runnera nie potrafiłaby być i nadawcą, i odbiorcą).
 *   tura      — Tester: `kom_list` (1 nowa) → `kom_read` (auto-ptaszek `ai_read`) → `kom_list`
 *               (0 nowych). Id do `kom_read` czytany z wyniku poprzedniej tury (wzór 08).
 *   asserts   — dopchnięcie drugiego ptaszka (`markUserRead` = ścieżka UI) i sprawdzenie, że
 *               event ALL_READ przyszedł, kandydat jest na liście hurtowej, a `deleteMessage`
 *               ZDEJMUJE PLIK Z DYSKU.
 *
 * ⚠️ PRODUKCYJNA KOLEJKA SPRZĄTANIA TEŻ SŁUCHA. `registerKomunikatorCleanup` wpina się przy
 * boocie (flaga `komunikatorEnabled` domyślnie ON) i po evencie otwiera `KomunikatorCleanupModal`
 * — a w harnessie `Modal.open()` z atrapy `obsidian` jest no-opem, więc `onDecision` nigdy nie
 * padnie i kolejka zawiśnie na tej jednej pozycji. To NIE blokuje scenariusza: `enqueue` jest
 * fire-and-forget (`void this._drain()`), a `onunload` robi `queue.clear()`. Scenariusz rejestruje
 * WŁASNY listener obok produkcyjnego i sam odgrywa klik „Usuń".
 *
 * Inwarianty: nagłówki bez treści i z poprawnym `przeczytana`, plik spoza wzorca `msg-*` niewidzialny
 * dla listingu, event ALL_READ z {agent,id}, kasacja realnie usuwa plik i tylko jego.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { assert, assertToolOk, exists, listVaultFiles } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const NADAWCA = 'Ciasny';
const ODBIORCA = 'Tester';
const TEMAT = 'Rekwizyt do sprzatniecia';
const TRESC = 'Tresc wiadomosci, ktora po dwoch ptaszkach ma zniknac z dysku.';

const INBOX_TESTERA = '.pkm-assistant/komunikator/inbox/tester';
/** Plik-intruz: `.md` w skrzynce, ale NIE w formacie `msg-<ts>` → listing ma go pomijać. */
const INTRUZ = `${INBOX_TESTERA}/notatka-obok.md`;

/** Id wysłanej wiadomości — ustalane w `setup`, czytane w `asserts`. */
const stan: { id: string | null } = { id: null };

/** Wynik `kom_list` z n-tego wywołania (JSON w resultPreview). Null gdy nie-JSON. */
function odczytajListe(result: FixturePayload, nr: number): FixturePayload {
  const wyniki = (result?.toolCallDetails || [])
    .filter((d: FixturePayload) => d.name === 'kom_list')
    .map((d: FixturePayload) => d.resultPreview || '');
  if (!wyniki[nr]) return null;
  try { return JSON.parse(wyniki[nr]); } catch { return null; }
}

export default ({
  file: '34_komunikator_sprzatanie',
  name: 'komunikator sprzatanie',
  opis: 'kom_list/kom_read → drugi ptaszek → event ALL_READ → deleteMessage zdejmuje plik z dysku',
  agent: ODBIORCA,
  // `kom_list`/`kom_read` są GREEN (nie pytają o zgodę), więc edge wystarczy — a przy okazji
  // pilnuje, że poczta do odczytu NIE jest bramkowana approvalem.
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 6,
  evidenceFiles: [INBOX_TESTERA, INTRUZ],
  liveSkip: 'wymaga deterministycznej sekwencji kom_list → kom_read → kom_list i pracy na DWÓCH tożsamościach (nadawca w setup) — żywy model tego nie odtworzy',

  fixtures: [
    {
      // Intruz podłożony PRZED bootem — skrzynka powstanie wokół niego przy pierwszym `sendMessage`.
      path: INTRUZ,
      content: '# Nie jestem wiadomoscia\n\nZaden `msg-<ts>.md`, wiec listing ma mnie nie widziec.\n',
    },
  ],

  /** Ciasny → Tester ścieżką UI (`sendMessage`), bo narzędzia agenta piszą zawsze „od siebie". */
  async setup({ plugin }) {
    stan.id = null;
    const komunikator = plugin?.agentManager?.komunikatorManager;
    assert(komunikator, 'Brak agentManager.komunikatorManager — komunikator wyłączony flagą albo bootstrap nieukończony.');

    const res = await komunikator.sendMessage(NADAWCA, ODBIORCA, TEMAT, TRESC);
    assert(res?.success && res.id, `Podłożenie wiadomości nie powiodło się: ${JSON.stringify(res)}`);
    stan.id = res.id;

    // Świeżo wysłana = zero ptaszków. Bez tego reszta scenariusza mierzyłaby cudzy stan.
    const naStart = await komunikator.listMessages(ODBIORCA);
    assert(naStart.length === 1, `Skrzynka Testera miała mieć 1 wiadomość na start, ma ${naStart.length}.`);
    assert(!naStart[0].userRead && !naStart[0].aiRead,
      `Podłożona wiadomość ma już ptaszki: ${JSON.stringify(naStart[0])}`);
  },

  offlineScript: (ctx: FixturePayload) => {
    if (ctx.turnIndex === 0) return toolCallTurn('kom_list', {});
    if (ctx.turnIndex === 1) {
      // Id bierzemy z WYNIKU poprzedniej tury — dokładnie jak żywy model czyta transkrypt.
      let id = null;
      for (const raw of lastToolResults(ctx.request)) {
        try {
          const obj = JSON.parse(raw);
          const pierwsza = Array.isArray(obj?.messages) ? obj.messages[0] : null;
          if (pierwsza?.id) { id = pierwsza.id; break; }
        } catch { /* nie-JSON wynik — pomiń */ }
      }
      if (!id) return textTurn('Nie udało się odczytać id wiadomości z wyniku kom_list.');
      return toolCallTurn('kom_read', { id });
    }
    if (ctx.turnIndex === 2) return toolCallTurn('kom_list', {});
    return textTurn('Skrzynka przejrzana i odhaczona.');
  },

  async asserts(ctx) {
    const { result, vaultRoot, plugin } = ctx;
    const komunikator = plugin?.agentManager?.komunikatorManager;
    const id = stan.id as string;
    const sciezkaWiadomosci = `${INBOX_TESTERA}/${id}.md`;

    // ── 1. Pierwszy `kom_list`: jedna nowa, nagłówek bez treści, intruz niewidoczny ──
    assertToolOk(result, 'kom_list');
    const przed = odczytajListe(result, 0);
    assert(przed, 'Pierwszy kom_list nie zwrócił JSON-a.');
    assert(przed.count === 1 && przed.unread === 1,
      `Pierwszy kom_list: oczekiwano count=1 unread=1, jest count=${przed.count} unread=${przed.unread}. `
      + 'Podejrzany: plik-intruz wpuszczony do listingu.');
    const naglowek = przed.messages?.[0];
    assert(naglowek?.id === id, `Pierwszy kom_list zwrócił inną wiadomość: ${JSON.stringify(naglowek)}`);
    assert(naglowek.od === NADAWCA && naglowek.temat === TEMAT,
      `Nagłówek zgubił nadawcę/temat: ${JSON.stringify(naglowek)}`);
    assert(naglowek.przeczytana === false,
      `Nieprzeczytana wiadomość ma „przeczytana: ${naglowek.przeczytana}" (pole mapuje na ai_read).`);
    assert(!JSON.stringify(przed).includes(TRESC),
      'kom_list wypuścił TREŚĆ wiadomości — miał oddawać wyłącznie nagłówki (budżet tokenów).');

    // ── 2. `kom_read`: treść + auto-ptaszek `ai_read` ──
    const odczyt = assertToolOk(result, 'kom_read');
    assert((odczyt.resultPreview || '').includes(TRESC),
      `kom_read nie zwrócił treści wiadomości: ${(odczyt.resultPreview || '(brak)').slice(0, 200)}`);

    // ── 3. Drugi `kom_list`: ta sama wiadomość, ale już odhaczona przez AI ──
    const po = odczytajListe(result, 1);
    assert(po, 'Drugi kom_list nie zwrócił JSON-a.');
    assert(po.count === 1 && po.unread === 0,
      `Po kom_read: oczekiwano count=1 unread=0, jest count=${po.count} unread=${po.unread}.`);
    assert(po.messages?.[0]?.przeczytana === true,
      `Po kom_read wiadomość nadal ma „przeczytana: ${po.messages?.[0]?.przeczytana}" — auto-ptaszek AI nie wszedł.`);

    // Jeden ptaszek to jeszcze NIE ALL_READ — wiadomość dalej leży na dysku.
    assert(exists(vaultRoot, sciezkaWiadomosci), `Plik ${sciezkaWiadomosci} zniknął po samym kom_read.`);
    const poOdczycie = await komunikator.listAllRead(ODBIORCA);
    assert(poOdczycie.length === 0,
      `Po SAMYM kom_read wiadomość trafiła do kandydatów sprzątania (${poOdczycie.length}) — `
      + 'ALL_READ policzone z jednego ptaszka.');

    // ── 4. Drugi ptaszek (ścieżka UI) → event ALL_READ ──
    // Listener rejestrujemy PRZED mutacją; produkcyjna kolejka sprzątania słucha obok nas.
    const zlapane: FixturePayload[] = [];
    const odsubskrybuj = plugin.agentManager.on((event: string, data: FixturePayload) => {
      if (event === 'communicator:message_all_read') zlapane.push(data);
    });
    try {
      const zmieniony = await komunikator.markUserRead(ODBIORCA, id);
      assert(zmieniony, 'markUserRead nie zmienił pliku — drugi ptaszek nie wszedł.');
    } finally {
      odsubskrybuj();
    }
    assert(zlapane.length === 1,
      `Oczekiwano DOKŁADNIE jednego zdarzenia communicator:message_all_read, jest ${zlapane.length}.`);
    assert(zlapane[0]?.agent === ODBIORCA && zlapane[0]?.id === id,
      `Zdarzenie ALL_READ niesie zły ładunek: ${JSON.stringify(zlapane[0])}`);

    // ── 5. Kandydat hurtowy („Usuń przeczytane") ──
    const kandydaci = await komunikator.listAllRead(ODBIORCA);
    assert(kandydaci.length === 1 && kandydaci[0].id === id,
      `listAllRead miało oddać naszą wiadomość, oddało: ${JSON.stringify(kandydaci.map((m: FixturePayload) => m.id))}`);

    // ── 6. Klik „Usuń" = deleteMessage → plik ZNIKA z dysku ──
    const usuniete = await komunikator.deleteMessage(ODBIORCA, id);
    assert(usuniete, 'deleteMessage zwrócił false — kasacja nie doszła.');
    assert(!exists(vaultRoot, sciezkaWiadomosci),
      `Plik ${sciezkaWiadomosci} DALEJ jest na dysku — „usuwanie twarde" (D5) nic nie usunęło.`);
    assert((await komunikator.listAllRead(ODBIORCA)).length === 0, 'Po kasacji listAllRead nadal coś zwraca.');
    assert((await komunikator.listMessages(ODBIORCA)).length === 0,
      'Po kasacji skrzynka Testera nadal ma wiadomości.');

    // ── 7. Kasacja nie ruszyła NICZEGO obok — intruz leży dalej ──
    assert(exists(vaultRoot, INTRUZ), `Sprzątanie zjadło plik spoza wzorca (${INTRUZ}).`);
    const zostalo = listVaultFiles(vaultRoot, INBOX_TESTERA);
    assert(zostalo.length === 1 && zostalo[0].endsWith('notatka-obok.md'),
      `W skrzynce Testera miał zostać sam intruz, jest: ${zostalo.join(', ') || '(pusto)'}`);

    // ── 8. Poczta do odczytu NIE pyta o zgodę (kom_list/kom_read są GREEN) ──
    assert((ctx.approvals || []).length === 0,
      `Odczyt poczty poprosił o zgodę — kom_list/kom_read miały być GREEN: ${JSON.stringify(ctx.approvals)}`);
  },
} satisfies Scenario);
