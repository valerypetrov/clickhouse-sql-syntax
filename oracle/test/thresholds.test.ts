import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check } from "clickhouse-sql-syntax";

import { type Metrics, compare } from "../src/compare.js";
import { readCorpus } from "../src/corpus.js";
import { CORPUS_FILE, THRESHOLDS_FILE } from "../src/paths.js";

// The lowest accepted rates, from 0 to 1; raise them as check() gets closer to ClickHouse.
type Thresholds = Partial<Record<keyof Metrics, number>>;

test("check() agrees with ClickHouse at least as often as thresholds.json says", (t) => {
  const thresholds = JSON.parse(readFileSync(THRESHOLDS_FILE, "utf8")) as Thresholds;
  const { metrics } = compare(readCorpus(CORPUS_FILE), check, CORPUS_FILE);
  for (const [name, minimum] of Object.entries(thresholds)) {
    const value = metrics[name as keyof Metrics];
    t.diagnostic(`${name}: ${(value * 100).toFixed(2)}% (threshold ${(minimum * 100).toFixed(2)}%)`);
    assert.equal(typeof value, "number", `thresholds.json names an unknown metric: ${name}`);
    assert.ok(value >= minimum, `${name} is ${value.toFixed(4)}, below the threshold ${minimum}`);
  }
});
