export interface SettingInfo {
    name: string;
    /** The type of its value, such as UInt64 or Bool. */
    type: string;
    default?: string;
    /** The setting this name is an alias of. */
    aliasTo?: string;
    description?: string;
    /** The values of an enum, as ClickHouse lists them. */
    values?: readonly string[];
    /** Whether it takes a comma-separated list of the values. */
    multi?: boolean;
    /** An obsolete setting, which ClickHouse still takes but ignores; completion does not offer it. */
    obsolete?: boolean;
}
export declare const SETTINGS: readonly SettingInfo[];
//# sourceMappingURL=settings.d.ts.map