import { type CompletionCandidate, type Token } from "../types.js";
import { type SettingsContext } from "./catalog.js";
export interface OptionSuggestions {
    candidates: {
        tier: number;
        candidate: CompletionCandidate;
    }[];
    /** Whether nothing else fits there, as in CODEC(...), so that functions and columns are left out. */
    only: boolean;
}
/** Where a list of settings is, as read from the words before it. */
export interface SettingsPlace {
    context: SettingsContext;
    engine?: string;
    kind?: string;
    /** The setting whose value the cursor is at, after `name =`. */
    valueOf?: string;
}
/** The place of the settings list that the tokens end in, at a name or, after `name =`, at its value. */
export declare function settingsPlace(sql: string, before: Token[]): SettingsPlace | undefined;
/** What goes at the cursor among the options of a statement, from the tokens before it. */
export declare function optionSuggestions(sql: string, before: Token[], prefix?: string): OptionSuggestions;
//# sourceMappingURL=complete.d.ts.map