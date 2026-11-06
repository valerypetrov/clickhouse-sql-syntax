/**
 * Quick fixes: the names and values that ClickHouse would take in place of a wrong one, with the edits that write them.
 */
import type { SettingInfo } from "../generated/settings.js";
import { levenshtein } from "../parser/index.js";
import type { Fix, Token } from "../types.js";
import { type Value, valueError } from "./values.js";

/** A name that may be meant, and how many typos away it is. */
export interface NameHint {
  name: string;
  distance: number;
}

/** NamePrompter::getHints of ClickHouse: the names within a few typos of `name`, closest first. */
export function nameHints(name: string, names: Iterable<string>, max = 3): NameHint[] {
  const found: NameHint[] = [];
  const mistakes = Math.floor((name.length + 2) / 3);
  for (const prompt of names) {
    const least = Math.abs(name.length - prompt.length);
    if (least > 0 && Math.floor(name.length / least) < 3) continue;
    if (prompt.length > name.length + mistakes || prompt.length + mistakes < name.length) continue;
    const distance = levenshtein(prompt, name);
    if (distance <= mistakes) found.push({ name: prompt, distance });
  }
  // A stable sort keeps the order of `names` among equally close ones, as ClickHouse does.
  return found.sort((a, b) => a.distance - b.distance).slice(0, max);
}

/** A fix for each hint, written by `write` from `start` to `end`; the closest one is preferred when no other is as close. */
export function replaceFixes(start: number, end: number, hints: readonly NameHint[], write: (name: string) => string = (name) => name): Fix[] {
  return hints.map((hint, i) => {
    const newText = write(hint.name);
    const fix: Fix = { title: `Change to ${newText}`, edits: [{ start, end, newText }] };
    if (i === 0 && hints[1]?.distance !== hint.distance) fix.preferred = true;
    return fix;
  });
}

const quoteString = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Fixes of a setting's value: the enum value it is likely a typo of, or a number in quotes for a setting of one character. */
export function valueFixes(sql: string, tokens: readonly Token[], setting: SettingInfo, value: Value): Fix[] | undefined {
  const start = tokens[0]!.start;
  const end = tokens[tokens.length - 1]!.end;
  if (value.t === "String" && setting.values?.length) {
    const parts = setting.multi ? value.v.split(/[\s,]+/).filter((part) => part !== "") : [value.v];
    const wrong = parts.filter((part) => !setting.values!.includes(part));
    if (wrong.length !== 1) return undefined;
    const hints = nameHints(wrong[0]!, setting.values);
    // A list keeps its other values: the wrong one is replaced where it is written.
    if (!hints.length || !/^\w+$/.test(wrong[0]!)) return undefined;
    const at = new RegExp(`(?<!\\w)${wrong[0]}(?!\\w)`).exec(sql.slice(start, end))?.index;
    if (at === undefined) return undefined;
    return replaceFixes(start + at, start + at + wrong[0]!.length, hints);
  }
  // Only a number for one character, whose strings are checked in full; many settings of strings check them further.
  if (setting.type !== "Char" || (value.t !== "UInt64" && value.t !== "Int64" && value.t !== "Float64")) return undefined;
  const quoted = quoteString(sql.slice(start, end));
  if (valueError(setting, { t: "String", v: sql.slice(start, end), text: quoted })) return undefined;
  return [{ title: `Write it as a string: ${quoted}`, edits: [{ start, end, newText: quoted }], preferred: true }];
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Fixes from the hints of a ClickHouse error message, as "Maybe you meant: ['length']" or "Maybe you meant system?",
 * that replace the name from `start` to `end`. Hints that would need quotes are left out.
 */
export function messageFixes(sql: string, start: number, end: number, message: string): Fix[] {
  const written = sql.slice(start, end).replace(/`/g, "");
  if (!PLAIN_NAME.test(written)) return [];
  const list = /Maybe you meant:? \[([^\]]*)\]/.exec(message);
  const one = /Maybe you meant ([^\s?]+)\?/.exec(message);
  const names = list ? [...list[1]!.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]!) : one ? [one[1]!] : [];
  const hints = names
    .filter((name) => PLAIN_NAME.test(name) && name !== written)
    .map((name) => ({ name, distance: levenshtein(name, written) }))
    .sort((a, b) => a.distance - b.distance);
  return replaceFixes(start, end, hints);
}
