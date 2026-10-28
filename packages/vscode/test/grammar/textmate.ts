import { readFileSync } from "node:fs";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry, type IGrammar } from "vscode-textmate";
import { GRAMMAR_PATH } from "../../scripts/generate-grammar.js";

const ROOT_SCOPE = "source.clickhouse-sql";
let grammar: Promise<IGrammar> | undefined;

// Loads the grammar with the same TextMate and regex engines that VS Code uses.
function loadGrammar(): Promise<IGrammar> {
  grammar ??= (async () => {
    const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources) => new OnigScanner(sources),
        createOnigString: (text) => new OnigString(text),
      }),
      loadGrammar: async () => parseRawGrammar(readFileSync(GRAMMAR_PATH, "utf8"), GRAMMAR_PATH),
    });
    const loaded = await registry.loadGrammar(ROOT_SCOPE);
    if (!loaded) throw new Error(`Grammar ${ROOT_SCOPE} not found`);
    return loaded;
  })();
  return grammar;
}

/** The innermost grammar scope of every UTF-16 offset of `sql`; undefined where no rule applies. */
export async function grammarScopes(sql: string): Promise<(string | undefined)[]> {
  const loaded = await loadGrammar();
  const scopes: (string | undefined)[] = new Array(sql.length).fill(undefined);
  let ruleStack = INITIAL;
  let offset = 0;
  const parts = sql.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    const result = loaded.tokenizeLine(line, ruleStack);
    for (const token of result.tokens) {
      const scope = token.scopes[token.scopes.length - 1];
      if (scope === ROOT_SCOPE) continue;
      for (let j = token.startIndex; j < Math.min(token.endIndex, line.length); j++) scopes[offset + j] = scope;
    }
    ruleStack = result.ruleStack;
    offset += line.length + (parts[i + 1]?.length ?? 0);
  }
  return scopes;
}

/** Runs of text with the same scope, as [text, scope] pairs; unscoped whitespace is left out. */
export async function grammarTokens(sql: string): Promise<[string, string][]> {
  const scopes = await grammarScopes(sql);
  const tokens: [string, string][] = [];
  let start = 0;
  for (let i = 1; i <= sql.length; i++) {
    if (i < sql.length && scopes[i] === scopes[start]) continue;
    const scope = scopes[start];
    if (scope !== undefined) tokens.push([sql.slice(start, i), scope]);
    start = i;
  }
  return tokens;
}
