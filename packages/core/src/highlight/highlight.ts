import { DATA_TYPES } from "../generated/data-types.js";
import { KEYWORDS } from "../generated/keywords.js";
import { tokenize } from "../lexer/index.js";
import { TokenKind, isErrorKind, isSignificant, type HighlightSpan, type Scope, type Token } from "../types.js";

// highlight() colours tokens, and bare words by what is around them: bareWord() tries its rules
// in order, and the first that matches wins.

/** Keywords that a bracket often follows without making a function call, as in IN (1, 2). */
const CLAUSE_WORDS = new Set(
  (
    "ALIAS ALL AND APPLY ARGUMENTS AS BETWEEN BY CASE CHECK CODEC COLUMNS CUBE DEFAULT DESCRIBE DISTINCT " +
    "ELSE EPHEMERAL EXCEPT EXPLAIN FILTER FROM HAVING ILIKE IN INTERPOLATE INTERSECT INTERVAL JOIN KEY " +
    "LATERAL LAYOUT LIFETIME LIKE LIMIT MATERIALIZED NOT OFFSET ON OR OVER PARTITION PREWHERE QUALIFY " +
    "ROLLUP SELECT SETTINGS SOME SOURCE STATISTICS THEN TOP TTL UNION USING VALUES WHEN WHERE WITH"
  ).split(" "),
);

/** Words after which a name is a table or another object, not a function: CREATE TABLE t (...). */
const OBJECT_WORDS = new Set(["TABLE", "VIEW", "DICTIONARY", "EXISTS", "TO", "INTO", "CLUSTER", "INDEX", "PROJECTION"]);

/** The object words whose bracket holds column definitions or column names. */
const COLUMN_LIST_WORDS = new Set(["TABLE", "VIEW", "DICTIONARY", "EXISTS", "TO", "INTO", "CLUSTER"]);

/** Keywords that may follow AS: CREATE VIEW v AS SELECT, CREATE ROW POLICY p ON t AS RESTRICTIVE. */
const KEYWORDS_AFTER_AS = new Set("SELECT WITH FROM MATERIALIZED PERMISSIVE RESTRICTIVE REPLICATED NOT".split(" "));

/** Names of access entities, which ClickHouse takes as keywords: DROP USER, SHOW POLICIES. */
const ACCESS_KEYWORDS = ["USER", "USERS", "ROLES", "QUOTAS", "POLICY", "POLICIES", "MASKING"];

/** Keywords that may come before "=": ENGINE = Memory, DEFINER = user. */
const KEYWORDS_BEFORE_EQUALS = new Set(["ENGINE", "DEFINER"]);

/** Short interval units, keywords only after a number or a string, as in INTERVAL 1 D. */
const UNIT_ABBREVIATIONS = new Set("D DD H HH M MCS MI MM MS N NS Q QQ S SS WK WW YY YYYY".split(" "));

const COMPARISONS = new Set([
  TokenKind.Equals,
  TokenKind.NotEquals,
  TokenKind.Less,
  TokenKind.Greater,
  TokenKind.LessOrEquals,
  TokenKind.GreaterOrEquals,
  TokenKind.Spaceship,
]);

/** The commands of SYSTEM queries, from ASTSystemQuery::Type in src/Parsers/ASTSystemQuery.h. */
export const SYSTEM_COMMANDS: readonly string[] = (
  "SHUTDOWN KILL SUSPEND CLEAR_DNS_CACHE CLEAR_CONNECTIONS_CACHE PREWARM_MARK_CACHE PREWARM_PRIMARY_INDEX_CACHE " +
  "CLEAR_MARK_CACHE CLEAR_PRIMARY_INDEX_CACHE CLEAR_STATISTICS_CACHE CLEAR_UNCOMPRESSED_CACHE CLEAR_INDEX_MARK_CACHE " +
  "CLEAR_INDEX_UNCOMPRESSED_CACHE CLEAR_VECTOR_SIMILARITY_INDEX_CACHE CLEAR_TEXT_INDEX_TOKENS_CACHE " +
  "CLEAR_TEXT_INDEX_HEADER_CACHE CLEAR_TEXT_INDEX_POSTINGS_CACHE CLEAR_TEXT_INDEX_CACHES CLEAR_COLUMNS_CACHE " +
  "CLEAR_MMAP_CACHE CLEAR_QUERY_CONDITION_CACHE CLEAR_ENCRYPTION_HEADERS_CACHE CLEAR_QUERY_CACHE " +
  "CLEAR_COMPILED_EXPRESSION_CACHE CLEAR_ICEBERG_METADATA_CACHE CLEAR_PAIMON_METADATA_CACHE " +
  "CLEAR_PARQUET_METADATA_CACHE CLEAR_POINT_IN_POLYGON_CACHE CLEAR_FILESYSTEM_CACHE CLEAR_DISTRIBUTED_CACHE " +
  "CLEAR_DISK_METADATA_CACHE CLEAR_PAGE_CACHE CLEAR_SCHEMA_CACHE CLEAR_FORMAT_SCHEMA_CACHE CLEAR_AVRO_SCHEMA_CACHE " +
  "CLEAR_S3_CLIENT_CACHE CLEAR_TIME_SERIES_CACHES STOP_LISTEN START_LISTEN RESTART_REPLICAS RESTART_REPLICA " +
  "RESTORE_REPLICA RESTORE_DATABASE_REPLICA WAIT_LOADING_PARTS WAIT_QUERY_RUNNER DROP_REPLICA DROP_DATABASE_REPLICA " +
  "DROP_CATALOG_REPLICA JEMALLOC_PURGE JEMALLOC_ENABLE_PROFILE JEMALLOC_DISABLE_PROFILE JEMALLOC_FLUSH_PROFILE " +
  "SYNC_REPLICA SYNC_DATABASE_REPLICA SYNC_TRANSACTION_LOG SYNC_FILE_CACHE REPLICA_READY REPLICA_UNREADY " +
  "RELOAD_DICTIONARY RELOAD_DICTIONARIES UNLOAD_DICTIONARY UNLOAD_DICTIONARIES RELOAD_FUNCTION RELOAD_FUNCTIONS " +
  "RELOAD_EMBEDDED_DICTIONARIES RELOAD_CONFIG RELOAD_USERS RELOAD_ASYNCHRONOUS_METRICS RELOAD_DELTA_KERNEL_TRACING " +
  "RESTART_DISK STOP_MERGES START_MERGES STOP_TTL_MERGES START_TTL_MERGES STOP_FETCHES START_FETCHES STOP_MOVES " +
  "START_MOVES STOP_REPLICATED_SENDS START_REPLICATED_SENDS STOP_REPLICATION_QUEUES START_REPLICATION_QUEUES " +
  "STOP_REPLICATED_DDL_QUERIES START_REPLICATED_DDL_QUERIES FLUSH_LOGS FLUSH_DISTRIBUTED FLUSH_ASYNC_INSERT_QUEUE " +
  "FLUSH_OBJECT_STORAGE_QUEUE STOP_DISTRIBUTED_SENDS START_DISTRIBUTED_SENDS START_THREAD_FUZZER STOP_THREAD_FUZZER " +
  "UNFREEZE ENABLE_FAILPOINT DISABLE_FAILPOINT DISABLE_ALL_FAILPOINTS ALLOCATE_MEMORY FREE_MEMORY WAIT_FAILPOINT " +
  "NOTIFY_FAILPOINT SYNC_FILESYSTEM_CACHE STOP_PULLING_REPLICATION_LOG START_PULLING_REPLICATION_LOG STOP_CLEANUP " +
  "START_CLEANUP SCHEDULE_MERGE SYNC_MERGES RESET_COVERAGE SET_COVERAGE_TEST REFRESH_VIEW WAIT_VIEW START_VIEW " +
  "START_VIEWS START_REPLICATED_VIEW STOP_VIEW STOP_VIEWS STOP_REPLICATED_VIEW PAUSE_VIEW PAUSE_VIEWS CANCEL_VIEW " +
  "TEST_VIEW LOAD_PRIMARY_KEY UNLOAD_PRIMARY_KEY STOP_VIRTUAL_PARTS_UPDATE START_VIRTUAL_PARTS_UPDATE " +
  "STOP_REDUCE_BLOCKING_PARTS START_REDUCE_BLOCKING_PARTS UNLOCK_SNAPSHOT RECONNECT_ZOOKEEPER WAIT_BLOBS_CLEANUP " +
  "INSTRUMENT_ADD INSTRUMENT_REMOVE RESET_DDL_WORKER RESET_FILELOG STOP_ALL_BACKGROUND START_ALL_BACKGROUND " +
  "PAUSE_ALL_BACKGROUND CANCEL_ALL_BACKGROUND"
)
  .split(" ")
  // ClickHouse still takes the older DROP ... CACHE for each CLEAR ... CACHE command.
  .flatMap((name) => (name.startsWith("CLEAR_") ? [name, name.replace("CLEAR_", "DROP_")] : [name]))
  .map((name) => name.replaceAll("_", " "));

const CONSTANTS = new Set(["NULL", "TRUE", "FALSE"]);

interface Phrase {
  words: string[];
  caseInsensitive: boolean;
}

/** Multi-word names indexed by their first word, longest first. */
class PhraseTable {
  private readonly byFirstWord = new Map<string, Phrase[]>();

  constructor(entries: Iterable<Phrase>) {
    for (const phrase of entries) {
      const key = phrase.words[0]!.toUpperCase();
      const list = this.byFirstWord.get(key) ?? [];
      list.push(phrase);
      this.byFirstWord.set(key, list);
    }
    for (const list of this.byFirstWord.values()) list.sort((a, b) => b.words.length - a.words.length);
  }

  /** Number of words of the longest phrase that `words` starts with, or 0. */
  match(words: readonly string[]): number {
    const candidates = this.byFirstWord.get(words[0]!.toUpperCase()) ?? [];
    for (const { words: phrase, caseInsensitive } of candidates) {
      if (phrase.length > words.length) continue;
      const same = phrase.every((word, i) =>
        caseInsensitive ? word.toUpperCase() === words[i]!.toUpperCase() : word === words[i],
      );
      if (same) return phrase.length;
    }
    return 0;
  }
}

const KEYWORD_TABLE = new PhraseTable(
  [...KEYWORDS, ...ACCESS_KEYWORDS].map((k) => ({ words: k.split(" "), caseInsensitive: true })),
);
const SYSTEM_TABLE = new PhraseTable(SYSTEM_COMMANDS.map((c) => ({ words: c.split(" "), caseInsensitive: true })));
const TYPE_TABLE = new PhraseTable(
  DATA_TYPES.map((t) => ({ words: t.name.split(" "), caseInsensitive: t.caseInsensitive })),
);
const MAX_PHRASE_WORDS = 6;

/** What an open bracket holds; it decides where data types are expected. */
type BracketKind = "columns" | "type" | "cast" | "other";

class Highlighter {
  /** Significant tokens, ending with EndOfStream. */
  private readonly sig: Token[] = [];
  /** For each significant token, its index in `tokens`. */
  private readonly rawIndex: number[] = [];
  private readonly scopes: (Scope | undefined)[];
  /** Query parameters: index of "{" to index of "}". */
  private readonly params = new Map<number, number>();
  private readonly brackets: BracketKind[] = [];
  private typeExpected = false;

  constructor(
    private readonly sql: string,
    private readonly tokens: Token[],
  ) {
    tokens.forEach((t, i) => {
      if (!isSignificant(t.kind)) return;
      this.sig.push(t);
      this.rawIndex.push(i);
    });
    this.scopes = new Array<Scope | undefined>(this.sig.length);
  }

  run(): HighlightSpan[] {
    for (let i = 0; i < this.sig.length; ) i = this.classify(i);
    return this.spans();
  }

  private text(i: number): string {
    const t = this.sig[i];
    return t ? this.sql.slice(t.start, t.end) : "";
  }

  private kind(i: number): TokenKind | undefined {
    return this.sig[i]?.kind;
  }

  /** The upper-case text of a bare word, or "" for any other token. */
  private word(i: number): string {
    return this.kind(i) === TokenKind.BareWord ? this.text(i).toUpperCase() : "";
  }

  private isName(i: number): boolean {
    return this.kind(i) === TokenKind.BareWord || this.kind(i) === TokenKind.QuotedIdentifier;
  }

  /** The bare words from `i` on that a phrase could be made of; one before a "." ends the run. */
  private wordsAt(i: number): string[] {
    const words: string[] = [];
    for (let j = i; words.length < MAX_PHRASE_WORDS && this.kind(j) === TokenKind.BareWord; j++) {
      if (j > i && this.kind(j + 1) === TokenKind.Dot) break;
      words.push(this.text(j));
    }
    return words;
  }

  private typeAt(i: number): number {
    return this.kind(i) === TokenKind.BareWord ? TYPE_TABLE.match(this.wordsAt(i)) : 0;
  }

  /** Whether the next significant token is "(" on the same line, with only spaces between. */
  private callFollows(i: number): boolean {
    return this.kind(i + 1) === TokenKind.OpeningRoundBracket && this.onSameLine(i);
  }

  /** Whether only spaces, no line break or comment, separate significant tokens `i` and `i + 1`. */
  private onSameLine(i: number): boolean {
    for (let r = this.rawIndex[i]! + 1; r < this.rawIndex[i + 1]!; r++) {
      if (this.tokens[r]!.kind !== TokenKind.Whitespace) return false;
    }
    return !/[\r\n]/.test(this.sql.slice(this.sig[i]!.end, this.sig[i + 1]!.start));
  }

  /** Classifies significant token `i` and returns the index of the next one to classify. */
  private classify(i: number): number {
    const token = this.sig[i]!;
    const typeExpected = this.typeExpected;
    this.typeExpected = false;

    switch (token.kind) {
      case TokenKind.BareWord:
        return this.bareWord(i, typeExpected);
      case TokenKind.QuotedIdentifier:
        this.scopes[i] = "variable.other.sql";
        if (this.declaresName(i)) this.typeExpected = true;
        return i + 1;
      case TokenKind.OpeningCurlyBrace: {
        const end = this.queryParameterEnd(i);
        if (end > 0) {
          this.params.set(i, end);
          return end + 1;
        }
        this.brackets.push("other");
        this.scopes[i] = "punctuation.sql";
        return i + 1;
      }
      case TokenKind.OpeningRoundBracket:
        this.brackets.push(this.bracketKind(i));
        this.scopes[i] = "punctuation.sql";
        return i + 1;
      case TokenKind.OpeningSquareBracket:
        this.brackets.push("other");
        this.scopes[i] = "punctuation.sql";
        return i + 1;
      case TokenKind.ClosingRoundBracket:
      case TokenKind.ClosingSquareBracket:
      case TokenKind.ClosingCurlyBrace:
        this.brackets.pop();
        this.scopes[i] = "punctuation.sql";
        return i + 1;
      case TokenKind.DoubleColon:
        this.scopes[i] = "keyword.operator.sql";
        this.typeExpected = true;
        return i + 1;
      case TokenKind.Semicolon:
        this.brackets.length = 0;
        this.scopes[i] = "punctuation.sql";
        return i + 1;
      default:
        this.scopes[i] = tokenScope(token.kind);
        return i + 1;
    }
  }

  private bareWord(i: number, typeExpected: boolean): number {
    const upper = this.word(i);
    // Next to a "." it is a name: db.table, t.column.
    if (this.kind(i - 1) === TokenKind.Dot || this.kind(i + 1) === TokenKind.Dot) {
      this.scopes[i] = "variable.other.sql";
      return i + 1;
    }
    // ENGINE = Memory names an engine, and ENGINE = MergeTree() calls one.
    if (this.kind(i - 1) === TokenKind.Equals && this.word(i - 2) === "ENGINE") {
      this.scopes[i] = this.callFollows(i) ? "entity.name.function.sql" : "variable.other.sql";
      return i + 1;
    }
    if (CONSTANTS.has(upper)) {
      this.scopes[i] = "constant.language.sql";
      return i + 1;
    }

    // A type where one goes: after "::", in CAST(x AS T), after a column name, inside Array(...).
    const bracket = this.brackets.at(-1);
    const inType = bracket === "type";
    const castAs = bracket === "cast" && this.word(i - 1) === "AS";
    const typeWords = this.typeAt(i);
    if (typeWords > 0 && (typeExpected || castAs || inType)) {
      // Inside Tuple(...) a type name followed by a type is an element name, as in Tuple(date Date).
      if (!typeExpected && !castAs && this.typeAt(i + typeWords) > 0) {
        this.scopes[i] = "variable.other.sql";
        this.typeExpected = true;
        return i + 1;
      }
      for (let j = i; j < i + typeWords; j++) this.scopes[j] = "storage.type.sql";
      return i + typeWords;
    }

    if (this.declaresName(i)) {
      this.scopes[i] = "variable.other.sql";
      this.typeExpected = true;
      return i + 1;
    }

    // A name before "(" is a function, except a keyword as in IN (...) or a table as in CREATE TABLE t (...).
    if (this.callFollows(i)) {
      if (CLAUSE_WORDS.has(upper)) this.scopes[i] = "keyword.other.sql";
      else if (OBJECT_WORDS.has(this.word(i - 1))) this.scopes[i] = "variable.other.sql";
      else this.scopes[i] = "entity.name.function.sql";
      return i + 1;
    }

    // SYSTEM FLUSH LOGS
    const commandWords = this.word(i - 1) === "SYSTEM" ? SYSTEM_TABLE.match(this.wordsAt(i)) : 0;
    if (commandWords > 0) {
      for (let j = i; j < i + commandWords; j++) this.scopes[j] = "keyword.other.sql";
      return i + commandWords;
    }

    if (this.keywordIsName(i, upper)) {
      this.scopes[i] = "variable.other.sql";
      return i + 1;
    }

    // Phrases like ORDER BY are matched whole.
    const keywordWords = KEYWORD_TABLE.match(this.wordsAt(i));
    if (keywordWords > 0) {
      for (let j = i; j < i + keywordWords; j++) {
        this.scopes[j] = CONSTANTS.has(this.word(j)) ? "constant.language.sql" : "keyword.other.sql";
      }
      return i + keywordWords;
    }

    this.scopes[i] = "variable.other.sql";
    return i + 1;
  }

  /** Whether a word that may be a keyword is a name here: AS key, name = 'x', a lone D or S. */
  private keywordIsName(i: number, upper: string): boolean {
    // After a number or a string it is a unit: INTERVAL 1 DAY, INTERVAL '1' D.
    if (this.kind(i - 1) === TokenKind.Number || this.kind(i - 1) === TokenKind.StringLiteral) return false;
    if (this.word(i - 1) === "AS") return !KEYWORDS_AFTER_AS.has(upper);
    if (UNIT_ABBREVIATIONS.has(upper)) return true;
    return COMPARISONS.has(this.kind(i + 1)!) && this.onSameLine(i) && !KEYWORDS_BEFORE_EQUALS.has(upper);
  }

  /** Whether name `i` is followed by its data type: a column, a named tuple element. */
  private declaresName(i: number): boolean {
    if (this.typeAt(i + 1) === 0) return false;
    const bracket = this.brackets.at(-1);
    if (bracket === "type") return true;
    const prev = this.kind(i - 1);
    if (bracket === "columns" && (prev === TokenKind.OpeningRoundBracket || prev === TokenKind.Comma)) return true;
    // ALTER TABLE t ADD COLUMN [IF NOT EXISTS] name Type
    let j = i - 1;
    while (["IF", "NOT", "EXISTS"].includes(this.word(j))) j--;
    return this.word(j) === "COLUMN";
  }

  /** Decides what the "(" at `i` holds from the tokens before it. */
  private bracketKind(i: number): BracketKind {
    const prev = this.scopes[i - 1];
    if (prev === "storage.type.sql") return "type";
    if (prev === "entity.name.function.sql") return this.word(i - 1) === "CAST" ? "cast" : "other";
    // CREATE TABLE [db.]t (...), ON CLUSTER '{cluster}' (...), UUID '...' (...)
    if (this.kind(i - 1) === TokenKind.StringLiteral) {
      return ["CLUSTER", "UUID"].includes(this.word(i - 2)) ? "columns" : "other";
    }
    if (!this.isName(i - 1)) return "other";
    let j = i - 2;
    if (this.kind(j) === TokenKind.Dot && this.isName(j - 1)) j -= 2;
    return COLUMN_LIST_WORDS.has(this.word(j)) ? "columns" : "other";
  }

  /** For "{" at `i` that opens {name:Type}, the index of its "}", otherwise 0. */
  private queryParameterEnd(i: number): number {
    if (this.kind(i + 1) !== TokenKind.BareWord || this.kind(i + 2) !== TokenKind.Colon) return 0;
    if (this.kind(i + 3) !== TokenKind.BareWord) return 0;
    let depth = 0;
    for (let j = i + 4; j < this.sig.length; j++) {
      const kind = this.sig[j]!.kind;
      if (kind === TokenKind.OpeningRoundBracket || kind === TokenKind.OpeningSquareBracket) depth++;
      else if (kind === TokenKind.ClosingRoundBracket || kind === TokenKind.ClosingSquareBracket) {
        if (--depth < 0) return 0;
      } else if (kind === TokenKind.ClosingCurlyBrace) {
        return depth === 0 ? j : 0;
      } else if (
        kind === TokenKind.OpeningCurlyBrace ||
        kind === TokenKind.Semicolon ||
        kind === TokenKind.EndOfStream ||
        isErrorKind(kind)
      ) {
        return 0;
      }
    }
    return 0;
  }

  /** Puts the comments back between the classified tokens. */
  private spans(): HighlightSpan[] {
    const spans: HighlightSpan[] = [];
    let s = 0;
    let skipUntil = 0;
    for (const token of this.tokens) {
      if (token.start < skipUntil) continue;
      if (token.kind === TokenKind.Comment) {
        const block = this.sql.startsWith("/*", token.start);
        spans.push({ start: token.start, end: token.end, scope: block ? "comment.block.sql" : "comment.line.sql" });
        continue;
      }
      if (!isSignificant(token.kind)) continue;
      while (this.sig[s] !== token) s++;
      const paramEnd = this.params.get(s);
      if (paramEnd !== undefined) {
        const end = this.sig[paramEnd]!.end;
        spans.push({ start: token.start, end, scope: "variable.parameter.sql" });
        skipUntil = end;
        continue;
      }
      const scope = this.scopes[s];
      if (scope && token.end > token.start) spans.push({ start: token.start, end: token.end, scope });
    }
    return spans;
  }
}

/** The scope of a token that is not a word. */
function tokenScope(kind: TokenKind): Scope | undefined {
  if (isErrorKind(kind)) return "invalid.illegal.sql";
  switch (kind) {
    case TokenKind.Number:
      return "constant.numeric.sql";
    case TokenKind.StringLiteral:
      return "string.quoted.single.sql";
    case TokenKind.HereDoc:
      return "string.unquoted.heredoc.sql";
    case TokenKind.Comma:
    case TokenKind.Dot:
    case TokenKind.VerticalDelimiter:
      return "punctuation.sql";
    case TokenKind.EndOfStream:
      return undefined;
    default:
      return "keyword.operator.sql";
  }
}

/** Returns coloured spans for `sql`, sorted by offset. */
export function highlight(sql: string): HighlightSpan[] {
  return new Highlighter(sql, tokenize(sql)).run();
}
