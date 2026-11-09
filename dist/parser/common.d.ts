/**
 * Small helpers shared by the statement parsers: ON CLUSTER, [db.]table names, PARTITION and time intervals.
 * Ports of parseDatabaseAndTableName.cpp, parseIdentifierOrStringLiteral.cpp, ParserPartition.cpp
 * and ParserTimeInterval.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** parseIdentifierOrStringLiteral: a name or a non-empty string; moves back on failure. */
export declare function parseIdentifierOrStringLiteral(p: P): string | null;
/** parseIdentifiersOrStringLiterals: a non-empty comma-separated list of them. */
export declare function parseIdentifiersOrStringLiterals(p: P): string[] | null;
/** ASTQueryWithOnCluster::parse, called after ON: CLUSTER name. */
export declare function parseCluster(p: P): boolean;
/** An optional ON CLUSTER clause; false if ON is not followed by a valid CLUSTER name. */
export declare function parseOnCluster(p: P): boolean;
/** parseDatabaseAndTableName: [db.]table with plain identifiers. It does not move back on failure. */
export declare function parseDatabaseAndTableName(p: P): {
    database: string;
    table: string;
} | null;
/** parseDatabaseAndTableAsAST: [db.]table where both may be {name:Identifier} parameters. */
export declare function parseDatabaseAndTableAsAST(p: P): boolean;
/** parseDatabaseAsAST. */
export declare function parseDatabaseAsAST(p: P): boolean;
export interface TableNameOrAsterisks {
    database: string;
    table: string;
    wildcard: boolean;
    /** The name has no database part, so the current database is meant. */
    defaultDatabase: boolean;
}
/** parseDatabaseAndTableNameOrAsterisks: *, *.*, db.*, db.table or table, a name maybe with a * wildcard after it. */
export declare function parseDatabaseAndTableNameOrAsterisks(p: P): TableNameOrAsterisks | null;
/** ParserPartition: ID 'x', ALL, or a partition expression. */
export declare function parsePartition(p: P): Ast | null;
/** A CalendarTimeInterval: months and seconds, kept apart because months differ in length. */
export interface TimeInterval {
    months: number;
    seconds: number;
}
/** CalendarTimeInterval::minSeconds and maxSeconds: a month is 28 to 31 days, a year 365 to 366. */
export declare function intervalSeconds(interval: TimeInterval, longest: boolean): number;
/** ParserTimeInterval: 1 HOUR 30 MINUTE, as in REFRESH EVERY. */
export declare function parseTimeInterval(p: P, allowZero?: boolean, allowMixing?: boolean): TimeInterval | null;
//# sourceMappingURL=common.d.ts.map