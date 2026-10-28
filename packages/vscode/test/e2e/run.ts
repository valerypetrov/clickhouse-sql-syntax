// Downloads VS Code into .vscode-test and runs the extension tests in it.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

const root = resolve(__dirname, "..", "..");

// A private macOS home, so that the saved window state of another VS Code cannot stop the start with a dialog.
process.env.CFFIXED_USER_HOME = resolve(root, ".vscode-test", "home");
mkdirSync(process.env.CFFIXED_USER_HOME, { recursive: true });

runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(__dirname, "index.js"),
  launchArgs: [resolve(root, "test", "fixtures", "workspace"), "--disable-extensions", "--disable-workspace-trust"],
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
