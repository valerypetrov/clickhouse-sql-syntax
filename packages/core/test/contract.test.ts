import assert from "node:assert/strict";
import { test } from "node:test";

import api, { DATA_TYPES, KEYWORDS, LEXER_ERROR_MESSAGES, TokenKind, isErrorKind, isSignificant } from "../src/index.js";

test("the default export carries the whole API", () => {
  assert.deepEqual(Object.keys(api).sort(), ["check", "highlight", "tokenize"]);
});

test("every Error* kind has a message and no other kind has one", () => {
  for (const kind of Object.values(TokenKind)) {
    assert.equal(isErrorKind(kind), kind.startsWith("Error"), kind);
    assert.equal(kind in LEXER_ERROR_MESSAGES, kind.startsWith("Error"), kind);
  }
});

test("only whitespace and comments are insignificant", () => {
  const insignificant = Object.values(TokenKind).filter((kind) => !isSignificant(kind));
  assert.deepEqual(insignificant, [TokenKind.Whitespace, TokenKind.Comment]);
});

test("generated keyword list has single and multi-word keywords", () => {
  assert.equal(new Set(KEYWORDS).size, KEYWORDS.length);
  assert.ok(KEYWORDS.includes("SELECT"));
  assert.ok(KEYWORDS.includes("ORDER BY"));
});

test("generated data type list knows names and aliases", () => {
  const byName = new Map(DATA_TYPES.map((t) => [t.name, t]));
  assert.equal(byName.size, DATA_TYPES.length);
  assert.equal(byName.get("UInt64")?.caseInsensitive, false);
  assert.equal(byName.get("BIGINT")?.aliasTo, "Int64");
});
