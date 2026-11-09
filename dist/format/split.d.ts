import { type Token } from "../types.js";
export interface Unit {
    /** Offsets of the whole unit: leading comments, the statement, comments after it. */
    start: number;
    end: number;
    /** The statement as check() sees it; null for comments alone. */
    statement: {
        start: number;
        end: number;
    } | null;
    /** Inline INSERT data, printed as written; start is -1 without data. */
    data: {
        start: number;
        end: number;
        blankLine: boolean;
    };
    /** The tokens of the unit, whitespace and comments included, without the ones inside the data. */
    tokens: Token[];
}
/** The number of line breaks in a piece of whitespace. */
export declare function lineBreaks(text: string): number;
export declare function split(sql: string): Unit[];
//# sourceMappingURL=split.d.ts.map