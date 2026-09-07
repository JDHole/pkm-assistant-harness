/**
 * index.js — rejestr scenariuszy-łamaczy (S26 FAZA C).
 *
 * Statyczne importy (NIE glob) — esbuild bundluje wszystkie scenariusze do jednego pliku
 * (`dist/scenarios.js`). Kolejność = kolejność uruchamiania (sekwencyjnie w _runner.js).
 */
import s01 from './01_smoke_loop.js';
import s02 from './02_backstop.js';
import s03 from './03_izolacja_pkm.js';
import s04 from './04_nogo.js';
import s05 from './05_create_only_memory.js';
import s06 from './06_edge_deny.js';
import s07 from './07_yolo_nie_omija.js';
import s08 from './08_artefakt_plan.js';
import s09 from './09_todo.js';
import s10 from './10_sklejone_tool_calls.js';
import s11 from './11_delegacja_glebia.js';
import s12 from './12_poczta_petla.js';
import s13 from './13_external_red.js';
// S36 (przenumerowany przy merge bazy: 11 -> 14, kolizja z trojka S33):
import s14 from './14_sesja_pisarze.js';
// Poligon F1 (2026-07-31): numeracja 25+ zarezerwowana pod scenariusze Poligonu.
import s25 from './25_think_parser.js';
import s26 from './26_settings_pancerz.js';
import s27 from './27_settings_lastgood.js';
import s28 from './28_memory_cykl.js';
import s29 from './29_puls_pamieci.js';
import s30 from './30_skill_przepis.js';
import s31 from './31_sub_szablon_fallback.js';
import s32 from './32_deep_research.js';
import s33 from './33_skill_marker.js';
import s34 from './34_komunikator_sprzatanie.js';
import s35 from './35_artefakt_approval.js';
import s36 from './36_web_provenance.js';
import s37 from './37_semantyka_indeks.js';
import s38 from './38_multimodal_fake.js';
import s39 from './39_boot_nie_pisze.js';
// F2 (2026-08-15): delegacja w tle.
import s40 from './40_delegacja_tlo.js';
// F5 (2026-08-15): uczciwość zejścia suba + sterowanie biegiem w trakcie.
import s41 from './41_sub_uczciwosc.js';
// K1 (2026-08-22): kanoniczna ścieżka — No-Go trzyma mimo przebrań zapisu.
import s42 from './42_sciezka_kanoniczna.js';
// K4 (2026-08-22): bieg w tle trzyma się TURY, która go zleciła — nie globalnych luster.
import s43 from './43_tlo_po_turze.js';
// K5 (2026-08-22): Stop zatrzaskuje przerwanie — backstop i narzędzia po Stopie już nie lecą.
import s44 from './44_stop_zatrzask.js';

export const SCENARIOS = [
  s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14,
  s25, s26, s27, s28, s29, s30, s31, s32, s33, s34, s35, s36, s37, s38, s39,
  s40, s41, s42, s43, s44,
];
