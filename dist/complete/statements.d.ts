import { type ParseCache } from "../parser/index.js";
import { type KeywordDocumentation } from "../types.js";
/** The documentation of the SYSTEM command or access statement clause whose keyword is at `offset`. */
export declare function keywordDocumentation(sql: string, offset: number, cache?: ParseCache): KeywordDocumentation | undefined;
//# sourceMappingURL=statements.d.ts.map