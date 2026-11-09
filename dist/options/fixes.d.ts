/**
 * Quick fixes: the names and values that ClickHouse would take in place of a wrong one, with the edits that write them.
 */
import type { SettingInfo } from "../generated/settings.js";
import type { Fix, Token } from "../types.js";
import { type Value } from "./values.js";
/** A name that may be meant, and how many typos away it is. */
export interface NameHint {
    name: string;
    distance: number;
}
/** NamePrompter::getHints of ClickHouse: the names within a few typos of `name`, closest first. */
export declare function nameHints(name: string, names: Iterable<string>, max?: number): NameHint[];
/** A fix for each hint, written by `write` from `start` to `end`; the closest one is preferred when no other is as close. */
export declare function replaceFixes(start: number, end: number, hints: readonly NameHint[], write?: (name: string) => string): Fix[];
/** Fixes of a setting's value: the enum value it is likely a typo of, or a number in quotes for a setting of one character. */
export declare function valueFixes(sql: string, tokens: readonly Token[], setting: SettingInfo, value: Value): Fix[] | undefined;
/**
 * Fixes from the hints of a ClickHouse error message, as "Maybe you meant: ['length']" or "Maybe you meant system?",
 * that replace the name from `start` to `end`. Hints that would need quotes are left out.
 */
export declare function messageFixes(sql: string, start: number, end: number, message: string): Fix[];
//# sourceMappingURL=fixes.d.ts.map