/**
 * Typy `js-yaml` dla kodu pluginu wciąganego przez alias `@plugin/...`.
 *
 * LUSTRO, nie nowy kontrakt: identyczna deklaracja żyje w repo pluginu
 * (`core/utils/js-yaml.d.ts`) i to ona jest źródłem prawdy — paczka `js-yaml` nie wozi
 * własnych typów, a plugin świadomie nie dokłada `@types/js-yaml`. Kopia jest tu, bo tsc
 * widzi wyłącznie pliki ze SWOJEGO `include`, a nasz obejmuje to repo, nie tamto; ambientu
 * z cudzego drzewa nie da się dociągnąć mapowaniem `paths`.
 *
 * Zakres celowo minimalny — dokładnie to, czego plugin używa. Gdyby po tamtej stronie
 * doszła funkcja, typecheck TUTAJ (nie bramka CI) zapali się pierwszy.
 */
declare module 'js-yaml' {
    export interface DumpOptions {
        indent?: number;
        lineWidth?: number;
        noRefs?: boolean;
        sortKeys?: boolean | ((a: string, b: string) => number);
        skipInvalid?: boolean;
        flowLevel?: number;
        styles?: Record<string, string>;
        schema?: unknown;
        noArrayIndent?: boolean;
        condenseFlow?: boolean;
        quotingType?: "'" | '"';
        forceQuotes?: boolean;
        [key: string]: unknown;
    }

    export interface LoadOptions {
        filename?: string;
        onWarning?: (error: Error) => void;
        schema?: unknown;
        json?: boolean;
        [key: string]: unknown;
    }

    /** Parsuje pojedynczy dokument YAML. Rzuca `YAMLException` przy błędzie składni. */
    export function load(str: string, opts?: LoadOptions): unknown;

    /** Serializuje wartość do YAML-a. */
    export function dump(obj: unknown, opts?: DumpOptions): string;

    const _default: {
        load: typeof load;
        dump: typeof dump;
    };
    export default _default;
}
