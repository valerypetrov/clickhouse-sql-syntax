import { type Statement, type Word } from "./tree.js";
export type DefKind = "alias" | "lambda parameter" | "table alias" | "CTE" | "column" | "query parameter";
/** A name defined in the statement. */
export interface Def {
    id: number;
    kind: DefKind;
    name: string;
    /** Where the name is written as a definition; the first is where it is defined. */
    sites: Word[];
    /** Why renaming it could change the query, when it could. */
    reason?: string;
}
declare const EXT: {
    readonly kind: "external";
};
declare const UNKNOWN: {
    readonly kind: "unknown";
};
type Target = Def | typeof EXT | typeof UNKNOWN;
/** The analysis of a statement: its definitions and what each word resolved to. */
export interface Resolution {
    defs: Def[];
    /** The targets of every word that was resolved, by its start offset. */
    words: Map<number, {
        word: Word;
        targets: Set<Target>;
    }>;
    /** Where a definition is written, by start offset. */
    sites: Map<number, Def>;
}
export declare function isDef(target: Target): target is Def;
/** Settings that change how names resolve; ClickHouse's defaults are assumed unless the text sets them. */
export interface ResolveOptions {
    /** prefer_column_name_to_alias may be on: both readings are tried. */
    preferColumnsMaybe?: boolean;
    /** The settings that the statement or SET before it writes, as param_x for the query parameter x. */
    settings?: Set<string>;
}
export declare function resolveStatement(statement: Statement, options?: ResolveOptions): Resolution;
export {};
//# sourceMappingURL=resolve.d.ts.map