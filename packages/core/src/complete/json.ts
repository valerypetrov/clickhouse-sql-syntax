/**
 * The JSON data type: the arguments of `JSON(...)` in a column type, and the typed paths that a JSON column
 * declares, offered as its subcolumns after `column.`.
 */
import { tokenize } from "../lexer/index.js";
import { type CompletionCandidate, isSignificant, TokenKind as T } from "../types.js";
import { nameOf } from "./schema.js";

const PARAMETER = "JSON type parameter";

/** What may start an argument of JSON(...), as ClickHouse's ObjectArgumentParser reads it. */
export function jsonTypeArguments(lower: boolean): CompletionCandidate[] {
  const keyword = (text: string) => (lower ? text.toLowerCase() : text);
  return [
    {
      label: "max_dynamic_paths",
      kind: "keyword",
      detail: PARAMETER,
      documentation: "How many paths are stored as subcolumns of their own; the others are stored together. 1024 by default.",
      insertText: "max_dynamic_paths = ",
    },
    {
      label: "max_dynamic_types",
      kind: "keyword",
      detail: PARAMETER,
      documentation: "How many data types a path of the type Dynamic stores separately. 32 by default.",
      insertText: "max_dynamic_types = ",
    },
    { label: keyword("SKIP"), kind: "keyword", detail: PARAMETER, documentation: "A path to leave out when parsing JSON.", insertText: `${keyword("SKIP")} ` },
    {
      label: keyword("SKIP REGEXP"),
      kind: "keyword",
      detail: PARAMETER,
      documentation: "Paths that match the regular expression are left out when parsing JSON.",
      insertText: `${keyword("SKIP REGEXP")} ''`,
      cursor: "SKIP REGEXP '".length,
    },
  ];
}

/** A path that a JSON type declares with its type, as `a.b UInt32` in JSON(a.b UInt32). */
export interface TypedPath {
  path: string;
  type: string;
}

/** The typed paths of a type written as JSON(...), or none for another type. */
export function typedPaths(type: string): TypedPath[] {
  const tokens = tokenize(type).filter((t) => isSignificant(t.kind) && t.kind !== T.EndOfStream);
  if (!/^json$/i.test(nameOf(type, tokens[0]) ?? "") || tokens[1]?.kind !== T.OpeningRoundBracket) return [];
  const paths: TypedPath[] = [];
  let start = 2;
  for (let i = 2, depth = 0; i < tokens.length && depth >= 0; i++) {
    const kind = tokens[i]!.kind;
    if (kind === T.OpeningRoundBracket) depth++;
    else if (kind === T.ClosingRoundBracket) depth--;
    if (depth > 0 || (kind !== T.Comma && depth === 0)) continue;
    // One argument: a path and its type, SKIP ..., or a parameter = N.
    const words = tokens.slice(start, i);
    start = i + 1;
    let j = /^shared$/i.test(nameOf(type, words[0]) ?? "") && words.length > 2 ? 1 : 0;
    const segments: string[] = [];
    for (; nameOf(type, words[j]) !== undefined; j += 2) {
      segments.push(nameOf(type, words[j])!);
      if (words[j + 1]?.kind !== T.Dot) break;
    }
    const rest = words[j + 1];
    if (!segments.length || /^skip$/i.test(segments[0]!) || !rest || rest.kind === T.Equals) continue;
    paths.push({ path: segments.join("."), type: type.slice(rest.start, words[words.length - 1]!.end) });
  }
  return paths;
}
