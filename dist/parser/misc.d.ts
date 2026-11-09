/**
 * Smaller statements: RENAME, DROP, UNDROP, CHECK, KILL, OPTIMIZE, USE, transactions, DELETE, UPDATE
 * and SNAPSHOT. Ports of the ClickHouse parsers with the same names.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** UUID 'xxxxxxxx-...'; parseFromString<UUID> throws a non-syntax error for a bad value. */
export declare function parseUuidClause(p: P): boolean;
/** ParserRenameQuery: RENAME|EXCHANGE TABLE|DICTIONARY a TO|AND b, ... and RENAME DATABASE. */
export declare function parseRenameQuery(p: P): Ast | null;
/** ParserDropQuery: DROP, DETACH and TRUNCATE. */
export declare function parseDropQuery(p: P): Ast | null;
/** ParserUndropQuery: UNDROP TABLE [db.]t [UUID 'x'] [ON CLUSTER c]. */
export declare function parseUndropQuery(p: P): Ast | null;
/** ParserCheckQuery: CHECK ALL TABLES, CHECK TABLE t [PARTITION p | PART 'x'], CHECK DATABASE d. */
export declare function parseCheckQuery(p: P): Ast | null;
/** ParserKillQueryQuery: KILL QUERY|MUTATION|PART_MOVE_TO_SHARD|TRANSACTION [ON CLUSTER c] WHERE expr [SYNC|ASYNC|TEST]. */
export declare function parseKillQueryQuery(p: P): Ast | null;
/** ParserOptimizeQuery. */
export declare function parseOptimizeQuery(p: P): Ast | null;
/** ParserUseQuery: USE [DATABASE] name. */
export declare function parseUseQuery(p: P): Ast | null;
/** ParserTransactionControl: BEGIN, START TRANSACTION, COMMIT, ROLLBACK, SET TRANSACTION SNAPSHOT n. */
export declare function parseTransactionControl(p: P): Ast | null;
/** ParserDeleteQuery: DELETE FROM t [ON CLUSTER c] [IN PARTITION p] WHERE expr [SETTINGS ...]. */
export declare function parseDeleteQuery(p: P): Ast | null;
/** ParserUpdateQuery: UPDATE t [ON CLUSTER c] SET a = x, ... [IN PARTITION p] WHERE expr [SETTINGS ...]. */
export declare function parseUpdateQuery(p: P): Ast | null;
/** EXCEPT DATABASE[S] a, b; moves back on failure. */
export declare function parseExceptDatabases(p: P): boolean;
/** EXCEPT TABLE[S] [db.]a, ...; a database other than `database` is a syntax error. */
export declare function parseExceptTables(p: P, database?: string): boolean;
/** ParserSnapshotQuery: SNAPSHOT TABLE t | ALL [EXCEPT ...] TO destination. */
export declare function parseSnapshotQuery(p: P): Ast | null;
//# sourceMappingURL=misc.d.ts.map