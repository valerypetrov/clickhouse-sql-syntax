/**
 * ALTER TABLE and ALTER DATABASE: a port of src/Parsers/ParserAlterQuery.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserStringAndSubstitution: a part name as a string or a {name:String} parameter. */
export declare function parseStringAndSubstitution(p: P): Ast | null;
/** ParserAlterQuery: ALTER [TEMPORARY] TABLE t [ON CLUSTER c] commands, or ALTER DATABASE d ... */
export declare function parseAlterQuery(p: P): Ast | null;
//# sourceMappingURL=alter.d.ts.map