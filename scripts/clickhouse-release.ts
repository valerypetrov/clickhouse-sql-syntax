// Fetches ClickHouse releases, runs the whole test suite with one, and updates the generated files for a new one.
// Usage: npx tsx scripts/clickhouse-release.ts --help

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { statementKind } from "../oracle/src/compare.js";

const ROOT = resolve(import.meta.dirname, "..");
const VERSION_FILE = join(ROOT, "data", "clickhouse-version.json");
const GENERATED = join(ROOT, "packages", "core", "src", "generated");
const REPOSITORY = "ClickHouse/ClickHouse";
const SPARSE_PATHS = ["/tests/queries/0_stateless/", "/src/Parsers/", "/src/Access/Common/AccessType.h"];

const USAGE = `Usage: npx tsx scripts/clickhouse-release.ts <command> [options]

Commands:
  newest                 the newest stable ClickHouse release, and whether it is newer than ${VERSION_FILE}
  fetch [--tag <tag>]    downloads that release (default: testTag of the file above) into <out>/clickhouse,
                         with its tests and parser sources in <out>/src
  suite --clickhouse <binary> --corpus <tests/queries/0_stateless>
                         runs every test, the opt-in ones too, and lists the failed ones
  release [--version <x.y.z.w>] [--dry-run]
                         for a new stable release (or the one given), regenerates everything that comes from
                         ClickHouse, runs the suite, and opens a pull request, or with --dry-run prints its text

Options:
  --out <dir>            where downloads and reports go (default: <temp>/clickhouse-release)`;

/** The ClickHouse build the generated lists and the oracle's labels come from, and the release CI tests with. */
export interface VersionFile {
  version: string;
  gitHash: string;
  /** The release tag of that build, or null for a build of master. */
  tag: string | null;
  testTag: string;
}

export interface Asset {
  name: string;
  url: string;
  /** "sha256:<hex>", from GitHub. */
  digest: string | null;
}

export interface Release {
  tag: string;
  version: string;
  assets: Asset[];
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

const STABLE_TAG = /^v(\d+\.\d+\.\d+\.\d+)-(?:stable|lts)$/;

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The stable and LTS releases, newest version first; drafts, pre-releases and testing tags are left out. */
export function stableReleases(releases: GitHubRelease[]): Release[] {
  return releases
    .flatMap((r) => {
      const version = STABLE_TAG.exec(r.tag_name)?.[1];
      if (!version || r.draft || r.prerelease) return [];
      const assets = r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, digest: a.digest ?? null }));
      return [{ tag: r.tag_name, version, assets }];
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Whether a release should replace the build of the file: one of a newer year.month line, or the first release of
 * the line of a master build. Patch releases of the same line only backport fixes, so they do not count.
 */
export function isNewer(release: string, current: VersionFile): boolean {
  const line = (v: string): string => v.split(".").slice(0, 2).join(".");
  const order = compareVersions(line(release), line(current.version));
  return order > 0 || (order === 0 && current.tag === null && compareVersions(release, current.version) > 0);
}

export function readVersionFile(): VersionFile {
  return JSON.parse(readFileSync(VERSION_FILE, "utf8")) as VersionFile;
}

async function github<T>(path: string): Promise<T> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, { headers });
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function newestRelease(): Promise<Release> {
  const newest = stableReleases(await github<GitHubRelease[]>("releases?per_page=100"))[0];
  if (!newest) throw new Error(`no stable release among the last 100 releases of ${REPOSITORY}`);
  return newest;
}

/** The stable or LTS release of a tag such as v26.10.2.103-stable, or of a version such as 26.10.2.103. */
export async function releaseOf(tagOrVersion: string): Promise<Release> {
  const tags = STABLE_TAG.test(tagOrVersion) ? [tagOrVersion] : [`v${tagOrVersion}-stable`, `v${tagOrVersion}-lts`];
  for (const tag of tags) {
    const found = await github<GitHubRelease>(`releases/tags/${tag}`).then((r) => stableReleases([r])[0], () => undefined);
    if (found) return found;
  }
  throw new Error(`${tagOrVersion} is not a stable or LTS release of ${REPOSITORY}`);
}

/** Runs a command with its output shown, and fails when it fails. */
function run(command: string, args: string[], env: Record<string, string> = {}): void {
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

/** Runs a command and returns its output. */
function output(command: string, args: string[], cwd = ROOT): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function clickhouseBuild(binary: string): { version: string; gitHash: string } {
  const query = "SELECT version(), (SELECT value FROM system.build_options WHERE name = 'GIT_HASH') FORMAT TSV";
  const [version = "", gitHash = ""] = output(binary, ["local", "-q", query]).trim().split("\t");
  return { version, gitHash };
}

/** The release asset with the binary for this machine. */
function binaryAsset(release: Release): Asset {
  const names: Record<string, string> = {
    "linux-x64": `clickhouse-common-static-${release.version}-amd64.tgz`,
    "linux-arm64": `clickhouse-common-static-${release.version}-arm64.tgz`,
    "darwin-arm64": "clickhouse-macos-aarch64",
    "darwin-x64": "clickhouse-macos",
  };
  const name = names[`${process.platform}-${process.arch}`];
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`${release.tag} has no ClickHouse binary for ${process.platform}-${process.arch}`);
  return asset;
}

async function download(url: string, file: string): Promise<{ sha256: string; sha512: string }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`cannot download ${url}: ${response.status}`);
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const hash = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      sha256.update(chunk);
      sha512.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hash, createWriteStream(file));
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("hex") };
}

/** Downloads the ClickHouse binary of a release into `dir`, checks its checksum, and returns its path. */
export async function fetchBinary(release: Release, dir: string): Promise<string> {
  const binary = join(dir, "clickhouse");
  if (existsSync(binary) && clickhouseBuild(binary).version === release.version) return binary;
  mkdirSync(dir, { recursive: true });
  const asset = binaryAsset(release);
  const file = join(dir, asset.name);
  console.error(`Downloading ${asset.url}`);
  const hashes = await download(asset.url, file);
  // ClickHouse publishes a .sha512 file next to its archives; GitHub keeps a sha256 of every asset.
  const published = release.assets.find((a) => a.name === `${asset.name}.sha512`);
  if (published) {
    const expected = (await (await fetch(published.url)).text()).trim().split(/\s+/)[0];
    if (expected !== hashes.sha512) throw new Error(`${asset.name}: sha512 ${hashes.sha512}, but ${published.name} says ${expected}`);
  } else if (asset.digest) {
    if (asset.digest !== `sha256:${hashes.sha256}`) throw new Error(`${asset.name}: sha256 ${hashes.sha256}, but GitHub says ${asset.digest}`);
  } else {
    throw new Error(`${asset.name} has no checksum to check`);
  }
  if (asset.name.endsWith(".tgz")) {
    const inside = `${asset.name.replace(/-(amd64|arm64)\.tgz$/, "")}/usr/bin/clickhouse`;
    run("tar", ["-xzf", file, "-C", dir, inside]);
    renameSync(join(dir, inside), binary);
    rmSync(join(dir, inside.split("/")[0]!), { recursive: true });
    rmSync(file);
  } else {
    renameSync(file, binary);
  }
  chmodSync(binary, 0o755);
  const build = clickhouseBuild(binary);
  if (build.version !== release.version) throw new Error(`${binary} is ClickHouse ${build.version}, not ${release.version}`);
  return binary;
}

/** A shallow checkout of the tests and parser sources of a ClickHouse tag in `dir`, made or moved to that tag. */
export function checkoutSources(tag: string, dir: string): string {
  const git = (...args: string[]): string => output("git", args, dir);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
    git("sparse-checkout", "set", "--no-cone", ...SPARSE_PATHS);
  }
  if (!git("tag", "--list", tag).trim()) git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", "tag", tag);
  git("checkout", "-q", "--detach", `refs/tags/${tag}`);
  return dir;
}

/** `git diff --stat` of src/Parsers between a tag or commit and the checked-out tag. */
function parsersDiff(dir: string, from: string, tag: string): string {
  const git = (...args: string[]): string => output("git", args, dir);
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ...(/^[0-9a-f]{40}$/.test(from) ? [from] : ["tag", from]));
  return git("diff", "--stat=100", "FETCH_HEAD", `refs/tags/${tag}`, "--", "src/Parsers").trimEnd();
}

// The names in each generated list, read from the files as the generators write them.
const QUOTED = String.raw`("(?:[^"\\]|\\.)*")`;
const CATALOG = new RegExp(String.raw`^ {2}\{"name":${QUOTED}`, "gm");
const NAMED = new RegExp(String.raw`^ {2}\{ name: ${QUOTED}`, "gm");
const LISTS: [string, string, RegExp][] = [
  ["keywords", "keywords.ts", new RegExp(String.raw`^ {2}${QUOTED},$`, "gm")],
  ["functions", "functions.ts", CATALOG],
  ["settings", "settings.ts", CATALOG],
  ["data types", "data-types.ts", NAMED],
  ["table engines", "table-engines.ts", CATALOG],
  ["formats", "formats.ts", CATALOG],
  ["table functions", "table-functions.ts", CATALOG],
  ["combinators", "combinators.ts", CATALOG],
  ["privileges", "privileges.ts", NAMED],
];

export type Names = Record<string, string[]>;

export function namesOf(read: (file: string) => string): Names {
  return Object.fromEntries(LISTS.map(([list, file, pattern]) => [list, [...read(file).matchAll(pattern)].map((m) => JSON.parse(m[1]!) as string)]));
}

export interface ListChange {
  list: string;
  count: number;
  added: string[];
  removed: string[];
}

export function listChanges(before: Names, after: Names): ListChange[] {
  return Object.keys(after).map((list) => {
    const old = new Set(before[list]);
    const now = new Set(after[list]);
    return { list, count: now.size, added: [...now].filter((n) => !old.has(n)), removed: [...old].filter((n) => !now.has(n)) };
  });
}

/** Writes everything that comes from ClickHouse: the generated lists, the grammar and the oracle's labels. */
function regenerate(clickhouse: string, src: string): void {
  run("npm", ["run", "generate", "--", "--src", src, "--clickhouse", clickhouse]);
  run("npx", ["tsx", "scripts/generate-catalog.ts", "--clickhouse", clickhouse]);
  // The grammar generator reads the lists from the built library.
  run("npm", ["run", "build", "-w", "packages/core"]);
  run("npm", ["run", "generate", "-w", "packages/vscode"]);
  run("npm", ["run", "corpus", "-w", "oracle", "--", "--clickhouse", clickhouse, "--corpus", join(src, "tests", "queries", "0_stateless")]);
}

function bumpPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

/** Bumps the patch versions of the library and the extension, and notes the release in the changelog. */
function bumpVersions(clickhouse: string): { core: string; vscode: string } {
  const edit = (file: string, change: (json: Record<string, any>) => void): void => {
    const path = join(ROOT, file);
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    change(json);
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  };
  const versions = { core: "", vscode: "", oldVscode: "" };
  edit("packages/core/package.json", (json) => (versions.core = json.version = bumpPatch(json.version)));
  edit("packages/vscode/package.json", (json) => {
    versions.oldVscode = json.version;
    versions.vscode = json.version = bumpPatch(json.version);
    json.devDependencies["clickhouse-sql-syntax"] = versions.core;
  });
  edit("oracle/package.json", (json) => (json.dependencies["clickhouse-sql-syntax"] = versions.core));
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const changelog = join(ROOT, "packages", "vscode", "CHANGELOG.md");
  const text = readFileSync(changelog, "utf8").replace(/^# Changelog\n\n/, `# Changelog\n\n## ${versions.vscode}\n\n- Updated for ClickHouse ${clickhouse}.\n\n`);
  writeFileSync(changelog, text);
  const readme = join(ROOT, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replaceAll(`clickhouse-sql-${versions.oldVscode}.vsix`, `clickhouse-sql-${versions.vscode}.vsix`));
  return versions;
}

export interface StepResult {
  name: string;
  ok: boolean;
  seconds: number;
}

/** Every test of CONTRIBUTING.md, with the server, corpus and stress tests, against one ClickHouse binary and its tests. */
function suiteSteps(clickhouse: string, corpus: string, out: string): { name: string; command: string[]; env?: Record<string, string> }[] {
  // VS Code needs a display; on Linux without one it runs under a virtual one.
  const display = process.platform === "linux" && !process.env.DISPLAY ? ["xvfb-run", "-a"] : [];
  return [
    { name: "npm test", command: ["npm", "test"], env: { CLICKHOUSE_CORPUS: corpus } },
    { name: "oracle on the stored labels", command: ["npm", "run", "oracle", "--", "--report", join(out, "oracle-stored.json")] },
    {
      name: "oracle on the tests of this ClickHouse",
      command: ["npm", "run", "oracle", "--", "--clickhouse", clickhouse, "--corpus", corpus, "--report", join(out, "oracle-live.json")],
    },
    {
      name: "format oracle on the tests of this ClickHouse",
      command: ["npm", "run", "oracle:format", "--", "--clickhouse", clickhouse, "--corpus", corpus, "--report", join(out, "format-live.json")],
    },
    {
      name: "VS Code tests with a ClickHouse server",
      command: [...display, "npm", "run", "test:vscode"],
      env: { CLICKHOUSE_BINARY: clickhouse, CLICKHOUSE_SERVER_DIR: join(out, "server") },
    },
    { name: "VS Code corpus tests", command: [...display, "npm", "run", "test:vscode:corpus"], env: { CLICKHOUSE_BINARY: clickhouse, CLICKHOUSE_CORPUS: corpus } },
    { name: "VS Code stress tests", command: [...display, "npm", "run", "test:vscode:stress"] },
  ];
}

/** Runs every step, also after a failed one, and writes the results to <out>/suite.json and the job summary. */
export function runSuite(clickhouse: string, corpus: string, out: string): StepResult[] {
  mkdirSync(join(out, "server"), { recursive: true });
  const results: StepResult[] = [];
  const actions = Boolean(process.env.GITHUB_ACTIONS);
  for (const step of suiteSteps(resolve(clickhouse), resolve(corpus), resolve(out))) {
    console.log(actions ? `::group::${step.name}` : `\n=== ${step.name}`);
    const started = performance.now();
    const result = spawnSync(step.command[0]!, step.command.slice(1), { cwd: ROOT, env: { ...process.env, ...step.env }, stdio: "inherit" });
    const ok = result.status === 0;
    results.push({ name: step.name, ok, seconds: Math.round((performance.now() - started) / 1000) });
    if (actions) console.log("::endgroup::");
    console.log(`${ok ? "passed" : "FAILED"}: ${step.name} in ${results.at(-1)!.seconds} s`);
  }
  writeFileSync(join(out, "suite.json"), JSON.stringify(results, null, 2) + "\n");
  summary(["| Step | Result | Time |", "| --- | --- | --- |", ...results.map((r) => `| ${r.name} | ${r.ok ? "passed" : "**failed**"} | ${r.seconds} s |`)].join("\n"));
  return results;
}

function summary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n\n");
}

interface OracleReport {
  clickhouse: string;
  metrics: Record<string, number>;
  falsePositives: { file: string; line: number; sql: string; start: number; message: string }[];
  versionGaps: unknown[];
}

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

function percent(value: number | undefined): string {
  return value === undefined ? "?" : `${(value * 100).toFixed(2)}%`;
}

function oneLine(sql: string, width = 120): string {
  const flat = sql.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

/** The valid statements that check() rejects, by statement kind and the word where check() stops. */
export function newSyntax(report: OracleReport, groups = 15, examples = 3): string[] {
  const byConstruct = new Map<string, OracleReport["falsePositives"]>();
  for (const c of report.falsePositives) {
    const word = /^(\w+|\S)/.exec(c.sql.slice(c.start))?.[0];
    const key = `${statementKind(c.sql)}, at ${word ? `\`${word.replaceAll("`", "'")}\`` : "the end"}`;
    byConstruct.set(key, [...(byConstruct.get(key) ?? []), c]);
  }
  const sorted = [...byConstruct].sort((a, b) => b[1].length - a[1].length);
  const lines = sorted.slice(0, groups).flatMap(([key, cases]) => [
    `- ${key}: ${cases.length}`,
    ...cases.slice(0, examples).map((c) => `  - \`${c.file}:${c.line}\`: \`${oneLine(c.sql).replaceAll("`", "'")}\``),
  ]);
  if (sorted.length > groups) lines.push(`- and ${sorted.length - groups} more groups, in the oracle report of the run`);
  return lines;
}

export interface BodyInput {
  release: Release;
  previous: VersionFile;
  changes: ListChange[];
  stored?: OracleReport;
  live?: OracleReport;
  results: StepResult[];
  parsers: string;
  runUrl?: string;
}

export function pullRequestBody(input: BodyInput): string {
  const { release, previous, changes, stored, live, results } = input;
  const failed = results.filter((r) => !r.ok);
  const from = previous.tag ?? `${previous.version} (${previous.gitHash.slice(0, 11)})`;
  const run = input.runUrl ? ` ([run](${input.runUrl}))` : "";
  const lines = [
    `Regenerates the lists, the grammar and the oracle's labels from ClickHouse ${release.version} (\`${release.tag}\`), instead of ${from}.`,
    "",
    failed.length === 0
      ? `All ${results.length} steps of the test suite passed${run}.`
      : `This is a draft, as ${failed.length} of ${results.length} steps of the test suite failed${run}:\n${failed.map((r) => `- ${r.name}`).join("\n")}`,
    "",
    "| List | Now | Added | Removed |",
    "| --- | --- | --- | --- |",
    ...changes.map((c) => `| ${c.list} | ${c.count} | ${c.added.length} | ${c.removed.length} |`),
    "",
  ];
  const names = (list: string[]): string => list.slice(0, 20).map((n) => `\`${n}\``).join(", ") + (list.length > 20 ? `, and ${list.length - 20} more` : "");
  for (const c of changes) {
    if (c.added.length) lines.push(`- New ${c.list}: ${names(c.added)}`);
    if (c.removed.length) lines.push(`- Removed ${c.list}: ${names(c.removed)}`);
  }
  const row = (name: string, r?: OracleReport): string => {
    const m = r?.metrics ?? {};
    const gaps = m.versionGaps ? `, ${m.versionGaps} version gaps` : "";
    return `| ${name} | ${m.statements ?? "?"}${gaps} | ${percent(m.verdictAgreement)} | ${percent(m.validAcceptedRate)} | ${percent(m.invalidRejectedRate)} | ${percent(m.positionMatch)} | ${percent(m.messageMatch)} |`;
  };
  lines.push(
    "",
    "| Oracle | Statements | Agreement | Valid accepted | Invalid rejected | Error position | Error message |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    row("stored labels, relabelled", stored),
    row(`all tests of ${release.version}`, live),
    "",
  );
  const syntax = live ? newSyntax(live) : [];
  lines.push(
    syntax.length > 0
      ? `Statements that ClickHouse ${release.version} accepts and \`check()\` rejects, the new syntax to port (${live!.falsePositives.length}):\n\n${syntax.join("\n")}`
      : `\`check()\` accepts every statement of the tests that ClickHouse ${release.version} accepts.`,
    "",
    `Changes in \`src/Parsers\` since ${from}:`,
    "",
    "```",
    input.parsers || "(none)",
    "```",
  );
  return lines.join("\n") + "\n";
}

/** Commits the changes on a branch clickhouse-<version>, pushes it and opens a pull request to main. */
function openPullRequest(release: Release, body: string, draft: boolean, out: string): void {
  const branch = `clickhouse-${release.version}`;
  const bot = { GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" };
  const identity = { ...bot, GIT_COMMITTER_NAME: bot.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: bot.GIT_AUTHOR_EMAIL };
  run("git", ["switch", "-c", branch]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-q", "-m", `Update for ClickHouse ${release.version}`], identity);
  run("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  writeFileSync(join(out, "pr-body.md"), body);
  const title = `Update for ClickHouse ${release.version}`;
  const url = output("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", join(out, "pr-body.md"), ...(draft ? ["--draft"] : [])]);
  console.log(`Opened ${url.trim()}`);
  summary(`Opened ${url.trim()}`);
}

/** The branches clickhouse-<version> on origin. */
function releaseBranches(): string[] {
  return output("git", ["ls-remote", "--heads", "origin"])
    .split("\n")
    .flatMap((line) => /\trefs\/heads\/clickhouse-(\d+\.\d+\.\d+\.\d+)$/.exec(line)?.[1] ?? []);
}

async function release(version: string | undefined, dryRun: boolean, out: string): Promise<void> {
  const previous = readVersionFile();
  const target = version ? await releaseOf(version) : await newestRelease();
  console.log(`ClickHouse ${target.version} (${target.tag}); the generated files come from ${previous.version}${previous.tag ? ` (${previous.tag})` : ", a master build"}`);
  if (!version) {
    if (!isNewer(target.version, previous)) {
      console.log("Nothing to do: it is not a newer release.");
      summary(`ClickHouse ${target.version} is the newest stable release, and the generated files come from ${previous.version}: nothing to do.`);
      return;
    }
    const line = target.version.split(".").slice(0, 2).join(".");
    const handled = releaseBranches().find((v) => v.startsWith(`${line}.`));
    if (handled) {
      console.log(`Nothing to do: the branch clickhouse-${handled} is there for the ${line} releases.`);
      summary(`The branch clickhouse-${handled} is there for the ${line} releases: nothing to do.`);
      return;
    }
  }
  const clickhouse = await fetchBinary(target, join(out, "bin"));
  const src = checkoutSources(target.tag, join(out, "src"));
  const corpus = join(src, "tests", "queries", "0_stateless");
  const read = (file: string): string => readFileSync(join(GENERATED, file), "utf8");
  const before = namesOf(read);
  regenerate(clickhouse, src);
  const changes = listChanges(before, namesOf(read));
  const build = clickhouseBuild(clickhouse);
  const next: VersionFile = { version: target.version, gitHash: build.gitHash, tag: target.tag, testTag: target.tag };
  writeFileSync(VERSION_FILE, JSON.stringify(next, null, 2) + "\n");
  bumpVersions(target.version);
  const parsers = parsersDiff(src, previous.tag ?? previous.gitHash, target.tag);
  const reports = join(out, "reports");
  const results = runSuite(clickhouse, corpus, reports);
  const server = process.env.GITHUB_SERVER_URL;
  const runUrl = server ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const body = pullRequestBody({
    release: target,
    previous,
    changes,
    stored: readJson<OracleReport>(join(reports, "oracle-stored.json")),
    live: readJson<OracleReport>(join(reports, "oracle-live.json")),
    results,
    parsers,
    ...(runUrl ? { runUrl } : {}),
  });
  writeFileSync(join(out, "pr-body.md"), body);
  writeFileSync(join(out, "changes.patch"), output("git", ["diff"]));
  if (dryRun) {
    console.log(`\nDry run: the pull request clickhouse-${target.version} would say:\n\n${body}`);
    summary(`## Dry run: the pull request clickhouse-${target.version} would say\n\n${body}`);
    return;
  }
  openPullRequest(target, body, results.some((r) => !r.ok), out);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tag: { type: "string" },
      version: { type: "string" },
      clickhouse: { type: "string" },
      corpus: { type: "string" },
      out: { type: "string", default: join(tmpdir(), "clickhouse-release") },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const out = resolve(values.out);
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (command === "newest") {
    const newest = await newestRelease();
    const current = readVersionFile();
    console.log(JSON.stringify({ version: newest.version, tag: newest.tag, current: current.version, newer: isNewer(newest.version, current) }));
  } else if (command === "fetch") {
    const target = await releaseOf(values.tag ?? readVersionFile().testTag);
    console.log(await fetchBinary(target, join(out, "bin")));
    console.log(checkoutSources(target.tag, join(out, "src")));
  } else if (command === "suite" && values.clickhouse && values.corpus) {
    if (runSuite(values.clickhouse, values.corpus, out).some((r) => !r.ok)) process.exit(1);
  } else if (command === "release") {
    await release(values.version, values["dry-run"], out);
  } else {
    console.log(USAGE);
    process.exit(2);
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) await main();
