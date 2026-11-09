/**
 * BACKUP and RESTORE: a port of src/Parsers/ParserBackupQuery.cpp.
 */
import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserBackupQuery: BACKUP elements TO name | RESTORE elements FROM name, with SETTINGS and ASYNC|SYNC. */
export declare function parseBackupQuery(p: P): Ast | null;
//# sourceMappingURL=backup.d.ts.map