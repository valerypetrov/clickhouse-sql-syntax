import type { Argument } from "./functions.js";
export interface TableFunctionInfo {
    name: string;
    description?: string;
    syntax?: string;
    arguments?: readonly Argument[];
}
export declare const TABLE_FUNCTIONS: readonly TableFunctionInfo[];
//# sourceMappingURL=table-functions.d.ts.map