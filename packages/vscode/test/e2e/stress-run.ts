// Runs the stress tests in a real VS Code with a profile of their own, so that they can run next to the other tests.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(__dirname, "..", "..");
const profile = resolve(root, ".vscode-test", "stress");

// A private macOS home, so that the saved window state of another VS Code cannot stop the start with a dialog.
process.env.CFFIXED_USER_HOME = resolve(profile, "home");
mkdirSync(process.env.CFFIXED_USER_HOME, { recursive: true });

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(__dirname, "stress-index.js"),
  // A short path in the temp folder, as VS Code puts a socket in it whose path must stay under 104 characters.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${join(tmpdir(), "chsql-stress")}`],
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
