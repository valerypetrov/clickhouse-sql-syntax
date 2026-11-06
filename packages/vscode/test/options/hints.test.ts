import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check } from "clickhouse-sql-syntax";
import { checkHints, hintCompletions, hintHover } from "../../src/hints.js";

/** The problems of the hints of `text`, as their text and message. */
function problems(text: string): [string, string, string][] {
  return checkHints(text, check(text).map((e) => e.start)).map((p) => [text.slice(p.start, p.end), p.severity, p.message]);
}

describe("test hints", () => {
  test("accepts the hints that clickhouse-client reads", () => {
    for (const text of [
      "SELECT throwIf(1); -- { serverError FUNCTION_THROW_IF_VALUE_IS_NON_ZERO }",
      "SELECT throwIf(1); -- { serverError 395, BAD_ARGUMENTS }",
      "SELECT (; -- { clientError SYNTAX_ERROR }",
      "SELECT (; -- { error 62 }",
      "SELECT 1 -- { echo }\n;",
      "SELECT 1; -- { echoOn } -- { echoOff }",
      "SELECT throwIf(1); -- { retry 3 until serverError 395 }",
      "SELECT {x:UInt8}; -- see {x:UInt8}",
      // Leading hints only echo; clickhouse-client does not read errors from them.
      "-- { serverError NO_SUCH_NAME }\nSELECT 1;",
      // Without a } a comment is not a hint.
      "SELECT 1; -- { serverError NOPE",
    ])
      assert.deepEqual(problems(text), [], text);
  });

  test("reports what makes clickhouse-client stop, in its words", () => {
    const cases: [string, string, string][] = [
      ["SELECT 1; -- { serverError NO_SUCH_THING }", "NO_SUCH_THING", "No error code with name: 'NO_SUCH_THING'"],
      ["SELECT 1;\n-- { serverError NOPE }\nSELECT 2;", "NOPE", "No error code with name: 'NOPE'"],
      ["SELECT 1; -- { serverError 395, }", "}", "Could not parse error code in EndOfStream: "],
      ["SELECT 1; -- { serverError 395 BAD_ARGUMENTS }", "BAD_ARGUMENTS", "Could not parse error code. Expected ','. Got 'BAD_ARGUMENTS'"],
      ["SELECT 1; -- {serverError 'x'}", "'x'", "Could not parse error code in StringLiteral: 'x'"],
      ["SELECT 1; -- { retry 3 serverError 395 }", "serverError", "Expected 'until' or 'while' after the number of retries, got: serverError"],
      ["SELECT 1; -- { retry x }", "x", "Could not parse the number of retries: x"],
      ["SELECT 1; -- {retry 2 until serverError 1, 2}", "retry", "Expected one serverError after the 'retry N while|until' command"],
      ["SELECT 1; -- { serverError constructor }", "constructor", "No error code with name: 'constructor'"],
    ];
    for (const [text, at, message] of cases) assert.deepEqual(problems(text), [[at, "error", message]], text);
  });

  test("warns when serverError expects the error of a statement that the client rejects", () => {
    const [problem] = problems("SELECT (; -- { serverError SYNTAX_ERROR }\nSELECT 1;");
    assert.deepEqual(problem!.slice(0, 2), ["{ serverError SYNTAX_ERROR }", "warning"]);
    assert.match(problem![2], /write clientError/);
    assert.deepEqual(problems("SELECT 1,\n  (; -- { clientError SYNTAX_ERROR }"), []);
  });

  test("completes commands, error names and retry words", () => {
    const at = (text: string) => hintCompletions(text.replace("|", ""), text.indexOf("|"))?.map((c) => c.label);
    assert.deepEqual(at("SELECT 1; -- { |"), ["serverError", "clientError", "error", "echo", "echoOn", "echoOff", "retry"]);
    assert.deepEqual(at("SELECT 1; -- { ser|"), ["serverError", "clientError", "error", "echo", "echoOn", "echoOff", "retry"]);
    const errors = at("SELECT 1; -- { serverError |")!;
    assert.ok(errors.includes("UNKNOWN_TABLE") && errors.includes("SYNTAX_ERROR") && errors.length > 600);
    assert.ok(at("SELECT 1; -- { serverError UNKNOWN_TABLE, UNKN| }")!.includes("UNKNOWN_DATABASE"));
    assert.deepEqual(at("SELECT 1; -- { retry 3 |"), ["until", "while"]);
    assert.deepEqual(at("SELECT 1; -- { retry 3 until |"), ["serverError"]);
    assert.equal(at("SELECT 1; -- no hint |"), undefined);
    assert.equal(at("SELECT '{ |'"), undefined);
  });

  test("documents commands and errors", () => {
    const text = "SELECT 1; -- { serverError UNKNOWN_TABLE, 47 }";
    assert.match(hintHover(text, text.indexOf("serverError") + 2)!.markdown, /must fail on the server/);
    assert.equal(hintHover(text, text.indexOf("UNKNOWN") + 2)!.markdown, "**UNKNOWN_TABLE**: error code 60");
    assert.equal(hintHover(text, text.indexOf("47"))!.markdown, "**UNKNOWN_IDENTIFIER**: error code 47");
  });
});
