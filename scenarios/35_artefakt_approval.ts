/**
 * 35_artefakt_approval — plan od utworzenia po zatwierdzenie: agent proponuje, USER klika.
 *
 * Scenariusz 08 pokrywa `artifact_create` + patch sekcji, 32 — typ `raport` w przepisie. Tu jest
 * gatunek, którego nie tykał żaden: **approval flow typu `plan`** (statusy
 * `do-akceptacji → uwagi | zaakceptowany → zamkniety`) plus **block-idy checkboxów**.
 *
 * ⚠️ APPROVAL ARTEFAKTU TO NIE MODAL. Guziki żyją w code-blocku renderowanym w notatce; „co
 * pokazać" liczy PURE `computeArtifactButtons(status, statusy)`, a klik to dwie rzeczy:
 * `artifactStore.update(id, [set_field status])` + `summonAgentForArtifact` (w harnessie
 * fail-soft — bez ChatView nic nie wysyła). Nie da się tego kliknąć bez UI, więc scenariusz
 * odgrywa klik 1:1 tymi samymi wywołaniami i sprawdza notatkę na dysku.
 *
 * Trzy warstwy asercji:
 *   1. TURA MODELU — `artifact_create(plan)` → status startowy `do-akceptacji`; `artifact_update`
 *      z dwoma `add_item` + `check_item` na pierwszym. Block-idy `nextBlockId` nadaje
 *      deterministycznie: `^k1`, `^k2` (skan `^k<n>` po CAŁYM pliku).
 *   2. KLIK USERA — mapa guzików per status + realny `set_field` + bump `zaktualizowano`.
 *   3. ODPORNOŚĆ — nieistniejący block-id wraca jako `not_found` w `errors[]`, `applied: 0`,
 *      a PLIK ZOSTAJE NIETKNIĘTY (patch nie może „prawie zadziałać").
 *
 * LIVE ZOSTAJE WŁĄCZONY: prompt jest nakazowy i nazywa narzędzia oraz opsy po imieniu, a warstwy
 * 2-3 nie zależą od modelu (biegną na `artifactStore`). Ryzyko resztkowe: model, który zamiast
 * `add_item` wsadzi listę przez `set_section`, nie dostanie block-idów i warstwa 1 zaświeci RED
 * — to uczciwy sygnał „przepis niewykonalny dla modelu", nie awaria harnessa.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { computeArtifactButtons } from '../../modules/artifacts/artifactButtons.js';
import { buildSummonMessage } from '../../modules/artifacts/artifactSummon.js';
import { t } from '../../core/i18n/index.js';
import { assert, assertToolOk, listVaultFiles, readVaultFile, snapshot, toolResult } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const TYTUL = 'Plan Poligonu';
const KROK_1 = 'Przygotuj rekwizyty';
const KROK_2 = 'Odpal harness';
/** Data zasadzona przed klikiem — po `set_field` silnik MUSI ją podmienić na dzisiejszą. */
const STARA_DATA = '2000-01-01';
const ARTEFAKTY = 'PKM Assistant/Artefakty';

/** Wyciągnij `id` artefaktu z wyniku `artifact_create` w transkrypcie (wzór 08). */
function idZTranskryptu(request: FixturePayload): string | null {
  for (const raw of lastToolResults(request)) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.id === 'string' && obj.id.startsWith('art-')) return obj.id;
    } catch { /* nie-JSON wynik — pomiń */ }
  }
  return null;
}

/** Ścieżka notatki planu w folderze artefaktów (jedyna). Rzuca, gdy nie ma dokładnie jednej. */
function znajdzNotatkePlanu(vaultRoot: string): string {
  const notatki = listVaultFiles(vaultRoot, ARTEFAKTY).filter((p) => p.endsWith('.md'));
  const plany = notatki.filter((rel) => /(^|\n)typ:\s*plan\b/.test(readVaultFile(vaultRoot, rel)));
  assert(plany.length === 1,
    `Oczekiwano DOKŁADNIE jednej notatki typu plan, jest ${plany.length}: ${notatki.join(', ') || '(brak)'}`);
  return plany[0];
}

export default ({
  file: '35_artefakt_approval',
  name: 'artefakt approval',
  opis: 'plan: create → add_item ×2 + check_item (^k1/^k2) → guziki wg statusu → set_field zaakceptowany → not_found nie rusza pliku',
  agent: 'Tester',
  // yolo: artefakty i tak nie otwierają modala diffa (to nie `write`), ale tura ma być o approvalu
  // artefaktu, nie o zgodach — żadne pytanie nie ma prawa wejść jej w drogę.
  autonomy: 'yolo',
  approve: 'auto',
  maxIterations: 6,
  evidenceFiles: [ARTEFAKTY],
  livePrompt: `Utwórz artefakt typu plan o tytule „${TYTUL}" (narzędzie artifact_create). `
    + `Następnie JEDNYM wywołaniem artifact_update dodaj do sekcji „Kroki" dwa punkty operacją `
    + `add_item: „${KROK_1}" i „${KROK_2}", a potem operacją check_item odhacz PIERWSZY z nich `
    + '(jego blockId to k1). Nie używaj set_section.',

  async setup({ plugin }) {
    const typ = plugin?.agentManager?.artifactTypeLoader?.getType?.('plan');
    assert(typ, 'Wbudowany typ artefaktu „plan" nie zaseedował się — nie ma czego zatwierdzać.');
    assert(Array.isArray(typ.statusy) && typ.statusy.includes('do-akceptacji') && typ.statusy.includes('zaakceptowany'),
      `Typ „plan" ma inne statusy niż zakłada scenariusz: ${JSON.stringify(typ.statusy)}`);
    assert(plugin?.artifactStore, 'Brak plugin.artifactStore — narzędzia artefaktów nie mają silnika.');
  },

  offlineScript: (ctx: FixturePayload) => {
    if (ctx.turnIndex === 0) {
      return toolCallTurn('artifact_create', { typ: 'plan', tytul: TYTUL });
    }
    if (ctx.turnIndex === 1) {
      const id = idZTranskryptu(ctx.request);
      if (!id) return textTurn('Nie udało się odczytać id artefaktu z wyniku create.');
      return toolCallTurn('artifact_update', {
        id,
        // Opsy lecą po kolei na wynik poprzednich — drugi `add_item` widzi już `^k1` w pliku.
        ops: [
          { op: 'add_item', heading: 'Kroki', text: KROK_1 },
          { op: 'add_item', heading: 'Kroki', text: KROK_2 },
          { op: 'check_item', blockId: 'k1' },
        ],
      });
    }
    return textTurn('Plan gotowy do akceptacji.');
  },

  async asserts({ result, vaultRoot, plugin }) {
    const store = plugin.artifactStore;
    const statusy: string[] = plugin.agentManager.artifactTypeLoader.getType('plan').statusy;

    // ══ 1. TURA MODELU — notatka planu z checkboxami i block-idami ══
    assertToolOk(result, 'artifact_create');
    assertToolOk(result, 'artifact_update');

    const patch = toolResult(result, 'artifact_update');
    assert(/"errors"\s*:\s*\[\]/.test(patch?.resultPreview || ''),
      `Patch kroków zgłosił błędy: ${(patch?.resultPreview || '(brak)').slice(0, 300)}`);

    const notePath = znajdzNotatkePlanu(vaultRoot);
    let tresc = readVaultFile(vaultRoot, notePath);

    const id = (/(^|\n)pkm-artefakt:\s*(\S+)/.exec(tresc) || [])[2];
    assert(id && id.startsWith('art-'), `Notatka ${notePath} nie niesie id w polu pkm-artefakt.`);

    assert(/(^|\n)status:\s*do-akceptacji\b/.test(tresc),
      `Świeży plan miał wystartować w statusie „do-akceptacji". Frontmatter: ${tresc.slice(0, 300)}`);

    // Block-idy nadane deterministycznie przez `nextBlockId` (skan `^k<n>` po całym pliku).
    assert(new RegExp(`- \\[x\\] ${KROK_1} \\^k1`).test(tresc),
      `Brak odhaczonego „- [x] ${KROK_1} ^k1" w notatce:\n${tresc.slice(0, 600)}`);
    assert(new RegExp(`- \\[ \\] ${KROK_2} \\^k2`).test(tresc),
      `Brak nieodhaczonego „- [ ] ${KROK_2} ^k2" w notatce:\n${tresc.slice(0, 600)}`);

    // ══ 2. KLIK USERA — mapa guzików + realne zatwierdzenie ══
    const guziki = computeArtifactButtons('do-akceptacji', statusy);
    assert(guziki.length === 2,
      `Plan „do-akceptacji" miał dać 2 guziki (zatwierdź/uwagi), dał ${guziki.length}: `
      + JSON.stringify(guziki.map((b) => b.action)));
    assert(guziki[0].statusTo === 'zaakceptowany' && guziki[1].statusTo === 'uwagi',
      `Guziki celują w złe statusy: ${JSON.stringify(guziki.map((b) => b.statusTo))}`);

    // Zasadź starą datę, żeby bump `zaktualizowano` był WIDOCZNY (silnik stempluje dniem, nie ms).
    const plik = plugin.app.vault.getAbstractFileByPath(notePath);
    assert(plik, `vault.getAbstractFileByPath nie zna ${notePath} — nie mam czego przestemplować.`);
    await plugin.app.fileManager.processFrontMatter(plik, (fm: FixturePayload) => { fm.zaktualizowano = STARA_DATA; });

    // Klik „Zatwierdź" 1:1: dokładnie ten op, który wysyła renderer guzików.
    const zatwierdzenie = await store.update(id, [{ op: 'set_field', key: 'status', value: guziki[0].statusTo }]);
    assert(zatwierdzenie.applied === 1 && zatwierdzenie.errors.length === 0,
      `Zatwierdzenie nie weszło: ${JSON.stringify(zatwierdzenie.errors)} (applied=${zatwierdzenie.applied})`);

    tresc = readVaultFile(vaultRoot, notePath);
    assert(/(^|\n)status:\s*zaakceptowany\b/.test(tresc),
      `Status w notatce nie zmienił się na „zaakceptowany". Frontmatter: ${tresc.slice(0, 300)}`);
    assert(!new RegExp(`(^|\\n)zaktualizowano:\\s*'?${STARA_DATA}`).test(tresc),
      `Pole „zaktualizowano" zostało na ${STARA_DATA} — silnik nie ostemplował zmiany. Frontmatter: ${tresc.slice(0, 300)}`);

    // Po zatwierdzeniu zostaje samo przywołanie; status domykający gasi guziki całkiem.
    const poZatwierdzeniu = computeArtifactButtons('zaakceptowany', statusy);
    assert(poZatwierdzeniu.length === 1 && poZatwierdzeniu[0].action === 'summon' && poZatwierdzeniu[0].statusTo === null,
      `Po zatwierdzeniu miał zostać sam „Przywołaj", jest: ${JSON.stringify(poZatwierdzeniu)}`);
    assert(computeArtifactButtons('zamkniety', statusy).length === 0,
      'Domknięty artefakt („zamkniety" = ostatni status typu) NADAL pokazuje guziki.');

    // ══ 3. ODPORNOŚĆ — zły block-id nie rusza pliku ══
    const przed = snapshot(vaultRoot, notePath);
    const pudlo = await store.update(id, [{ op: 'check_item', blockId: 'k99' }]);
    assert(pudlo.applied === 0, `Patch z nieistniejącym blockId zaaplikował ${pudlo.applied} opsów.`);
    assert(pudlo.errors.some((e: FixturePayload) => e.code === 'not_found'),
      `Oczekiwano błędu „not_found", jest: ${JSON.stringify(pudlo.errors)}`);
    assert(readVaultFile(vaultRoot, notePath) === przed.content,
      'Nieudany patch ZMIENIŁ notatkę — „prawie zadziałał" zamiast odbić się bez śladu.');

    // ══ 4. Wiadomość przywołania (PURE) niesie tożsamość artefaktu i akcję usera ══
    const thin = await store.read(id);
    const etykieta = t(guziki[0].summonKey);
    const wiadomosc = buildSummonMessage(thin, etykieta);
    assert(wiadomosc.includes(TYTUL) && wiadomosc.includes(id),
      `Wiadomość przywołania zgubiła tytuł/id: ${wiadomosc.slice(0, 200)}`);
    assert(wiadomosc.includes(etykieta),
      `Wiadomość przywołania nie mówi, CO user zrobił („${etykieta}"): ${wiadomosc.slice(0, 200)}`);
    assert(wiadomosc.includes('"status": "zaakceptowany"'),
      `Wiadomość przywołania nie niesie świeżego stanu artefaktu: ${wiadomosc.slice(0, 400)}`);
  },
} satisfies Scenario);
