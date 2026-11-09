import { type CompleteOptions, type CompletionCandidate, type EngineArgument, type FunctionArgument } from "../types.js";
/** Suggestions at `offset` of `sql`, best first, for the word that ends there. */
export declare function complete(sql: string, offset: number, options?: CompleteOptions): CompletionCandidate[];
/** The function whose brackets `offset` is in, and the documented arguments that the argument there may be. */
export declare function functionArgument(sql: string, offset: number): FunctionArgument | undefined;
/** The engine whose brackets `offset` is in, and the parameters that the argument there may be. */
export declare function engineArgument(sql: string, offset: number): EngineArgument | undefined;
//# sourceMappingURL=complete.d.ts.map