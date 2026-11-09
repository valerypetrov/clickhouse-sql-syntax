import { type CompletionCandidate } from "../types.js";
/** The parameters that clickhouse-test sets for the tests that use them. */
export declare const TEST_PARAMETERS: Readonly<Record<string, string>>;
/** The names of the parameters that `sql` writes, as {name:Type} or as a param_name setting. */
export declare function parameterNames(sql: string): Set<string>;
/** `Identifier`, where the type of a parameter goes. */
export declare function identifierType(): CompletionCandidate;
/** The names of the parameters of `sql`, where the name of a parameter goes, and those of clickhouse-test after them. */
export declare function parameterNameCandidates(sql: string): {
    tier: number;
    candidate: CompletionCandidate;
}[];
/** param_name for each parameter of `sql`, where a setting goes. */
export declare function parameterSettings(sql: string): CompletionCandidate[];
//# sourceMappingURL=parameters.d.ts.map