import { Ast } from "./ast.js";
import { P } from "./state.js";
/** parseIntervalKind: DAY, DAYS, SQL_TSI_DAY, DD, D and so on; returns the kind or null. */
export declare function parseIntervalKind(p: P): string | null;
/** The tokens of a string, for the parts of the parser that read inside literals. */
export declare function subParser(text: string): P;
/** ParserExpression: any expression, including lambdas. */
export declare function parseExpression(p: P, allowTrailingCommas?: boolean): Ast | null;
/** ParserTableFunctionExpression: an argument of a table function. */
export declare function parseTableFunctionExpression(p: P): Ast | null;
/** ParserArray: [x, y]. */
export declare function parseArray(p: P): Ast | null;
/** ParserFunction: f(args), with parameters f(p)(args) if allowed. */
export declare function parseFunction(p: P, allowParameters?: boolean, isTableFunction?: boolean): Ast | null;
/** ParserExpressionWithOptionalArguments: f(args) or just f. */
export declare function parseExpressionWithOptionalArguments(p: P): Ast | null;
/** ParserLeftAssociativeBinaryOperatorList, for the few places that still use it. */
export declare function parseLeftAssociativeOperators(p: P, operators: [string, string][], element: () => Ast | null): Ast | null;
/** ParserExpressionWithOptionalAlias. */
export declare function parseExpressionWithOptionalAlias(p: P, allowWithoutAs: boolean, isTableFunction?: boolean, allowTrailingCommas?: boolean): Ast | null;
/** ParserExpressionList: a comma-separated list of expressions, possibly empty. */
export declare function parseExpressionList(p: P, allowWithoutAs: boolean, isTableFunction?: boolean, allowTrailingCommas?: boolean): Ast | null;
/** ParserNotEmptyExpressionList. */
export declare function parseNotEmptyExpressionList(p: P, allowWithoutAs: boolean, allowTrailingCommas?: boolean): Ast | null;
export declare function parseStorageOrderByExpressionList(p: P, allowOrder: boolean): Ast | null;
export declare function parseOrderByExpressionList(p: P): Ast | null;
export declare function parseAliasesExpressionList(p: P): Ast | null;
/** GROUPING SETS ((a, b), c, ()). */
export declare function parseGroupingSetsExpressionList(p: P): Ast | null;
export declare function parseInterpolateExpressionList(p: P): Ast | null;
export declare function parseTTLExpressionList(p: P): Ast | null;
/** ParserKeyValuePairsList: pairs separated by nothing. */
export declare function parseKeyValuePairsList(p: P): Ast | null;
/**
 * Whether the brackets at `open` hold an expression over a column named `from`
 * rather than a FROM-first subquery. Does not move the position.
 */
export declare function parenthesesHoldExpressionOverColumnNamedFrom(p: P, open: number): boolean;
//# sourceMappingURL=expression.d.ts.map