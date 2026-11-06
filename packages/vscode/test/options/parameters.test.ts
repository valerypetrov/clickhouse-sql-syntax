import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parameterHover, parameters, parameterValuesBefore } from "../../src/parameters.js";

describe("query parameters", () => {
  test("finds {name:Type} and param_name settings outside strings and comments", () => {
    const text = "SET param_a = 'x', max_threads = 1, param_b = 5;\nSELECT {a:String}, {b:Array(Nullable(UInt8))} -- {c:UInt8}\n, '{d:UInt8}' FROM {t:Identifier} SETTINGS param_e = 1";
    const found = parameters(text);
    assert.deepEqual(found.substitutions.map((s) => [s.name, s.type, text.slice(s.start, s.end)]), [
      ["a", "String", "{a:String}"],
      ["b", "Array(Nullable(UInt8))", "{b:Array(Nullable(UInt8))}"],
      ["t", "Identifier", "{t:Identifier}"],
    ]);
    assert.deepEqual(found.settings.map((s) => [s.name, s.value, s.inSet]), [["a", "x", true], ["b", "5", true], ["e", "1", false]]);
  });

  test("takes the values of SET param_x that ClickHouse passes on as written", () => {
    const text = [
      "SET param_s = 'abc', param_n = 42, param_t = numbers, param_f = 1.50, param_e = 'a\\tb', param_arr = [1, 2];",
      "SELECT {s:String} SETTINGS param_q = 'only here';",
      "SET param_n = 'again';",
      "SELECT {n:String};",
    ].join("\n");
    const { settings } = parameters(text);
    assert.deepEqual(parameterValuesBefore(settings, text.indexOf("SELECT {s")), { s: "abc", n: "42", t: "numbers" });
    assert.deepEqual(parameterValuesBefore(settings, text.indexOf("SELECT {n")), { s: "abc", n: "again", t: "numbers" });
    // A value that ClickHouse writes otherwise, as 1.5 for 1.50, forgets the one before.
    assert.deepEqual(parameterValuesBefore(parameters("SET param_x = 1; SET param_x = 1.50; SELECT 1").settings, 40), {});
  });

  test("documents the parameter under the mouse", () => {
    const text = "SET param_limit = 10;\nSELECT number FROM {t:Identifier}(100) LIMIT {limit:UInt64}";
    const at = (s: string) => parameterHover(text, text.indexOf(s) + 1);
    const limit = at("{limit")!;
    assert.equal(text.slice(limit.start, limit.end), "{limit:UInt64}");
    assert.match(limit.markdown, /^\*\*Query parameter `limit`\*\*/);
    assert.match(limit.markdown, /reads its value, which is text, as `UInt64`/);
    assert.match(limit.markdown, /In this file: `\{limit:UInt64\}` on line 2\./);
    assert.match(limit.markdown, /Set by `param_limit` on line 1\./);
    assert.match(limit.markdown, /`--param_limit='value'` on the command line/);
    assert.match(at("UInt64")!.markdown, /`limit`/);
    assert.match(at("param_limit")!.markdown, /^\*\*Query parameter `limit`\*\*/);
    assert.match(at("{t:")!.markdown, /`Identifier`: its value is a name/);
    assert.equal(parameterHover(text, text.indexOf("number")), undefined);
    assert.match(parameterHover("SELECT * FROM {CLICKHOUSE_DATABASE:Identifier}.t", 20)!.markdown, /clickhouse-test sets it to the database of the test/);
  });
});
