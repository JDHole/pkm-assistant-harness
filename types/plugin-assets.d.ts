/**
 * Deklaracje modułów-nie-JS, po które sięga KOD PLUGINU wciągany tu przez alias `@plugin/...`.
 *
 * PO CO: plugin importuje arkusze (`import sheet from './x.css'`) i notatki wydania
 * (`import notes from '../../releases/latest_release.md'`). W jego repo pilnują tego lokalne
 * deklaracje (`modules/komunikator/css.d.ts`, `modules/shell/markdown.d.ts`) — ale tsc widzi
 * tylko pliki ze SWOJEGO `include`, a nasz obejmuje to repo, nie tamto. Bez tej deklaracji
 * `npm run typecheck` tutaj tonie w TS2307 o cudzych plikach.
 *
 * Runtime robi to samo dwoma pluginami tekstowymi w `esbuild.harness.ts` (bliźniaczymi do
 * tych z `esbuild.js` pluginu) — tu tylko dokładamy typy do tego samego kontraktu.
 */
declare module '*.css' {
    const sheet: CSSStyleSheet;
    export default sheet;
}

declare module '*.md' {
    const content: string;
    export default content;
}
