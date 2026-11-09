/**
 * INSERT queries: a port of src/Parsers/ParserInsertQuery.cpp.
 * The node remembers where the inline data starts, as an offset into the text.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserInsertQuery. `data` is set to the offset of the inline data, if there is any. */
export declare function parseInsertQuery(p: P, allowSettingsAfterFormat?: boolean): Ast | null;
//# sourceMappingURL=insert.d.ts.map