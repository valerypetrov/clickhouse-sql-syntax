/** Words of statements that no system table lists. */

/** The compression methods of INTO OUTFILE and FROM INFILE, with the other spellings of src/IO/CompressionMethod.cpp. */
export const COMPRESSION_METHODS = new Set(["auto", "none", "gzip", "deflate", "br", "xz", "zstd", "lz4", "bz2", "snappy", "gz", "brotli", "lzma", "zst", ""]);

/** The kinds of EXPLAIN, longest first among those that share a word. */
export const EXPLAIN_KINDS = ["AST", "SYNTAX", "QUERY TREE", "PLAN", "PIPELINE", "ESTIMATE", "ANALYZE", "TABLE OVERRIDE", "CURRENT TRANSACTION", "WHATIF"];
