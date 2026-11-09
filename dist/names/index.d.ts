import { type NameLocation, type NameOptions, type PrepareRenameResult, type RenameResult } from "../types.js";
export { objectDefinitions, objectReferences, objects } from "./objects.js";
/** Where the name at `offset` is defined; empty when it is not defined in the statement or is ambiguous. */
export declare function definition(sql: string, offset: number, options?: NameOptions): NameLocation[];
/** Every place in the statement that names the same definition as the name at `offset`, definitions included. */
export declare function references(sql: string, offset: number, options?: NameOptions): NameLocation[];
/** The name at `offset` and its range, when it can be renamed, or why not. */
export declare function prepareRename(sql: string, offset: number, options?: NameOptions): PrepareRenameResult;
/** The edits that rename the name at `offset` to `newName`, quoted where needed, or why it cannot be renamed. */
export declare function rename(sql: string, offset: number, newName: string, options?: NameOptions): RenameResult;
//# sourceMappingURL=index.d.ts.map