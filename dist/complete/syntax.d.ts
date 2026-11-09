/**
 * The lists of arguments that the syntax of a call in the catalog allows, such as `File(format[, path | fd])` of an
 * engine or `JSONExtract(json[, indices_or_keys, ...], return_type)` of a function.
 */
/** A parameter as a syntax names it, such as `'zoo_path'`, `ver` or `NOSIGN`. */
export interface Parameter {
    /** The name without its quotes; the words joined by spaces for a parameter of several. */
    name: string;
    /** Written in quotes, so the argument is a string. */
    quoted: boolean;
    /** A word in capitals, such as NOSIGN, that the argument is. */
    keyword: boolean;
    /** `key = value`: an argument given by name. */
    named: boolean;
    /** The words of one argument written as several, as INTERVAL, x and unit in `INTERVAL x unit`. */
    words?: Parameter[];
}
/**
 * A list of arguments whose last parameter may follow any number of times with `repeats`, and then those of `tail`,
 * as `return_type` after `indices_or_keys, ...`.
 */
export interface ArgumentList {
    parameters: Parameter[];
    repeats: boolean;
    tail?: Parameter[];
}
/** What the brackets of a call hold, read from its syntax. */
export interface CallSyntax {
    /** Each parameter once, in the order of the syntax. */
    parameters: Parameter[];
    lists: ArgumentList[];
}
/** The lists of arguments that the syntax of the brackets' contents allows, or undefined for one it cannot read. */
export declare function readArguments(text: string, closes?: (param: Parameter) => boolean): CallSyntax | undefined;
/**
 * The parameter that the argument at `index` of a list is, of `count` arguments in all when known; past the
 * repeated parameter, the last `tail.length` arguments are those of the tail.
 */
export declare function parameterAt(list: ArgumentList, index: number, count?: number): Parameter | undefined;
/** The index of the bracket that closes the one at `open` in a text, or -1. */
export declare function closingBracket(text: string, open: number): number;
//# sourceMappingURL=syntax.d.ts.map