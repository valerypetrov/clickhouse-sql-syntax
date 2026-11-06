import * as vscode from "vscode";
import {
  definition, type NameLocation, objectDefinitions, objectReferences, type ParseCache, prepareRename, references, rename, type SqlObject,
} from "clickhouse-sql-syntax";
import { tooLarge } from "./size.js";
import { type FileObjects, positions, type WorkspaceObjects } from "./symbols.js";

/** A CREATE statement's object in a file of the workspace. */
interface Found {
  uri: vscode.Uri;
  key: string;
  object: SqlObject;
  range: vscode.Range;
}

/**
 * Go to definition, references, highlights and rename of the names a statement defines, through the library, and
 * definition and references of the tables and databases that the files of the workspace create.
 */
export function registerNames(languageId: string, cacheOf: (document: vscode.TextDocument) => ParseCache, index: WorkspaceObjects): vscode.Disposable {
  const range = (document: vscode.TextDocument, place: { start: number; end: number }) =>
    new vscode.Range(document.positionAt(place.start), document.positionAt(place.end));
  const places = (document: vscode.TextDocument, position: vscode.Position): NameLocation[] =>
    tooLarge(document) ? [] : references(document.getText(), document.offsetAt(position), { cache: cacheOf(document) });
  // A thrown error is the message VS Code shows for a rename it cannot do.
  const refuse = (document: vscode.TextDocument) => {
    if (tooLarge(document)) throw new Error("This file is longer than clickhouseSql.maxFileSize.");
  };

  /** The table or database named at `offset`, and what it may be among the files' objects. */
  const objectsAt = async (document: vscode.TextDocument, offset: number) => {
    const here = objectReferences(document.getText(), { cache: cacheOf(document) }).filter((r) => r.start <= offset && offset <= r.end);
    // The database of db.t when the cursor is on it.
    const reference = here.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!reference) return undefined;
    const files = await index.all(document);
    const objects = new Map([...files].map(([key, file]) => [key, file.objects]));
    const found = objectDefinitions(reference, document.uri.toString(), objects).map(({ file, object }) => toFound(files.get(file)!, file, object));
    return { reference, files, objects, found };
  };

  return vscode.Disposable.from(
    vscode.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(document, position) {
        if (tooLarge(document)) return undefined;
        const offset = document.offsetAt(position);
        const local = definition(document.getText(), offset, { cache: cacheOf(document) });
        if (local.length) return local.map((place) => new vscode.Location(document.uri, range(document, place)));
        return (await objectsAt(document, offset))?.found.map((found) => new vscode.Location(found.uri, found.range)) ?? [];
      },
    }),
    vscode.languages.registerReferenceProvider(languageId, {
      async provideReferences(document, position, context, token) {
        const local = places(document, position);
        if (local.length || tooLarge(document)) {
          return local
            .filter((place) => context.includeDeclaration || !place.definition)
            .map((place) => new vscode.Location(document.uri, range(document, place)));
        }
        const at = await objectsAt(document, document.offsetAt(position));
        if (!at?.found.length) return [];
        const { reference, objects, found } = at;
        const targets = new Set(found.map((f) => f.object));
        const declarations = new Set(found.map((f) => `${f.key} ${f.object.nameStart}`));
        const result = context.includeDeclaration ? found.map((f) => new vscode.Location(f.uri, f.range)) : [];
        for await (const { uri, text } of index.texts(token)) {
          if (!text.includes(reference.name)) continue;
          const key = uri.toString();
          const position = positions(text);
          for (const other of objectReferences(text, key === document.uri.toString() ? { cache: cacheOf(document) } : {})) {
            if (other.kind !== reference.kind || other.name !== reference.name || declarations.has(`${key} ${other.start}`)) continue;
            if (!objectDefinitions(other, key, objects).some((d) => targets.has(d.object))) continue;
            result.push(new vscode.Location(uri, new vscode.Range(position(other.start), position(other.end))));
          }
        }
        return result;
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

function toFound(file: FileObjects, key: string, object: SqlObject): Found {
  return { uri: file.uri, key, object, range: file.ranges[file.objects.indexOf(object)]! };
}
