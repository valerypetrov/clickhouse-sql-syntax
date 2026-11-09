import { type SettingInfo } from "../generated/settings.js";
/** What a list of settings belongs to, as the parser marks it. */
export type SettingsContext = "query" | "set" | "profile" | "storage" | "database" | "column" | "column reset" | "projection" | "alter" | "reset" | "alter database" | "refresh" | "explain" | "backup" | "restore" | "dictionary" | "table function" | "distributed";
/** The settings a place takes and how ClickHouse treats other names there. */
export interface SettingsScope {
    /** The settings to offer, without the obsolete ones, each with what it is a setting of and its rank, own ones first. */
    offered: readonly {
        info: SettingInfo;
        label: string;
        rank: number;
    }[];
    /** The setting a name stands for there, obsolete ones included. */
    find(name: string): SettingInfo | undefined;
    /** ClickHouse's message for a name it does not take, with {} for the name; none when it is not known to refuse them. */
    unknown?: string;
    /** ClickHouse's message when no SETTINGS are allowed at all. */
    unsupported?: string;
    /** What the settings are of, for the detail of a suggestion, such as "Kafka setting". */
    label: string;
}
/** The setting of queries named `name`. */
export declare function querySetting(name: string): SettingInfo | undefined;
/**
 * The settings of a place: `engine` is the engine of a storage or database, `kind` the kind of an EXPLAIN.
 * A storage without an engine takes those of MergeTree, the default engine, but its other names are not checked.
 */
export declare function settingsScope(context: SettingsContext, engine?: string, kind?: string): SettingsScope;
/** The EXPLAIN settings of a kind, with ClickHouse's messages for wrong values. */
export declare function explainSettings(kind: string): import("../generated/options.js").ExplainSettings | undefined;
//# sourceMappingURL=catalog.d.ts.map