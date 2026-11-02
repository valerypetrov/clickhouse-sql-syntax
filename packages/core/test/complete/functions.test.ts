import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type CompletionCandidate, type CompletionSchema, complete, describe as describeName, functionArgument } from "../../src/index.js";
import { functionSignature } from "../../src/complete/functions.js";
import { argumentKind } from "../../src/complete/kinds.js";
import { findFunction } from "../../src/complete/catalog.js";
import { FUNCTIONS } from "../../src/generated/functions.js";
import { TIME_ZONES } from "../../src/generated/time-zones.js";

const schema: CompletionSchema = {
  databases: ["default"],
  tables: [
    {
      database: "default",
      name: "hits",
      columns: [
        { name: "id", type: "UInt64" },
        { name: "url", type: "String" },
        { name: "ts", type: "DateTime" },
        { name: "day", type: "Date" },
        { name: "tags", type: "Array(String)" },
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

/** The suggestions before the first generic one, the keywords and functions of any expression. */
function specific(text: string, options?: { schema?: CompletionSchema }): CompletionCandidate[] {
  const found = at(text, options);
  const generic = found.findIndex((c) => c.label === "CASE" || c.label === "ALL" || c.label === "abs");
  return generic < 0 ? found : found.slice(0, generic);
}

function argumentAt(text: string) {
  const offset = text.indexOf("|");
  return functionArgument(text.slice(0, offset) + text.slice(offset + 1), offset);
}

const lists = (name: string, group: "arguments" | "parameters" = "arguments") =>
  functionSignature(findFunction(name)!)[group].map(
    (l) => l.parameters.map((p) => p.name).join(", ") + (l.repeats ? " ..." : "") + (l.tail?.length ? `, ${l.tail.map((p) => p.name).join(", ")}` : ""),
  );

const kindOf = (name: string, argument: string) => {
  const info = findFunction(name)!;
  const target = info.aliasTo ? findFunction(info.aliasTo)! : info;
  return argumentKind(target, (target.arguments ?? target.parameters)!.find((a) => a.name === argument)!);
};

describe("function signatures", () => {
  test("lists the arguments that optional and repeated parameters allow, and what follows a repeated one", () => {
    assert.deepEqual(lists("JSONExtract"), ["json, return_type", "json, indices_or_keys ..., return_type"]);
    assert.deepEqual(lists("JSONExtractString"), ["json", "json, indices_or_keys ..."]);
    assert.deepEqual(lists("JSONExtractCaseInsensitive"), ["json, return_type", "json, indices_or_keys ..., return_type"]);
    assert.deepEqual(lists("JSONExtractArrayRawCaseInsensitive"), ["json", "json, indices_or_keys ..."]);
    assert.deepEqual(lists("dateDiff"), ["unit, startdate, enddate", "unit, startdate, enddate, timezone"]);
    assert.ok(lists("toStartOfInterval").includes("value, INTERVAL x unit, origin, time_zone"));
    assert.deepEqual(lists("UUIDStringToNum"), ["string", "string, variant"]);
    assert.deepEqual(lists("quantile"), ["expr"]);
    assert.deepEqual(lists("quantile", "parameters"), ["level"]);
    assert.deepEqual(lists("quantileBFloat16", "parameters"), ["level"]);
    // Each form of the syntax, as CAST(x, T) and CAST(x AS T).
    assert.deepEqual(lists("CAST"), ["x, T", "x AS T"]);
  });

  test("reads the syntax of most functions, and takes the documented arguments in order for the others", () => {
    const withSyntax = FUNCTIONS.filter((f) => !f.aliasTo && f.syntax);
    const read = withSyntax.filter((f) => functionSignature(f).read);
    assert.ok(read.length > 0.95 * withSyntax.length, `${read.length} of ${withSyntax.length}`);
    // A lambda in the syntax is not read.
    assert.equal(functionSignature(findFunction("arrayFold")!).read, false);
    assert.deepEqual(lists("arrayFold"), [findFunction("arrayFold")!.arguments!.map((a) => a.name).join(", ")]);
  });
});

describe("argument kinds", () => {
  test("tell what an argument takes by the phrases of its documentation", () => {
    assert.equal(kindOf("dateDiff", "unit"), "value");
    assert.equal(kindOf("toStartOfInterval", "unit"), "value");
    assert.equal(kindOf("JSONExtract", "return_type"), "JSON data type");
    assert.equal(kindOf("JSONExtractKeysAndValues", "value_type"), "JSON data type");
    assert.equal(kindOf("CAST", "T"), "data type");
    assert.equal(kindOf("accurateCastOrNull", "T"), "data type");
    assert.equal(kindOf("defaultValueOfTypeName", "type"), "data type");
    assert.equal(kindOf("toTimezone", "timezone"), "time zone");
    assert.equal(kindOf("toDateTime", "time_zone"), "time zone");
    assert.equal(kindOf("formatRow", "format"), "format");
    assert.equal(kindOf("JSON_VALUE", "path"), "JSON path");
    assert.equal(kindOf("encrypt", "mode"), "value");
  });

  test("are what describe() gives for the arguments of a function", () => {
    const dateDiff = describeName("dateDiff", "function")!;
    assert.deepEqual(dateDiff.arguments!.map((a) => a.kind), ["value", undefined, undefined, "time zone"]);
    assert.deepEqual(dateDiff.arguments![1]!.types, ["Date", "Date32", "DateTime", "DateTime64"]);
    assert.equal(describeName("JSON_VALUE", "function")!.arguments![1]!.kind, "JSON path");
  });

  test("give nothing to an argument whose documentation names no kind, nor one that is not a string", () => {
    assert.equal(kindOf("JSONExtract", "indices_or_keys"), undefined);
    assert.equal(kindOf("simpleJSONExtractString", "field_name"), undefined);
    assert.equal(kindOf("dateDiff", "startdate"), undefined);
    assert.equal(kindOf("timezoneOffset", "datetime"), undefined);
    assert.equal(kindOf("formatDateTime", "format"), undefined);
    assert.equal(kindOf("kqlParameterCast", "type"), undefined);
    assert.equal(kindOf("aiClassify", "params"), undefined);
  });
});

describe("functionArgument()", () => {
  test("names the argument at the offset past optional and repeated parameters, by how many the brackets hold", () => {
    assert.deepEqual(argumentAt("SELECT JSONExtract(j, |)"), { function: "JSONExtract", parameters: false, arguments: ["return_type"] });
    assert.deepEqual(argumentAt("SELECT JSONExtract(j, |, 'String')")?.arguments, ["indices_or_keys"]);
    assert.deepEqual(argumentAt("SELECT JSONExtract(j, 'a', 1, |)")?.arguments, ["return_type"]);
    assert.deepEqual(argumentAt("SELECT JSONExtract(j, 'a', |, 'b', 'String')")?.arguments, ["indices_or_keys"]);
    assert.deepEqual(argumentAt("SELECT JSONExtractString(j, 'a', |)")?.arguments, ["indices_or_keys"]);
    assert.deepEqual(argumentAt("SELECT JSONHas(j, 'a', |)")?.arguments, ["[ ,indices_or_keys, ...]"]);
    assert.deepEqual(argumentAt("SELECT dateDiff('day', a, b, |)")?.arguments, ["timezone"]);
    assert.deepEqual(argumentAt("SELECT dateDiff('day', a, b, 'UTC', |)")?.arguments, []);
    assert.deepEqual(argumentAt("SELECT toStartOfInterval(t, INTERVAL 1 |)")?.arguments, ["unit"]);
    assert.deepEqual(argumentAt("SELECT toStartOfInterval(t, INTERVAL 1 DAY, |)")?.arguments, ["time_zone", "origin"]);
    assert.deepEqual(argumentAt("SELECT formatRow('CSV', a, b, |)")?.arguments, ["x, y, ..."]);
    // An alias stands for its function.
    assert.deepEqual(argumentAt("SELECT toTimeZone(t, |)"), { function: "toTimezone", parameters: false, arguments: ["timezone"] });
  });

  test("tells the parameters of a parametric aggregate function from its arguments", () => {
    assert.deepEqual(argumentAt("SELECT quantile(|)(x)"), { function: "quantile", parameters: true, arguments: ["level"] });
    assert.deepEqual(argumentAt("SELECT quantile(0.5)(|)"), { function: "quantile", parameters: false, arguments: ["expr"] });
    assert.deepEqual(argumentAt("SELECT quantile(|)"), { function: "quantile", parameters: false, arguments: ["expr"] });
    assert.deepEqual(argumentAt("SELECT kolmogorovSmirnovTest('less', |)(a, b)")?.arguments, ["computation_method"]);
  });

  test("is undefined outside the brackets of a function", () => {
    assert.equal(argumentAt("SELECT a|"), undefined);
    assert.equal(argumentAt("SELECT * FROM numbers(|)"), undefined);
    assert.equal(argumentAt("INSERT INTO FUNCTION file(|) SELECT 1"), undefined);
    assert.equal(argumentAt("CREATE TABLE t (a UInt8) ENGINE = MergeTree(|) ORDER BY a"), undefined);
    assert.equal(argumentAt("SELECT noSuchFunction(|)"), undefined);
    assert.equal(argumentAt("SELECT t.toDate(|)"), undefined);
  });
});

describe("completion in the arguments of a function", () => {
  test("offers the types that JSONExtract returns in quotes, before the expressions that any argument takes", () => {
    const found = specific("SELECT JSONExtract(j, 'a', |)");
    assert.ok(found.length > 40 && found.every((c) => c.kind === "data type"));
    const array = found.find((c) => c.label === "Array(String)")!;
    assert.deepEqual([array.insertText, array.detail], ["'Array(String)'", "return_type"]);
    assert.equal(found.find((c) => c.label === "Enum8('a' = 0, 'b' = 1)")!.insertText, "'Enum8(\\'a\\' = 0, \\'b\\' = 1)'");
    for (const label of ["Int64", "Nullable(String)", "LowCardinality(String)", "Map(String, String)", "Tuple(String, UInt64)", "DateTime64", "JSON"])
      assert.ok(found.some((c) => c.label === label), label);
    for (const label of ["AggregateFunction(sum, UInt64)", "BFloat16", "IntervalDay", "Nothing", "BIGINT"]) assert.ok(!found.some((c) => c.label === label), label);
    for (const label of ["CASE", "abs"]) assert.ok(labels("SELECT JSONExtract(j, 'a', |)").includes(label), label);
    assert.ok(specific("SELECT JSONExtractKeysAndValues(j, |)").some((c) => c.label === "Float64"));
  });

  test("offers nothing of its own for the keys of a JSON function", () => {
    assert.deepEqual(specific("SELECT JSONExtract(j, |, 'String')", {}), []);
    assert.deepEqual(specific("SELECT JSONExtractString(j, 'a', |)", {}), []);
    assert.deepEqual(specific("SELECT simpleJSONExtractString(j, |)", {}), []);
  });

  test("offers type names in quotes where the argument is a string, and the parser's bare ones after AS", () => {
    const cast = specific("SELECT CAST(x, |)");
    assert.equal(cast.find((c) => c.label === "Int64")!.insertText, "'Int64'");
    assert.ok(cast.some((c) => c.label === "AggregateFunction(sum, UInt64)"));
    assert.equal(at("SELECT CAST(x AS |)").find((c) => c.label === "Int64")!.insertText, undefined);
    assert.ok(labels("SELECT CAST(x AS |)").includes("BIGINT"));
    assert.ok(specific("SELECT defaultValueOfTypeName(|)").some((c) => c.label === "Nullable(String)"));
  });

  test("offers only the types that a function takes where ClickHouse takes only some", () => {
    // The OrNull and OrDefault functions return Nullable, which an array or a map cannot be inside.
    const orNull = specific("SELECT accurateCastOrNull(x, |)").map((c) => c.label);
    assert.ok(orNull.includes("Int64") && orNull.includes("Tuple(String, UInt64)") && !orNull.includes("Array(String)") && !orNull.includes("Map(String, String)"));
    const reinterpreted = specific("SELECT reinterpret(x, |)").map((c) => c.label);
    assert.ok(reinterpreted.includes("UInt64") && reinterpreted.includes("FixedString(16)") && !reinterpreted.includes("IPv4"));
    assert.ok(reinterpreted.includes("Array(UInt8)") && !reinterpreted.includes("Array(String)"));
    // A Variant column holds the types to name, and with none known there are none.
    const variant: CompletionSchema = { tables: [{ database: "default", name: "v", columns: [{ name: "x", type: "Variant(Array(String), UInt64)" }] }] };
    assert.deepEqual(specific("SELECT variantElement(x, |) FROM v", { schema: variant }).filter((c) => c.kind === "data type").map((c) => c.label), ["Array(String)", "UInt64"]);
    assert.deepEqual(specific("SELECT variantElement(y, |) FROM v", { schema: variant }).filter((c) => c.kind === "data type"), []);
    assert.ok(specific("SELECT dynamicElement(d, |)").some((c) => c.label === "Array(String)"));
  });

  test("offers the documented units in quotes where a string goes, and as keywords after INTERVAL", () => {
    const units = specific("SELECT dateDiff(|, a, b)");
    assert.deepEqual(
      units.map((c) => c.label),
      ["day", "hour", "microsecond", "millisecond", "minute", "month", "nanosecond", "quarter", "second", "week", "year"],
    );
    assert.deepEqual([units[0]!.kind, units[0]!.insertText, units[0]!.detail], ["value", "'day'", "unit, also days, dd, d"]);
    assert.equal(at("SELECT dateDiff(mi|, a, b)")[0]!.insertText, "'microsecond'");
    assert.deepEqual(specific("SELECT dateTrunc(|, t)").map((c) => c.label).slice(0, 3), ["day", "hour", "microsecond"]);
    assert.ok(specific("SELECT dateName(|, t)").some((c) => c.label === "dayofyear"));
    const interval = specific("SELECT toStartOfInterval(t, INTERVAL 1 |)");
    assert.deepEqual(interval.slice(0, 3).map((c) => [c.label, c.kind]), [["DAY", "keyword"], ["HOUR", "keyword"], ["MICROSECOND", "keyword"]]);
    assert.equal(at("SELECT toStartOfInterval(t, INTERVAL 1 d|)")[0]!.label, "day");
    assert.deepEqual(specific("SELECT toStartOfInterval(t, |)").filter((c) => c.kind === "keyword"), []);
    assert.deepEqual(specific("SELECT kolmogorovSmirnovTest(|)(a, b)").map((c) => c.label), ["greater", "less", "two-sided"]);
    assert.ok(specific("SELECT encrypt(|)").some((c) => c.label === "aes-256-gcm"));
  });

  test("offers time zones, formats and a JSONPath where the argument takes one", () => {
    const zones = specific("SELECT toTimeZone(now(), |)").filter((c) => c.detail === "time zone");
    assert.equal(zones.length, TIME_ZONES.length);
    assert.equal(zones.find((c) => c.label === "Europe/Berlin")!.insertText, "'Europe/Berlin'");
    assert.ok(specific("SELECT dateDiff('day', a, b, |)").some((c) => c.label === "UTC"));
    const rows = specific("SELECT formatRow(|, a)").map((c) => c.label);
    assert.ok(rows.includes("CSV") && rows.includes("JSONEachRow") && !rows.includes("Parquet") && !rows.includes("Pretty"));
    assert.equal(at("SELECT formatRow(|, a)").find((c) => c.label === "CSV")!.insertText, "'CSV'");
    assert.ok(specific("SELECT groupFormat(|)(a)").some((c) => c.label === "Parquet"));
    const path = specific("SELECT JSON_VALUE(j, |)");
    assert.deepEqual(path.map((c) => [c.label, c.insertText, c.cursor]), [["'$.'", "'$.'", 3]]);
  });

  test("offers the columns whose type fits the argument first, and the others after them", () => {
    assert.deepEqual(specific("SELECT dateDiff('day', |) FROM hits").map((c) => c.label).slice(0, 2), ["day", "ts"]);
    assert.deepEqual(specific("SELECT lower(|) FROM hits").map((c) => c.label)[0], "url");
    assert.deepEqual(specific("SELECT JSONAllPaths(|) FROM hits").map((c) => c.label)[0], "doc");
    const created = specific("CREATE TABLE t (n UInt64, s String, d DateTime, a Date ALIAS toDate(d)) ENGINE = MergeTree ORDER BY toStartOfDay(|)");
    assert.deepEqual(created.map((c) => c.label), ["a", "d", "n", "s"]);
    // Every column stays, as ClickHouse converts many types.
    assert.ok(specific("SELECT lower(|) FROM hits").some((c) => c.label === "id"));
  });

  test("leaves the arguments of engines and table functions as they are", () => {
    assert.deepEqual(specific("CREATE TABLE t (a UInt8) ENGINE = File(|)").slice(0, 2).map((c) => c.label), ["Arrow", "ArrowStream"]);
    assert.ok(!specific("SELECT * FROM file(|)").some((c) => c.kind === "value"));
  });
});
