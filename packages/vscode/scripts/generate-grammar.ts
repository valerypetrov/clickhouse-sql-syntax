// Writes syntaxes/clickhouse-sql.tmLanguage.json; run it after the keyword or type lists change.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_TYPES, KEYWORDS } from "clickhouse-sql-syntax";
import { buildGrammar } from "./grammar.js";

export const GRAMMAR_PATH = join(__dirname, "..", "syntaxes", "clickhouse-sql.tmLanguage.json");

export function grammarText(): string {
  return JSON.stringify(buildGrammar(KEYWORDS, DATA_TYPES), null, 2) + "\n";
}

if (require.main === module) {
  writeFileSync(GRAMMAR_PATH, grammarText());
  console.log(`Wrote ${GRAMMAR_PATH}`);
}
