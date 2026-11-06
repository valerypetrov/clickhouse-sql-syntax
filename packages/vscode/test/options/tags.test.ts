import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { otherDialectSpans } from "../../src/dialect.js";
import { checkTags, tagCompletions, tagHover } from "../../src/tags.js";

function problems(text: string): [string, string, string][] {
  return checkTags(text).map((p) => [text.slice(p.start, p.end), p.severity, p.message]);
}

describe("tags of clickhouse-test", () => {
  test("accepts the tags that clickhouse-test reads, by name and by rule", () => {
    const text = "-- Tags: no-fasttest, no-parallel ,long, use-vectorscan, use_jemalloc, no-cpu-aarch64, no-tsan, zookeeper\nSELECT 1;";
    assert.deepEqual(problems(text), []);
    assert.deepEqual(problems("--Tags: shard\n-- Random settings limits: max_block_size=(65409, None); max_threads=(1, 4)\nSELECT 1"), []);
  });

  test("reports what clickhouse-test refuses or ignores", () => {
    assert.deepEqual(problems("-- Tags: no-stress, no-random-mergetree-settings\n-- Tags: long\nSELECT 1"), [
      ["no-stress", "error", "clickhouse-test refuses the no-stress tag: stress tests must be able to run every test."],
      ["no-random-mergetree-settings", "information", "clickhouse-test does not read the tag no-random-mergetree-settings, so it changes nothing."],
      ["-- Tags: long", "information", "clickhouse-test reads only the first Tags line of a test."],
    ]);
    const limits = problems("-- Random settings limits: max_block_size=65409; max_threads=(1, 4);\nSELECT 1");
    assert.deepEqual(limits.map((p) => p[0]), ["max_block_size=65409", ""]);
    // A Tags line must start with -- at the start of the line, and a comment after a statement is not one.
    assert.deepEqual(problems(" -- Tags: nope\nSELECT 1; -- Tags: nope"), []);
  });

  test("completes and documents tags", () => {
    const text = "-- Tags: no-fasttest, \nSELECT 1";
    const labels = tagCompletions(text, text.indexOf("\n"))!.map((c) => c.label);
    assert.ok(labels.includes("no-parallel") && labels.includes("long") && !labels.includes("no-fasttest"));
    assert.equal(tagCompletions(text, text.length), undefined);
    assert.match(tagHover(text, 12)!.markdown, /^\*\*Tag `no-fasttest`\*\* of clickhouse-test\n\nSkipped in the Fast test/);
    assert.match(tagHover("-- Tags: use-hdfs", 12)!.markdown, /Needs a build with HDFS/);
  });
});

describe("other dialects", () => {
  test("finds the statements after SET dialect, up to SET dialect = 'clickhouse'", () => {
    const text = [
      "SELECT 1;",
      "SET allow_experimental_kusto_dialect = 1, dialect = 'kusto';",
      "print 1;",
      "SET max_threads = 1;",
      "Customers | take 1;",
      "SET dialect = 'clickhouse';",
      "SELECT 2;",
      "SET dialect = 'prql';",
      "from t;",
      "SET dialect = DEFAULT;",
      "SELECT 3;",
      // The values are case-sensitive, so SET fails and nothing changes.
      "SET dialect = 'Kusto';",
      "SELECT 4",
    ].join("\n");
    assert.deepEqual(otherDialectSpans(text).map((s) => text.slice(s.start, s.end)), ["print 1;", "Customers | take 1;", "from t;"]);
    assert.deepEqual(otherDialectSpans("SELECT 1 SETTINGS dialect = 'kusto'; SELECT 2"), []);
  });
});
