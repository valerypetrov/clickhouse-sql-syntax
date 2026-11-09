/**
 * SET queries and SETTINGS clauses: a port of src/Parsers/ParserSetQuery.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserSetQuery::parseNameValuePair: name = literal, map or disk(...); it does not move back on failure. */
export declare function parseNameValuePair(p: P): boolean;
/** The settings from token `first` to the parser position belong to `context`, as "query" or "storage". */
export declare function markSettings(p: P, first: number, context: string, engine?: number): void;
/** name = value, ... as in named collections and dictionary SETTINGS; `after` runs after each pair. */
export declare function parseNameValuePairs(p: P, after?: () => void): boolean;
/**
 * parseNameValuePairWithParameterOrDefault: name = value, param_name = value, name = DEFAULT,
 * or just name when shorthand is allowed. A {name:Type} value is a "substitution".
 */
export declare function parseSetting(p: P, shorthand: boolean): "setting" | "parameter" | "default" | "substitution" | null;
/**
 * ParserSetQuery. With `onlyInternals` it reads the list after SETTINGS;
 * otherwise a whole SET statement, including SET TIME ZONE.
 */
export declare function parseSetQuery(p: P, onlyInternals?: boolean, shorthand?: boolean, context?: string): Ast | null;
//# sourceMappingURL=set.d.ts.map