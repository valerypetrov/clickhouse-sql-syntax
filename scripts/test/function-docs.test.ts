import assert from "node:assert/strict";
import { test } from "node:test";

import { argumentTypes, argumentValues } from "../function-docs.js";

const link = (type: string) => `[\`${type}\`](/reference/data-types/${type.toLowerCase()})`;

test("reads the types that end the documentation of an argument", () => {
  assert.deepEqual(argumentTypes(`JSON string to parse. ${link("String")}`), ["String"]);
  assert.deepEqual(argumentTypes(`The first time value. ${link("Date")} or ${link("DateTime64")}`), ["Date", "DateTime64"]);
  assert.deepEqual(argumentTypes("A list of zero or more arguments. `String` or `(U)Int*`"), ["String", "(U)Int*"]);
  assert.deepEqual(argumentTypes(`JSON column. [\`JSON\`](/reference/data-types/newjson)`), ["JSON"]);
  // A word in capitals in back quotes is a value, not a type.
  assert.deepEqual(argumentTypes(`The type modifier, or \`NULL\`. ${link("UInt8")} or \`NULL\``), ["UInt8"]);
  assert.deepEqual(argumentTypes("Interval length number."), []);
});

test("reads the values listed in a table, after a colon or in quotes, each with its other spellings", () => {
  const table = [
    "The type of interval for result.",
    "",
    "| Unit        | Possible values                    |",
    "|-------------|------------------------------------|",
    "| second      | `second`, `seconds`, `ss`, `s`     |",
    "| minute      | `minute`, `minutes`, `mi`, `n`     |",
  ].join("\n");
  assert.deepEqual(argumentValues(table, "", "unit"), [["second", "seconds", "ss", "s"], ["minute", "minutes", "mi", "n"]]);
  assert.deepEqual(argumentValues("Interval unit: YEAR, QUARTER, MONTH.", "", "unit"), [["YEAR"], ["QUARTER"], ["MONTH"]]);
  assert.deepEqual(
    argumentValues(`The unit of time. Valid values: 'second', 'minute', 'hour'. ${link("String")}`, "", "unit"),
    [["second"], ["minute"], ["hour"]],
  );
  assert.deepEqual(
    argumentValues("Possible values: `nanosecond` (only DateTime64), `second`, `minute`.", "", "unit"),
    [["nanosecond"], ["second"], ["minute"]],
  );
  assert.deepEqual(
    argumentValues("Day count convention. Supported values: - 'ACT_365F' - Actual/365 Fixed: days / 365 - 'ACT_365_25' - Actual/365.25", "", "daycount"),
    [["ACT_365F"], ["ACT_365_25"]],
  );
  assert.deepEqual(argumentValues("Selection of pooling method. Can be either 'unpooled' or 'pooled'.", "", "pool_type"), [["unpooled"], ["pooled"]]);
  assert.deepEqual(
    argumentValues("Alternative hypothesis. 'two-sided' (default): not equal. 'greater': bigger. 'less': smaller.", "", "alternative"),
    [["two-sided"], ["greater"], ["less"]],
  );
});

test("reads values for an argument from the list in the function's description that names it", () => {
  const description = "Encrypts plaintext using AES in one of the following modes:\n\n- aes-128-ecb, aes-192-ecb\n- aes-128-gcm\n";
  assert.deepEqual(argumentValues(`Encryption mode. ${link("String")}`, description, "mode"), [["aes-128-ecb"], ["aes-192-ecb"], ["aes-128-gcm"]]);
  assert.deepEqual(argumentValues(`Text to encrypt. ${link("String")}`, description, "plaintext"), []);
  // The fuller list of the description, which holds those that the argument names.
  const hmac = "Supported hash algorithms:\n- md4\n- md5\n- ripemd (aliases: RIPEMD160, ripemd)\n- sha1\n";
  assert.deepEqual(argumentValues("Hash algorithm name. Supported: md5, sha1. `String`", hmac, "mode"), [["md4"], ["md5"], ["ripemd"], ["sha1"]]);
  const dateName = "Returns the specified part of the date.\n\nPossible values:\n- 'year'\n- 'month'\n";
  assert.deepEqual(argumentValues(`The part of the date. ${link("String")}`, dateName, "date_part"), [["year"], ["month"]]);
});

test("reads no values from prose, ranges or arguments that are not strings", () => {
  assert.deepEqual(argumentValues("A list of zero or more arguments each of which can be either string or integer. `String` or `(U)Int*`", "", "keys"), []);
  assert.deepEqual(argumentValues("Supported: values or string representations of type (U)Int*, values of type Float*.", "", "expr"), []);
  assert.deepEqual(argumentValues("The power. Possible values: real number from `1; inf)`.", "", "p"), []);
  assert.deepEqual(argumentValues("Optional. A mode `0` to `9` determines the first day of the week.", "", "mode"), []);
  assert.deepEqual(
    argumentValues(`Parameters. Function-specific keys: \`temperature\` (randomness), \`max_tokens\` (limit). [\`Map(String, String)\`](/reference/data-types/map)`, "", "params"),
    [],
  );
});
