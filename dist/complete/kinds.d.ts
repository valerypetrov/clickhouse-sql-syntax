/**
 * What a documented argument of a function takes, by the phrases of its documentation, its types and the values it lists.
 */
import type { Argument, FunctionInfo } from "../generated/functions.js";
import type { ArgumentKind } from "../types.js";
/** The phrases of the documentation that tell each kind, tried in this order after the values it lists. */
export declare const KIND_PHRASES: readonly [ArgumentKind, readonly RegExp[]][];
/** The kind of a documented argument of a function, by its documentation, or undefined for an expression of any kind. */
export declare function argumentKind(info: FunctionInfo, arg: Argument): ArgumentKind | undefined;
//# sourceMappingURL=kinds.d.ts.map