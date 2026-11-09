import { type Role } from "../parser/index.js";
import { type FormatOptions } from "../types.js";
import { type Tok } from "./analyze.js";
import { type Unit } from "./split.js";
export declare function format(sql: string, options?: FormatOptions): string;
/** The significant tokens of a unit as analyze() reads them, given the role of each word by its offset. */
export declare function unitTokens(sql: string, unit: Unit, roles: Map<number, Role>): Tok[];
/** Whether two texts have the same tokens, apart from whitespace and the case of the keywords that keywordAt() finds in a. */
export declare function sameTokens(a: string, b: string, keywordAt: (start: number) => boolean): boolean;
//# sourceMappingURL=format.d.ts.map