/**
 * Expression elements: a port of src/Parsers/ExpressionElementParsers.cpp.
 * Each parser returns a node, or null after moving back to where it started.
 */
import { Ast } from "./ast.js";
import { P, peekKwQuiet } from "./state.js";
/** ParserIdentifier: a bare word, a quoted name, or a {name:Identifier} parameter. */
export declare function parseIdentifier(p: P, allowParam?: boolean): Ast | null;
/** ParserTableAsStringLiteralIdentifier: a table named by a string, like 'data.csv'. */
export declare function parseTableAsStringLiteral(p: P): Ast | null;
/** ParserCompoundIdentifier: a.b.c, json.a.:Type, or db.table UUID '...'. */
export declare function parseCompoundIdentifier(p: P, tableWithUuid?: boolean, allowParam?: boolean): Ast | null;
/** ParserSubquery; `out.startsValid` tells that it read a SELECT or EXPLAIN but no closing bracket. */
export declare function parseSubquery(p: P, out?: {
    startsValid: boolean;
}): Ast | null;
/** ParserLiteral: NULL, a number, TRUE or FALSE, or a string. */
export declare function parseLiteral(p: P): Ast | null;
export declare function parseNull(p: P): Ast | null;
export declare function parseBool(p: P): Ast | null;
/** ParserNumber: a number with an optional sign, or inf and nan as bare words. */
export declare function parseNumber(p: P): Ast | null;
/** ParserUnsignedInteger, used for x.1 and a few clauses. */
export declare function parseUnsignedInteger(p: P): Ast | null;
/** ParserStringLiteral: a quoted string or a heredoc. */
export declare function parseStringLiteral(p: P): Ast | null;
export declare function parseTupleOfLiterals(p: P): Ast | null;
export declare function parseArrayOfLiterals(p: P): Ast | null;
/** ParserAllCollectionsOfLiterals: nested maps, arrays and tuples of literals. */
export declare function parseAllCollectionsOfLiterals(p: P, allowMap?: boolean): Ast | null;
/** ParserAlias: [AS] name, where a name without AS must not be a clause keyword. */
export declare function parseAlias(p: P, allowWithoutAs: boolean): Ast | null;
/** ParserWithOptionalAlias: an element, then an alias if the element can carry one. */
export declare function parseWithOptionalAlias(p: P, element: () => Ast | null, allowWithoutAs: boolean): Ast | null;
/** ParserSubstitution: a {name:Type} query parameter. */
export declare function parseSubstitution(p: P): Ast | null;
/** ParserMySQLGlobalVariable: @@name or @@session.name. */
export declare function parseMySQLGlobalVariable(p: P): Ast | null;
declare const ALL_TRANSFORMERS: {
    apply: boolean;
    except: boolean;
    replace: boolean;
};
export type Transformers = typeof ALL_TRANSFORMERS;
/** ParserColumnsTransformers: APPLY(f), EXCEPT(a, b) or REPLACE(x AS y) after * or COLUMNS. */
export declare function parseColumnsTransformer(p: P, allowed?: Transformers): Ast | null;
/** True for lambda(tuple(...), body), like isASTLambdaFunction. */
export declare function isLambdaFunction(node: Ast): boolean;
/** ParserAsterisk: * with an optional LIKE pattern and transformers. */
export declare function parseAsterisk(p: P, allowed?: Transformers): Ast | null;
/** ParserQualifiedAsterisk: t.* or db.t.*. */
export declare function parseQualifiedAsterisk(p: P): Ast | null;
/** ParserColumnsMatcher: COLUMNS(a, b) or COLUMNS('regexp'). */
export declare function parseColumnsMatcher(p: P, allowed?: Transformers): Ast | null;
/** ParserQualifiedColumnsMatcher: t.COLUMNS(...). */
export declare function parseQualifiedColumnsMatcher(p: P, allowed?: Transformers): Ast | null;
/** ParserList: elements with a separator, as an ExpressionList. */
export declare function parseList(p: P, element: () => Ast | null, separator?: () => boolean, allowEmpty?: boolean, allowTrailing?: boolean): Ast | null;
/** ParserFilterClause: FILTER (WHERE cond) after an aggregate function. */
export declare function parseFilterClause(p: P, fn: Ast): boolean;
/** ParserWindowReference: OVER name or OVER (definition). */
export declare function parseWindowReference(p: P, fn: Ast): boolean;
/** ParserWindowDefinition: ([parent] [PARTITION BY ...] [ORDER BY ...] [frame]). */
export declare function parseWindowDefinition(p: P): Ast | null;
/** ParserWindowList: name AS (definition), ... */
export declare function parseWindowList(p: P): Ast | null;
/** ParserIdentifierWithParameters: Engine(args), parsed as a function. */
export declare function parseIdentifierWithParameters(p: P): Ast | null;
/** ParserIdentifierWithOptionalParameters: Engine or Engine(args). */
export declare function parseIdentifierWithOptionalParameters(p: P): Ast | null;
/** ParserCodec: (ZSTD(1), Delta) after CODEC. */
export declare function parseCodec(p: P): Ast | null;
/** ParserStatisticsType: (tdigest, uniq) after STATISTICS. */
export declare function parseStatisticsType(p: P): Ast | null;
/** ParserCollation: a name like utf8_unicode_ci. */
export declare function parseCollation(p: P): Ast | null;
/** The text of a literal read by parseLiteralAsText, and what its numbers look like. */
export interface LiteralAsText {
    allNumbers: boolean;
    allIntegers: boolean;
    allNonNegative: boolean;
    hasNull: boolean;
}
/** parseLiteralAsText: a number, or an array or tuple of literals, read as text. */
export declare function parseLiteralAsText(p: P): LiteralAsText | null;
/** ParserCastOperator: a literal followed by ::Type. */
export declare function parseCastOperator(p: P): Ast | null;
/** ParserStorageOrderByElement: an expression, without alias, with ASC or DESC if allowed. */
export declare function parseStorageOrderByElement(p: P, allowOrder: boolean): Ast | null;
/** ParserOrderByElement: expr [ASC|DESC] [NULLS FIRST|LAST] [COLLATE 'x'] [WITH FILL ...]. */
export declare function parseOrderByElement(p: P): Ast | null;
/** ParserInterpolateElement: column [AS expr]. */
export declare function parseInterpolateElement(p: P): Ast | null;
/** ParserFunctionWithKeyValueArguments: SOURCE(CLICKHOUSE(host 'x' port 9000)). */
export declare function parseFunctionWithKeyValueArguments(p: P, bracketsCanBeOmitted?: boolean): Ast | null;
/** ParserAssignment: column = expr. */
export declare function parseAssignment(p: P): Ast | null;
/** ParserTTLElement: expr [DELETE [WHERE ...] | TO DISK|VOLUME 'x' | GROUP BY ... | RECOMPRESS CODEC(...)]. */
export declare function parseTTLElement(p: P): Ast | null;
/** Parses an enum-like data type argument list: 'a' = 1 with ParserLeftAssociativeBinaryOperatorList. */
export declare function parseEnumElement(p: P): Ast | null;
export { peekKwQuiet };
//# sourceMappingURL=elements.d.ts.map