import { type ParseCache } from "../parser/index.js";
import { type ParameterHint } from "../types.js";
/**
 * The parameter of each argument of the function, table function and engine calls with two arguments or more, in the
 * statements that parse, where the parser reads the name as a function or an engine.
 */
export declare function parameterHints(sql: string, cache?: ParseCache): ParameterHint[];
//# sourceMappingURL=hints.d.ts.map