// Entry point that VS Code calls inside the extension host to run the corpus tests.
import { resolve } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 0, color: true });
  mocha.addFile(resolve(__dirname, "corpus.test.js"));
  return new Promise((done, fail) => {
    mocha.run((failures) => (failures > 0 ? fail(new Error(`${failures} test(s) failed`)) : done()));
  });
}
