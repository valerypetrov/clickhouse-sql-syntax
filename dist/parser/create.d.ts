import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserSQLSecurity: DEFINER = user and SQL SECURITY DEFINER|INVOKER|NONE, in either order. */
export declare function parseSQLSecurity(p: P): Ast | null;
export interface ColumnOptions {
    requireType?: boolean;
    allowNullModifiers?: boolean;
    checkKeywordsAfterName?: boolean;
    /** ParserCompoundColumnDeclaration: the name may be a.b. */
    compoundName?: boolean;
    /** enableCheckTypeKeyword: the type follows TYPE. */
    checkTypeKeyword?: boolean;
}
/** IParserColumnDeclaration: name [Type] [NULL] [DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL expr] [modifiers]. */
export declare function parseColumnDeclaration(p: P, options?: ColumnOptions): Ast | null;
/** ParserColumnDeclarationList. */
export declare function parseColumnDeclarationList(p: P, options?: ColumnOptions): Ast | null;
/** ParserNameList: a list of [db.]table names. */
export declare function parseNameList(p: P): Ast | null;
/** ParserIndexDeclaration: name expr TYPE type(args) [GRANULARITY n]. */
export declare function parseIndexDeclaration(p: P): Ast | null;
/** ParserStatisticsDeclaration: columns TYPE types. */
export declare function parseStatisticsDeclaration(p: P): Ast | null;
/** ParserStatisticsDeclarationWithoutTypes: columns. */
export declare function parseStatisticsDeclarationWithoutTypes(p: P): Ast | null;
/** ParserConstraintDeclaration: name CHECK|ASSUME expr. */
export declare function parseConstraintDeclaration(p: P): Ast | null;
/** parseProjectionDeclarationBody: (SELECT ...) or INDEX exprs TYPE type, then [WITH SETTINGS (...)]. */
export declare function parseProjectionDeclarationBody(p: P, node: Ast): boolean;
/** ParserProjectionDeclaration: name (SELECT ...). */
export declare function parseProjectionDeclaration(p: P): Ast | null;
/** ParserTablePropertiesDeclarationList: the (...) of CREATE TABLE, sorted into columns, indices and the rest. */
export declare function parseTablePropertiesDeclarationList(p: P): Ast | null;
/** ParserStorage: [ENGINE = name(args)] [PARTITION BY ...] [PRIMARY KEY ...] [ORDER BY ...] ... [SETTINGS ...]. */
export declare function parseStorage(p: P): Ast | null;
/** ParserCreateTableQuery: CREATE|ATTACH|REPLACE [TEMPORARY] TABLE ... */
export declare function parseCreateTableQuery(p: P): Ast | null;
/** ParserTableOverrideDeclaration: TABLE OVERRIDE name (COLUMNS (...) PARTITION BY ... ...). */
export declare function parseTableOverrideDeclaration(p: P, standalone?: boolean): Ast | null;
/** ParserRefreshStrategy: AFTER|EVERY interval [OFFSET ...] [RANDOMIZE FOR ...] [DEPENDS ON ...] [SETTINGS ...] [APPEND]. */
export declare function parseRefreshStrategy(p: P): Ast | null;
/** ParserCreateNamedCollectionQuery: CREATE [OR REPLACE] NAMED COLLECTION [IF NOT EXISTS] name [ON CLUSTER c] AS key = value, ... */
export declare function parseCreateNamedCollectionQuery(p: P): Ast | null;
/** ParserCreateQuery: a table, database, view or dictionary. */
export declare function parseCreateQuery(p: P): Ast | null;
//# sourceMappingURL=create.d.ts.map