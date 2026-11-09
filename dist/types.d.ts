/**
 * Shared contracts of the library. Every other module builds on these types,
 * so change them only together with all their users.
 */
import type { ParseCache } from "./parser/index.js";
/** Token kinds of ClickHouse's lexer, named as in src/Parsers/Lexer.h. */
export declare enum TokenKind {
    Whitespace = "Whitespace",
    Comment = "Comment",
    /** A keyword (SELECT) or an identifier (column). */
    BareWord = "BareWord",
    /** Never negative, no leading plus: 123, 123.456e12, 0x123p12, 0b101, 1_000. */
    Number = "Number",
    /** 'hello', 'it''s', 'it\'s', x'ab', b'01', ‘hello’. */
    StringLiteral = "StringLiteral",
    /** "x", `x`, “x”. */
    QuotedIdentifier = "QuotedIdentifier",
    OpeningRoundBracket = "OpeningRoundBracket",
    ClosingRoundBracket = "ClosingRoundBracket",
    OpeningSquareBracket = "OpeningSquareBracket",
    ClosingSquareBracket = "ClosingSquareBracket",
    OpeningCurlyBrace = "OpeningCurlyBrace",
    ClosingCurlyBrace = "ClosingCurlyBrace",
    Comma = "Comma",
    Semicolon = "Semicolon",
    /** \G at the end of a query. */
    VerticalDelimiter = "VerticalDelimiter",
    /** a.b, a.1 and (x, y).2; never the start of a number like .1 */
    Dot = "Dot",
    /** Multiplication or "SELECT *". */
    Asterisk = "Asterisk",
    /** $tag$ ... $tag$ and $$ ... $$. */
    HereDoc = "HereDoc",
    DollarSign = "DollarSign",
    Plus = "Plus",
    Minus = "Minus",
    Slash = "Slash",
    Percent = "Percent",
    /** -> */
    Arrow = "Arrow",
    QuestionMark = "QuestionMark",
    Colon = "Colon",
    Caret = "Caret",
    /** :: */
    DoubleColon = "DoubleColon",
    /** = and == */
    Equals = "Equals",
    /** != and <> */
    NotEquals = "NotEquals",
    Less = "Less",
    Greater = "Greater",
    LessOrEquals = "LessOrEquals",
    GreaterOrEquals = "GreaterOrEquals",
    /** <=> */
    Spaceship = "Spaceship",
    /** | */
    PipeMark = "PipeMark",
    /** |> */
    PipeOperator = "PipeOperator",
    /** || */
    Concatenation = "Concatenation",
    Tilde = "Tilde",
    /** ~* */
    TildeAsterisk = "TildeAsterisk",
    /** !~ */
    NotTilde = "NotTilde",
    /** !~* */
    NotTildeAsterisk = "NotTildeAsterisk",
    At = "At",
    /** @@ */
    DoubleAt = "DoubleAt",
    /** Zero-width token at the end of the input; always the last token. */
    EndOfStream = "EndOfStream",
    /** Something unrecognized. */
    Error = "Error",
    ErrorMultilineCommentIsNotClosed = "ErrorMultilineCommentIsNotClosed",
    ErrorSingleQuoteIsNotClosed = "ErrorSingleQuoteIsNotClosed",
    ErrorDoubleQuoteIsNotClosed = "ErrorDoubleQuoteIsNotClosed",
    ErrorBackQuoteIsNotClosed = "ErrorBackQuoteIsNotClosed",
    ErrorSingleExclamationMark = "ErrorSingleExclamationMark",
    ErrorWrongNumber = "ErrorWrongNumber"
}
/** Messages for error tokens, worded as in ClickHouse's getErrorTokenDescription(). */
export declare const LEXER_ERROR_MESSAGES: Readonly<Partial<Record<TokenKind, string>>>;
/** True for every token except whitespace and comments. */
export declare function isSignificant(kind: TokenKind): boolean;
/** True for the Error* kinds. */
export declare function isErrorKind(kind: TokenKind): boolean;
/**
 * Offsets count UTF-16 code units of the JavaScript string, like String.prototype.slice.
 * Lines and columns start at 1; a line ends at "\n", "\r\n" or a lone "\r".
 */
export interface Token {
    kind: TokenKind;
    /** Offset of the first character. */
    start: number;
    /** Offset just past the last character. */
    end: number;
    /** Line of `start`. */
    line: number;
    /** Column of `start`. */
    col: number;
}
export type Severity = "error" | "warning";
/** A problem found by check(). Offsets, line and column follow the same rules as Token. */
export interface Diagnostic {
    message: string;
    start: number;
    /** Equal to `start` for a problem at the end of the input. */
    end: number;
    line: number;
    col: number;
    severity: Severity;
    /** Edits that fix the problem, for a quick fix. */
    fixes?: Fix[];
}
/** A change of the input that fixes a diagnostic. */
export interface Fix {
    title: string;
    edits: TextEdit[];
    /** The fix to apply first, when it is the one closest to what was written. */
    preferred?: boolean;
}
/**
 * TextMate scope names used by highlight() and by the VS Code grammar, so that
 * any TextMate theme colours them. Every significant token falls in exactly one span.
 */
export type Scope = 
/** -- comment, // comment, # comment, #!shebang */
"comment.line.sql"
/** Nested multiline comment. */
 | "comment.block.sql"
/** A word from the ClickHouse keyword list used as a keyword. */
 | "keyword.other.sql"
/** Symbolic operators: + - * / % = != < <= <=> || -> :: ? : ^ ~ |> @ ... */
 | "keyword.operator.sql"
/** NULL, TRUE, FALSE. */
 | "constant.language.sql" | "constant.numeric.sql"
/** 'string', x'hex', b'bits', ‘string’. */
 | "string.quoted.single.sql"
/** $tag$ ... $tag$ */
 | "string.unquoted.heredoc.sql"
/** Identifiers, bare or quoted. */
 | "variable.other.sql"
/** A whole query parameter such as {name:Type}. */
 | "variable.parameter.sql"
/** The name before the "(" of a function call. */
 | "entity.name.function.sql"
/** Data type names such as UInt64 or Nullable. */
 | "storage.type.sql"
/** Brackets, commas, dots and semicolons. */
 | "punctuation.sql"
/** Error tokens. */
 | "invalid.illegal.sql";
/** One coloured piece of the input. Spans are sorted and never overlap. */
export interface HighlightSpan {
    start: number;
    end: number;
    scope: Scope;
}
/** The public API, implemented in lexer/, highlight/ and parser/. */
export interface ClickHouseSqlSyntax {
    /** Every token of the input in order, whitespace and comments included, ending with EndOfStream. */
    tokenize(sql: string): Token[];
    /** Coloured spans for the input; whitespace is not covered. */
    highlight(sql: string): HighlightSpan[];
    /** Syntax errors of every ';'-separated statement; an empty array when the input is valid. */
    check(sql: string): Diagnostic[];
    /** What ClickHouse refuses in the settings, codecs, index types, formats and other options of the statements that parse. */
    checkOptions(sql: string, cache?: ParseCache): Diagnostic[];
    /** The input with ClickHouse-style layout and keyword case; meaning, names and comments are kept. */
    format(sql: string, options?: FormatOptions): string;
    /** Suggestions at an offset: the keywords valid there, and the functions, types, settings or names that fit. */
    complete(sql: string, offset: number, options?: CompleteOptions): CompletionCandidate[];
    /** The documentation of a function, setting, table function, table engine, format or combinator. */
    describe(name: string, kind?: CompletionKind): Description | undefined;
    /** The lines an editor can fold: statements, brackets and comments of several lines, and -- #region blocks. */
    foldingRanges(sql: string): FoldingRange[];
    /** Each statement with its kind and a short name, and its CTEs and columns; a ParseCache saves parsing again. */
    outline(sql: string, cache?: ParseCache): OutlineSymbol[];
    /** For each offset, the pieces around it from the token out to the statement, each holding the one before. */
    selectionRanges(sql: string, offsets: readonly number[], cache?: ParseCache): TextRange[][];
    /** Where the alias, CTE, table alias, lambda parameter or query parameter at an offset is defined. */
    definition(sql: string, offset: number, options?: NameOptions): NameLocation[];
    /** Every place of its statement that names the same thing as the name at an offset. */
    references(sql: string, offset: number, options?: NameOptions): NameLocation[];
    /** The name at an offset and its range, if rename() can rename it. */
    prepareRename(sql: string, offset: number, options?: NameOptions): PrepareRenameResult;
    /** The edits that give the name at an offset a new name, quoted where needed. */
    rename(sql: string, offset: number, newName: string, options?: NameOptions): RenameResult;
    /** The tables, views, dictionaries, functions and databases that the CREATE statements make, without parsing them. */
    objects(sql: string): SqlObject[];
    /** The names of tables and databases in the statements that parse, with the database that each one means. */
    objectReferences(sql: string, options?: NameOptions): ObjectReference[];
    /** The objects of `files` that a reference in `file` may name, as ClickHouse runs each file in a session of its own. */
    objectDefinitions<F>(reference: ObjectReference, file: F, files: ReadonlyMap<F, readonly SqlObject[]>): {
        file: F;
        object: SqlObject;
    }[];
}
/** Options of definition(), references(), prepareRename() and rename(). */
export interface NameOptions {
    /** The statements parsed before, as checkWithRoles() keeps them. */
    cache?: ParseCache;
}
/** Where a name is written; `definition` is true where it is defined. */
export interface NameLocation {
    start: number;
    end: number;
    definition: boolean;
}
/** What a CREATE statement makes. */
export type ObjectKind = "table" | "view" | "materialized view" | "dictionary" | "function" | "database";
/** An object that a CREATE statement of the input makes, as objects() finds it. */
export interface SqlObject {
    kind: ObjectKind;
    name: string;
    /**
     * The database written before the name, or set by an earlier USE; none for the session's database, a function, a
     * temporary table and a database. A query parameter such as `{db:Identifier}` is kept as written.
     */
    database?: string;
    temporary: boolean;
    /** The statement. */
    start: number;
    end: number;
    /** The name with its database, as written. */
    nameStart: number;
    nameEnd: number;
}
/** A name of a table, view or dictionary, or of a database, in a statement that parses. */
export interface ObjectReference {
    kind: "table" | "database";
    name: string;
    /** For a table, the database written before it or set by an earlier USE, as in SqlObject. */
    database?: string;
    /** Whether the database is written before the name. */
    qualified: boolean;
    start: number;
    end: number;
}
/** Text from `start` to `end` to replace with `newText`. */
export interface TextEdit {
    start: number;
    end: number;
    newText: string;
}
/** What prepareRename() gives: the name and where it is written, or why it cannot be renamed. */
export type PrepareRenameResult = {
    start: number;
    end: number;
    name: string;
    error?: undefined;
} | {
    error: string;
};
/** The name and the range that rename() would change. */
export type RenameRange = Extract<PrepareRenameResult, {
    name: string;
}>;
/** What rename() gives: the edits, or why it cannot rename. */
export type RenameResult = {
    edits: TextEdit[];
    error?: undefined;
} | {
    error: string;
    edits?: undefined;
};
/** How format() writes keywords: in upper case, in lower case, or as they are. */
export type KeywordCase = "upper" | "lower" | "preserve";
/** Options of format(). */
export interface FormatOptions {
    /** "upper" by default. */
    keywordCase?: KeywordCase;
    /** Spaces per level of indentation, 4 by default. */
    indentSize?: number;
}
/** What a completion candidate or a described name is. */
export type CompletionKind = "keyword" | "function" | "combinator" | "table function" | "table engine" | "format" | "setting" | "data type" | "database" | "table" | "column"
/** A value to write, such as a ZooKeeper path in the arguments of an engine. */
 | "value"
/** A compression codec of CODEC(...). */
 | "codec"
/** The type of a skipping index, after INDEX name expr TYPE. */
 | "index type"
/** A kind of column statistics, as in STATISTICS(tdigest). */
 | "statistics type" | "database engine";
/** One suggestion of complete(). */
export interface CompletionCandidate {
    label: string;
    kind: CompletionKind;
    /** A short note shown next to the label, such as the type of a column. */
    detail?: string;
    /** Markdown from the ClickHouse documentation. */
    documentation?: string;
    /** What to insert when it is not the label, such as a name in back quotes. */
    insertText?: string;
    /** Where the cursor goes in what is inserted when not at its end, as 3 inside the quotes of `'$.'`. */
    cursor?: number;
}
/** Databases, tables and their columns, for example as a live server lists them. */
export interface CompletionSchema {
    databases?: string[];
    tables?: {
        database: string;
        name: string;
        columns: {
            name: string;
            type: string;
        }[];
    }[];
    /** The clusters of the server, for the arguments of engines like Distributed. */
    clusters?: string[];
    /** The macros of the server, such as replica; when given, suggestions that use macros say what they stand for. */
    macros?: {
        name: string;
        value: string;
    }[];
}
/** Options of complete(). */
export interface CompleteOptions {
    /** Names to offer besides those ClickHouse knows; columns come from the tables the statement uses. */
    schema?: CompletionSchema;
}
/** The engine whose brackets an offset is in, and the parameters that the argument there may be. */
export interface EngineArgument {
    /** The engine as ClickHouse spells it. */
    engine: string;
    /** Names of the parameters that describe() gives for the engine, in its order; empty past the last one. */
    parameters: string[];
}
/** The function whose brackets an offset is in, and the documented arguments that the argument there may be. */
export interface FunctionArgument {
    /** Present for calls that read tables, such as s3(). */
    kind?: "table function";
    /** The function as ClickHouse spells it, the one an alias stands for. */
    function: string;
    /** Whether the brackets hold the parameters of a parametric aggregate function, as the first ones of quantile(0.5)(x). */
    parameters: boolean;
    /** Names of the arguments, or parameters, that describe() gives for the function, in its order; empty past the last one. */
    arguments: string[];
}
/** What a documented argument of a function takes, as its documentation describes it. */
export type ArgumentKind = 
/** The name of a data type in a string, as the T of CAST(x, 'T'). */
"data type"
/** A data type that JSONExtract() and the other functions that parse JSON can return. */
 | "JSON data type"
/** One of the values its documentation lists, as the unit of dateDiff(). */
 | "value" | "time zone" | "format"
/** A JSONPath, as the path of JSON_VALUE(). */
 | "JSON path";
/** A documented argument of a function. */
export interface ArgumentInfo {
    name: string;
    description: string;
    /** The types its documentation names, such as `String` or `(U)Int*`. */
    types?: readonly string[];
    /** What it takes, for an argument of a function whose documentation tells; none for an expression of any kind. */
    kind?: ArgumentKind;
}
/** The documentation of a name, and for a function what signature help needs. */
export interface Description {
    /** The name as ClickHouse spells it. */
    name: string;
    kind: CompletionKind;
    /** Markdown. */
    documentation: string;
    /** How it is used, one form per line, such as `toDate(x)`. */
    syntax?: string;
    arguments?: readonly ArgumentInfo[];
    /** The parameters of a parametric aggregate function, as `level` in quantile(level)(x). */
    parameters?: readonly ArgumentInfo[];
}
/**
 * Lines that an editor can fold, numbered as in Token. The first line stays in view, and the
 * lines after it up to endLine fold under it.
 */
export interface FoldingRange {
    startLine: number;
    endLine: number;
    kind?: "comment" | "region";
}
/** What a symbol of outline() is: what a CREATE statement makes, a query, another statement, a CTE or a column. */
export type OutlineKind = "table" | "view" | "dictionary" | "database" | "function" | "query" | "statement" | "cte" | "column";
/** A statement, or a CTE or column of one, for an editor's outline. Offsets follow the rules of Token. */
export interface OutlineSymbol {
    /** A short name: "CREATE TABLE db.t", "SELECT … FROM db.t", or the name of the CTE or column. */
    name: string;
    kind: OutlineKind;
    /** The whole statement, CTE or column. */
    start: number;
    end: number;
    /** Where its name is written; the SELECT keyword of a query, and the leading keywords of a statement without a name. */
    nameStart: number;
    nameEnd: number;
    children: OutlineSymbol[];
}
/** A piece of the input, by offsets. */
export interface TextRange {
    start: number;
    end: number;
}
/** The documented parameter that an argument of a call is, for an inlay hint before it. */
export interface ParameterHint {
    /** Where the argument starts. */
    offset: number;
    name: string;
}
/** The documentation of a SYSTEM command or of a clause of an access statement, and the keywords it covers. */
export interface KeywordDocumentation extends TextRange {
    documentation: string;
}
//# sourceMappingURL=types.d.ts.map