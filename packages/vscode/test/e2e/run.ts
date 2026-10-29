// Downloads VS Code into .vscode-test and runs the extension tests in it, in a fresh profile. VSCODE_VERSION
// picks the version, and VSIX=<file> tests that package, installed with the code CLI, instead of this folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downloadAndUnzipVSCode, runTests, runVSCodeCommand } from "@vscode/test-electron";

const EXTENSION_ID = "valerypetrov.clickhouse-sql";
// The chat input of VS Code would take the keyboard focus from the editors that the tests drive,
// and new documents get \n line breaks on Windows too, as the tests expect.
const SETTINGS = { "chat.disableAIFeatures": true, "files.eol": "\n" };
const root = resolve(__dirname, "..", "..");

// A private macOS home, so that the saved window state of another VS Code cannot stop the start with a dialog.
process.env.CFFIXED_USER_HOME = resolve(root, ".vscode-test", "home");
mkdirSync(process.env.CFFIXED_USER_HOME, { recursive: true });

async function main(): Promise<void> {
  const version = process.env.VSCODE_VERSION || "stable";
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version });
  // npm runs this script in packages/vscode, so a relative path is taken from where npm was started.
  const vsix = process.env.VSIX && resolve(process.env.INIT_CWD ?? "", process.env.VSIX);

  // A short path, because VS Code puts its IPC socket in the user data folder.
  const profile = mkdtempSync(join(tmpdir(), "chsql-e2e-"));
  mkdirSync(join(profile, "user-data", "User"), { recursive: true });
  writeFileSync(join(profile, "user-data", "User", "settings.json"), JSON.stringify(SETTINGS));
  const dirs = [`--extensions-dir=${join(profile, "extensions")}`, `--user-data-dir=${join(profile, "user-data")}`];
  const code = async (...args: string[]) => (await runVSCodeCommand([...args, ...dirs], { version })).stdout;
  const installed = async () => (await code("--list-extensions", "--show-versions")).split(/\r?\n/).filter(Boolean);

  try {
    if (vsix) {
      await code("--install-extension", vsix);
      const found = await installed();
      if (!found.some((line) => line.startsWith(`${EXTENSION_ID}@`))) throw new Error(`${vsix} did not install`);
      console.log(`Installed ${found.join(", ")}`);
    }
    await runTests({
      vscodeExecutablePath,
      // VS Code runs tests only with a development folder; this one has no extension, so the installed one is tested.
      extensionDevelopmentPath: vsix ? __dirname : root,
      extensionTestsPath: resolve(__dirname, "index.js"),
      launchArgs: [resolve(root, "test", "fixtures", "workspace"), ...dirs],
    });
    if (vsix) {
      await code("--uninstall-extension", EXTENSION_ID);
      if ((await installed()).length > 0) throw new Error(`${EXTENSION_ID} is still installed`);
      console.log(`Uninstalled ${EXTENSION_ID}`);
    }
  } finally {
    // Windows can hold the files of VS Code for a moment after it exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
