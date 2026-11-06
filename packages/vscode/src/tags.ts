// The "-- Tags:" and "-- Random settings limits:" lines of ClickHouse's tests, as tests/clickhouse-test reads them.
import type { HintCompletion, Problem } from "./hints.js";

/** The tags that tests/clickhouse-test reads, and what each does there. */
export const TAGS: Readonly<Record<string, string>> = {
  disabled: "Never runs, unless clickhouse-test gets --disabled.",
  "no-parallel": "Runs alone, never at the same time as other tests.",
  sequential: "Runs alone, never at the same time as other tests, as no-parallel does.",
  long: "Skipped with --no-long; the flaky check gives it a longer timeout.",
  deadlock: "A test for a deadlock, which runs a long time: skipped with --no-long.",
  race: "A test for a race, which runs a long time: skipped with --no-long.",
  zookeeper: "Needs ZooKeeper: skipped without --zookeeper and in the cloud.",
  replica: "Needs replicas and ZooKeeper: skipped without --zookeeper and in the cloud.",
  shard: "Needs shards: skipped without --shard.",
  distributed: "Needs distributed tables: skipped without --shard.",
  global: "Needs GLOBAL subqueries over shards: skipped without --shard.",
  "no-fasttest": "Skipped in the Fast test, whose build leaves many libraries out.",
  "fasttest-only": "Runs only in the Fast test.",
  "no-replicated-database": "Skipped when the test database is Replicated, and with the shared catalog.",
  "no-shared-merge-tree": "Skipped when Replicated tables are replaced with Shared ones, and in the cloud.",
  "shared-catalog": "Runs only with the shared catalog.",
  "no-shared-catalog": "Skipped with the shared catalog.",
  "no-parallel-replicas": "Skipped in the runs with parallel replicas.",
  "no-async-insert": "Skipped in the runs with asynchronous inserts.",
  "no-darwin": "Skipped on macOS.",
  linux: "Runs only on Linux.",
  "memory-engine": "Uses the Memory engine: skipped when Log and Memory tables are replaced with MergeTree.",
  "log-engine": "Uses the Log engines: skipped when Log and Memory tables are replaced with MergeTree.",
  "no-llvm-coverage": "Skipped in the LLVM coverage build.",
  "no-coverage": "Skipped when coverage is collected for each test.",
  "use-rocksdb": "Needs a build with RocksDB; skipped when the test database is Replicated.",
  "use-hdfs": "Needs a build with HDFS; skipped in the cloud.",
  "no-distributed-cache": "Skipped with the distributed cache.",
  "atomic-database": "Runs only when the test database is Atomic.",
  "no-s3-storage": "Skipped when tables are stored in S3.",
  "no-azure-blob-storage": "Skipped when tables are stored in Azure Blob Storage.",
  "no-object-storage": "Skipped when tables are stored in S3 or Azure, and in the cloud.",
  "no-object-storage-with-slow-build": "Skipped when tables are stored in S3 or Azure, unless the build is a release one.",
  "no-batch": "Skipped when the tests are split into batches by hash.",
  "no-flaky-check": "Skipped in the flaky check, which runs each new test many times.",
  stateful: "A stateful test, on the datasets of the stateful runs: skipped in them with --no-stateful, run only there.",
  "no-openssl-fips": "Skipped in the OpenSSL FIPS build.",
  "no-encrypted-storage": "Skipped when tables are stored encrypted.",
  "no-sanitizers": "Skipped in the builds with any sanitizer.",
  "no-random-settings": "Runs with the default settings, not random ones.",
  "no-random-merge-tree-settings": "Its MergeTree tables get the default settings, not random ones.",
  "need-query-parameters": "Gets the query parameters CLICKHOUSE_DATABASE and the like; clickhouse-test adds this tag by itself to a test that writes {CLICKHOUSE_...}.",
  cloud: "Runs only in the cloud.",
  "cloud-no-sticky": "In the cloud, its queries may run on different replicas.",
  "no-tsan": "Skipped in the build with ThreadSanitizer.",
  "no-asan": "Skipped in the build with AddressSanitizer.",
  "no-ubsan": "Skipped in the build with UndefinedBehaviorSanitizer.",
  "no-msan": "Skipped in the build with MemorySanitizer.",
  "no-debug": "Skipped in the debug build.",
  "no-release": "Skipped in the release build.",
  "no-with-coverage": "Skipped in the build with coverage.",
  "no-with-coverage-depth": "Skipped in the build with coverage depth.",
  "no-ordinary-database": "Skipped when the test database may be Ordinary.",
  "no-polymorphic-parts": "Skipped when every part is wide, with min_bytes_for_wide_part = 0.",
};

/** What a tag that is not in TAGS does, when clickhouse-test reads it by a rule. */
function ruleOf(tag: string): string | undefined {
  if (/^use[-_]\w/.test(tag)) return `Needs a build with ${tag.replace(/-/g, "_").toUpperCase()}: skipped in the others.`;
  if (/^no-cpu-\w/.test(tag)) return `Skipped on the ${tag.slice(7)} processors.`;
  if (/^no-use_\w/.test(tag)) return `Skipped in the builds with ${tag.slice(3).toUpperCase()}.`;
  return undefined;
}

/** The documentation of a tag, or undefined for one that clickhouse-test does not read. */
export function tagDocumentation(tag: string): string | undefined {
  return Object.hasOwn(TAGS, tag) ? TAGS[tag] : ruleOf(tag);
}

/** A line of the file that starts with "--" and, after spaces, `prefix`. */
interface Line {
  start: number;
  /** Where the text after the prefix starts. */
  body: number;
  end: number;
}

function lines(text: string, prefix: string): Line[] {
  const found: Line[] = [];
  const pattern = new RegExp(`^--[ \\t]*${prefix}`, "gm");
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const newline = text.slice(start).search(/[\r\n]/);
    found.push({ start, body: start + match[0].length, end: newline < 0 ? text.length : start + newline });
  }
  return found;
}

/** The tags of a Tags line, by offsets, as clickhouse-test splits them at commas. */
function tagsOf(text: string, line: Line): { tag: string; start: number; end: number }[] {
  const tags: { tag: string; start: number; end: number }[] = [];
  let from = line.body;
  for (const piece of text.slice(line.body, line.end).split(",")) {
    const lead = piece.length - piece.trimStart().length;
    const tag = piece.trim();
    if (tag) tags.push({ tag, start: from + lead, end: from + lead + tag.length });
    from += piece.length + 1;
  }
  return tags;
}

/** The problems of the Tags and Random settings limits lines of a test. */
export function checkTags(text: string): Problem[] {
  if (!text.includes("--")) return [];
  const problems: Problem[] = [];
  const [first, ...more] = lines(text, "Tags:");
  if (first) {
    for (const { tag, start, end } of tagsOf(text, first)) {
      if (tag === "no-stress") problems.push({ start, end, severity: "error", message: "clickhouse-test refuses the no-stress tag: stress tests must be able to run every test." });
      else if (!tagDocumentation(tag)) problems.push({ start, end, severity: "information", message: `clickhouse-test does not read the tag ${tag}, so it changes nothing.` });
    }
  }
  for (const line of more) problems.push({ start: line.start, end: line.end, severity: "information", message: "clickhouse-test reads only the first Tags line of a test." });
  for (const line of lines(text, "Random settings limits:")) {
    let from = line.body;
    for (const piece of text.slice(line.body, line.end).split(";")) {
      const start = from + piece.length - piece.trimStart().length;
      from += piece.length + 1;
      if (!/^\s*\w+\s*=\s*\(\s*(?:-?\d+(?:\.\d+)?|None)\s*,\s*(?:-?\d+(?:\.\d+)?|None)\s*\)\s*$/.test(piece))
        problems.push({ start, end: start + piece.trim().length || start + 1, severity: "error", message: "clickhouse-test reads each limit as setting=(min, max), with numbers or None, split by ';'." });
    }
  }
  return problems;
}

/** The tags to suggest at `offset` in the Tags line, or undefined elsewhere. */
export function tagCompletions(text: string, offset: number): HintCompletion[] | undefined {
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  if (!text.startsWith("--", lineStart)) return undefined;
  const line = lines(text, "Tags:").find((l) => l.body <= offset && offset <= l.end);
  if (!line) return undefined;
  const written = new Set(tagsOf(text, line).map((t) => t.tag));
  return Object.entries(TAGS)
    .filter(([tag]) => !written.has(tag))
    .map(([tag, documentation]) => ({ label: tag, detail: "clickhouse-test tag", documentation }));
}

/** The documentation of the tag or the limits under `offset`. */
export function tagHover(text: string, offset: number): { markdown: string; start: number; end: number } | undefined {
  const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
  if (!text.startsWith("--", lineStart)) return undefined;
  const line = lines(text, "Tags:").find((l) => l.start <= offset && offset <= l.end);
  if (line) {
    const tag = tagsOf(text, line).find((t) => t.start <= offset && offset <= t.end);
    const documentation = tag && tagDocumentation(tag.tag);
    if (tag && documentation) return { markdown: `**Tag \`${tag.tag}\`** of clickhouse-test\n\n${documentation}`, start: tag.start, end: tag.end };
    if (offset < line.body) return { markdown: "**Tags** of clickhouse-test: the tags of the test, split by commas, which decide where it runs.", start: line.start, end: line.body };
    return undefined;
  }
  const limits = lines(text, "Random settings limits:").find((l) => l.start <= offset && offset < l.body);
  if (limits)
    return {
      markdown: "**Random settings limits** of clickhouse-test: `setting=(min, max); ...` keeps each random setting between min and max, where None means no limit.",
      start: limits.start,
      end: limits.body,
    };
  return undefined;
}
