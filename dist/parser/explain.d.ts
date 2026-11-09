/**
 * EXPLAIN queries: a port of src/Parsers/ParserExplainQuery.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/**
 * ParserExplainQuery. A subquery (EXPLAIN ...) uses `selectOnly`, where only
 * SELECT can be explained; a statement can also explain CREATE TABLE, INSERT and SYSTEM.
 */
export declare function parseExplainQuery(p: P, selectOnly?: boolean, allowSettingsAfterFormat?: boolean): Ast | null;
//# sourceMappingURL=explain.d.ts.map