import type { SettingInfo } from "./settings.js";
export interface SettingList {
    /** The macro that declares it in the sources, such as KAFKA_RELATED_SETTINGS. */
    name: string;
    settings: readonly SettingInfo[];
}
/** The SETTINGS that an engine, BACKUP, RESTORE or a refresh strategy takes. */
export interface OptionSettings {
    context: "table" | "database" | "backup" | "restore" | "refresh";
    engine?: string;
    /** Names of SETTING_LISTS. */
    lists?: readonly string[];
    /** Other names it takes, of MergeTree or of the lists of other engines. */
    names?: readonly string[];
    /** Whether it takes the settings of queries as well. */
    query?: boolean;
    /** Whether it takes the MergeTree settings. */
    mergeTree?: boolean;
    /** ClickHouse's message for a name it does not take, with {} for the name; none when ClickHouse was not asked. */
    unknown?: string;
    /** ClickHouse's message when it takes no SETTINGS. */
    unsupported?: string;
}
export declare const SETTING_LISTS: readonly SettingList[];
export declare const OPTION_SETTINGS: readonly OptionSettings[];
//# sourceMappingURL=engine-settings.d.ts.map