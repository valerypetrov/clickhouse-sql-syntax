import * as vscode from "vscode";
import { parameterHints, type ParseCache } from "clickhouse-sql-syntax";
import { parameters } from "./parameters.js";
import { pieces } from "./semantic.js";
import { editorSetting, setting } from "./settings.js";
import { tooLarge } from "./size.js";

/** The parameter names of call arguments, and the type of the query parameter that each param_name sets. */
export function registerInlayHints(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: changed.event,
    provideInlayHints(document, range) {
      if (!setting<boolean>("clickhouseSql.inlayHints.enabled", document) || tooLarge(document)) return [];
      if (editorSetting<string>("editor.inlayHints.enabled", document) === "off") return [];
      const text = document.getText();
      const from = document.offsetAt(range.start);
      const to = document.offsetAt(range.end);
      const hints: vscode.InlayHint[] = [];
      for (const [start, end] of pieces(text)) {
        if (end <= from || start >= to) continue;
        for (const { offset, name } of parameterHints(text.slice(start, end), cacheOf(document))) {
          if (start + offset < from || start + offset > to) continue;
          const hint = new vscode.InlayHint(document.positionAt(start + offset), `${name}:`, vscode.InlayHintKind.Parameter);
          hint.paddingRight = true;
          hints.push(hint);
        }
      }
      // Only a screen that writes param_ costs a pass over the whole text.
      if (text.slice(from, to).includes("param_")) {
        const { substitutions, settings } = parameters(text);
        for (const s of settings) {
          if (s.start < from || s.end > to) continue;
          const types = new Set(substitutions.filter((u) => u.name === s.name).map((u) => u.type));
          if (types.size === 1) hints.push(new vscode.InlayHint(document.positionAt(s.end), `: ${[...types][0]}`, vscode.InlayHintKind.Type));
        }
      }
      return hints;
    },
  };
  return vscode.Disposable.from(
    changed,
    vscode.languages.registerInlayHintsProvider(languageId, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("clickhouseSql.inlayHints.enabled") || event.affectsConfiguration("editor.inlayHints.enabled")) changed.fire();
    }),
  );
}
