/**
 * 08_artefakt_plan — artefakt żywy typu `plan`: create → note z frontmatterem, potem update patchem.
 *
 * Co realnie sprawdza: `artifact_create(typ:plan)` tworzy NOTATKĘ w folderze artefaktów
 * (`PKM Assistant/Artefakty/<agent>/`) z frontmatterem bazowym (pkm-artefakt/typ/status), a
 * `artifact_update` nakłada strukturalny patch (set_section „Cel") na ŚWIEŻY stan notatki.
 *
 * DYNAMICZNY responder: `id` artefaktu powstaje w runtime (art-YYYYMMDD-hex), więc turę update
 * budujemy z `id` odczytanego z wyniku create w transkrypcie — dokładnie jak żywy model, który
 * czyta wynik poprzedniego narzędzia. Asercje pozostają identyczne dla trybu live.
 */
import { toolCallTurn, textTurn, lastToolResults } from '../mock/fake-llm-server.js';
import { listVaultFiles, readVaultFile, assertToolOk, assert } from './_asserts.js';

const NEW_CEL = 'Zmieniony cel przez patch harnessa';

/** Wyciągnij `id` artefaktu z wyniku artifact_create w transkrypcie (poprzednia tura). */
function artifactIdFromRequest(request: import('./_asserts.js').FixturePayload) {
  for (const raw of lastToolResults(request)) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.id === 'string' && obj.id.startsWith('art-')) return obj.id;
    } catch { /* nie-JSON wynik — pomiń */ }
  }
  return null;
}

export default ({
  file: '08_artefakt_plan',
  name: 'artefakt plan',
  opis: 'artifact_create(plan) → notatka z frontmatterem; artifact_update patch → treść zmieniona',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  evidenceFiles: ['PKM Assistant/Artefakty'],
  livePrompt: 'Utwórz artefakt typu plan o tytule „Plan Testowy". Potem zmień sekcję Cel na „'
    + NEW_CEL + '" przez artifact_update.',

  offlineScript: (ctx: import('./_asserts.js').FixturePayload) => {
    if (ctx.turnIndex === 0) {
      return toolCallTurn('artifact_create', { typ: 'plan', tytul: 'Plan Testowy' });
    }
    if (ctx.turnIndex === 1) {
      const id = artifactIdFromRequest(ctx.request);
      if (!id) return textTurn('Nie udało się odczytać id artefaktu z wyniku create.');
      return toolCallTurn('artifact_update', {
        id,
        ops: [{ op: 'set_section', heading: 'Cel', text: NEW_CEL }],
      });
    }
    return textTurn('Plan utworzony i zaktualizowany.');
  },

  asserts({ result, vaultRoot }) {
    assertToolOk(result, 'artifact_create');
    assertToolOk(result, 'artifact_update');

    // Notatka artefaktu powstała w folderze artefaktów.
    const files = listVaultFiles(vaultRoot, 'PKM Assistant/Artefakty').filter((p) => p.endsWith('.md'));
    assert(files.length >= 1, `Brak notatki artefaktu w PKM Assistant/Artefakty (znaleziono: ${files.length}).`);
    const notePath = files[0];
    const body = readVaultFile(vaultRoot, notePath);

    // Frontmatter bazowy.
    assert(/(^|\n)pkm-artefakt:/.test(body), `Notatka ${notePath} nie ma frontmatteru pkm-artefakt.`);
    assert(/(^|\n)typ:\s*plan\b/.test(body), `Notatka ${notePath} nie ma typ: plan.`);
    assert(/(^|\n)status:\s*\S/.test(body), `Notatka ${notePath} nie ma pola status.`);

    // Patch wszedł: sekcja Cel niesie nową treść.
    assert(body.includes(NEW_CEL), `Patch set_section „Cel" nie zmienił treści notatki (${notePath}).`);
  },
} satisfies import('./_asserts.js').Scenario);
