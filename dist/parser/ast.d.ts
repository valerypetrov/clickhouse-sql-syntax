/**
 * A light syntax tree. The checker builds only what ClickHouse's parser looks at
 * when it decides whether a query is valid, not a full AST.
 */
/** A literal value, typed like ClickHouse's Field. */
export type Lit = {
    t: "Null";
} | {
    t: "Bool";
    v: boolean;
} | {
    t: "UInt64" | "Int64" | "Float64";
    v: number;
} | {
    t: "String";
    v: string;
} | {
    t: "Array" | "Tuple" | "Map";
    v: Lit[];
};
/** The node type, named after ClickHouse's AST classes: Function, Literal, SelectQuery, ... */
export type AstKind = string;
export declare class Ast {
    kind: AstKind;
    children: Ast[];
    name: string;
    alias: string;
    /** Identifier parts; a query parameter part is an empty string. */
    parts?: string[];
    /** Literal value. */
    value?: Lit;
    /** Function parameters, as in quantile(0.5)(x). */
    params?: Ast[];
    /** Where the inline data of an INSERT starts, as an offset into the text. */
    data?: number;
    /** Named fields of statement and clause nodes. */
    fields?: Record<string, Ast | undefined>;
    flags?: Set<string>;
    constructor(kind: AstKind);
    set(name: string, value: Ast | undefined | null): this;
    get(name: string): Ast | undefined;
    flag(name: string, on?: boolean): this;
    has(name: string): boolean;
}
/**
 * The depth of the deepest node of ClickHouse's AST for this tree, as IAST::checkDepth counts it.
 * A node can have several parents (x in x BETWEEN a AND b), so each height is computed once.
 */
export declare function astDepth(root: Ast): number;
/** Nodes that can carry an alias, like ClickHouse's ASTWithAlias. */
export declare function canHaveAlias(node: Ast): boolean;
/** Sets a part of `node` and tells whether there is one, for the parsers that return a boolean. */
export declare function keep(node: Ast, name: string, value: Ast | null): boolean;
export declare function identifier(parts: string[]): Ast;
export declare function literal(value: Lit): Ast;
export declare function func(name: string, args?: Ast[]): Ast;
export declare function list(children?: Ast[]): Ast;
export declare function isIdentifier(node: Ast | undefined | null): node is Ast;
/** The name of a plain identifier, or undefined; like tryGetIdentifierName. */
export declare function identifierName(node: Ast | undefined | null): string | undefined;
/** True if the identifier is a {name:Identifier} query parameter or has one in its parts. */
export declare function isParam(node: Ast): boolean;
export declare function functionName(node: Ast | undefined | null): string | undefined;
export declare function stringValue(node: Ast | undefined | null): string | undefined;
//# sourceMappingURL=ast.d.ts.map