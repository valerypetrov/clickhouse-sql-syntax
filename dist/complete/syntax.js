/**
 * The lists of arguments that the syntax of a call in the catalog allows, such as `File(format[, path | fd])` of an
 * engine or `JSONExtract(json[, indices_or_keys, ...], return_type)` of a function.
 */
/** More lists than any engine or function has; a syntax that gives more is not read. */
const MAX_LISTS = 1000;
/** The tokens of the syntax inside the brackets, or undefined at a character it does not use. */
function syntaxTokens(text) {
    const pattern = /\s*(?:(\.\.\.|[[\]|,=])|'([^']*)'|([A-Za-z_]\w*|\d+))/y;
    const tokens = [];
    while (pattern.lastIndex < text.length) {
        if (/^\s*$/.test(text.slice(pattern.lastIndex)))
            break;
        const match = pattern.exec(text);
        if (!match)
            return undefined;
        if (match[1])
            tokens.push({ punct: match[1] });
        else
            tokens.push({ name: match[2] ?? match[3], quoted: match[2] !== undefined });
    }
    return tokens;
}
/** The items up to `]`, or to the end at the top level, as alternatives split by `|` inside brackets. */
function parseItems(tokens, pos, inBrackets) {
    const lists = [[]];
    for (;;) {
        const list = lists[lists.length - 1];
        const token = tokens[pos.i];
        if (!token)
            return inBrackets ? undefined : lists;
        if (token.punct === "]") {
            pos.i++;
            return inBrackets ? lists : undefined;
        }
        if (token.punct === "," || token.punct === "|" || token.punct === "...") {
            pos.i++;
            if (token.punct === "|" && inBrackets)
                lists.push([]);
            else if (token.punct === "|") {
                // At the top level, `a | b` is one argument that is either.
                const left = list.pop();
                const right = parseAtom(tokens, pos);
                if (!left || !right)
                    return undefined;
                list.push({ type: "choice", items: [...(left.type === "choice" ? left.items : [left]), right] });
            }
            else if (token.punct === "...") {
                const last = list[list.length - 1];
                // `[, x]...` repeats the last parameter of each alternative in the brackets.
                const repeated = last?.type === "optional" ? last.lists.map((l) => l[l.length - 1]) : [last];
                if (!repeated.every((item) => item?.type === "param"))
                    return undefined;
                for (const item of repeated)
                    if (item?.type === "param")
                        item.repeats = true;
            }
            continue;
        }
        const atom = parseAtom(tokens, pos);
        if (!atom)
            return undefined;
        const last = list[list.length - 1];
        // Words with no comma between them are one argument, as `INTERVAL x unit`.
        if (atom.type === "param" && last?.type === "param" && !last.repeats && token.name !== undefined && tokens[pos.i - 2]?.name !== undefined) {
            const words = [...(last.param.words ?? [last.param]), atom.param];
            last.param = { name: words.map((w) => w.name).join(" "), quoted: false, keyword: false, named: false, words };
        }
        else
            list.push(atom);
    }
}
function parseAtom(tokens, pos) {
    const token = tokens[pos.i++];
    if (token?.punct === "[") {
        const lists = parseItems(tokens, pos, true);
        return lists && { type: "optional", lists };
    }
    if (token?.name === undefined)
        return undefined;
    const param = { name: token.name, quoted: token.quoted, keyword: !token.quoted && /^[A-Z][A-Z0-9_]+$/.test(token.name), named: false };
    if (tokens[pos.i]?.punct === "=") {
        const value = tokens[pos.i + 1]?.name;
        if (value === undefined)
            return undefined;
        pos.i += 2;
        // `variant = 1` gives a default; `key = value` is an argument given by name.
        param.named = !/^\d/.test(value);
    }
    return { type: "param", param, repeats: false };
}
/** Every list of parameters that the items allow; `closes(p)` tells that no optional part follows an optional `p` left out. */
function expand(items, closes) {
    let lists = [{ parameters: [], repeats: false, closed: false }];
    for (const item of items) {
        const next = [];
        for (const list of lists) {
            const add = (tails) => {
                for (const tail of tails)
                    next.push({ parameters: [...list.parameters, ...tail.parameters], repeats: tail.repeats, tail: tail.tail, closed: list.closed });
            };
            if (list.repeats) {
                // A parameter after a repeated one comes after the repetitions; an optional part there is left out.
                next.push(item.type === "param" ? { ...list, tail: [...(list.tail ?? []), item.param] } : list);
            }
            else if (item.type === "param")
                add([{ parameters: [item.param], repeats: item.repeats }]);
            else if (item.type === "choice")
                add(item.items.flatMap((choice) => expand([choice], closes)));
            else {
                const typed = item.lists.every((l) => l[0]?.type === "param" && closes(l[0].param));
                next.push({ ...list, closed: list.closed || typed });
                if (!list.closed)
                    add(item.lists.flatMap((l) => expand(l, closes)));
            }
        }
        if (next.length > MAX_LISTS)
            return [];
        lists = next;
    }
    return lists.map(({ parameters, repeats, tail }) => (tail ? { parameters, repeats, tail } : { parameters, repeats }));
}
function parametersOf(items, into) {
    for (const item of items) {
        if (item.type === "param") {
            if (!into.some((p) => p.name === item.param.name))
                into.push(item.param);
        }
        else if (item.type === "choice")
            parametersOf(item.items, into);
        else
            for (const list of item.lists)
                parametersOf(list, into);
    }
    return into;
}
/** The lists of arguments that the syntax of the brackets' contents allows, or undefined for one it cannot read. */
export function readArguments(text, closes = () => false) {
    const tokens = syntaxTokens(text);
    const items = tokens && parseItems(tokens, { i: 0 }, false)?.[0];
    if (!items)
        return undefined;
    const lists = expand(items, closes);
    return lists.length ? { parameters: parametersOf(items, []), lists } : undefined;
}
/**
 * The parameter that the argument at `index` of a list is, of `count` arguments in all when known; past the
 * repeated parameter, the last `tail.length` arguments are those of the tail.
 */
export function parameterAt(list, index, count) {
    const { parameters, tail = [] } = list;
    if (index < parameters.length - (list.repeats ? 1 : 0))
        return parameters[index];
    if (!list.repeats)
        return undefined;
    const fromTail = count === undefined ? -1 : index - Math.max(count - tail.length, parameters.length - 1);
    return fromTail >= 0 ? tail[fromTail] : parameters[parameters.length - 1];
}
/** The index of the bracket that closes the one at `open` in a text, or -1. */
export function closingBracket(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "(")
            depth++;
        else if (text[i] === ")" && --depth === 0)
            return i;
    }
    return -1;
}
//# sourceMappingURL=syntax.js.map