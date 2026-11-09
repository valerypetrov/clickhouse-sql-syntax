/** Prints a statement from its tokens, comments and the shape that analyze() found. */
import { type KeywordCase } from "../types.js";
import { type Shape, type Tok } from "./analyze.js";
/** A comment and where it stood in the source. */
export interface Note {
    text: string;
    /** Nothing but whitespace before it on its line. */
    ownLine: boolean;
    /** A line break follows it. */
    newlineAfter: boolean;
    /** A -- # or // comment, which runs to the end of the line. */
    line: boolean;
}
export interface Piece {
    sig: Tok[];
    /** notes[i] are the comments before sig[i]; notes[sig.length] are the ones after the last token. */
    notes: Note[][];
    /** Whether anything (whitespace or a comment) separated sig[i] from sig[i - 1] in the source. */
    gap: Uint8Array;
    /** The source, for query parameters printed as written. */
    sql: string;
}
export declare function print(piece: Piece, shape: Shape, keywordCase: KeywordCase, unit: string, eol: string): string;
//# sourceMappingURL=print.d.ts.map