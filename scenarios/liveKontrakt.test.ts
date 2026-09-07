/**
 * Strażnik kontraktu katalogu scenariuszy w trybie LIVE
 * (audyt nocny 2026-09-02, moduł 14 — scenariusze LIVE na DeepSeeku).
 *
 * DLACZEGO PO ŹRÓDLE, A NIE BEHAWIORALNIE: `harness/scenarios/*.ts` importują
 * cały bootstrap pluginu (a przez niego `obsidian`), więc w AVA nie da się ich
 * zaimportować. Ten sam wzór i ten sam powód, co `core/PKMEnv.boot_timing.test.ts`
 * — test czyta źródła katalogu zamiast wołać runner. Poza tym `harness/scenarios/`
 * NIE jest objęty `ava.files` (zasięg to `harness/lib/*.test.ts`), więc test
 * położony obok runnera nie zostałby nawet zebrany przez `npm test`; ten leży
 * w `core/`, czyli pod bramką.
 *
 * CO PILNUJE. Runner ma dwa tryby: offline (fake-serwer odgrywa `offlineScript`)
 * i live (`--live`, prawdziwy DeepSeek). Asercje w obu trybach są DOKŁADNIE TE
 * SAME — `_runner.ts` mówi o tym wprost w komentarzu („Live: wymagany klucz
 * (asercje identyczne, ale bieg na żywym modelu)"), a jedyną różnicą jest to,
 * czy `setHarnessLlmEndpoint` dostaje adres atrapy, czy `null`.
 *
 * Problem, który ten plik zamraża w liczbach: asercja napisana pod MODEL ZE
 * SKRYPTU, puszczona na model NIEDETERMINISTYCZNY, nie odróżnia dwóch różnych
 * światów:
 *   (a) strażnik pękł — plugin wpuścił coś, czego nie powinien (REGRES),
 *   (b) żywy model w ogóle nie spróbował — bieg niczego nie dowiódł (SZUM).
 * Runner skleja oba w `RED` z etykietą „asercja/znalezisko" i daje `exit 1`
 * (`_runner.ts:288-291`, `:306`). Status `EMPTY` tej dziury NIE zatyka, bo
 * powstaje tylko przy `getCheckCount() === 0` (`_runner.ts:211`) — a w świecie
 * (b) asercja SIĘ WYKONAŁA i policzyła się, tylko nie miała czego zmierzyć.
 *
 * Zmierzone tej nocy trzema pełnymi biegami live na tym samym HEAD (`f6bca13`):
 *   - bieg 1: 13/13 GREEN
 *   - bieg 2: 12/13 — RED na `03_izolacja_pkm`, `stoppedBy=natural iters=1 tools=[]`
 *   - bieg 3: 12/13 — RED na `03_izolacja_pkm`, ten sam obraz
 * W obu czerwonych biegach padła asercja o treści „Żywy model nie podjął ŻADNEJ
 * próby dostępu do cudzej pamięci — bieg niczego nie dowodzi", czyli świat (b).
 * Plugin nie zrobił nic złego; DeepSeek odpowiedział tekstem i nie tknął narzędzi.
 *
 * `03_izolacja_pkm` umie to nazwać, bo jako JEDYNY z trzynastu czyta flagę `live`
 * z kontekstu asercji — runner podaje ją każdemu (`_runner.ts:207`), ale sięga
 * po nią jeden scenariusz. Pozostałe dwanaście, kiedy model się nie postara,
 * oddadzą generyczne „Oczekiwano wywołania narzędzia X, ale go nie było"
 * (`_asserts.ts:224`) — nie do odróżnienia od regresu bez czytania logu.
 *
 * STAN 2026-09-04 (wciąganie ogonów). Znalezisko ZOSTAŁO ROZSTRZYGNIĘTE, tylko
 * inaczej, niż zakładał pin nocy: runner dostał centralny status `NO_ATTEMPT`
 * (`_asserts.isNoAttemptRun` wołane PRZED `asserts()` na biegu live, `_runner.ts:216`),
 * więc pusty bieg rozpoznaje SILNIK, a nie każdy scenariusz z osobna. Z tej gałęzi
 * wchodzą więc tylko dwa strażniki, które nadal coś znaczą — pin `test.failing`
 * i dwa zamrożone liczniki katalogu (34/21/13 i „jeden scenariusz czyta live")
 * zostały pominięte jako nieaktualne.
 */

import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const SCENARIOS_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
  'harness',
  'scenarios',
);

/** Pliki katalogu scenariuszy: `NN_nazwa.ts`. Pomocnicze (`_runner`, `_asserts`, `index`) odpadają. */
function scenarioFiles(): string[] {
  return fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => /^\d+_.*\.ts$/.test(f))
    .sort();
}

function read(file: string): string {
  return fs.readFileSync(path.join(SCENARIOS_DIR, file), 'utf8');
}

/** Scenariusz wypada z biegu live, gdy deklaruje `liveSkip` na najwyższym poziomie obiektu. */
function declaresLiveSkip(src: string): boolean {
  return /^\s*liveSkip:/m.test(src);
}

test('każdy liveSkip niesie POWÓD, a nie gołe `true`', (t) => {
  const bezPowodu: string[] = [];

  for (const file of scenarioFiles()) {
    const src = read(file);
    if (!declaresLiveSkip(src)) continue;
    // Powód musi być niepustym literałem tekstowym w tej samej linii co pole.
    if (!/^\s*liveSkip:\s*['"`][^'"`]{10,}/m.test(src)) bezPowodu.push(file);
  }

  t.deepEqual(
    bezPowodu,
    [],
    'liveSkip bez uzasadnienia = scenariusz wypisany z biegu live bez śladu dlaczego',
  );
});

test('runner PODAJE flagę `live` do kontekstu asercji — kontrakt istnieje po stronie silnika', (t) => {
  const runner = fs.readFileSync(path.join(SCENARIOS_DIR, '_runner.ts'), 'utf8');

  t.regex(
    runner,
    /live:\s*!!flags\.live/,
    'runner przestał podawać flagę `live` do asercji — scenariusze nie mają jak rozpoznać biegu żywego',
  );
});
