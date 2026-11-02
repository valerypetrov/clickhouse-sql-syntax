import assert from "node:assert/strict";
import { test } from "node:test";
import { complete, describe, functionArgument } from "../../src/index.js";
import { FUNCTIONS } from "../../src/generated/functions.js";
import { TABLE_FUNCTIONS } from "../../src/generated/table-functions.js";
import { COMBINATORS } from "../../src/generated/combinators.js";

function argument(text: string) {
  return functionArgument(text.replace("|", ""), text.indexOf("|"));
}

function suggestions(text: string) {
  return complete(text.replace("|", ""), text.indexOf("|"), {
    schema: { databases: ["analytics"], clusters: ["production"], tables: [{ database: "analytics", name: "hits", columns: [] }] },
  });
}

test("every catalog function, including aliases, has a signature", () => {
  for (const info of FUNCTIONS) assert.ok(describe(info.name, "function")?.syntax, info.name);
  for (const info of TABLE_FUNCTIONS) {
    assert.ok(describe(info.name, "table function")?.syntax, info.name);
    assert.equal(argument(`SELECT * FROM ${info.name}(|)`)?.kind, "table function", info.name);
  }
});

test("every public combinator supplies a signature for its aggregate", () => {
  for (const suffix of COMBINATORS) assert.ok(describe(`sum${suffix.name}`, "function")?.syntax, suffix.name);
  assert.equal(describe("absIf", "function"), undefined);
  assert.equal(describe("sum" + "If".repeat(5000), "function"), undefined);
  assert.deepEqual(argument("SELECT sumIf(x, |)")?.arguments, ["condition"]);
  assert.deepEqual(argument("SELECT quantileIf(0.5)(x, |)")?.arguments, ["condition"]);
  assert.deepEqual(argument("SELECT sumMerge(|)")?.arguments, ["state"]);
  assert.deepEqual(argument("SELECT sumArrayIf(x, |)")?.arguments, ["condition"]);
  assert.deepEqual(argument("SELECT sumResample(0, 10, 1)(x, |)")?.arguments, ["resampling_key"]);
  assert.equal(describe("quantileResample", "function")?.syntax, "quantileResample(level, start, end, step)(expr, resampling_key)");
  assert.deepEqual(argument("SELECT sumMap(x, |)")?.arguments, ["key"]);
  assert.deepEqual(describe("sumArray", "function")?.arguments?.[0]?.types, ["Array"]);
});

test("window functions and missing parametric aggregates identify their arguments", () => {
  assert.deepEqual(argument("SELECT lag(x, |) OVER ()")?.arguments, ["offset"]);
  assert.deepEqual(argument("SELECT histogram(|)(x)")?.arguments, ["number_of_bins"]);
  assert.deepEqual(argument("SELECT windowFunnel(100, |)(ts, a, b)")?.arguments, ["mode"]);
  assert.deepEqual(argument("SELECT sequenceNextNode(|, 'head')(ts, x, cond)")?.arguments, ["direction"]);
  assert.ok(suggestions("SELECT windowFunnel(100, |)(ts, a, b)").some((c) => c.insertText === "'strict_order'"));
});

test("table functions suggest formats, compression, clusters, databases and tables", () => {
  assert.ok(suggestions("SELECT * FROM file('data', |)").some((c) => c.label === "Parquet" && c.insertText === "'Parquet'"));
  assert.ok(suggestions("SELECT * FROM file('data', 'CSV', 'x UInt8', |)").some((c) => c.insertText === "'gzip'"));
  assert.ok(suggestions("SELECT * FROM cluster(|)").some((c) => c.insertText === "'production'"));
  assert.ok(suggestions("SELECT * FROM cluster('production', |)").some((c) => c.insertText === "'analytics'"));
  assert.ok(suggestions("SELECT * FROM cluster('production', 'analytics', |)").some((c) => c.insertText === "'hits'"));
  assert.deepEqual(argument("INSERT INTO FUNCTION file('data', |) SELECT 1")?.arguments, ["format"]);
  assert.deepEqual(argument("SELECT * FROM format('CSV', |)")?.arguments, ["structure", "data"]);
  assert.deepEqual(argument("SELECT * FROM file('data', 'CSV', 'x UInt8', |)")?.arguments, ["compression"]);
});
