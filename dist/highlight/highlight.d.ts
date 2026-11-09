import { type HighlightSpan } from "../types.js";
/** The commands of SYSTEM queries, from ASTSystemQuery::Type in src/Parsers/ASTSystemQuery.h. */
export declare const SYSTEM_COMMANDS: readonly string[];
/** Returns coloured spans for `sql`, sorted by offset. */
export declare function highlight(sql: string): HighlightSpan[];
//# sourceMappingURL=highlight.d.ts.map