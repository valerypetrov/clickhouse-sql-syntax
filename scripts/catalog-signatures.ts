// Signatures absent from system.functions and system.table_functions, checked against ClickHouse 26.11 sources.
import type { Argument, FunctionInfo } from "../packages/core/src/generated/functions.js";
import { functionSignature } from "../packages/core/src/complete/functions.js";

export const FUNCTION_SYNTAX: Record<string, string> = {
  any_respect_nulls: "any_respect_nulls(column)",
  anyLast_respect_nulls: "anyLast_respect_nulls(column)",
  caseWithExpr: "caseWithExpr(expr, value, result[, value, result, ...], else_result)",
  connection_id: "connection_id()",
  cume_dist: "cume_dist()",
  denseRank: "denseRank()",
  groupNumericIndexedVector: "groupNumericIndexedVector(index, value)\ngroupNumericIndexedVector(vector_type, integer_bit_num, fraction_bit_num)(index, value)",
  histogram: "histogram(number_of_bins)(value)",
  lag: "lag(x[, offset[, default]])",
  lagInFrame: "lagInFrame(x[, offset[, default]])",
  lead: "lead(x[, offset[, default]])",
  leadInFrame: "leadInFrame(x[, offset[, default]])",
  nonNegativeDerivative: "nonNegativeDerivative(metric_column, timestamp_column[, INTERVAL x unit])",
  nothing: "nothing([value, ...])",
  nothingNull: "nothingNull([value, ...])",
  nothingUInt64: "nothingUInt64([value, ...])",
  nth_value: "nth_value(x, offset)",
  ntile: "ntile(buckets)",
  percentRank: "percentRank()",
  rank: "rank()",
  retention: "retention(condition[, condition, ...])",
  row_number: "row_number()",
  sequenceCount: "sequenceCount(pattern)(timestamp, condition[, condition, ...])",
  sequenceMatch: "sequenceMatch(pattern)(timestamp, condition[, condition, ...])",
  sequenceMatchEvents: "sequenceMatchEvents(pattern)(timestamp, condition[, condition, ...])",
  sequenceNextNode: "sequenceNextNode(direction, base)(timestamp, value_column, base_condition[, condition, ...])",
  sumMapFiltered: "sumMapFiltered(keys_to_keep)(keys, values[, values, ...])",
  sumMapFilteredWithOverflow: "sumMapFilteredWithOverflow(keys_to_keep)(keys, values[, values, ...])",
  tuple: "tuple([value, ...])",
  uniqUpTo: "uniqUpTo(threshold)(value[, value, ...])",
  windowFunnel: "windowFunnel(window[, mode, ...])(timestamp, condition[, condition, ...])",
};

// Positional forms; named collections and SETTINGS remain valid SQL in the parser.
const TABLE_ARGUMENTS: Record<string, string> = {
  SQLStandardValues: "row[, row, ...]",
  arrowFlight: "host, dataset_name[, username, password]",
  azureBlobStorage: "connection_string, container_name, blobpath[, format, compression, partition_strategy, structure]",
  azureBlobStorageCluster: "cluster_name, connection_string, container_name, blobpath[, account_name, account_key, format, compression, structure]",
  bigquery: "project, dataset, table[, access_token]",
  cluster: "cluster_name, database, table[, sharding_key]",
  dictionary: "dictionary_name",
  elasticsearch: "url, index[, user, password]",
  eval: "query",
  executable: "script_name, format, structure[, input_query, ...]",
  file: "path[, format[, structure[, compression]]]",
  fileCluster: "cluster_name, path[, format, structure, compression_method]",
  filesystem: "[path]",
  format: "format_name, [structure,] data",
  fuzzJSON: "json_str[, random_seed]",
  fuzzQuery: "query[, max_query_length[, random_seed]]",
  generateRandom: "[structure[, random_seed[, max_string_length[, max_array_length]]]]",
  generate_series: "start, stop[, step]",
  hdfs: "uri, format, structure",
  hdfsCluster: "cluster_name, uri, format, structure",
  hive: "metastore_url, database, table",
  input: "structure",
  jdbc: "datasource, [external_database,] external_table",
  loop: "[database,] table",
  merge: "[database,] tables_regexp",
  mergeTreeAnalyzeIndexes: "database, table[, condition[, parts_array[, optimization, args_array]]]",
  mergeTreeAnalyzeIndexesUUID: "uuid[, condition[, parts_array[, optimization, args_array]]]",
  mergeTreeCodecBlockCounts: "database, table",
  mergeTreeIndex: "database, table[, with_marks = true][, with_minmax = true]",
  mergeTreeProjection: "database, table, projection",
  mergeTreeTextIndex: "database, table, index_name",
  mongodb: "host, database, collection, user, password, structure[, options[, oid_columns]]",
  mysql: "host, database, table, user, password[, replace_query, on_duplicate_clause]",
  null: "structure",
  numbers: "[offset,] count[, step]",
  obfuscate: "subquery",
  postgresql: "host, database, table, user, password[, schema[, on_conflict]]",
  primes: "[offset,] count[, step]",
  prometheusQuery: "[database,] time_series_table, promql_query, evaluation_time",
  prometheusQueryRange: "[database,] time_series_table, promql_query, start_time, end_time, step",
  redis: "host, key, structure[, db_index[, password[, pool_size]]]",
  remote: "addresses_expr, database, table[, user[, password[, sharding_key]]]",
  s3: "url[, NOSIGN | access_key_id, secret_access_key[, session_token]][, format][, structure][, compression_method][, headers][, extra_credentials][, partition_strategy][, partition_columns_in_data_file]",
  s3Cluster: "cluster_name, url[, NOSIGN | access_key_id, secret_access_key[, session_token]][, format][, structure][, compression_method][, headers][, extra_credentials]",
  sqlite: "db_path, table_name",
  timeSeriesSamples: "[database,] time_series_table",
  timeSeriesSelector: "[database,] time_series_table, instant_query, min_time, max_time, return_columns",
  traceView: "trace_id[, timeline_width[, cluster]]",
  url: "url[, format][, structure][, headers]",
  urlCluster: "cluster_name, url, format, structure",
  values: "[structure,] value[, value, ...]",
  view: "subquery",
  viewExplain: "query",
  viewIfPermitted: "subquery, else_table_function",
  ytsaurus: "http_proxy_url, cypress_path, oauth_token, format",
  zeros: "[count]",
};

const TABLE_ALIASES: Record<string, string> = {
  arrowflight: "arrowFlight", clusterAllReplicas: "cluster", cosn: "s3", gcs: "s3", oss: "s3",
  generateSeries: "generate_series", numbers_mt: "numbers", odbc: "jdbc", remoteSecure: "remote", zeros_mt: "zeros",
  timeSeriesData: "timeSeriesSamples", timeSeriesMetricFamilies: "timeSeriesSamples", timeSeriesMetrics: "timeSeriesSamples",
  timeSeriesTags: "timeSeriesSamples", timeSeriesTimeRanges: "timeSeriesSamples",
};

/** A table function's positional syntax, including the shared storage forms. */
export function tableSyntax(name: string): string | undefined {
  let args = TABLE_ARGUMENTS[TABLE_ALIASES[name] ?? name];
  if (!args && /^(deltaLake|hudi|iceberg|paimon)/.test(name)) {
    const cluster = name.endsWith("Cluster") ? "cluster_name, " : "";
    if (name.includes("Azure")) args = `${cluster}connection_string, container_name, blobpath[, account_name, account_key][, format][, compression_method]`;
    else if (name.includes("Local") || name.includes("HDFS")) args = `${cluster}path[, format][, compression_method]`;
    else args = `${cluster}url[, access_key_id, secret_access_key][, format]${name.startsWith("iceberg") ? "" : "[, structure]"}[, compression_method][, extra_credentials]`;
  }
  if (args === undefined) return undefined;
  const bounded = `${name}(${args})`;
  return /^(numbers|primes)/.test(name) ? `${name}(count)\n${name}(offset, count[, step])\n${name}()` : bounded;
}

const DETAILS: Record<string, Partial<Argument>> = {
  format: { description: "Input format name.", types: ["String"] },
  format_name: { description: "Input format name.", types: ["String"] },
  structure: { description: "Column names and types, such as 'id UInt64, name String'.", types: ["String"] },
  compression: { description: "Compression method.", types: ["String"], values: [["none"], ["gzip", "gz"], ["brotli", "br"], ["xz"], ["zstd", "zst"], ["lz4"], ["bz2"]] },
  direction: { description: "Direction in which to search the events.", types: ["String"], values: [["forward"], ["backward"]] },
  base: { description: "The event from which the search starts.", types: ["String"], values: [["head"], ["tail"], ["first_match"], ["last_match"]] },
  mode: { description: "The window matching mode.", types: ["String"], values: [["strict_deduplication"], ["strict_order"], ["strict_increase"], ["strict_once"]] },
  condition: { description: "Event condition.", types: ["UInt8"] },
  base_condition: { description: "Condition selecting the base event.", types: ["UInt8"] },
};
DETAILS.compression_method = DETAILS.compression!;

/** Keep the server's argument documentation, filling only names absent from it. */
export function withSignature(info: FunctionInfo, syntax: string | undefined = info.syntax): FunctionInfo {
  if (!syntax) return info;
  const signature = functionSignature({ ...info, syntax });
  const list = (group: "arguments" | "parameters"): Argument[] => {
    const documented = info[group] ?? [];
    if (documented.length) return [...documented];
    const names = signature[group].flatMap((l) => [...l.parameters, ...(l.tail ?? [])])
      .flatMap((p) => p.words ?? [p]).filter((p) => !p.keyword || documented.some((a) => a.name === p.name)).map((p) => p.name);
    return [...documented, ...[...new Set(names)].sort((a, b) => syntax.indexOf(a) - syntax.indexOf(b)).filter((name) => !documented.some((a) => a.name === name || a.name.match(/[A-Za-z_]\w*/g)?.includes(name)))
      .map((name) => ({ name, description: name.replaceAll("_", " ") + ".", ...DETAILS[name] }))];
  };
  return { ...info, syntax, arguments: list("arguments"), parameters: list("parameters") };
}
