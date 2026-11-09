/**
 * Smaller DDL statements: functions, workloads, resources, named collections, handlers, indexes,
 * hypothetical objects and COPY. Ports of the ClickHouse parsers with the same names.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserCreateFunctionQuery: AS lambda, a function with a driver, or LANGUAGE WASM. */
export declare function parseCreateFunctionQuery(p: P): Ast | null;
/** ParserDropFunctionQuery. */
export declare function parseDropFunctionQuery(p: P): Ast | null;
/** ParserCreateWorkloadQuery: CREATE [OR REPLACE] WORKLOAD [IF NOT EXISTS] w [ON CLUSTER c] [IN parent] [SETTINGS ...]. */
export declare function parseCreateWorkloadQuery(p: P): Ast | null;
/** ParserDropWorkloadQuery. */
export declare function parseDropWorkloadQuery(p: P): Ast | null;
/** ParserCreateResourceQuery: CREATE [OR REPLACE] RESOURCE [IF NOT EXISTS] r [ON CLUSTER c] (operations). */
export declare function parseCreateResourceQuery(p: P): Ast | null;
/** ParserDropResourceQuery. */
export declare function parseDropResourceQuery(p: P): Ast | null;
/** ParserDropNamedCollectionQuery. */
export declare function parseDropNamedCollectionQuery(p: P): Ast | null;
/** ParserAlterNamedCollectionQuery: ALTER NAMED COLLECTION n [ON CLUSTER c] [SET k = v [[NOT] OVERRIDABLE], ...] [DELETE k, ...]. */
export declare function parseAlterNamedCollectionQuery(p: P): Ast | null;
/** ParserCreateHandlerQuery: CREATE|ALTER HANDLER name [PROTOCOL p|ANY] URL [PREFIX|REGEXP] 'path' [METHODS (...)] [TYPE t] [AS query]. */
export declare function parseCreateHandlerQuery(p: P): Ast | null;
/** ParserDropHandlerQuery. */
export declare function parseDropHandlerQuery(p: P): Ast | null;
/** ParserCreateIndexQuery: CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON [db.]table [ON CLUSTER c] declaration. */
export declare function parseCreateIndexQuery(p: P): Ast | null;
/** ParserDropIndexQuery: DROP INDEX [IF EXISTS] name ON [db.]table [ON CLUSTER c]. */
export declare function parseDropIndexQuery(p: P): Ast | null;
/** ParserHypotheticalObjectQuery: CREATE|DROP HYPOTHETICAL INDEX|PROJECTION ..., DROP ALL HYPOTHETICAL INDEXES|PROJECTIONS. */
export declare function parseHypotheticalObjectQuery(p: P): Ast | null;
/** ParserCopyQuery: COPY table [(columns)] TO|FROM target, or COPY (query) TO target. */
export declare function parseCopyQuery(p: P): Ast | null;
//# sourceMappingURL=ddl.d.ts.map