import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { splitStatements } from "./split.js";

export interface Extracted {
  sql: string;
  /** File name inside the corpus directory. */
  file: string;
  line: number;
  hints: string[];
}

export interface ExtractOptions {
  /** Longer statements are left out, as ClickHouse limits the query size too. */
  maxLength: number;
}

export interface ExtractResult {
  statements: Extracted[];
  files: number;
  skippedFiles: string[];
  /** Statements found, before deduplication. */
  total: number;
}

const DIALECT = /\bdialect\s*=\s*['"]?(\w+)/gi;

export function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** True when the file switches to a dialect other than clickhouse, such as kusto or prql. */
export function usesOtherDialect(source: string): boolean {
  for (const match of source.matchAll(DIALECT)) {
    if (match[1]!.toLowerCase() !== "clickhouse") return true;
  }
  return false;
}

/** True for tests that need a build with XRay, whose SYSTEM INSTRUMENT the other builds parse in another way. */
export function needsXRay(source: string): boolean {
  return /^--\s*Tags:.*\buse-xray\b/m.test(source);
}

export function expectsSyntaxError(hints: readonly string[]): boolean {
  return hints.some((hint) => /^clientError\b.*\b(SYNTAX_ERROR|62)\b/.test(hint));
}

/** Reads every *.sql file of a ClickHouse tests/queries/0_stateless directory and returns its statements, deduplicated. */
export function extractCorpus(dir: string, options: ExtractOptions): ExtractResult {
  const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const byText = new Map<string, Extracted>();
  const skippedFiles: string[] = [];
  let total = 0;
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    if (usesOtherDialect(source) || needsXRay(source)) {
      skippedFiles.push(file);
      continue;
    }
    for (const statement of splitStatements(source)) {
      total++;
      if (statement.text.length > options.maxLength) continue;
      const seen = byText.get(statement.text);
      if (seen) {
        seen.hints = [...new Set([...seen.hints, ...statement.hints])];
      } else {
        byText.set(statement.text, { sql: statement.text, file, line: statement.line, hints: statement.hints });
      }
    }
  }
  return { statements: [...byText.values()], files: files.length, skippedFiles, total };
}
