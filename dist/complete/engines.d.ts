import { type TableEngineInfo } from "../generated/table-engines.js";
import { type Token } from "../types.js";
import { type ArgumentList, type Parameter } from "./syntax.js";
/** A parameter as the syntax of an engine names it, such as `'zoo_path'`, `ver` or `NOSIGN`. */
export type EngineParameter = Parameter;
/** What the brackets of an engine hold, read from its syntax. */
export interface EngineSignature {
    /** The call as the syntax writes it, such as `File(format[, path | fd])`. */
    label: string;
    /** Each parameter once, in the order of the label. */
    parameters: EngineParameter[];
    lists: ArgumentList[];
}
/** Reads `ENGINE = Name(...)` of the engine's syntax, or `ENGINE = Name` for none; undefined for any other form. */
export declare function readSignature(info: TableEngineInfo): EngineSignature | undefined;
export declare function engineSignature(info: TableEngineInfo): EngineSignature | undefined;
export declare function findEngine(name: string): TableEngineInfo | undefined;
/** What a parameter takes, by the name the syntax gives it. */
export type ParameterKind = "zoo path" | "replica" | "sign" | "version" | "is_deleted" | "columns" | "sharding key" | "key" | "format" | "compression" | "cluster" | "database" | "table" | "strictness" | "join kind" | "keyword";
export declare function kindOf(param: EngineParameter): ParameterKind | undefined;
export declare function parameterDescription(param: EngineParameter): string;
/** The methods of ClickHouse's chooseCompressionMethod(), and the other names it takes for them. */
export declare const COMPRESSION: string[];
export declare const STRICTNESS: string[];
/** The join kinds that the Join engine takes after each strictness. */
export declare const JOIN_KINDS: Record<string, string[]>;
/** An argument as written: its value when it is one string or word, and its name when it is `name = value`. */
export interface Written {
    value?: string;
    named?: string;
}
/** The engine call whose brackets the cursor is in, at the top level of them. */
export interface EngineCall {
    info: TableEngineInfo;
    /** The arguments before the one at the cursor. */
    args: Written[];
    /** The tokens of the argument at the cursor that are before it. */
    current: Token[];
    /** The lists that agree with the arguments before, each with a parameter at the cursor. */
    lists: ArgumentList[];
    /** The parameters that the argument at the cursor may be, in the order of the label. */
    parameters: EngineParameter[];
}
/** The engine call at the end of `before`, the tokens of the statement before the cursor. */
export declare function engineCall(sql: string, statement: Token[], before: Token[]): EngineCall | undefined;
//# sourceMappingURL=engines.d.ts.map