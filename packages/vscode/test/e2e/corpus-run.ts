// Runs the corpus tests in a real VS Code with a profile of their own, so that they can run next to the other tests.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

if (!process.env.CLICKHOUSE_CORPUS || !process.env.CLICKHOUSE_BINARY) {
  console.error("Usage: CLICKHOUSE_CORPUS=<ClickHouse checkout>/tests/queries/0_stateless CLICKHOUSE_BINARY=<clickhouse> npm run test:vscode:corpus");
  process.exit(2);
}

const root = resolve(__dirname, "..", "..");
const profile = resolve(root, ".vscode-test", "corpus");

// A private macOS home, so that the saved window state of another VS Code cannot stop the start with a dialog.
process.env.CFFIXED_USER_HOME = resolve(profile, "home");
mkdirSync(process.env.CFFIXED_USER_HOME, { recursive: true });

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(__dirname, "corpus-index.js"),
  // npm runs this in packages/vscode, so a relative path is taken from where npm was started.
  extensionTestsEnv: { CLICKHOUSE_CORPUS: resolve(process.env.INIT_CWD ?? "", process.env.CLICKHOUSE_CORPUS) },
  // A short path in the temp folder, as VS Code puts a socket in it whose path must stay under 104 characters.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${join(tmpdir(), "chsql-corpus")}`],
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
