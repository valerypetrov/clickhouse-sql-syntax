// Reads the lists of settings that ClickHouse declares with macros, such as
// `#define KAFKA_RELATED_SETTINGS(DECLARE, ALIAS) DECLARE(UInt64, kafka_num_consumers, 1, "...", 0) \`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface SourceSetting {
  name: string;
  /** The setting this name is another name of. */
  aliasTo?: string;
  type: string;
  /** The default as C++ wrote it, when it is a plain literal. */
  default?: string;
  description?: string;
}

export interface SourceList {
  /** The name of the macro, such as KAFKA_RELATED_SETTINGS. */
  macro: string;
  /** The file it is defined in, relative to the checkout. */
  file: string;
  settings: SourceSetting[];
}

/** Splits the arguments of a macro call at its top-level commas, past brackets, strings and raw strings. */
export function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const raw = /^R"([^(]*)\(/.exec(text.slice(i, i + 20));
    if (raw) {
      const close = `)${raw[1]}"`;
      const end = text.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? text.length : end + close.length;
      current += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      // A digit separator as in 60'000 is not a character literal.
      if (c === "'" && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) j = i;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(" || c === "{" || c === "[" || c === "<") depth++;
    if (c === ")" || c === "}" || c === "]" || c === ">") depth--;
    if (c === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The text of C++ string literals written one after another, raw ones too. */
export function stringValue(literal: string): string | undefined {
  let out = "";
  let found = false;
  const re = /R"([^(]*)\(([\s\S]*?)\)\1"|"((?:[^"\\]|\\.)*)"/g;
  for (const match of literal.matchAll(re)) {
    found = true;
    out += match[2] ?? match[3]!.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
  }
  return found ? out : undefined;
}

/** The literal a default is written as, or undefined for an expression. */
function defaultValue(text: string): string | undefined {
  const t = text.replace(/'/g, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === "true" || t === "false") return t === "true" ? "1" : "0";
  if (/^"(?:[^"\\]|\\.)*"$/.test(text.trim())) return stringValue(text);
  return undefined;
}

/** Every `#define NAME(DECLARE, ...)` or `#define NAME(M)` list of settings in the .h and .cpp files under `dirs`. */
export function readSettingLists(root: string, dirs: readonly string[]): SourceList[] {
  const lists: SourceList[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(h|cpp)$/.test(entry)) lists.push(...listsOf(root, path));
    }
  };
  for (const dir of dirs) visit(join(root, dir));
  return lists;
}

/** The index just past the string literal or raw string literal that starts at `i`, or `i` when none does. */
function skipString(text: string, i: number): number {
  const raw = /^R"([^(\s]*)\(/.exec(text.slice(i, i + 20));
  if (raw) {
    const end = text.indexOf(`)${raw[1]}"`, i + raw[0].length);
    return end < 0 ? text.length : end + raw[1]!.length + 2;
  }
  if (text[i] !== '"') return i;
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** The text of each `call(...)` in `text`, brackets matched. */
function calls(text: string, call: string): string[] {
  const found: string[] = [];
  const head = new RegExp(`\\b${call}\\(`, "g");
  for (let match = head.exec(text); match; match = head.exec(text)) {
    const from = match.index + match[0].length;
    let depth = 1;
    let i = from;
    while (i < text.length && depth > 0) {
      const next = skipString(text, i);
      if (next > i) {
        i = next;
        continue;
      }
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    found.push(text.slice(from, i - 1));
    head.lastIndex = i;
  }
  return found;
}

/** Whether a raw string literal is still open at the end of `text`, which a #define goes on past its line. */
function openRawString(text: string): boolean {
  for (let i = 0; i < text.length; ) {
    const raw = /^R"([^(\s]*)\(/.exec(text.slice(i, i + 20));
    if (raw && /[^\w]/.test(text[i - 1] ?? " ") && text.indexOf(`)${raw[1]}"`, i + raw[0].length) < 0) return true;
    const next = skipString(text, i);
    i = next > i ? next : i + 1;
  }
  return false;
}

function listsOf(root: string, path: string): SourceList[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const lists: SourceList[] = [];
  for (let n = 0; n < lines.length; n++) {
    const match = /^#define ([A-Z0-9_]+)\((DECLARE|M)\b[^)]*\)(.*)$/.exec(lines[n]!);
    if (!match) continue;
    const [, macro, call] = match as unknown as [string, string, string];
    let body = match[3]!;
    while ((body.endsWith("\\") || openRawString(body)) && n + 1 < lines.length)
      body = (body.endsWith("\\") ? body.slice(0, -1) : body) + "\n" + lines[++n]!;
    const settings: SourceSetting[] = [];
    for (const [macro, text] of [...calls(body, call).map((t) => [call, t]), ...calls(body, `${call}_WITH_ALIAS`).map((t) => [`${call}_WITH_ALIAS`, t])]) {
      const args = splitArguments(text!);
      if (args.length < 2 || !/^[a-z_][a-z0-9_]*$/.test(args[1]!)) continue;
      const description = args[3] === undefined ? undefined : stringValue(args[3]);
      const value = args[2] === undefined ? undefined : defaultValue(args[2]);
      const setting = { type: args[0]!, name: args[1]!, ...(value !== undefined ? { default: value } : {}), ...(description ? { description } : {}) };
      settings.push(setting);
      // DECLARE_WITH_ALIAS(type, name, default, description, flags, alias).
      const alias = macro!.endsWith("_WITH_ALIAS") ? args[5] : undefined;
      if (alias && /^[a-z_][a-z0-9_]*$/.test(alias)) settings.push({ ...setting, name: alias, aliasTo: setting.name });
    }
    if (settings.length) lists.push({ macro, file: relative(root, path), settings });
  }
  return lists;
}
