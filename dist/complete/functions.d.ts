import type { Argument, FunctionInfo } from "../generated/functions.js";
import { type CompletionCandidate, type CompletionSchema, type Token } from "../types.js";
import { type DeclaredColumn } from "./schema.js";
import { type ArgumentList, type Parameter } from "./syntax.js";
/** The types to offer where a type name goes: each type as ClickHouse names it, not its aliases like BIGINT. */
export declare function typeNames(skip?: RegExp): string[];
/** A string literal of the text. */
export declare function literal(text: string): string;
/** The lists of arguments in each pair of brackets of a function. */
interface FunctionSignature {
    /** The lists of the parameters of a parametric aggregate function, as `level` in quantile(level)(x). */
    parameters: ArgumentList[];
    arguments: ArgumentList[];
    /** Whether the lists come from the syntax, not from the documented arguments in their order. */
    read: boolean;
}
/**
 * Reads each line of the syntax that calls the function, such as `quantile(level)(expr)` or `or CAST(x AS T)`;
 * a function whose syntax gives no list has its documented arguments in their order.
 */
export declare function functionSignature(info: FunctionInfo): FunctionSignature;
/** The function call whose brackets the cursor is in, at the top level of them. */
export interface FunctionCall {
    info: FunctionInfo;
    tableFunction?: boolean;
    /** The function the name stands for, the target of an alias. */
    target: FunctionInfo;
    /** Whether the brackets hold the parameters of a parametric aggregate function, the first of two pairs. */
    inParameters: boolean;
    /** The index of the argument at the cursor, and how many arguments the brackets hold. */
    index: number;
    count: number;
    /** The tokens of the argument at the cursor that are before it. */
    current: Token[];
    /** The name that each argument before the cursor is, when it is one. */
    names: (string | undefined)[];
    /** The documented arguments that the argument at the cursor may be, each with the word of the syntax it is. */
    arguments: {
        arg: Argument;
        word: Parameter;
        afterKeyword: boolean;
    }[];
}
/** The function call at the end of `before`, the tokens of the statement before the cursor, in `statement`. */
export declare function functionCall(sql: string, statement: Token[], before: Token[]): FunctionCall | undefined;
/** Whether a column of the family fits one of the documented types, or undefined when they say any type does. */
export declare function fitsTypes(types: readonly string[], family: string | undefined): boolean | undefined;
/** A suggestion and its tier: the lower, the earlier. */
export interface Ranked {
    tier: number;
    candidate: CompletionCandidate;
}
export interface FunctionContext {
    call: FunctionCall;
    schema?: CompletionSchema;
    /** The columns the statement may use: of the table it makes, and of the tables it reads in the schema. */
    columns: {
        column: DeclaredColumn;
        documentation?: string;
    }[];
    /** The tier of the columns that fit no documented type. */
    columnTier: number;
    /** Whether keywords are written in lower case, after a prefix in lower case. */
    lower: boolean;
}
/** The suggestions for the argument at the cursor of a function, by what each documented argument there takes. */
export declare function functionCandidates(context: FunctionContext): Ranked[];
export {};
//# sourceMappingURL=functions.d.ts.map