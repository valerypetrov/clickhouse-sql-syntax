import type { SettingInfo } from "../generated/settings.js";
/** The type, default, values and description of a setting. */
export declare function settingDocumentation(info: SettingInfo): string;
export type OptionKind = "codec" | "index type" | "statistics type" | "database engine";
/** The documentation of a codec, index type, statistics type or database engine. */
export declare function optionDocumentation(kind: OptionKind, name: string): string | undefined;
//# sourceMappingURL=docs.d.ts.map