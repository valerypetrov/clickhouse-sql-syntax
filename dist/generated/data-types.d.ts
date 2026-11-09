export interface DataTypeName {
    name: string;
    /** Whether the name may be written in any letter case, like `date` for `Date`. */
    caseInsensitive: boolean;
    /** The type this name is an alias of, or an empty string. */
    aliasTo: string;
}
export declare const DATA_TYPES: readonly DataTypeName[];
//# sourceMappingURL=data-types.d.ts.map