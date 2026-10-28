import { fileURLToPath } from "node:url";

/** Inputs, most from ClickHouse's tests (Apache-2.0), with the tokens ClickHouse's lexer gives them. */
export const GOLDEN_PATH = fileURLToPath(new URL("golden.json", import.meta.url));

/** Kind, start and end, in UTF-16 offsets; EndOfStream is left out, as ClickHouse leaves it out. */
export type GoldenToken = [kind: string, start: number, end: number];

export interface GoldenEntry {
  /** The ClickHouse test file and lines the input comes from, or "edge case". */
  source: string;
  sql: string;
  tokens: GoldenToken[];
}

/** JSON with one token per line, so that a change shows up as a small diff. */
export function formatGolden(entries: GoldenEntry[]): string {
  const blocks = entries.map((entry) => {
    const tokens = entry.tokens.map((token) => `      ${JSON.stringify(token)}`).join(",\n");
    return [
      "  {",
      `    "source": ${JSON.stringify(entry.source)},`,
      `    "sql": ${JSON.stringify(entry.sql)},`,
      tokens ? `    "tokens": [\n${tokens}\n    ]` : `    "tokens": []`,
      "  }",
    ].join("\n");
  });
  return `[\n${blocks.join(",\n")}\n]\n`;
}
