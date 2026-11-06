import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check, complete } from "../../src/index.js";

/** The labels that complete() offers at the "|" of `text`. */
function labels(text: string, kind?: string): string[] {
  const offset = text.indexOf("|");
  return complete(text.replace("|", ""), offset)
    .filter((c) => !kind || c.kind === kind)
    .map((c) => c.label);
}

describe("query parameters", () => {
  test("offers Identifier where only a name may be a parameter", () => {
    for (const text of ["SELECT 1 FROM {t:|", "INSERT INTO {t:|", "USE {db:|", "SELECT * FROM {db:|"]) assert.deepEqual(labels(text), ["Identifier"], text);
    assert.deepEqual(labels("SELECT 1 FROM {t:Id|"), ["Identifier"]);
  });

  test("offers the data types and Identifier for a parameter of an expression", () => {
    const types = labels("SELECT {x:|", "data type");
    for (const type of ["UInt8", "String", "Array", "Nullable", "LowCardinality", "Identifier"]) assert.ok(types.includes(type), type);
    assert.deepEqual(labels("SELECT {x:UInt|"), ["UInt128", "UInt16", "UInt256", "UInt32", "UInt64", "UInt8"]);
  });

  test("offers the names of the file's parameters, then those of clickhouse-test", () => {
    assert.deepEqual(labels("SET param_limit = 5; SELECT * FROM {table:Identifier} LIMIT {|"), [
      "limit",
      "table",
      "CLICKHOUSE_DATABASE",
      "CLICKHOUSE_DATABASE_1",
      "CLICKHOUSE_DATABASE_2",
      "CLICKHOUSE_USER_FILES",
      "CLICKHOUSE_USER_FILES_UNIQUE",
    ]);
    assert.deepEqual(labels("SELECT {start:Date}, {st|"), ["start"]);
    // Not in strings and comments.
    assert.deepEqual(labels("SELECT '{a:UInt8}' -- {b:UInt8}\n, {|"), labels("SELECT {|"));
  });

  test("offers param_ settings for the file's parameters in SET and SETTINGS", () => {
    const sql = "SELECT {n:UInt64} FROM numbers(10) WHERE number < {limit:UInt64}";
    assert.deepEqual(labels(`${sql};\nSET param_|`), ["param_limit", "param_n"]);
    assert.deepEqual(labels(`${sql} SETTINGS max_threads = 1, param_l|`), ["param_limit"]);
    assert.deepEqual(labels(`SET param_|; ${sql}`), ["param_limit", "param_n"]);
    assert.deepEqual(labels("SELECT 1; SET param_|"), []);
  });

  test("what it offers parses as ClickHouse reads it", () => {
    const cases = [
      ["SELECT 1 FROM {t:|", "}"],
      ["SELECT {x:|", "}"],
      ["SELECT {a:UInt8}, {|", ":UInt8}"],
      ["SELECT {n:UInt8}; SET param_|", " = 1"],
    ] as const;
    for (const [text, after] of cases) {
      const offset = text.indexOf("|");
      for (const candidate of complete(text.replace("|", ""), offset)) {
        const sql = text.replace("|", (candidate.insertText ?? candidate.label) + after);
        // A data type with arguments, such as Array, needs them.
        if (/\(/.test(candidate.label) || ["Array", "Tuple", "Map", "Nullable", "LowCardinality"].includes(candidate.label)) continue;
        assert.deepEqual(check(sql), [], sql);
      }
    }
  });
});
