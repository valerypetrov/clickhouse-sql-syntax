/**
 * The parser state: a port of IParser::Pos, Tokens and Expected from ClickHouse.
 * A parser function takes a P and returns a node, or null and leaves p.i where it was.
 */
import { TokenKind as T, isErrorKind, type Token } from "../types.js";

export { T };

/** ClickHouse's max_parser_depth and max_parser_backtracks defaults. */
export const MAX_PARSER_DEPTH = 1000;
export const MAX_PARSER_BACKTRACKS = 1_000_000;

/**
 * What the parser could accept at the rightmost position it reached, like ClickHouse's Expected.
 * ClickHouse compares the descriptions by pointer, so `ids` keeps what tells two equal texts apart.
 */
export class Expected {
  /** Token index of the position, -1 when nothing was added yet. */
  pos = -1;
  variants: string[] = [];
  ids: string[] = [];

  add(pos: number, description: string, id = description): void {
    if (this.pos < 0 || pos > this.pos) {
      this.variants = [description];
      this.ids = [id];
      this.pos = pos;
    } else if (pos === this.pos && !this.ids.includes(id)) {
      this.variants.push(description);
      this.ids.push(id);
    }
  }

  /** expected.variants.clear(): keeps the position. */
  clearVariants(): void {
    this.variants = [];
    this.ids = [];
  }

  copy(): Expected {
    const result = new Expected();
    result.assign(this);
    return result;
  }

  assign(other: Expected): void {
    this.pos = other.pos;
    this.variants = [...other.variants];
    this.ids = [...other.ids];
  }
}

/** An exception the parser throws instead of returning false, which ends the whole parse. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly tokenIndex: number,
    /** True for ClickHouse's SYNTAX_ERROR code, false for other codes such as BAD_ARGUMENTS. */
    readonly syntax = true,
  ) {
    super(message);
  }
}

export class P {
  /** Current token index; it may run past the last token like a C++ iterator. */
  i: number;
  /** Rightmost token index looked at, like Tokens::max(). */
  maxIndex: number;
  e = new Expected();
  depth = 0;
  backtracks = 0;
  readonly last: number;
  private readonly lowered: (string | undefined)[] = [];

  constructor(
    readonly toks: Token[],
    readonly sql: string,
    start = 0,
  ) {
    this.last = toks.length - 1;
    this.i = start;
    this.maxIndex = start;
  }

  /** The token at index i, recording that the parser looked at it. */
  at(i: number): Token {
    const index = i < this.last ? i : this.last;
    if (index > this.maxIndex) this.maxIndex = index;
    return this.toks[index]!;
  }

  tok(): Token {
    return this.at(this.i);
  }

  kind(): T {
    return this.at(this.i).kind;
  }

  kindAt(i: number): T {
    return this.at(i).kind;
  }

  textAt(i: number): string {
    const token = this.at(i);
    return this.sql.slice(token.start, token.end);
  }

  text(): string {
    return this.textAt(this.i);
  }

  lowerAt(i: number): string {
    const index = i < this.last ? i : this.last;
    this.at(index);
    let value = this.lowered[index];
    if (value === undefined) {
      value = this.textAt(index).toLowerCase();
      this.lowered[index] = value;
    }
    return value;
  }

  lower(): string {
    return this.lowerAt(this.i);
  }

  /** Neither the end nor an error token: TokenIterator::isValid(). */
  validAt(i: number): boolean {
    const kind = this.kindAt(i);
    return kind !== T.EndOfStream && !isErrorKind(kind);
  }

  valid(): boolean {
    return this.validAt(this.i);
  }

  isEnd(i = this.i): boolean {
    return this.kindAt(i) === T.EndOfStream;
  }

  /** Is the token a bare word equal to `word`, given in lower case? */
  isWord(word: string, i = this.i): boolean {
    return this.kindAt(i) === T.BareWord && this.lowerAt(i) === word;
  }

  /** Token index as a position for Expected, clamped like the C++ token stream. */
  posOf(i: number): number {
    this.at(i);
    return i < this.last ? i : this.last;
  }

  /** expected.add(pos, description). */
  expect(description: string, i = this.i, id = description): void {
    this.e.add(this.posOf(i), description, id);
  }

  /** Moves back to an earlier position, counting backtracks as ClickHouse does. */
  restore(i: number): void {
    if (i < this.i) {
      this.backtracks++;
      if (this.backtracks > MAX_PARSER_BACKTRACKS)
        throw new ParseError(
          `Maximum amount of backtracking (${MAX_PARSER_BACKTRACKS}) exceeded in the parser. ` +
            "Consider rising max_parser_backtracks parameter.",
          this.i,
          false,
        );
    }
    this.i = i;
  }

  increaseDepth(): void {
    this.depth++;
    if (this.depth > MAX_PARSER_DEPTH)
      throw new ParseError(
        `Maximum parse depth (${MAX_PARSER_DEPTH}) exceeded. Consider rising max_parser_depth parameter.`,
        this.i,
        false,
      );
  }

  /** Runs `body` with its own Expected, so that what it adds is thrown away. */
  quiet<R>(body: () => R, expected = new Expected()): R {
    const saved = this.e;
    this.e = expected;
    try {
      return body();
    } finally {
      this.e = saved;
    }
  }

  fail(message: string, i = this.i): never {
    throw new ParseError(message, i);
  }

  /** An exception with a code other than SYNTAX_ERROR. */
  failOther(message: string, i = this.i): never {
    throw new ParseError(message, i, false);
  }
}

type Result<R> = R | null | undefined | false;

/**
 * IParserBase::parse: names the parser in Expected, counts the depth and
 * moves back to the start when the body fails.
 */
export function base<R>(p: P, name: string, body: () => Result<R>): R | null {
  p.expect(name);
  const begin = p.i;
  const depth = p.depth;
  p.increaseDepth();
  const result = body();
  p.depth = depth;
  if (result === null || result === undefined || result === false) {
    p.restore(begin);
    return null;
  }
  // IParserBase::parse reads the token after a successful parse, which counts as looking at it.
  p.at(p.i);
  return result;
}

/** Runs `body` and moves back if it fails, like IParser::check or a saved Pos. */
export function attempt<R>(p: P, body: () => Result<R>): R | null {
  const begin = p.i;
  const depth = p.depth;
  const result = body();
  if (result === null || result === undefined || result === false) {
    p.restore(begin);
    p.depth = depth;
    return null;
  }
  return result;
}

/**
 * Runs `body` on a copy of the position, like a C++ Pos passed by value: the position,
 * depth and backtrack count come back afterwards. With `expected`, Expected is left alone too.
 */
export function lookahead<R>(p: P, body: () => R, expected?: Expected): R {
  const { i, depth, backtracks } = p;
  try {
    return expected ? p.quiet(body, expected) : body();
  } finally {
    p.i = i;
    p.depth = depth;
    p.backtracks = backtracks;
  }
}

interface KeywordInfo {
  lowerWords: string[];
  /** What Expected gets at each word: the rest of the keyword from that word on. */
  descriptions: string[];
  ids: string[];
}

const keywordInfo = new Map<string, KeywordInfo>();

function infoOf(keyword: string): KeywordInfo {
  let info = keywordInfo.get(keyword);
  if (!info) {
    const words = keyword.split(" ");
    const descriptions = words.map((_, index) => words.slice(index).join(" "));
    info = {
      lowerWords: words.map((word) => word.toLowerCase()),
      descriptions,
      // The tail of a keyword is a pointer into the middle of the keyword string.
      ids: descriptions.map((text, index) => (index === 0 ? text : `${keyword}@${index}`)),
    };
    keywordInfo.set(keyword, info);
  }
  return info;
}

/**
 * ParserKeyword(keyword).ignore(pos, expected). An `id` tells this keyword apart from another
 * one with the same text, as two keyword strings at different addresses are in ClickHouse.
 */
export function kw(p: P, keyword: string, id?: string): boolean {
  const info = infoOf(keyword);
  const ids = id === undefined ? info.ids : info.ids.map((_, w) => (w === 0 ? id : `${id}@${w}`));
  p.expect(keyword, p.i, ids[0]);
  if (p.depth + 1 > MAX_PARSER_DEPTH) p.increaseDepth();
  const begin = p.i;
  if (p.kind() !== T.BareWord) return false;
  for (let w = 0; w < info.lowerWords.length; w++) {
    p.expect(info.descriptions[w]!, p.i, ids[w]);
    if (p.kind() !== T.BareWord || p.lower() !== info.lowerWords[w]) {
      p.restore(begin);
      return false;
    }
    p.i++;
  }
  p.at(p.i);
  return true;
}

/** ParserKeyword(keyword).checkWithoutMoving(pos, expected). */
export function peekKw(p: P, keyword: string): boolean {
  const begin = p.i;
  const ok = kw(p, keyword);
  p.i = begin;
  return ok;
}

/** ParserKeyword(keyword).checkWithoutMoving(pos, stub): looks ahead without touching Expected. */
export function peekKwQuiet(p: P, keyword: string): boolean {
  return p.quiet(() => peekKw(p, keyword));
}

/** ParserKeyword(keyword).ignore(pos), with a throwaway Expected. */
export function kwQuiet(p: P, keyword: string): boolean {
  return p.quiet(() => kw(p, keyword));
}

/** ParserToken(kind).ignore(pos, expected). */
export function tok(p: P, kind: T): boolean {
  p.expect("token");
  if (p.depth + 1 > MAX_PARSER_DEPTH) p.increaseDepth();
  if (p.kind() !== kind) {
    p.expect(kind);
    return false;
  }
  p.i++;
  p.at(p.i);
  return true;
}

/** ParserToken(kind).ignore(pos), with a throwaway Expected. */
export function tokQuiet(p: P, kind: T): boolean {
  return p.quiet(() => tok(p, kind));
}

/** ParserTokenSequence(kinds).ignore(pos, expected). */
export function tokSeq(p: P, kinds: T[]): boolean {
  return (
    base(p, "token sequence", () => {
      for (const kind of kinds) {
        if (p.kind() !== kind) {
          p.expect(kind);
          return false;
        }
        p.i++;
      }
      return true;
    }) !== null
  );
}

/**
 * ParserList::parseUtil: elements with separators. A separator not followed
 * by an element is left unparsed unless trailing separators are allowed.
 */
export function listUtil(
  p: P,
  element: () => unknown,
  separator: () => boolean = () => tok(p, T.Comma),
  allowEmpty = true,
  allowTrailing = false,
): boolean {
  let begin = p.i;
  if (!element()) {
    p.restore(begin);
    return allowEmpty;
  }
  for (;;) {
    begin = p.i;
    if (!separator()) {
      p.restore(begin);
      return true;
    }
    const afterSeparator = p.i;
    if (!element()) {
      p.restore(allowTrailing ? afterSeparator : begin);
      return true;
    }
  }
}

/** Case-insensitive ASCII comparison. */
export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

export function isWordChar(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

export function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
