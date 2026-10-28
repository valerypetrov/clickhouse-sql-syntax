import { fileURLToPath } from "node:url";

export const CORPUS_FILE = fileURLToPath(new URL("../fixtures/corpus.jsonl.gz", import.meta.url));
export const THRESHOLDS_FILE = fileURLToPath(new URL("../thresholds.json", import.meta.url));
export const CACHE_DIR = fileURLToPath(new URL("../.cache", import.meta.url));
export const REPORT_FILE = fileURLToPath(new URL("../out/report.json", import.meta.url));

export const SOURCE_NOTE =
  "The statements come from the tests of ClickHouse (https://github.com/ClickHouse/ClickHouse), " +
  "Copyright ClickHouse, Inc., licensed under the Apache License 2.0. Mutated entries are changed copies of them.";

/** Reads a whole-number command line option, failing with a clear message. */
export function integerOption(value: string, name: string, min = 0): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} needs a whole number of at least ${min}, not "${value}"`);
  return n;
}
