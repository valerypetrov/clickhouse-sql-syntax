import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import type * as vscode from "vscode";

let providers: {
  registerSignatureHelp(id: string): vscode.SignatureHelpProvider;
  registerCompletion(id: string): vscode.CompletionItemProvider;
};

before(async () => {
  // Run the providers with the VS Code value objects and registration calls replaced by a small host.
  const result = await build({
    stdin: { contents: 'export { registerSignatureHelp } from "./src/signature.js"; export { registerCompletion } from "./src/complete.js";', resolveDir: resolve(__dirname, "../..") },
    bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{
      name: "vscode-host",
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "host" }));
        build.onLoad({ filter: /.*/, namespace: "host" }, () => ({ contents: `
          export class MarkdownString { constructor(value) { this.value = value; } }
          export class ParameterInformation { constructor(label, documentation) { Object.assign(this, {label, documentation}); } }
          export class SignatureInformation extends ParameterInformation {}
          export class SignatureHelp {}
          export class CompletionItem { constructor(label, kind) { Object.assign(this, {label, kind}); } }
          export class CompletionList { constructor(items) { this.items = items; } }
          export class SnippetString {
            value = "";
            appendText(text) { this.value += text; return this; }
            appendTabstop(index) { this.value += "$" + index; return this; }
          }
          export const CompletionItemKind = new Proxy({}, {get: (_, name) => name});
          export const languages = {
            registerSignatureHelpProvider: (_, provider) => provider,
            registerCompletionItemProvider: (_, provider) => provider,
          };
          export const window = {showInformationMessage: () => {}};
          export const workspace = {getConfiguration: () => ({get: (_, fallback) => fallback})};
        ` }));
      },
    }],
  });
  providers = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`);
});

function document(text: string) {
  const offset = text.indexOf("|");
  const sql = text.replace("|", "");
  return {
    document: {
      getText: () => sql, offsetAt: (position: number) => position, lineCount: 1,
      lineAt: () => ({ range: { end: sql.length } }), getWordRangeAtPosition: () => undefined,
    } as unknown as vscode.TextDocument,
    position: offset as unknown as vscode.Position,
  };
}

const token = {} as vscode.CancellationToken;

test("signature provider highlights the current argument across all function families", async () => {
  const provider = providers.registerSignatureHelp("clickhouse-sql");
  for (const [text, expected] of [
    ["SELECT * FROM file('data', |)", "format"],
    ["SELECT * FROM numbers(|)", "count"],
    ["SELECT sumIf(x, |)", "condition"],
    ["SELECT sumMap(x, |)", "key"],
    ["SELECT quantileIf(0.5)(x, |)", "condition"],
    ["SELECT histogram(|)(x)", "number_of_bins"],
    ["SELECT lag(x, |) OVER ()", "offset"],
  ]) {
    const doc = document(text!);
    const help = await provider.provideSignatureHelp(doc.document, doc.position, token, {} as vscode.SignatureHelpContext);
    assert.ok(help, text);
    const signature = help.signatures[0]!;
    const parameter = signature.parameters[help.activeParameter]!;
    assert.ok(parameter, text);
    assert.equal(typeof parameter.label === "string" ? parameter.label : signature.label.slice(...parameter.label), expected, text);
  }
});

test("completion provider inserts quoted table-function argument values and opens after commas", async () => {
  const provider = providers.registerCompletion("clickhouse-sql");
  for (const [text, expected] of [
    ["SELECT * FROM file('data', |)", "'Parquet'"],
    ["SELECT * FROM file('data', 'CSV', 'x UInt8', |)", "'gzip'"],
  ]) {
    const doc = document(text!);
    const found = await provider.provideCompletionItems(doc.document, doc.position, token, { triggerCharacter: " " } as vscode.CompletionContext) as vscode.CompletionList;
    assert.ok(found?.items.some((item) => item.insertText === expected), text);
  }
});
