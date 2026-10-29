import * as vscode from "vscode";
import { type ArgumentInfo, describe, isSignificant, TokenKind as T, type Token, tokenize } from "clickhouse-sql-syntax";

/** The function call the cursor is in. */
interface Call {
  name: string;
  /** 0 in the first brackets, 1 in the second ones of name(parameters)(arguments). */
  group: number;
  /** The index of the argument the cursor is at. */
  argument: number;
  /** Whether another pair of brackets follows, so that these hold parameters. */
  nextGroup: boolean;
}

const isOpening = (kind: T) => kind === T.OpeningRoundBracket || kind === T.OpeningSquareBracket;
const isClosing = (kind: T) => kind === T.ClosingRoundBracket || kind === T.ClosingSquareBracket;

/** The index of the bracket that closes or opens the one at `from`, looking in the direction `step`. */
function matching(tokens: Token[], from: number, step: 1 | -1): number {
  let depth = 0;
  for (let i = from; i >= 0 && i < tokens.length; i += step) {
    const kind = tokens[i]!.kind;
    if (step === 1 ? isOpening(kind) : isClosing(kind)) depth++;
    else if (step === 1 ? isClosing(kind) : isOpening(kind)) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function callAt(text: string, offset: number): Call | undefined {
  const tokens = tokenize(text).filter((t) => isSignificant(t.kind));
  // The brackets still open before the cursor, each with its commas so far.
  const open: { index: number; commas: number }[] = [];
  let i = 0;
  for (; tokens[i]!.start < offset && tokens[i]!.kind !== T.EndOfStream; i++) {
    const kind = tokens[i]!.kind;
    if (isOpening(kind)) open.push({ index: i, commas: 0 });
    else if (isClosing(kind)) open.pop();
    else if (kind === T.Comma && open.length) open[open.length - 1]!.commas++;
    else if (kind === T.Semicolon) open.length = 0;
  }
  const top = open[open.length - 1];
  if (!top || tokens[top.index]!.kind !== T.OpeningRoundBracket) return undefined;
  let nameIndex = top.index - 1;
  let group = 0;
  if (tokens[nameIndex]?.kind === T.ClosingRoundBracket) {
    nameIndex = matching(tokens, nameIndex, -1) - 1;
    group = 1;
  }
  const name = tokens[nameIndex];
  if (name?.kind !== T.BareWord) return undefined;
  const close = matching(tokens, top.index, 1);
  const nextGroup = close >= 0 && tokens[close + 1]?.kind === T.OpeningRoundBracket;
  return { name: text.slice(name.start, name.end), group, argument: top.commas, nextGroup };
}

/** Where `name` is in the `group`-th brackets of the label, for VS Code to highlight it. */
function labelRange(label: string, group: number, name: string): [number, number] | string {
  let from = -1;
  let depth = 0;
  let groups = 0;
  for (let i = 0; i < label.length && from < 0; i++) {
    if (label[i] === "(") {
      if (depth === 0 && groups++ === group) from = i;
      depth++;
    } else if (label[i] === ")") depth--;
  }
  const found = from < 0 ? null : new RegExp(`\\b${name.replace(/\W/g, "\\$&")}\\b`).exec(label.slice(from));
  return found ? [from + found.index, from + found.index + name.length] : name;
}

/** The arguments of the function call the cursor is in, from the ClickHouse documentation. */
export function registerSignatureHelp(languageId: string): vscode.Disposable {
  const provider: vscode.SignatureHelpProvider = {
    provideSignatureHelp(document, position) {
      const call = callAt(document.getText(), document.offsetAt(position));
      const description = call && describe(call.name, "function");
      if (!call || !description?.syntax) return undefined;
      const label = description.syntax.split("\n")[0]!;
      const parameters = description.parameters ?? [];
      const toParameter = (group: number) => (a: ArgumentInfo) =>
        new vscode.ParameterInformation(labelRange(label, group, a.name), new vscode.MarkdownString(a.description));
      const signature = new vscode.SignatureInformation(label, new vscode.MarkdownString(description.documentation));
      signature.parameters = [
        ...parameters.map(toParameter(0)),
        ...(description.arguments ?? []).map(toParameter(parameters.length ? 1 : 0)),
      ];
      const help = new vscode.SignatureHelp();
      help.signatures = [signature];
      help.activeSignature = 0;
      const inParameters = parameters.length > 0 && call.group === 0 && call.nextGroup;
      help.activeParameter = inParameters ? call.argument : parameters.length + call.argument;
      return help;
    },
  };
  return vscode.languages.registerSignatureHelpProvider(languageId, provider, { triggerCharacters: ["(", ","], retriggerCharacters: [")"] });
}
