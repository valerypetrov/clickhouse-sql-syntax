// Entry point that VS Code calls inside the extension host to run the stress tests.
import { resolve } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 900_000, color: true });
  mocha.addFile(resolve(__dirname, "stress.test.js"));
  return new Promise((done, fail) => {
    mocha.run((failures) => (failures > 0 ? fail(new Error(`${failures} test(s) failed`)) : done()));
  });
}
