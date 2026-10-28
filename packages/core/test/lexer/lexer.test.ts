import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { tokenize } from "../../src/lexer/index.js";
import { TokenKind, isSignificant, type Token } from "../../src/types.js";

/** Kind and text of every token but EndOfStream. */
function lex(sql: string): [TokenKind, string][] {
  return tokenize(sql)
    .filter((token) => token.kind !== TokenKind.EndOfStream)
    .map((token) => [token.kind, sql.slice(token.start, token.end)]);
}

/** The kind of the only token of `sql`. */
function kindOf(sql: string): TokenKind {
  const tokens = lex(sql);
  assert.equal(tokens.length, 1, `${JSON.stringify(sql)} gives ${JSON.stringify(tokens)}`);
  return tokens[0]![0];
}

/** Checks the promises of tokenize(): full coverage in order, and a zero-width EndOfStream at the end. */
function assertWellFormed(sql: string, tokens: Token[]): void {
  let offset = 0;
  for (const [i, token] of tokens.entries()) {
    const last = i === tokens.length - 1;
    assert.equal(token.start, offset, `gap or overlap before token ${i} of ${JSON.stringify(sql)}`);
    assert.equal(token.kind === TokenKind.EndOfStream, last);
    assert.ok(last ? token.end === token.start : token.end > token.start);
    offset = token.end;
  }
  assert.equal(offset, sql.length);
}

describe("token kinds", () => {
  const examples: [string, TokenKind][] = [
    [" \t\r\n\f\v", TokenKind.Whitespace],
    [" 　 ", TokenKind.Whitespace],
    ["-- comment", TokenKind.Comment],
    ["// comment", TokenKind.Comment],
    ["# comment", TokenKind.Comment],
    ["#!/usr/bin/env clickhouse-local", TokenKind.Comment],
    ["/* a /* nested */ comment */", TokenKind.Comment],
    ["SELECT", TokenKind.BareWord],
    ["$alias$name$", TokenKind.BareWord],
    ["1st", TokenKind.BareWord],
    ["inf", TokenKind.BareWord],
    ["123", TokenKind.Number],
    ["1_000.000_1e-1_0", TokenKind.Number],
    ["0x1F.8p-3", TokenKind.Number],
    ["0b1010", TokenKind.Number],
    [".5e3", TokenKind.Number],
    ["'it''s \\'quoted\\''", TokenKind.StringLiteral],
    ["x'4142'", TokenKind.StringLiteral],
    ["b'0101'", TokenKind.StringLiteral],
    ["‘curly’", TokenKind.StringLiteral],
    ['"double ""quoted"""', TokenKind.QuotedIdentifier],
    ["`back``quoted`", TokenKind.QuotedIdentifier],
    ["“curly”", TokenKind.QuotedIdentifier],
    ["(", TokenKind.OpeningRoundBracket],
    [")", TokenKind.ClosingRoundBracket],
    ["[", TokenKind.OpeningSquareBracket],
    ["]", TokenKind.ClosingSquareBracket],
    ["{", TokenKind.OpeningCurlyBrace],
    ["}", TokenKind.ClosingCurlyBrace],
    [",", TokenKind.Comma],
    [";", TokenKind.Semicolon],
    ["\\G", TokenKind.VerticalDelimiter],
    ["*", TokenKind.Asterisk],
    ["$tag$ any 'text' $tag$", TokenKind.HereDoc],
    ["$$$$", TokenKind.HereDoc],
    ["$", TokenKind.DollarSign],
    ["+", TokenKind.Plus],
    ["-", TokenKind.Minus],
    ["−", TokenKind.Minus],
    ["/", TokenKind.Slash],
    ["%", TokenKind.Percent],
    ["->", TokenKind.Arrow],
    ["?", TokenKind.QuestionMark],
    [":", TokenKind.Colon],
    ["^", TokenKind.Caret],
    ["::", TokenKind.DoubleColon],
    ["=", TokenKind.Equals],
    ["==", TokenKind.Equals],
    ["!=", TokenKind.NotEquals],
    ["<>", TokenKind.NotEquals],
    ["<", TokenKind.Less],
    [">", TokenKind.Greater],
    ["<=", TokenKind.LessOrEquals],
    [">=", TokenKind.GreaterOrEquals],
    ["<=>", TokenKind.Spaceship],
    ["|", TokenKind.PipeMark],
    ["|>", TokenKind.PipeOperator],
    ["||", TokenKind.Concatenation],
    ["~", TokenKind.Tilde],
    ["~*", TokenKind.TildeAsterisk],
    ["!~", TokenKind.NotTilde],
    ["!~*", TokenKind.NotTildeAsterisk],
    ["@", TokenKind.At],
    ["@@", TokenKind.DoubleAt],
    ["&", TokenKind.Error],
    ["#", TokenKind.Error],
    ["é", TokenKind.Error],
    ["😀", TokenKind.Error],
    ["/* open", TokenKind.ErrorMultilineCommentIsNotClosed],
    ["'open", TokenKind.ErrorSingleQuoteIsNotClosed],
    ["x'4g'", TokenKind.ErrorSingleQuoteIsNotClosed],
    ["‘open", TokenKind.ErrorSingleQuoteIsNotClosed],
    ['"open', TokenKind.ErrorDoubleQuoteIsNotClosed],
    ["“open", TokenKind.ErrorDoubleQuoteIsNotClosed],
    ["`open", TokenKind.ErrorBackQuoteIsNotClosed],
    ["!", TokenKind.ErrorSingleExclamationMark],
    ["1.5x", TokenKind.ErrorWrongNumber],
  ];

  for (const [sql, kind] of examples) {
    test(`${JSON.stringify(sql)} is ${kind}`, () => assert.equal(kindOf(sql), kind));
  }

  // A lone "." is a Number, as in ClickHouse; the Dot tests are below.
  test("every kind has an example", () => {
    const covered = new Set<TokenKind>([...examples.map(([, kind]) => kind), TokenKind.Dot, TokenKind.EndOfStream]);
    assert.deepEqual(Object.values(TokenKind).filter((kind) => !covered.has(kind)), []);
  });
});

describe("tricky input", () => {
  test("a dot after a name or a bracket is tuple access, so x.1.1 is not x . 1.1", () => {
    assert.deepEqual(lex("x.1.1"), [
      [TokenKind.BareWord, "x"],
      [TokenKind.Dot, "."],
      [TokenKind.Number, "1"],
      [TokenKind.Dot, "."],
      [TokenKind.Number, "1"],
    ]);
    assert.deepEqual(lex("(1).2"), [
      [TokenKind.OpeningRoundBracket, "("],
      [TokenKind.Number, "1"],
      [TokenKind.ClosingRoundBracket, ")"],
      [TokenKind.Dot, "."],
      [TokenKind.Number, "2"],
    ]);
  });

  test("comments between tokens do not change how a dot is read", () => {
    assert.deepEqual(
      lex("x /**/ .5").filter(([kind]) => isSignificant(kind)),
      [
        [TokenKind.BareWord, "x"],
        [TokenKind.Dot, "."],
        [TokenKind.Number, "5"],
      ],
    );
  });

  test("# starts a comment only before a space or !", () => {
    assert.deepEqual(lex("#hash"), [
      [TokenKind.Error, "#"],
      [TokenKind.BareWord, "hash"],
    ]);
  });

  test("a dot after an operator starts a number", () => {
    assert.deepEqual(lex("1+.5"), [
      [TokenKind.Number, "1"],
      [TokenKind.Plus, "+"],
      [TokenKind.Number, ".5"],
    ]);
  });

  test("a heredoc needs its closing tag, otherwise $ starts a word", () => {
    assert.deepEqual(lex("$a$x"), [
      [TokenKind.BareWord, "$a$x"],
    ]);
    assert.deepEqual(lex("$doc$ $x$ $doc$"), [[TokenKind.HereDoc, "$doc$ $x$ $doc$"]]);
  });

  test("a single-line comment ends at \\n only, and the \\n is whitespace", () => {
    assert.deepEqual(lex("-- a\rb\nc"), [
      [TokenKind.Comment, "-- a\rb"],
      [TokenKind.Whitespace, "\n"],
      [TokenKind.BareWord, "c"],
    ]);
  });

  test("an unclosed string runs to the end of the input", () => {
    assert.deepEqual(lex("SELECT 'a\nb"), [
      [TokenKind.BareWord, "SELECT"],
      [TokenKind.Whitespace, " "],
      [TokenKind.ErrorSingleQuoteIsNotClosed, "'a\nb"],
    ]);
  });

  test("an error token covers one whole character", () => {
    assert.deepEqual(lex("a😀b"), [
      [TokenKind.BareWord, "a"],
      [TokenKind.Error, "😀"],
      [TokenKind.BareWord, "b"],
    ]);
  });
});

describe("positions", () => {
  test("the empty input has only EndOfStream", () => {
    assert.deepEqual(tokenize(""), [{ kind: TokenKind.EndOfStream, start: 0, end: 0, line: 1, col: 1 }]);
  });

  test("lines end at \\n, \\r\\n and a lone \\r", () => {
    const tokens = tokenize("a\nb\r\nc\rd\n").filter((token) => token.kind !== TokenKind.Whitespace);
    assert.deepEqual(
      tokens.map((token) => [token.kind, token.line, token.col]),
      [
        [TokenKind.BareWord, 1, 1],
        [TokenKind.BareWord, 2, 1],
        [TokenKind.BareWord, 3, 1],
        [TokenKind.BareWord, 4, 1],
        [TokenKind.EndOfStream, 5, 1],
      ],
    );
  });

  test("offsets and columns count UTF-16 code units", () => {
    const tokens = tokenize("😀 x‘é’\tSELECT");
    assert.deepEqual(
      tokens.map((token) => [token.kind, token.start, token.end, token.col]),
      [
        [TokenKind.Error, 0, 2, 1],
        [TokenKind.Whitespace, 2, 3, 3],
        [TokenKind.BareWord, 3, 4, 4],
        [TokenKind.StringLiteral, 4, 7, 5],
        [TokenKind.Whitespace, 7, 8, 8],
        [TokenKind.BareWord, 8, 14, 9],
        [TokenKind.EndOfStream, 14, 14, 15],
      ],
    );
  });

  test("a token keeps the line and column of its start", () => {
    const [comment] = tokenize("/* a\nb */ x");
    assert.deepEqual(comment, { kind: TokenKind.Comment, start: 0, end: 9, line: 1, col: 1 });
    const x = tokenize("/* a\nb */ x").find((token) => token.kind === TokenKind.BareWord)!;
    assert.deepEqual([x.line, x.col], [2, 6]);
  });
});

test("any input is covered without gaps and ends with EndOfStream", () => {
  const pieces = [..."019xXbBeEpP._'\"`\\$-+>/*#!=<|:@~?^{}(),;%[] \n\r\t", "‘", "’", "“", "”", "−", "é", "　", "😀"];
  let seed = 1;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 3000; i++) {
    let sql = "";
    for (let length = 1 + random(12); length > 0; length--) sql += pieces[random(pieces.length)];
    assertWellFormed(sql, tokenize(sql));
  }
});
