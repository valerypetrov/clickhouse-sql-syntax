/**
 * What the parser accepts at a position, for completion: the variants that ClickHouse's
 * Expected collects there, such as "FROM", "identifier" or "data type".
 */
import { type Token } from "../types.js";
/**
 * The Expected variants at `offset`, after the significant tokens `before` of one statement.
 * The parser reads them followed by a token it never accepts, so it records all it tries there.
 */
export declare function expectedAt(sql: string, before: Token[], offset: number): string[];
/** acceptsKeyword() for the keywords of one place, which share one budget of backtracks and tokens; past it, all pass. */
export declare function keywordFilter(sql: string, before: Token[], offset: number): (keyword: string) => boolean;
//# sourceMappingURL=expected.d.ts.map