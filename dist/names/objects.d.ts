import { type NameOptions, type ObjectReference, type SqlObject } from "../types.js";
export declare function objects(sql: string): SqlObject[];
export declare function objectReferences(sql: string, options?: NameOptions): ObjectReference[];
export declare function objectDefinitions<F>(reference: ObjectReference, file: F, files: ReadonlyMap<F, readonly SqlObject[]>): {
    file: F;
    object: SqlObject;
}[];
//# sourceMappingURL=objects.d.ts.map