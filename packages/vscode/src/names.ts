import * as vscode from "vscode";
import { definition, type NameLocation, type ParseCache, prepareRename, references, rename } from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";

/** Go to definition, references, highlights and rename of the names a statement defines, through the library. */
export function registerNames(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache): vscode.Disposable {
  const range = (document: vscode.TextDocument, place: { start: number; end: number }) =>
    new vscode.Range(document.positionAt(place.start), document.positionAt(place.end));
  const places = (document: vscode.TextDocument, position: vscode.Position): NameLocation[] =>
    tooLarge(document) ? [] : references(document.getText(), document.offsetAt(position), { cache: cacheOf(document) });
  // A thrown error is the message VS Code shows for a rename it cannot do.
  const refuse = (document: vscode.TextDocument) => {
    if (tooLarge(document)) throw new Error("This file is longer than clickhouseSql.maxFileSize.");
  };

  return vscode.Disposable.from(
    vscode.languages.registerDefinitionProvider(languageId, {
      provideDefinition(document, position) {
        if (tooLarge(document)) return undefined;
        return definition(document.getText(), document.offsetAt(position), { cache: cacheOf(document) }).map(
          (place) => new vscode.Location(document.uri, range(document, place)),
        );
      },
    }),
    vscode.languages.registerReferenceProvider(languageId, {
      provideReferences(document, position, context) {
        return places(document, position)
          .filter((place) => context.includeDeclaration || !place.definition)
          .map((place) => new vscode.Location(document.uri, range(document, place)));
      },
    }),
    vscode.languages.registerDocumentHighlightProvider(languageId, {
      provideDocumentHighlights(document, position) {
        const { Read, Write } = vscode.DocumentHighlightKind;
        return places(document, position).map((place) => new vscode.DocumentHighlight(range(document, place), place.definition ? Write : Read));
      },
    }),
    vscode.languages.registerRenameProvider(languageId, {
      prepareRename(document, position) {
        refuse(document);
        const result = prepareRename(document.getText(), document.offsetAt(position), { cache: cacheOf(document) });
        if (result.error !== undefined) throw new Error(result.error);
        return { range: range(document, result), placeholder: result.name };
      },
      provideRenameEdits(document, position, newName) {
        refuse(document);
        const result = rename(document.getText(), document.offsetAt(position), newName, { cache: cacheOf(document) });
        if (result.error !== undefined) throw new Error(result.error);
        const edit = new vscode.WorkspaceEdit();
        for (const change of result.edits) edit.replace(document.uri, range(document, change), change.newText);
        return edit;
      },
    }),
  );
}
