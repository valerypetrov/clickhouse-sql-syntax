/**
 * SELECT queries: a port of ParserSelectWithUnionQuery.cpp, ParserSelectQuery.cpp,
 * ParserTablesInSelectQuery.cpp, ParserWithElement.cpp, ParserSampleRatio.cpp and ParserPipeOperators.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserSelectWithUnionQuery: selects joined by UNION, EXCEPT and INTERSECT, then pipe operators. */
export declare function parseSelectWithUnionQuery(p: P): Ast | null;
/** ParserUnionQueryElement: a SELECT, or a subquery in brackets. */
export declare function parseUnionQueryElement(p: P): Ast | null;
/** parseOrderByClauseBody: ORDER BY ALL [ASC|DESC] [NULLS ...] or a list with WITH FILL and INTERPOLATE. */
export declare function parseOrderByClauseBody(p: P, node: Ast): boolean;
/** ParserSelectQuery: WITH, SELECT and every clause after it, or the FROM-first form. */
export declare function parseSelectQuery(p: P, implicitSelect?: boolean): Ast | null;
/** ParserWithElement: name [(aliases)] AS [MATERIALIZED] (subquery), or expr AS name. */
export declare function parseWithElement(p: P): Ast | null;
/** ParserTablesInSelectQuery: a table expression followed by joins. */
export declare function parseTablesInSelectQuery(p: P, allowWithoutAs?: boolean): Ast | null;
/** ParserTablesInSelectQueryElement: the first table, or a join, or an ARRAY JOIN. */
export declare function parseTablesInSelectQueryElement(p: P, isFirst: boolean, allowWithoutAs?: boolean): Ast | null;
/** ParserTableExpression: a subquery, table function, table or (joined tables), with FINAL, SAMPLE, STREAM. */
export declare function parseTableExpression(p: P, allowWithoutAs?: boolean): Ast | null;
//# sourceMappingURL=select.d.ts.map