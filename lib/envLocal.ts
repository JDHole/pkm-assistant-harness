/**
 * envLocal.js — ręczny parser `harness/.env.local` (FAZA B, mostek klucza).
 *
 * Bez `dotenv` (zero nowych zależności). Format `KEY=VALUE` na linię:
 *   - puste linie i `# komentarze` pomijane,
 *   - `export KEY=VALUE` akceptowane (prefiks `export ` ścinany),
 *   - opcjonalne cudzysłowy wokół wartości zdejmowane,
 *   - pierwszy `=` rozdziela klucz od wartości (wartość może zawierać `=`).
 *
 * Plik jest gitignored i MOŻE NIE ISTNIEĆ — wtedy zwracamy `{}` (bieg żywy niedostępny).
 */
import fs from 'fs';

/**
 * @param {string} filePath - absolutna ścieżka do .env.local
 * @returns {Record<string,string>} mapa KEY→VALUE ({} gdy brak pliku)
 */
export function parseEnvLocal(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
