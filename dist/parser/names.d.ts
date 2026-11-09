/**
 * The queries, tables, aliases, lambdas and identifiers that a successful parse read, for names analysis,
 * whose marks past the position are dropped when the parser moves back, as the roles are.
 */
import type { Ast } from "./ast.js";
import type { P } from "./state.js";
export type NameMarkKind = 
/** A SELECT; `part` is its select list. */
"query"
/** SELECTs joined by UNION and the like; the flag "pipe" marks pipe operators. */
 | "union"
/** A WITH element: a CTE named `name` (flag "cte") with column names `part`, or an expression (flag "expr"). */
 | "with"
/** A table expression; the flag tells its source, `alias` its alias and `part` its column names. */
 | "table"
/** A join after the first table; the flag is its kind, `part` its USING list or ON condition. */
 | "join"
/** An ARRAY JOIN; `part` is its list. */
 | "arrayjoin"
/** An aliased expression `part` named `name`; the flag tells what the expression is. */
 | "alias"
/** A lambda with the parameters `part`. */
 | "lambda"
/** An identifier read as an expression. */
 | "ref"
/** The name of a function call. */
 | "call"
/** *, t.*, COLUMNS(...) with the qualifier `name`; the flag "transformers" marks EXCEPT, REPLACE or APPLY. */
 | "matcher"
/** The INTERPOLATE list. */
 | "interpolate"
/** Something names analysis does not follow, such as a subquery of EXPLAIN. */
 | "opaque"
/** A list of settings; the flag tells what it belongs to, `name` is the engine of a storage. Names analysis skips it. */
 | "settings"
/** The [db.]name of a table, view or dictionary. Names analysis skips it. */
 | "object";
/** A mark with the offsets of its first and last token, from where its statement begins; ranges are [start, end). */
export interface NameMark {
    kind: NameMarkKind;
    start: number;
    end: number;
    name?: [number, number];
    part?: [number, number];
    alias?: [number, number];
    flag?: string;
}
/** Token ranges are inclusive [first, last] while parsing. */
type Range = [number, number];
interface Pending {
    /** The token index of the last token, which a move back to it or before drops. */
    key: number;
    kind: NameMarkKind;
    range: Range;
    name?: Range;
    part?: Range;
    alias?: Range;
    flag?: string;
}
export declare class NameMarks {
    private readonly p;
    private readonly marks;
    constructor(p: P);
    /** A mark over the tokens `first` to `last`; marks stay sorted by their last token. */
    add(kind: NameMarkKind, first: number, last: number, extra?: Omit<Pending, "key" | "kind" | "range">): void;
    /** The parser moved back to token `i`. */
    rewind(i: number): void;
    /** The marks before the parser position, with offsets from `base`. */
    list(base: number): NameMark[];
}
/** What an aliased node is, as the flag of its alias mark. */
export declare function aliasKind(node: Ast): string;
export {};
//# sourceMappingURL=names.d.ts.map