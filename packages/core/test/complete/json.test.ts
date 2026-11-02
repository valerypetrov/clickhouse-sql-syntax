import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CompletionCandidate, type CompletionSchema, complete } from "../../src/index.js";

const schema: CompletionSchema = {
  tables: [
    {
      database: "default",
      name: "hits",
      columns: [
        { name: "id", type: "UInt64" },
        { name: "doc", type: "JSON(max_dynamic_paths=10, `a.b` UInt32, `x-y`.z String, SKIP c, SKIP REGEXP \\'^d\\')" },
      ],
    },
  ],
};

function at(text: string, options: { schema?: CompletionSchema } = { schema }): CompletionCandidate[] {
  const offset = text.indexOf("|");
  return complete(text.slice(0, offset) + text.slice(offset + 1), offset, options);
}

function labels(text: string, options?: { schema?: CompletionSchema }): string[] {
  return at(text, options).map((c) => c.label);
}

describe("the JSON data type", () => {
  test("offers its parameters and SKIP where an argument of JSON(...) starts", () => {
    const found = at("CREATE TABLE t (j JSON(|)) ENGINE = Memory");
    assert.deepEqual(
      found.map((c) => [c.label, c.insertText, c.cursor]),
      [
        ["max_dynamic_paths", "max_dynamic_paths = ", undefined],
        ["max_dynamic_types", "max_dynamic_types = ", undefined],
        ["SKIP", "SKIP ", undefined],
        ["SKIP REGEXP", "SKIP REGEXP ''", 13],
      ],
    );
    assert.deepEqual(labels("CREATE TABLE t (j JSON(max_dynamic_paths = 8, |)) ENGINE = Memory"), ["max_dynamic_paths", "max_dynamic_types", "SKIP", "SKIP REGEXP"]);
    assert.deepEqual(labels("CREATE TABLE t (j json(sk|)) ENGINE = Memory"), ["skip", "skip regexp"]);
    // The type of a typed path.
    assert.ok(labels("CREATE TABLE t (j JSON(a.b |)) ENGINE = Memory").includes("UInt32"));
    assert.ok(labels("SELECT '{}'::JSON(|)").includes("SKIP"));
  });

  test("offers the typed paths that a JSON column declares as its subcolumns", () => {
    const table = "CREATE TABLE t (id UInt64, j JSON(a.b UInt32, a.c String, `x y` Int64, SKIP d)) ENGINE = Memory;\n";
    assert.deepEqual(labels(`${table}SELECT j.| FROM t`, {}), ["a.b", "a.c", "x y"]);
    assert.equal(at(`${table}SELECT j.| FROM t`, {}).find((c) => c.label === "x y")!.insertText, "`x y`");
    assert.deepEqual(at(`${table}SELECT j.| FROM t`, {})[0]!.detail, "UInt32");
    assert.deepEqual(labels(`${table}SELECT j.a.| FROM t`, {}), ["b", "c"]);
    assert.deepEqual(labels(`${table}SELECT x.j.| FROM t AS x`, {}), ["a.b", "a.c", "x y"]);
    assert.deepEqual(labels(`${table}SELECT j.^| FROM t`, {}), ["a"]);
    assert.ok(labels(`${table}SELECT j.a.:| FROM t`, {}).includes("Int64"));
    assert.deepEqual(labels("SELECT doc.| FROM hits"), ["a.b", "x-y.z"]);
    assert.equal(at("SELECT doc.| FROM hits").find((c) => c.label === "x-y.z")!.insertText, "`x-y`.z");
    assert.deepEqual(labels("SELECT id.| FROM hits"), []);
  });
});
