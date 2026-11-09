/**
 * SHOW, DESCRIBE and EXISTS queries: a port of ParserShowTablesQuery.cpp, ParserShowColumnsQuery.cpp,
 * ParserShowIndexesQuery.cpp, ParserTablePropertiesQuery.cpp, ParserDescribeTableQuery.cpp and friends.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserShowTablesQuery: SHOW TABLES, DATABASES, CLUSTERS, MERGES, SETTINGS, DICTIONARIES and the like. */
export declare function parseShowTablesQuery(p: P): Ast | null;
/** ParserShowColumnsQuery: SHOW [EXTENDED] [FULL] COLUMNS|FIELDS FROM t [FROM db] [[NOT] LIKE ... | WHERE ...] [LIMIT n]. */
export declare function parseShowColumnsQuery(p: P): Ast | null;
/** ParserShowEnginesQuery. */
export declare function parseShowEnginesQuery(p: P): Ast | null;
/** ParserShowFunctionsQuery: SHOW FUNCTIONS [[I]LIKE 'x']. */
export declare function parseShowFunctionsQuery(p: P): Ast | null;
/** ParserShowIndexesQuery: SHOW [EXTENDED] INDEX|INDEXES|INDICES|KEYS FROM t [FROM db] [WHERE expr]. */
export declare function parseShowIndexesQuery(p: P): Ast | null;
/** ParserShowSettingQuery: SHOW SETTING name. */
export declare function parseShowSettingQuery(p: P): Ast | null;
/** ParserShowProcesslistQuery. */
export declare function parseShowProcesslistQuery(p: P): Ast | null;
/** ParserTablePropertiesQuery: EXISTS [TEMPORARY] TABLE|VIEW|DICTIONARY|DATABASE x and SHOW CREATE ... x. */
export declare function parseTablePropertiesQuery(p: P): Ast | null;
/** ParserDescribeCacheQuery: DESCRIBE FILESYSTEM CACHE 'name'. */
export declare function parseDescribeCacheQuery(p: P): Ast | null;
/** ParserDescribeTableQuery: DESCRIBE [TEMPORARY] [TABLE] table | (subquery) | SELECT ... [SETTINGS ...]. */
export declare function parseDescribeTableQuery(p: P): Ast | null;
//# sourceMappingURL=show.d.ts.map