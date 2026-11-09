import type { SettingInfo } from "../generated/settings.js";
import { type Token } from "../types.js";
/** A literal as ClickHouse's Field holds it. */
export type Value = {
    t: "UInt64" | "Int64" | "Float64";
    v: number;
    big?: bigint;
    text: string;
} | {
    t: "String";
    v: string;
    text: string;
} | {
    t: "Bool";
    v: boolean;
    text: string;
} | {
    t: "Null";
    text: string;
} | {
    t: "Map";
    text: string; /** Whether it holds string pairs only, so that text is as ClickHouse writes it. */
    pairs?: boolean;
} | {
    t: "Array" | "Tuple";
    text: string;
};
/** The literal that the tokens of a value write, or undefined for anything else, such as DEFAULT or a function. */
export declare function readValue(sql: string, tokens: readonly Token[]): Value | undefined;
/** ClickHouse's message for a value that a setting does not take, or undefined when it takes it or the check is not known. */
export declare function valueError(setting: SettingInfo, value: Value): string | undefined;
//# sourceMappingURL=values.d.ts.map