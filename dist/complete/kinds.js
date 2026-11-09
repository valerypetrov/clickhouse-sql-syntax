/** The phrases of the documentation that tell each kind, tried in this order after the values it lists. */
export const KIND_PHRASES = [
    ["JSON path", [/\bJSONPath\b/i, /^(?:A|The) string representing the path\b/i]],
    [
        "data type",
        [
            /^(?:the |a )?(?:clickhouse |target |destination )*data type\b/i,
            /^destination type\b/i,
            /^a string representing a type name\b/i,
            /^the name of the (?:variant )?type\b/i,
        ],
    ],
    ["time zone", [/^(?:optional\.\s*)?[^.]*\btime ?zone\b/i]],
    ["format", [/\bformat name\b/i, /^(?:text|input|output) format\b/i]],
];
const STRING_TYPE = /^(?:const )?(?:String|FixedString)$/;
const kinds = new WeakMap();
/** The kind of a documented argument of a function, by its documentation, or undefined for an expression of any kind. */
export function argumentKind(info, arg) {
    let kind = kinds.get(arg);
    if (kind === undefined)
        kinds.set(arg, (kind = readKind(info, arg) ?? null));
    return kind ?? undefined;
}
function readKind(info, arg) {
    // Each kind is a string, so an argument documented with other types is none of them.
    if (arg.types?.length && !arg.types.some((type) => STRING_TYPE.test(type)))
        return undefined;
    if (arg.values?.length)
        return "value";
    const phrase = KIND_PHRASES.find(([, patterns]) => patterns.some((pattern) => pattern.test(arg.description)))?.[0];
    // The functions that parse JSON return only some types.
    const parsesJSON = info.category === "JSON" && /\bparses\b[^.]*\bJSON\b/i.test(info.description ?? "");
    return phrase === "data type" && parsesJSON ? "JSON data type" : phrase;
}
//# sourceMappingURL=kinds.js.map