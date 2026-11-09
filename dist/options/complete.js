/**
 * Suggestions for the options of a statement at the cursor, read from the tokens before it: setting names and values
 * by the place of the list, codecs, index types, statistics types, database engines and compression methods.
 */
import { DATABASE_ENGINES, CODECS, INDEX_TYPES, STATISTICS_TYPES } from "../generated/options.js";
import { TIME_ZONES } from "../generated/time-zones.js";
import { TokenKind as T } from "../types.js";
import { parameterSettings } from "../complete/parameters.js";
import { settingsScope } from "./catalog.js";
import { optionDocumentation, settingDocumentation } from "./docs.js";
import { EXPLAIN_KINDS } from "./words.js";
const COMPRESSION = ["auto", "none", "gzip", "deflate", "br", "xz", "zstd", "lz4", "bz2", "snappy"];
const lower = (sql, token) => (token?.kind === T.BareWord ? sql.slice(token.start, token.end).toLowerCase() : undefined);
const isOpen = (k) => k === T.OpeningRoundBracket || k === T.OpeningSquareBracket || k === T.OpeningCurlyBrace;
const isClose = (k) => k === T.ClosingRoundBracket || k === T.ClosingSquareBracket || k === T.ClosingCurlyBrace;
const nameText = (sql, token) => token.kind === T.QuotedIdentifier ? sql.slice(token.start + 1, token.end - 1) : sql.slice(token.start, token.end);
/** The index of the first token of a compound name that ends at `i`, as a.b, or -1. */
function nameStart(before, i) {
    if (before[i]?.kind !== T.BareWord && before[i]?.kind !== T.QuotedIdentifier)
        return -1;
    while (before[i - 1]?.kind === T.Dot && (before[i - 2]?.kind === T.BareWord || before[i - 2]?.kind === T.QuotedIdentifier))
        i -= 2;
    return i;
}
/** The number of words of the kind after EXPLAIN, when the statement is one. */
function explainKindEnd(sql, before) {
    if (lower(sql, before[0]) !== "explain")
        return undefined;
    for (const kind of [...EXPLAIN_KINDS].sort((a, b) => b.length - a.length)) {
        const parts = kind.toLowerCase().split(" ");
        if (parts.every((part, j) => lower(sql, before[1 + j]) === part))
            return { end: 1 + parts.length, kind };
    }
    return { end: 1, kind: "PLAN" };
}
/** The place of the settings list that the tokens end in, at a name or, after `name =`, at its value. */
export function settingsPlace(sql, before) {
    let i = before.length - 1;
    let valueOf;
    if (before[i]?.kind === T.Equals) {
        const start = nameStart(before, i - 1);
        if (start < 0)
            return undefined;
        valueOf = before.slice(start, i).filter((t) => t.kind !== T.Dot).map((t) => nameText(sql, t)).join(".");
        i = start - 1;
    }
    const explain = explainKindEnd(sql, before);
    for (;;) {
        const w = lower(sql, before[i]);
        if (explain && i === explain.end - 1)
            return { context: "explain", kind: explain.kind, valueOf };
        if (w === "settings" || w === "setting")
            return classify(sql, before, i, valueOf);
        if (w === "set" && i === 0)
            return { context: "set", valueOf };
        if (before[i]?.kind === T.OpeningRoundBracket && lower(sql, before[i - 1]) === "settings")
            return classify(sql, before, i, valueOf);
        if (before[i]?.kind !== T.Comma)
            return undefined;
        // Back over the value, which may hold brackets, to its "=", then over the name; RESET SETTING lists names only.
        let depth = 0;
        let j = i - 1;
        for (; j >= 0 && (depth > 0 || (before[j].kind !== T.Equals && before[j].kind !== T.Comma && lower(sql, before[j]) !== "setting")); j--) {
            const kind = before[j].kind;
            if (isClose(kind))
                depth++;
            if (isOpen(kind))
                depth--;
            if (depth < 0)
                return undefined;
        }
        if (before[j]?.kind === T.Equals) {
            const start = nameStart(before, j - 1);
            if (start < 0)
                return undefined;
            i = start - 1;
        }
        else {
            const start = nameStart(before, i - 1);
            if (start < 0 || start !== j + 1)
                return undefined;
            i = start - 1;
        }
    }
}
/** The index of the last word `name` before `end` at the top level of the brackets, or -1. */
function lastTopWord(sql, before, end, names) {
    let depth = 0;
    for (let i = end - 1; i >= 0; i--) {
        const kind = before[i].kind;
        if (isClose(kind))
            depth++;
        else if (isOpen(kind))
            depth--;
        else if (depth === 0 && names.includes(lower(sql, before[i]) ?? ""))
            return i;
    }
    return -1;
}
function classify(sql, before, at, valueOf) {
    const words = before.slice(0, 4).map((t) => lower(sql, t) ?? "");
    const head = words[0];
    const keyword = lower(sql, before[at]);
    if (before[at].kind === T.OpeningRoundBracket) {
        if (lower(sql, before[at - 2]) === "with")
            return { context: "projection", valueOf };
        if (words.includes("dictionary"))
            return { context: "dictionary", valueOf };
        return { context: "column", valueOf };
    }
    if (keyword === "setting") {
        const reset = lower(sql, before[at - 1]) === "reset";
        if (head === "alter" && words[1] === "database")
            return { context: "alter database", valueOf };
        if (lastTopWord(sql, before, at, ["column"]) > lastTopWord(sql, before, at, [","]))
            return { context: reset ? "column reset" : "column", valueOf };
        return { context: reset ? "reset" : "alter", valueOf };
    }
    if (head === "backup")
        return { context: "backup", valueOf };
    if (head === "restore")
        return { context: "restore", valueOf };
    if (["user", "role", "profile", "quota"].includes(words[1]) || (words[1] === "settings" && words[2] === "profile") || words[1] === "or") {
        if (!words.includes("table") && !words.includes("database") && !words.includes("view"))
            return { context: "profile", valueOf };
    }
    if (head === "system")
        return { context: "storage", engine: "Distributed", valueOf };
    if (head !== "create" && head !== "attach" && head !== "replace")
        return { context: "query", valueOf };
    // A SELECT after the engine, as in CREATE TABLE ... AS SELECT ... SETTINGS, has query settings.
    const engineAt = lastTopWord(sql, before, at, ["engine"]);
    const selectAt = lastTopWord(sql, before, at, ["select", "with"]);
    const refreshAt = lastTopWord(sql, before, at, ["refresh"]);
    if (selectAt > engineAt)
        return { context: "query", valueOf };
    if (refreshAt > engineAt)
        return { context: "refresh", valueOf };
    const database = words.includes("database");
    if (engineAt >= 0) {
        const name = before[engineAt + 1]?.kind === T.Equals ? before[engineAt + 2] : before[engineAt + 1];
        const engine = name ? nameText(sql, name) : undefined;
        return { context: database ? "database" : "storage", engine, valueOf };
    }
    if (database)
        return { context: "database", valueOf };
    return { context: "storage", valueOf };
}
/** The values to offer for a setting: those of an enum, 0 and 1 for a boolean, or the time zones. */
function valueCandidates(setting, explain) {
    if (setting.values?.length)
        return setting.values.map((v) => ({ label: `'${v}'`, kind: "value", detail: setting.type, insertText: `'${v}'` }));
    if (setting.type === "Bool" || setting.type === "BoolAuto" || (explain && setting.type === "Bool"))
        return [
            { label: "1", kind: "value", detail: "true" },
            { label: "0", kind: "value", detail: "false" },
            ...(setting.type === "BoolAuto" ? [{ label: "'auto'", kind: "value", detail: setting.type }] : []),
        ];
    if (setting.type === "Timezone")
        return TIME_ZONES.map((z) => ({ label: `'${z.name}'`, kind: "value", detail: "time zone" }));
    return [];
}
/** The tokens of the call whose brackets the tokens end in: the name before its "(" and which argument is at the cursor. */
function enclosingCall(before) {
    let depth = 0;
    let argument = 0;
    for (let i = before.length - 1; i >= 0; i--) {
        const kind = before[i].kind;
        if (isClose(kind))
            depth++;
        else if (isOpen(kind)) {
            if (depth === 0)
                return kind === T.OpeningRoundBracket ? { open: i, argument } : undefined;
            depth--;
        }
        else if (kind === T.Comma && depth === 0)
            argument++;
    }
    return undefined;
}
/** What goes at the cursor among the options of a statement, from the tokens before it. */
export function optionSuggestions(sql, before, prefix = "") {
    const none = { candidates: [], only: false };
    const last = before[before.length - 1];
    const call = enclosingCall(before);
    const callee = call && lower(sql, before[call.open - 1]);
    const atListItem = last?.kind === T.OpeningRoundBracket || last?.kind === T.Comma;
    // CODEC(a, b(...)): the codecs at the top level, and the values of a codec's parameter inside its brackets.
    if (call && callee === "codec" && atListItem)
        return { only: true, candidates: CODECS.filter((c) => !c.refused).map((c) => ({ tier: 2, candidate: { label: c.name, kind: "codec", detail: codecDetail(c), documentation: optionDocumentation("codec", c.name) } })) };
    if (call && atListItem) {
        const outer = enclosingCall(before.slice(0, call.open - 1));
        if (outer && lower(sql, before[outer.open - 1]) === "codec") {
            const codec = CODECS.find((c) => c.name.toLowerCase() === callee);
            const param = codec?.rule?.parameters[call.argument];
            const words = [...(param?.strings ?? []).map((s) => `'${s}'`), ...(param?.words ?? []).map((w) => w.toUpperCase())];
            return { only: true, candidates: words.map((w) => ({ tier: 0, candidate: { label: w, kind: "value", detail: `${codec.name} parameter` } })) };
        }
    }
    // STATISTICS(a, b) and STATISTICS columns TYPE a, b.
    if ((call && callee === "statistics" && atListItem) || statisticsTypeList(sql, before))
        return { only: true, candidates: STATISTICS_TYPES.map((t) => ({ tier: 2, candidate: { label: t.name, kind: "statistics type", documentation: optionDocumentation("statistics type", t.name) } })) };
    // INDEX name expr TYPE kind, but not the index of a projection.
    if (lower(sql, last) === "type") {
        const index = lastTopWord(sql, before, before.length - 1, ["index"]);
        if (index >= 0 && lower(sql, before[index - 2]) !== "projection")
            return { only: true, candidates: INDEX_TYPES.filter((t) => !t.refused).map((t) => ({ tier: 2, candidate: { label: t.name, kind: "index type", detail: t.syntax?.replace(/^INDEX name \w+ TYPE /, "").replace(/ GRANULARITY \w+$/, ""), documentation: optionDocumentation("index type", t.name) } })) };
    }
    if (lower(sql, last) === "compression")
        return { only: true, candidates: COMPRESSION.map((m) => ({ tier: 0, candidate: { label: `'${m}'`, kind: "value", detail: "compression method" } })) };
    const afterEngine = lower(sql, last) === "engine" || (last?.kind === T.Equals && lower(sql, before[before.length - 2]) === "engine");
    if (afterEngine && before.slice(0, 5).some((t) => lower(sql, t) === "database"))
        return { only: true, candidates: DATABASE_ENGINES.map((e) => ({ tier: 2, candidate: { label: e.name, kind: "database engine", documentation: optionDocumentation("database engine", e.name) } })) };
    const place = settingsPlace(sql, before);
    if (!place)
        return none;
    const scope = settingsScope(place.context, place.engine, place.kind);
    if (place.valueOf !== undefined) {
        const setting = scope.find(place.valueOf);
        return { only: false, candidates: setting ? valueCandidates(setting, place.context === "explain").map((candidate) => ({ tier: 0, candidate })) : [] };
    }
    // Only the names the prefix starts get their documentation built.
    const start = prefix.toLowerCase();
    const candidates = scope.offered.filter(({ info }) => info.name.toLowerCase().startsWith(start)).map(({ info, label, rank }) => ({
        tier: 2 + rank,
        candidate: { label: info.name, kind: "setting", detail: label === "setting" ? info.type : `${info.type} · ${label}`, documentation: settingDocumentation(info) },
    }));
    // SET and a query's SETTINGS also take param_name for the file's query parameters.
    if (place.context === "set" || place.context === "query")
        for (const candidate of parameterSettings(sql))
            if (candidate.label.toLowerCase().startsWith(start))
                candidates.push({ tier: 2, candidate });
    return { only: false, candidates };
}
function codecDetail(c) {
    if (c.encryption)
        return "encryption";
    if (c.generic)
        return "general-purpose compression";
    if (c.compression)
        return "specialized compression";
    return "preprocessor";
}
/** Whether the tokens end in the list of types after STATISTICS columns TYPE. */
function statisticsTypeList(sql, before) {
    let i = before.length - 1;
    if (before[i]?.kind === T.Comma)
        i--;
    else if (lower(sql, before[i]) !== "type")
        return false;
    while (i >= 0 && lower(sql, before[i]) !== "type") {
        if (before[i].kind !== T.BareWord || before[i - 1]?.kind !== T.Comma) {
            if (lower(sql, before[i - 1]) === "type" && before[i].kind === T.BareWord) {
                i--;
                break;
            }
            return false;
        }
        i -= 2;
    }
    return lastTopWord(sql, before, i, ["statistics", "index"]) === lastTopWord(sql, before, i, ["statistics"]) && lastTopWord(sql, before, i, ["statistics"]) >= 0;
}
//# sourceMappingURL=complete.js.map