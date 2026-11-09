/** Words that ClickHouse never takes as an alias without AS, from ParserAlias. */
export declare const RESTRICTED_ALIASES: Set<string>;
/** Interval units, as IntervalKind parses them. */
export declare const INTERVAL_UNITS: Set<string>;
/** Every word that is a keyword or part of one. */
export declare const KEYWORD_WORDS: Set<string>;
/** The keyword phrases that start with `first`, longest first. */
export declare function phrasesOf(first: string): readonly string[][];
/** The commands of SYSTEM queries, from ASTSystemQuery::Type, longest first. */
export declare const SYSTEM_COMMANDS: readonly string[][];
export declare const JOIN_WORDS: Set<string>;
export declare const SET_OPERATIONS: Set<string>;
/** Column keywords that end the data type or the expression before them. */
export declare const COLUMN_WORDS: Set<string>;
/** CREATE clauses that start a line of their own. */
export declare const CREATE_CLAUSES: Set<string>;
/** Dictionary clauses written as a keyword followed by brackets: SOURCE(...). */
export declare const DICTIONARY_CALLS: Set<string>;
/** Words after which a statement names an object: TABLE t, FROM db. */
export declare const NAME_WORDS: Set<string>;
/** Object words that, followed by a name, are keywords even right after a NAME_WORDS word: TRUNCATE TABLE t. */
export declare const OBJECT_WORDS: Set<string>;
/** Keywords that may come before "=" in a statement: ENGINE = Memory. */
export declare const KEYWORDS_BEFORE_EQUALS: Set<string>;
/** Keywords of ALTER TABLE commands, which start a new command after a comma. */
export declare const ALTER_COMMANDS: Set<string>;
/** Keywords that may come right before "(": ORDER BY (a, b), NOT IN (1, 2). */
export declare const PAREN_AFTER: Set<string>;
/** Keywords that follow a name in a statement: DROP TABLE t SYNC, ON t USING x. */
export declare const AFTER_NAME: Set<string>;
/** Functions whose first argument may be an interval unit: dateDiff(hour, a, b). */
export declare const UNIT_FUNCTIONS: Set<string>;
/** Keywords that may come before "(" in the tail of a statement: WHERE (a = 1). */
export declare const TAIL_PAREN_KEYWORDS: Set<string>;
/** Keywords that may end a statement after a name. */
export declare const ENDING_WORDS: Set<string>;
/** First words of the kinds of EXPLAIN. */
export declare const EXPLAIN_KINDS: Set<string>;
/** Words that start a statement that EXPLAIN may explain. */
export declare const STATEMENT_WORDS: Set<string>;
/** Second words of multi-word data types: DOUBLE PRECISION, INT UNSIGNED, CHARACTER VARYING. */
export declare const TYPE_WORDS: Set<string>;
//# sourceMappingURL=words.d.ts.map