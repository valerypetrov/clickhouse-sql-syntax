import { type CompletionCandidate } from "../types.js";
/** What may start an argument of JSON(...), as ClickHouse's ObjectArgumentParser reads it. */
export declare function jsonTypeArguments(lower: boolean): CompletionCandidate[];
/** A path that a JSON type declares with its type, as `a.b UInt32` in JSON(a.b UInt32). */
export interface TypedPath {
    path: string;
    type: string;
}
/** The typed paths of a type written as JSON(...), or none for another type. */
export declare function typedPaths(type: string): TypedPath[];
//# sourceMappingURL=json.d.ts.map