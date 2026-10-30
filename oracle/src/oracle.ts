// Runs check() over a labelled corpus and reports how often it agrees with ClickHouse.
// Run it with `npm run oracle -w oracle -- --help`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { check } from "clickhouse-sql-syntax";

import { classify } from "./clickhouse.js";
import { compare, formatReport } from "./compare.js";
import { type Corpus, readCorpus } from "./corpus.js";
import { extractCorpus } from "./extract.js";
import { CACHE_DIR, CORPUS_FILE, REPORT_FILE, SOURCE_NOTE, integerOption } from "./paths.js";

const USAGE = `Usage: npm run oracle -w oracle [-- options]

Without --clickhouse, compares check() with the labelled corpus in ${CORPUS_FILE}.
With --clickhouse and --corpus, labels every statement of the tests with that binary first. Where the
labelled corpus comes from another build that reads a statement as check() does, while this binary
does not, the statement is listed as a version gap and left out of the numbers.

Options:
  --file <file>         a labelled corpus to use instead (default: the one above)
  --clickhouse <binary> a ClickHouse binary to label the statements with
  --corpus <dir>        tests/queries/0_stateless of a ClickHouse checkout
  --report <file>       where to write the JSON report (default: ${REPORT_FILE})
  --examples <n>        examples to print per section (default: 5)
  --jobs <n>            parallel ClickHouse processes, 1 to 4 (default: 4)`;

const { values } = parseArgs({
  options: {
    file: { type: "string", default: CORPUS_FILE },
    clickhouse: { type: "string" },
    corpus: { type: "string" },
    report: { type: "string", default: REPORT_FILE },
    examples: { type: "string", default: "5" },
    jobs: { type: "string", default: "4" },
    help: { type: "boolean", default: false },
  },
});
if (values.help || Boolean(values.clickhouse) !== Boolean(values.corpus)) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

async function liveCorpus(clickhouse: string, dir: string): Promise<Corpus> {
  const log = (line: string): void => console.error(line);
  // Well below ClickHouse's max_query_size of 256 KiB, so that no statement fails for its size.
  const extracted = extractCorpus(dir, { maxLength: 100_000 });
  const jobs = Math.min(4, integerOption(values.jobs, "--jobs", 1));
  const labelled = await classify(
    extracted.statements.map((s) => s.sql),
    { clickhouse, cacheDir: CACHE_DIR, formatCheck: 0, jobs, log },
  );
  const entries = extracted.statements.flatMap((s) => {
    const verdict = labelled.verdicts.get(s.sql);
    return verdict ? [{ sql: s.sql, file: s.file, line: s.line, ...(s.hints.length > 0 ? { hints: s.hints } : {}), ...verdict }] : [];
  });
  const header = {
    clickhouse: labelled.info.version,
    gitHash: labelled.info.gitHash,
    source: dir,
    note: SOURCE_NOTE,
    statements: entries.length,
    mutations: 0,
  };
  return { header, entries };
}

const corpus = values.clickhouse && values.corpus ? await liveCorpus(values.clickhouse, values.corpus) : readCorpus(values.file);
const name = values.clickhouse ? values.corpus! : values.file;
// Live labels from another build are compared with the stored ones to find version gaps.
const report = compare(corpus, check, name, values.clickhouse ? readCorpus(values.file) : undefined);
console.log(formatReport(report, integerOption(values.examples, "--examples")));
mkdirSync(dirname(values.report), { recursive: true });
writeFileSync(values.report, JSON.stringify(report, null, 2) + "\n");
console.log(`\nReport written to ${values.report}`);
