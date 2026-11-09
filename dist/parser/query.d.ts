import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserQueryWithOutput: SELECT, SHOW, CREATE, ALTER and the like, then INTO OUTFILE, FORMAT and SETTINGS. */
export declare function parseQueryWithOutput(p: P, allowSettingsAfterFormat?: boolean): Ast | null;
/** ParserQuery with the settings of `clickhouse format`: no implicit SELECT. */
export declare function parseQuery(p: P, allowSettingsAfterFormat?: boolean): Ast | null;
//# sourceMappingURL=query.d.ts.map