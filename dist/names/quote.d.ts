/**
 * Names as ClickHouse writes them: plain when the parser reads them back as the same name,
 * in quotes otherwise, as writeProbablyBackQuotedString in src/IO/WriteHelpers.cpp does.
 */
/** Whether ClickHouse writes this name in quotes. */
export declare function needsQuotes(name: string): boolean;
/** The name in back quotes or double quotes, escaped as writeAnyQuotedString does. */
export declare function quote(name: string, mark?: "`" | '"'): string;
/** The name as it should be written in place of a word that was written with `original` quotes, if any. */
export declare function written(name: string, original?: string): string;
//# sourceMappingURL=quote.d.ts.map