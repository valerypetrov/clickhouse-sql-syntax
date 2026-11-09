export interface KeywordDoc {
    /** The keywords it documents, such as FLUSH LOGS after SYSTEM, or VALID UNTIL in CREATE USER. */
    keywords: readonly string[];
    markdown: string;
}
export interface AccessStatementDoc {
    /** Such as CREATE USER. */
    statement: string;
    markdown: string;
    clauses: readonly KeywordDoc[];
}
export declare const SYSTEM_DOCS: readonly KeywordDoc[];
export declare const ACCESS_DOCS: readonly AccessStatementDoc[];
//# sourceMappingURL=statements.d.ts.map