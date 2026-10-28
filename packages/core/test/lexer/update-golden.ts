// Fills golden.json with the tokens of ClickHouse's own lexer, as its tokenizeQuery() function returns them.
// Usage: npx tsx test/lexer/update-golden.ts --clickhouse <path to the clickhouse binary>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { GOLDEN_PATH, type GoldenEntry, type GoldenToken, formatGolden } from "./golden.js";

const { values } = parseArgs({ options: { clickhouse: { type: "string" } } });
if (!values.clickhouse) {
  console.error("Usage: npx tsx test/lexer/update-golden.ts --clickhouse <path to the clickhouse binary>");
  process.exit(1);
}

const entries = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenEntry[];
const output = execFileSync(
  values.clickhouse,
  [
    "local",
    "--input-format=JSONEachRow",
    "--structure=sql String",
    "--query=SELECT arrayMap(t -> (t.1, t.2, toString(t.3)), tokenizeQuery(sql)) FROM table FORMAT JSONCompactEachRow",
  ],
  { input: entries.map((entry) => JSON.stringify({ sql: entry.sql })).join("\n"), maxBuffer: 1 << 28 },
).toString();

const rows = output.trim().split("\n");
if (rows.length !== entries.length) throw new Error(`ClickHouse returned ${rows.length} rows for ${entries.length} inputs`);

rows.forEach((row, i) => {
  const entry = entries[i]!;
  const [tokens] = JSON.parse(row) as [[number, number, string][]];
  const offsets = utf16Offsets(entry.sql);
  entry.tokens = tokens.map(([begin, end, kind]): GoldenToken => [kind, offsets.get(begin)!, offsets.get(end)!]);
});
writeFileSync(GOLDEN_PATH, formatGolden(entries));
console.log(`Wrote ${entries.length} entries to ${GOLDEN_PATH}`);

/** Maps each UTF-8 byte offset that starts a character to its UTF-16 offset. */
function utf16Offsets(sql: string): Map<number, number> {
  const offsets = new Map<number, number>();
  let bytes = 0;
  for (let i = 0; i < sql.length; ) {
    offsets.set(bytes, i);
    const code = sql.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  offsets.set(bytes, sql.length);
  return offsets;
}
