import { type Diagnostic } from "../types.js";
import { type NameMark } from "./names.js";
import { type RoleSpan } from "./roles.js";
/** Line and column of every offset, with lines ending at \n, \r\n or a lone \r. */
export declare class Lines {
    readonly text: string;
    private readonly starts;
    constructor(text: string);
    at(offset: number): {
        line: number;
        col: number;
    };
}
/** The edit distance of two words, ignoring case, as levenshteinDistanceCaseInsensitive. */
export declare function levenshtein(a: string, b: string): number;
/** What checking one statement gave, with offsets from where it begins; or that it needs more than `over` backtracks. */
type Checked = {
    diagnostics: Omit<Diagnostic, "line" | "col">[];
    spans: RoleSpan[];
    names: NameMark[];
    next: number;
    backtracks: number;
    over?: undefined;
} | {
    over: number;
};
/**
 * Statements checked before, by their text from where they begin to their first ';', for later calls
 * of checkWithRoles() to take instead of parsing them again. It keeps the `size` used last.
 */
export declare class ParseCache {
    private readonly size;
    private readonly checked;
    constructor(size?: number);
    get(text: string): Checked | undefined;
    set(text: string, checked: Checked): void;
}
/** Returns the syntax errors of every statement in `sql`. */
export declare function check(sql: string): Diagnostic[];
/** The roles of the words of every statement without syntax errors. */
export declare function roles(sql: string): RoleSpan[];
/** check() and roles() in one pass, taking the statements that `cache` has from it. */
export declare function checkWithRoles(sql: string, cache?: ParseCache): {
    diagnostics: Diagnostic[];
    spans: RoleSpan[];
};
/** A statement without syntax errors: where it begins and where the next one may begin, its roles, and its marks from `begin`. */
export interface ParsedStatement {
    begin: number;
    end: number;
    spans: RoleSpan[];
    names: NameMark[];
}
/** The statements without syntax errors, with what names analysis needs, through the same cache as checkWithRoles(). */
export declare function parsedStatements(sql: string, cache?: ParseCache): ParsedStatement[];
export {};
//# sourceMappingURL=check.d.ts.map