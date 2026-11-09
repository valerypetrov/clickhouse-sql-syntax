export interface ParameterRule {
    /** Numbers ClickHouse was asked about, with whether it took them; a value between two that agree gets their verdict. */
    ints: readonly (readonly [number, boolean])[];
    floats: readonly (readonly [number, boolean])[];
    /** The strings and bare words it took, in lower case; the others are refused when ClickHouse refused an unknown one. */
    strings?: readonly string[];
    words?: readonly string[];
    stringsRefused?: boolean;
    wordsRefused?: boolean;
    /** ClickHouse's messages for refused values, with {} for the value: int, negative, float, string or word. */
    messages: Readonly<Record<string, string>>;
}
/** The parameters a codec or an index type takes. */
export interface CallRule {
    min: number;
    max: number;
    /** ClickHouse's message for too many parameters, with {} for their count. */
    tooMany?: string;
    tooFew?: string;
    /** Counts between min and max that ClickHouse refuses, with its message. */
    gaps?: readonly (readonly [number, string])[];
    parameters: readonly ParameterRule[];
}
export interface CodecInfo {
    name: string;
    description?: string;
    compression?: boolean;
    /** A general-purpose compression, such as LZ4 or ZSTD, after which no other codec makes sense. */
    generic?: boolean;
    encryption?: boolean;
    timeSeries?: boolean;
    /** Experimental or Beta. */
    tier?: string;
    /** The setting that allows it, for a codec of a tier other than Production. */
    setting?: string;
    /** A column type that it applies to. */
    type?: string;
    /** ClickHouse's message when it cannot be written in CODEC at all. */
    refused?: string;
    rule?: CallRule;
    /** The column types it refuses, by ClickHouse's message with {} for the type, written without parameters and with them. */
    types?: readonly TypeRefusal[];
    typesWithParameters?: readonly TypeRefusal[];
}
export interface TypeRefusal {
    message: string;
    types: readonly string[];
    /** The number of parameters it was written with; none when any parameters give the same refusals. */
    parameters?: number;
}
/** The arguments of an index type written as name = value, as those of text. */
export interface NamedArguments {
    required: readonly string[];
    /** ClickHouse's messages, with {} for the name or names. */
    missing?: string;
    positional?: string;
    unknown?: string;
    duplicate?: string;
    /** The names it takes, with what each value may be; null when its values are not known. */
    arguments: Readonly<Record<string, ParameterRule | null>>;
    tokenizers: readonly string[];
    unknownTokenizer?: string;
}
export interface IndexTypeInfo {
    name: string;
    syntax?: string;
    description?: string;
    rule?: CallRule;
    named?: NamedArguments;
    /** ClickHouse's message for a type that no table can use any more. */
    refused?: string;
}
export interface NamedInfo {
    name: string;
    syntax?: string;
    description?: string;
}
export interface ExplainSettings {
    /** The kind of EXPLAIN, such as PLAN. */
    kind: string;
    /** ClickHouse's message for an unknown name, with {} for it and {list} for the settings it takes. */
    unknown: string;
    /** Its message for a string, with {} for the name and {type} for the type of the value. */
    string?: string;
    /** Its message for a boolean setting set to another number, with {} for the name and {value} for the value. */
    bool?: string;
    settings: readonly {
        name: string;
        bool?: boolean;
        description?: string;
    }[];
}
export declare const UNKNOWN_INDEX_TYPE = "Unknown Index type '{}'. Available index types: hypothesis, text, vector_similarity, bloom_filter, sparse_grams, tokenbf_v1, ngrambf_v1, set, minmax.";
export declare const STATISTICS_MESSAGE = "Unknown statistics type: {}. Supported statistics types are 'basic', 'countmin', 'minmax', 'tdigest', 'uniq' and 'uniq_v2'.";
/** The settings that a column can have in SETTINGS (...), and ClickHouse's message for others, with {} for the name. */
export declare const COLUMN_SETTINGS: readonly string[];
export declare const COLUMN_SETTING_MESSAGE = "Setting {} is unknown or not supported at column level, supported settings: max_compress_block_size, min_compress_block_size.";
/** The levels that INTO OUTFILE takes after COMPRESSION, by method, and ClickHouse's message for others. */
export declare const COMPRESSION_LEVELS: Readonly<Record<string, readonly [number, number]>>;
export declare const COMPRESSION_LEVEL_MESSAGE = "Invalid compression level, must be positive integer in range {min}-{max}.";
export declare const CODECS: readonly CodecInfo[];
export declare const INDEX_TYPES: readonly IndexTypeInfo[];
export declare const STATISTICS_TYPES: readonly NamedInfo[];
export declare const DATABASE_ENGINES: readonly NamedInfo[];
export declare const EXPLAIN_SETTINGS: readonly ExplainSettings[];
//# sourceMappingURL=options.d.ts.map