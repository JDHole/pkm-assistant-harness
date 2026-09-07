/**
 * 38_multimodal_fake — generowanie obrazu i transkrypcja audio OFFLINE, na atrapach `requestUrl`.
 *
 * PO CO: `modules/multimodal` to trzeci obszar, którego harness nie ruszał — cały jedzie
 * `requestUrl` z HARDCODOWANYMI hostami platform (żadnego DI poza routerem tras). Router
 * z Poligonu pozwala przejechać obie ścieżki bez sieci, bez kluczy i bez kosztów:
 *
 *   1. **`generate_image` end-to-end**: model prosi o obraz → adapter platformy oddaje base64
 *      → narzędzie dekoduje go do bajtów, zapisuje plik binarny w vaulcie i tworzy notatkę
 *      towarzyszącą z osadzeniem `![[…]]`. Inwariant jest twardy: bajty w vaulcie muszą być
 *      DOKŁADNIE tymi, które przyszły z atrapy (droga base64 → Uint8Array → Vault API).
 *   2. **STT (`transcribeAudio`)**: to NIE jest narzędzie MCP — w produkcji woła je warstwa
 *      czatu (przycisk mikrofonu), więc scenariusz woła je jak zwykłą funkcję, tak samo jak
 *      zrobiłby to czat. Sprawdzamy ścieżkę udaną (multipart → odpowiedź `{text}`) oraz trzy
 *      ścieżki błędu, bo to one decydują, czy user zobaczy czytelny komunikat, czy wyjątek.
 *
 * ⚠️ **Vision jest POZA zakresem** — wejście obrazowe żyje w warstwie czatu (`modules/chat` +
 * detekcja `_is_model_multimodal` w `modules/models`), której harness nie stawia. To świadoma
 * granica scenariusza, nie przeoczenie.
 */
import fs from 'fs';
import path from 'path';
import { textTurn, toolCallTurn } from '../mock/fake-llm-server.js';
import { setHarnessRequestUrlRoutes } from '../mock/obsidian.js';
import { transcribeAudio } from '../../modules/multimodal/index.js';
import { assert, assertFinalText, assertToolOk, listVaultFiles, readVaultFile } from './_asserts.js';

import type { FixturePayload, Scenario } from './_asserts.js';

const FOLDER_ZAPISU = 'Attachments/generated';
const PROMPT = 'a lighthouse at dusk, minimalist poster';
const REVISED_PROMPT = 'A minimalist dusk lighthouse poster.';

/**
 * Atrapa binarna: sygnatura PNG + kilka bajtów wypełnienia. **Nikt jej nie dekoduje** —
 * scenariusz sprawdza drogę base64 → bajty → plik w vaulcie, a nie poprawność obrazu.
 * Bajty budujemy w kodzie, żeby asercja mogła je porównać 1:1 z zawartością pliku.
 */
const BAJTY_OBRAZU = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x43, 0x44, 0x45]);
const OBRAZ_BASE64 = Buffer.from(BAJTY_OBRAZU).toString('base64');

const BAJTY_AUDIO = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
const TEKST_TRANSKRYPCJI = 'Nagranie testowe harnessu, jeden dwa trzy.';
const BLAD_STT = 'Klucz API odrzucony przez atrape.';

const ODPOWIEDZ = 'Obraz zapisany w vaulcie razem z notatka.';

/** Zwraca komunikat błędu rzuconego przez `fn` ('' gdy nie rzuciła). */
async function komunikatBledu(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return String((e as Error)?.message || e);
  }
  return '';
}

export default ({
  file: '38_multimodal_fake',
  name: 'multimodal offline',
  opis: 'generate_image na atrapie platformy zapisuje bajty + notatkę z osadzeniem; transkrypcja audio oddaje tekst, a błędy są czytelne',
  agent: 'Tester',
  autonomy: 'edge',
  approve: 'auto',
  maxIterations: 3,
  evidenceFiles: [FOLDER_ZAPISU],
  liveSkip: 'realne API obrazów i STT wymagają kluczy i kosztują — bieg żywy poza zakresem Poligonu',

  /**
   * Trasy routera + platformy w ustawieniach.
   *
   * Zapis idzie do SUROWEGO worka (`settingsStore.raw`) z pominięciem obserwującego
   * proxy — mutacja przez `env.settings` zaplanowałaby zapis ustawień na dysk (wzór z 26/27).
   * Namespace po S35 to `pkmAssistant.imageGen`; klucze API platform chmurowych mieszkają
   * osobno, w `pkmAssistant.chat.apiKeys` (tam ich szuka `GenerateImageTool`).
   */
  async setup({ plugin }) {
    setHarnessRequestUrlRoutes([
      {
        // OpenAI DALL-E: `{data:[{b64_json, revised_prompt}]}`.
        match: 'api.openai.com/v1/images/generations',
        handler: () => ({ json: { data: [{ b64_json: OBRAZ_BASE64, revised_prompt: REVISED_PROMPT }] } }),
      },
      {
        // Groq Whisper: `{text}` — ścieżka udana STT.
        match: 'api.groq.com/openai/v1/audio/transcriptions',
        handler: () => ({ json: { text: TEKST_TRANSKRYPCJI } }),
      },
      {
        // OpenAI Whisper: kształt BŁĘDU platformy (`{error:{message}}`) — adapter ma go
        // przetłumaczyć na czytelny wyjątek, a nie oddać pustą transkrypcję.
        match: 'api.openai.com/v1/audio/transcriptions',
        handler: () => ({ status: 200, json: { error: { message: BLAD_STT } } }),
      },
    ]);

    const worek = plugin?.env?.settingsStore.raw as FixturePayload;
    if (!worek) throw new Error('Brak settingsStore.raw — bootstrap środowiska nieukończony?');
    worek.pkmAssistant = worek.pkmAssistant || {};
    worek.pkmAssistant.imageGen = {
      platform: 'openai',
      saveFolder: FOLDER_ZAPISU,
      openai_model: 'dall-e-3',
    };
    worek.pkmAssistant = worek.pkmAssistant || {};
    worek.pkmAssistant.chat = worek.pkmAssistant.chat || {};
    worek.pkmAssistant.chat.apiKeys = { ...(worek.pkmAssistant.chat.apiKeys || {}), openai: 'harness-fake-openai' };
  },

  offlineScript: [
    toolCallTurn('generate_image', { prompt: PROMPT, size: '1024x1024' }),
    textTurn(ODPOWIEDZ),
  ],

  async asserts({ result, vaultRoot }) {
    // ── 1. Zwrotka narzędzia: sukces + obie ścieżki (binarka i notatka) ──
    const generowanie = assertToolOk(result, 'generate_image');
    const podglad = generowanie.resultPreview || '';
    const sciezkaObrazu = /"path"\s*:\s*"([^"]+)"/.exec(podglad)?.[1];
    const sciezkaNotatki = /"note_path"\s*:\s*"([^"]+)"/.exec(podglad)?.[1];
    assert(
      !!sciezkaObrazu && !!sciezkaNotatki,
      `generate_image nie oddał ścieżek zapisu (path/note_path). Podgląd: ${podglad.slice(0, 300)}`,
    );
    assert(
      sciezkaObrazu!.startsWith(`${FOLDER_ZAPISU}/generated_`) && sciezkaObrazu!.endsWith('.png'),
      `Obraz zapisany poza umówionym folderem/rozszerzeniem: ${sciezkaObrazu}`,
    );
    assert(
      podglad.includes(REVISED_PROMPT),
      `Zwrotka zgubiła pole revised_prompt z atrapy platformy. Podgląd: ${podglad.slice(0, 300)}`,
    );

    // ── 2. Plik binarny istnieje i ma DOKŁADNIE bajty z atrapy ──
    const abs = path.join(vaultRoot, sciezkaObrazu!);
    assert(fs.existsSync(abs), `Plik binarny „${sciezkaObrazu}" nie powstał w vaulcie.`);
    const bajty = fs.readFileSync(abs);
    assert(bajty.length > 0, `Plik „${sciezkaObrazu}" jest pusty — dekodowanie base64 się nie udało.`);
    assert(
      Buffer.compare(bajty, Buffer.from(BAJTY_OBRAZU)) === 0,
      `Bajty w vaulcie różnią się od tych z atrapy (droga base64 → plik jest uszkodzona). `
      + `Oczekiwano ${BAJTY_OBRAZU.length} B, jest ${bajty.length} B.`,
    );

    // ── 3. Notatka towarzysząca z osadzeniem obrazu ──
    const nazwaPliku = sciezkaObrazu!.split('/').pop();
    const notatka = readVaultFile(vaultRoot, sciezkaNotatki!);
    assert(
      notatka.includes(`![[${nazwaPliku}]]`),
      `Notatka „${sciezkaNotatki}" nie osadza wygenerowanego obrazu — brak ![[${nazwaPliku}]]. Treść: ${notatka.slice(0, 200)}`,
    );
    assert(notatka.includes(PROMPT), `Notatka nie niesie prompta użytego do generowania. Treść: ${notatka.slice(0, 200)}`);

    // Nic poza tą parą plików nie powstało w folderze zapisu.
    const wFolderze = listVaultFiles(vaultRoot, FOLDER_ZAPISU);
    assert(
      wFolderze.length === 2,
      `Oczekiwano DOKŁADNIE dwóch plików (obraz + notatka) w „${FOLDER_ZAPISU}", jest ${wFolderze.length}: ${wFolderze.join(', ')}`,
    );

    // ── 4. STT: ścieżka udana (multipart → `{text}` z atrapy) ──
    const nagranie = new Blob([BAJTY_AUDIO], { type: 'audio/webm' });
    const transkrypcja = await transcribeAudio('groq', { groq: 'harness-fake-groq' }, nagranie, 'pl');
    assert(
      transkrypcja.text === TEKST_TRANSKRYPCJI,
      `Transkrypcja nie zwróciła tekstu z atrapy: ${JSON.stringify(transkrypcja)}`,
    );

    // ── 5. STT: trzy błędy, każdy CZYTELNY (nie wyjątek z bebechów) ──
    const bladPlatformy = await komunikatBledu(() => transcribeAudio('nie-ma-takiej-platformy', {}, nagranie, 'pl'));
    assert(
      bladPlatformy.includes('nie-ma-takiej-platformy'),
      `Nieznana platforma STT miała dać komunikat z jej nazwą, jest: ${JSON.stringify(bladPlatformy)}`,
    );

    const bladKlucza = await komunikatBledu(() => transcribeAudio('groq', {}, nagranie, 'pl'));
    // Od 2026-09-06 etykieta to nazwa platformy (pole `groq_api_key` nie istnieje — klucz żyje
    // w `chat.apiKeys.groq`), a i18n dopowiada, żeby wpisać go w Ustawieniach.
    assert(
      bladKlucza.includes('Groq') && /Ustawieniach|Settings/.test(bladKlucza),
      `Brak klucza miał odbić się PRZED requestem, z nazwą platformy i wskazówką o Ustawieniach. Jest: ${JSON.stringify(bladKlucza)}`,
    );

    const bladApi = await komunikatBledu(() => transcribeAudio('openai', { openai: 'harness-fake-openai' }, nagranie, 'pl'));
    assert(
      bladApi.includes(BLAD_STT),
      `Błąd zwrócony przez platformę nie dotarł do wołacza (cicha pusta transkrypcja?). Jest: ${JSON.stringify(bladApi)}`,
    );

    // ── 6. Pętla domknęła się odpowiedzią ──
    const finalText = assertFinalText(result);
    assert(
      finalText.includes(ODPOWIEDZ),
      `Finalny tekst pętli jest inny niż zaskryptowany: ${JSON.stringify(finalText.slice(0, 200))}`,
    );
  },
} satisfies Scenario);
