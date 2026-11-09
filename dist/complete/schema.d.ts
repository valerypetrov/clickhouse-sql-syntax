import { type CompletionCandidate, type CompletionSchema, type Token } from "../types.js";
export type SchemaTable = NonNullable<CompletionSchema["tables"]>[number];
/** A table of the statement, as `[database.]name [AS alias]`. */
export interface TableRef {
    database?: string;
    name: string;
    alias?: string;
}
/** The name a bare word or a quoted identifier stands for. */
export declare function nameOf(sql: string, token: Token | undefined): string | undefined;
/** Is the token the bare word `word`, given in lower case? */
export declare function isWord(sql: string, token: Token | undefined, word: string): boolean;
/** The tables named after FROM, JOIN, INTO, TABLE and UPDATE, and in lists like FROM a, b. */
export declare function tableRefs(sql: string, toks: Token[]): TableRef[];
/** The tables of the schema that a reference may mean: in its database, or in any when it names none. */
export declare function resolve(schema: CompletionSchema, ref: TableRef): SchemaTable[];
/** A database, table or column, inserted in back quotes when it is not a plain identifier. */
export declare function named(candidate: CompletionCandidate): CompletionCandidate;
/** Every database of the schema, listed or holding a table. */
export declare function databases(schema: CompletionSchema): string[];
/** A column that a CREATE statement declares, with its type as written, empty when it is left out. */
export interface DeclaredColumn {
    name: string;
    type: string;
    /** The type the name of the type stands for, such as Int8 for TINYINT. */
    family?: string;
    /** The family of the type in the brackets, as UInt64 in LowCardinality(UInt64). */
    inner?: string;
}
/** A column of the schema, whose type the server writes as ClickHouse names it. */
export declare function schemaColumn(name: string, type: string): DeclaredColumn;
/** The `[database.]name` of the table that a CREATE TABLE statement makes. */
export declare function createdTableName(sql: string, toks: Token[]): TableRef | undefined;
/** The columns in the brackets after the name of the table that CREATE makes, and the table of its `AS [db.]table`. */
export declare function createdTable(sql: string, toks: Token[]): {
    columns: DeclaredColumn[];
    source?: TableRef;
};
/** The names in the ORDER BY, PRIMARY KEY and PARTITION BY clauses after the ENGINE of a statement. */
export declare function keyNames(sql: string, toks: Token[]): Set<string>;
//# sourceMappingURL=schema.d.ts.map