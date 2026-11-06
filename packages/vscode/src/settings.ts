import * as vscode from "vscode";
import { invalidValue, SETTINGS } from "./manifest.js";

/** The values already said to be wrong, so that each is said once. */
const warned = new Set<string>();

/** The value of a setting for `scope`, or its default when the value does not fit what package.json declares. */
export function setting<T>(key: string, scope?: vscode.ConfigurationScope): T {
  const fallback = SETTINGS[key]!.default as T;
  const value = vscode.workspace.getConfiguration(undefined, scope).get<T>(key, fallback);
  const problem = invalidValue(key, value);
  if (!problem) return value;
  if (!warned.has(problem)) {
    warned.add(problem);
    void vscode.window.showWarningMessage(`${problem}, so ClickHouse SQL uses ${JSON.stringify(fallback)}.`);
  }
  return fallback;
}

/** The value of a setting in the user's settings only, or its default; `problem` says why a value set there does not fit. */
export function userSetting<T>(key: string): { value: T; problem?: string } {
  const fallback = SETTINGS[key]!.default as T;
  const value = vscode.workspace.getConfiguration().inspect<T>(key)?.globalValue;
  if (value === undefined) return { value: fallback };
  const problem = invalidValue(key, value);
  return problem ? { value: fallback, problem } : { value };
}
