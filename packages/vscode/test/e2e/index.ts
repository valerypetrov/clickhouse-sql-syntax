// Entry point that VS Code calls inside the extension host to run the mocha tests.
import { resolve } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 20_000, color: true });
  mocha.addFile(resolve(__dirname, "extension.test.js"));
  mocha.addFile(resolve(__dirname, "format.test.js"));
  return new Promise((done, fail) => {
    mocha.run((failures) => (failures > 0 ? fail(new Error(`${failures} test(s) failed`)) : done()));
  });
}
