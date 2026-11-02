// What the documentation of a function argument says it takes, read from the Markdown of system.functions.

/** A type as the documentation names it after an argument: a link to its page, or a name in back quotes. */
const TYPE = String.raw`(?:\[\x60?([^\]\x60]+)\x60?\]\(/reference/data-types[^)]*\)|\x60((?:const )?(?:\(U\))?[A-Z][^\x60]*)\x60)`;
const TYPES = new RegExp(String.raw`${TYPE}(?:\s*(?:,\s*or|or|,)\s*${TYPE})*[\s.]*$`);

/** The types that end the documentation of an argument, as `Date` and `DateTime` in "... [`Date`](...) or [`DateTime`](...)". */
export function argumentTypes(markdown: string): string[] {
  const run = TYPES.exec(markdown.trim());
  if (!run) return [];
  // A word in capitals in back quotes, such as NULL, is a value; a link goes to the page of a type.
  return [...run[0].matchAll(new RegExp(TYPE, "g"))].flatMap((m) => (m[1] ?? (/^[A-Z_]+$/.test(m[2]!) ? "" : m[2]!)).trim() || []);
}

/** What introduces the values an argument takes: a ":", "either", "one of", "... are" or a "(" before a value in quotes. */
const CUE = /(?::|\b(?:can be either|either|one of|valid arguments are|possible values are)\b|\((?=\s*[`']))\s*/gi;

/** A value: in quotes or back quotes, or a word with no spaces. */
const VALUE = /^(?:`'([^'`]+)'`|`([^`]+)`|'([^']+)'|([A-Za-z][\w-]*))/;

/**
 * The values listed from `at`, between commas, "/", "or" and "and", each with any note after it, where values with
 * no quotes, which `quotedOnly` refuses, count only when a "." or the end follows them.
 */
function valuesAfter(text: string, at: number, quotedOnly: boolean): string[] {
  const values: string[] = [];
  let rest = text.slice(at);
  let bare: boolean | undefined = quotedOnly ? false : undefined;
  for (;;) {
    rest = rest.replace(/^\s*(?:-\s+)?/, "");
    const match = VALUE.exec(rest);
    if (!match) break;
    const quoted = match[4] === undefined;
    if (bare !== undefined && bare === quoted) break;
    bare = !quoted;
    values.push((match[1] ?? match[2] ?? match[3] ?? match[4])!);
    rest = rest.slice(match[0].length).replace(/^\s*\([^)]*\)/, "");
    const separator = /^\s*(?:,\s*(?:or\s+|and\s+)?|\/|or\s+|and\s+)/.exec(rest);
    if (separator) {
      rest = rest.slice(separator[0].length);
      continue;
    }
    if (bare) return /^\s*(?:[.;)]|$)/.test(rest) ? values : [];
    const note = /^\s*(?:[—–:]|-\s)[^'`]{0,200}?(?=\s(?:-\s+)?['`])/.exec(rest);
    if (!note) break;
    rest = rest.slice(note[0].length);
  }
  return values;
}

/** The values that look like ones to write, not code, numbers or ranges; at least two, or none. */
function plausible(values: string[]): string[] {
  const kept = [...new Set(values.filter((v) => /^[A-Za-z][\w.-]*$/.test(v) && v.length <= 40))];
  return kept.length >= 2 ? kept : [];
}

/** The rows of a Markdown table whose header has a column "Possible values": its first cell and the values in that column. */
function tableValues(markdown: string): string[][] {
  const rows = markdown
    .split("\n")
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) => line.trim().slice(1, -1).split("|").map((cell) => cell.trim()));
  const column = rows[0]?.findIndex((cell) => /^possible values$/i.test(cell)) ?? -1;
  if (column < 0) return [];
  return rows.slice(2).flatMap((row) => {
    const spellings = [...(row[column] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    return spellings.length ? [[...new Set([row[0]!.replace(/`/g, ""), ...spellings])]] : [];
  });
}

/** The values listed in the documentation of the argument itself. */
function ownValues(markdown: string): string[] {
  // Without the types at the end, whose names are no values.
  const text = markdown.trim().slice(0, TYPES.exec(markdown.trim())?.index).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ");
  for (const cue of text.matchAll(CUE)) {
    const values = plausible(valuesAfter(text, cue.index + cue[0].length, !cue[0].startsWith(":")));
    if (values.length) return values;
  }
  // Values in quotes that each start an explanation, as "'two-sided' (default): ... 'greater': ...".
  return plausible([...text.matchAll(/'([^'\s]+)'(?:\s*\([^)]*\))?:/g)].map((m) => m[1]!));
}

/**
 * The items of a list in the function's description after a sentence that ends with what the argument is and ":", as
 * "the following modes:" for `mode`, or after "Possible values:" that follows a sentence naming each word of its name.
 */
function describedValues(description: string, name: string, markdown: string): string[] {
  const words = name.toLowerCase().split("_").filter(Boolean);
  if (!words.length) return [];
  const head = /^(?:the |an? )?(\w+(?: \w+)?)/i.exec(markdown.trim())?.[1]?.toLowerCase();
  const nouns = [words[words.length - 1]!, ...(head && head.includes(" ") ? [head] : [])];
  for (const cue of description.matchAll(/([^\n]*)\n\s*\n?((?:\s*- [^\n]+\n?)+)/g)) {
    const lead = cue[1]!.toLowerCase().trim();
    const before = description.slice(0, cue.index).split("\n").filter((line) => line.trim()).pop()?.toLowerCase() ?? "";
    const named = words.every((word) => new RegExp(`\\b${word}s?\\b`).test(before));
    if (!nouns.some((noun) => new RegExp(`\\b${noun}s?(?: are)?:$`).test(lead)) && !(lead === "possible values:" && named)) continue;
    const values = cue[2]!
      .split("\n")
      .map((line) => line.replace(/^\s*- /, "").replace(/\s*\([^)]*\)/g, "").trim())
      .flatMap((item) => item.split(/,\s*/))
      .map((item) => item.replace(/^'(.*)'$/, "$1"))
      .filter(Boolean);
    const kept = plausible(values);
    if (kept.length === values.length) return kept;
  }
  return [];
}

/**
 * The values the documentation lists for an argument, each with its other spellings, as the units of dateDiff():
 * from a table of possible values, a list in its documentation, or one for it in the function's description.
 */
export function argumentValues(markdown: string, description: string, name: string): string[][] {
  // Values are strings, so an argument of other types, such as a Map of parameters, has none.
  const types = argumentTypes(markdown);
  if (types.length && !types.some((type) => /^(?:const )?String$/.test(type))) return [];
  const table = tableValues(markdown);
  if (table.length) return table;
  // The list of the description where it holds the argument's own, which may name only some.
  const own = ownValues(markdown);
  const described = describedValues(description, name, markdown);
  const fuller = described.length > own.length && own.every((value) => described.includes(value));
  return (own.length && !fuller ? own : described).map((value) => [value]);
}
