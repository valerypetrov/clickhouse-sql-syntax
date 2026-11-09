/**
 * The queries, tables, aliases, lambdas and identifiers of one statement, nested as the marks of a successful
 * parse show them, so that the structure never comes from guesses over the tokens.
 */
import { type ParsedStatement } from "../parser/index.js";
import { type Token } from "../types.js";
/** One part of a name as written: its offsets and its name without quotes. */
export interface Word {
    start: number;
    end: number;
    name: string;
    quoted: boolean;
}
interface Base {
    id: number;
    start: number;
    end: number;
    parent?: Node;
    children: Node[];
}
export interface Union extends Base {
    kind: "union";
    pipe: boolean;
}
export interface Query extends Base {
    kind: "query";
    recursive: boolean;
    projection?: [number, number];
    /** The items of the select list, in order. */
    items: Item[];
}
export type Item = ({
    kind: "alias";
    node: Alias;
} | {
    kind: "ref";
    node: Ref;
} | {
    kind: "matcher";
    node: Matcher;
} | {
    kind: "expression";
}) & {
    start: number;
    end: number;
};
export interface With extends Base {
    kind: "with";
    /** The CTE name, or undefined for `expr AS name`. */
    name?: Word;
    columns?: Word[];
    materialized: boolean;
}
export interface Table extends Base {
    kind: "table";
    source: "name" | "function" | "subquery" | "string" | "joined";
    /** The parts of a table name, or the name of a table function. */
    name: Word[];
    alias?: Word;
    columns?: Word[];
}
export interface Join extends Base {
    kind: "join";
    join: string;
    natural: boolean;
    lateral: boolean;
    using?: [number, number];
    on?: [number, number];
}
export interface ArrayJoin extends Base {
    kind: "arrayjoin";
    left: boolean;
    list: [number, number];
}
export interface Alias extends Base {
    kind: "alias";
    name: Word;
    body: [number, number];
    node: string;
}
export interface Lambda extends Base {
    kind: "lambda";
    params: Word[];
    paramsRange: [number, number];
}
export interface Ref extends Base {
    kind: "ref";
    parts: Word[];
    /** The parts could not be read as plain names, as in json.a.:Int64 or a {name:Identifier} part. */
    unsupported: boolean;
}
export interface Call extends Base {
    kind: "call";
    parts: Word[];
}
export interface Matcher extends Base {
    kind: "matcher";
    qualifier?: Word[];
    plain: boolean;
}
export interface Interpolate extends Base {
    kind: "interpolate";
}
export interface Opaque extends Base {
    kind: "opaque";
}
export type Node = Union | Query | With | Table | Join | ArrayJoin | Alias | Lambda | Ref | Call | Matcher | Interpolate | Opaque;
/** A query parameter {name:Type}: the offsets of its name. */
export interface QueryParameter {
    word: Word;
}
export interface Statement {
    sql: string;
    begin: number;
    end: number;
    /** The outermost nodes. */
    roots: Node[];
    nodes: Node[];
    parameters: QueryParameter[];
    /** Setting names written in the statement, in lower case. */
    settings: string[];
    /** Where the keyword GROUP of GROUP BY is written. */
    groups: number[];
    /** The first keywords of the statement, in upper case. */
    head: string[];
    /** Why the statement cannot be analyzed, when it cannot. */
    unsupported?: string;
    tokens: Token[];
    /** Index of the token at each start offset. */
    tokenAt: Map<number, number>;
    /** For each bracket token index, the index of the matching one. */
    match: Int32Array;
    /** For each token index, the index of the innermost bracket open around it, or -1. */
    enclosing: Int32Array;
}
/** The statement's tree, from the significant tokens of the whole text and the parse of the statement. */
export declare function buildStatement(sql: string, tokens: Token[], parsed: ParsedStatement): Statement;
/** The structure is not one this analysis follows. */
export declare class Unsupported extends Error {
}
/** The name a word token stands for. */
export declare function nameOf(sql: string, token: Token): string | undefined;
export {};
//# sourceMappingURL=tree.d.ts.map