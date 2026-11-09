export interface TableEngineInfo {
    name: string;
    /** How a table uses it, such as `ENGINE = Memory`. */
    syntax?: string;
    description?: string;
}
export declare const TABLE_ENGINES: readonly TableEngineInfo[];
//# sourceMappingURL=table-engines.d.ts.map