/**
 * A shallow parser for one valid statement. It finds the words used as keywords and marks where
 * lines break; anything it does not recognise keeps its case and stays on the current line.
 */
import { TokenKind as T } from "../types.js";
/** A significant token of the statement. `up` is the upper-case text of a bare word that is not a name, otherwise "". */
export interface Tok {
    kind: T;
    text: string;
    up: string;
    /** The parser reads the word as a keyword. */
    keyword?: boolean;
    start: number;
    end: number;
    /** Inline INSERT data with the whitespace before it, printed as written. */
    data?: boolean;
}
/** No space after this token: a unary minus, @@. */
export declare const GLUE_AFTER = 1;
/** No space before this token: the "(" of a call, the "[" of a subscript. */
export declare const GLUE_BEFORE = 2;
/** The ":" of a map literal. */
export declare const MAP_COLON = 4;
/** A "(" that opens an indented block on its line, or one on a line of its own. */
export declare const BLOCK_INLINE = 1;
export declare const BLOCK_OWN_LINE = 2;
/** What the analysis found out about each significant token. */
export interface Shape {
    /** 1 for a word used as a keyword. */
    keyword: Uint8Array;
    /** A new line before the token, at this indent from the enclosing block; -1 for none. */
    brk: Int8Array;
    /** BLOCK_* for a "(" whose contents go on their own lines. */
    block: Uint8Array;
    /** GLUE_* and MAP_COLON flags. */
    glue: Uint8Array;
    /** For the "{" of a query parameter, the index of its "}"; the whole parameter is printed as written. */
    verbatim: Int32Array;
    /** For every bracket, the index of the matching one; -1 if unmatched. */
    match: Int32Array;
}
/** What a part of a statement that analyze() read as one piece is. */
export type RegionKind = "query" | "clause" | "list" | "item" | "expression" | "group" | "call" | "name" | "table" | "type" | "column";
/** Takes the parts that analyze() reads: tokens from `start` up to `end`, and a clause's keyword as `name`. */
export type RegionRecorder = (kind: RegionKind, start: number, end: number, name?: string) => void;
export declare function analyze(sig: Tok[], record?: RegionRecorder): Shape;
//# sourceMappingURL=analyze.d.ts.map