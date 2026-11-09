import { type CompletionCandidate, type CompletionSchema } from "../types.js";
import { type EngineCall } from "./engines.js";
import { type DeclaredColumn } from "./schema.js";
/** A suggestion and its tier: the lower, the earlier. */
export interface Ranked {
    tier: number;
    candidate: CompletionCandidate;
}
export interface EngineContext {
    sql: string;
    call: EngineCall;
    /** The columns of the table the statement makes. */
    columns: DeclaredColumn[];
    /** The names in the sorting, primary and partition keys of the statement. */
    keys: Set<string>;
    schema: CompletionSchema;
    /** Whether keywords are written in lower case, after a prefix in lower case. */
    lower: boolean;
}
/** The suggestions for the argument at the cursor, by what each parameter there takes. */
export declare function engineCandidates(context: EngineContext): Ranked[];
//# sourceMappingURL=arguments.d.ts.map