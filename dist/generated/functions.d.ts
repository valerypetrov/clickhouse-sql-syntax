export interface Argument {
    name: string;
    description: string;
    /** The types its documentation ends with, such as `String` or `(U)Int*`. */
    types?: readonly string[];
    /** The values its documentation lists, each with the other spellings that ClickHouse takes for it. */
    values?: readonly (readonly string[])[];
}
export interface FunctionInfo {
    name: string;
    /** An aggregate function, which takes combinators such as sumIf. */
    aggregate?: boolean;
    /** Whether the name may be written in any letter case, like `COUNT` for `count`. */
    caseInsensitive?: boolean;
    /** The function this name is an alias of. */
    aliasTo?: string;
    /** How it is called, such as `toDate(x)`; one form per line. */
    syntax?: string;
    arguments?: readonly Argument[];
    /** The parameters of a parametric aggregate function, as `level` in quantile(level)(x). */
    parameters?: readonly Argument[];
    returns?: string;
    /** The first paragraph of the documentation, as plain text. */
    description?: string;
    category?: string;
}
export declare const FUNCTIONS: readonly FunctionInfo[];
//# sourceMappingURL=functions.d.ts.map