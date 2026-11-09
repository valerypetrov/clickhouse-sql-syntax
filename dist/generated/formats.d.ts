export interface FormatInfo {
    name: string;
    /** Whether INSERT can read data in it. */
    input?: boolean;
    /** Whether SELECT can write its result in it. */
    output?: boolean;
    /** Whether formatRow() can write one row in it. */
    rows?: boolean;
    description?: string;
}
export declare const FORMATS: readonly FormatInfo[];
//# sourceMappingURL=formats.d.ts.map