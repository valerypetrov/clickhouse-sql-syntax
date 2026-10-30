/**
 * The expression parser: a port of src/Parsers/ExpressionListParsers.cpp.
 * Operators and operands are collected in layers, one per bracketed or function-like part.
 */
import { tokenize } from "../lexer/index.js";
import { isSignificant } from "../types.js";
import { Ast, canHaveAlias, func, identifierName, list, literal, stringValue, type Lit } from "./ast.js";
import { parseDataTypeAsText } from "./datatype.js";
import {
  parseAlias,
  parseAllCollectionsOfLiterals,
  parseArrayOfLiterals,
  parseAsterisk,
  parseCastOperator,
  parseColumnsMatcher,
  parseLiteralAsText,
  parseCompoundIdentifier,
  parseFilterClause,
  parseIdentifier,
  parseInterpolateElement,
  parseList,
  parseLiteral,
  parseMySQLGlobalVariable,
  parseNumber,
  parseOrderByElement,
  parseQualifiedAsterisk,
  parseQualifiedColumnsMatcher,
  parseStorageOrderByElement,
  parseStringLiteral,
  parseSubquery,
  parseSubstitution,
  parseTTLElement,
  parseTupleOfLiterals,
  parseWindowReference,
  parseWithOptionalAlias,
} from "./elements.js";
import { parseSetQuery } from "./set.js";
import { parseSelectWithUnionQuery } from "./select.js";
import { base, Expected, kw, lookahead, P, peekKwQuiet, T, tok } from "./state.js";

const enum Action {
  None,
  Operand,
  Operator,
}

const enum Op {
  None,
  Comparison,
  Mergeable,
  ArrayElement,
  TupleElement,
  IsNull,
  IsTruthValue,
  StartBetween,
  StartNotBetween,
  FinishBetween,
  StartIf,
  FinishIf,
  Cast,
  Lambda,
  Not,
}

const enum Checkpoint {
  None,
  Interval,
  Case,
}

interface Operator {
  name: string;
  priority: number;
  arity: number;
  type: Op;
}

function op(name: string, priority: number, arity: number, type = Op.None): Operator {
  return { name, priority, arity, type };
}

/** ParserExpressionImpl::operators_table, in the order they are tried. */
const OPERATORS: [string, Operator][] = [
  ["->", op("lambda", 1, 2, Op.Lambda)],
  ["?", op("", 2, 0, Op.StartIf)],
  [":", op("if", 3, 3, Op.FinishIf)],
  ["OR", op("or", 3, 2, Op.Mergeable)],
  ["AND", op("and", 4, 2, Op.Mergeable)],
  ["IS NOT DISTINCT FROM", op("isNotDistinctFrom", 6, 2)],
  ["IS DISTINCT FROM", op("isDistinctFrom", 6, 2)],
  ["IS NOT UNKNOWN", op("isNotUnknownPredicate", 6, 1, Op.IsTruthValue)],
  ["IS UNKNOWN", op("isUnknownPredicate", 6, 1, Op.IsTruthValue)],
  ["IS NOT FALSE", op("isNotFalsePredicate", 6, 1, Op.IsTruthValue)],
  ["IS FALSE", op("isFalsePredicate", 6, 1, Op.IsTruthValue)],
  ["IS NOT TRUE", op("isNotTruePredicate", 6, 1, Op.IsTruthValue)],
  ["IS TRUE", op("isTruePredicate", 6, 1, Op.IsTruthValue)],
  ["IS NULL", op("isNull", 6, 1, Op.IsNull)],
  ["IS NOT NULL", op("isNotNull", 6, 1, Op.IsNull)],
  ["BETWEEN", op("", 7, 0, Op.StartBetween)],
  ["NOT BETWEEN", op("", 7, 0, Op.StartNotBetween)],
  ["|", op("__compose", 8, 2)],
  ["==", op("equals", 9, 2, Op.Comparison)],
  ["!=", op("notEquals", 9, 2, Op.Comparison)],
  ["<=>", op("isNotDistinctFrom", 9, 2, Op.Comparison)],
  ["<>", op("notEquals", 9, 2, Op.Comparison)],
  ["<=", op("lessOrEquals", 9, 2, Op.Comparison)],
  [">=", op("greaterOrEquals", 9, 2, Op.Comparison)],
  ["<", op("less", 9, 2, Op.Comparison)],
  [">", op("greater", 9, 2, Op.Comparison)],
  ["=", op("equals", 9, 2, Op.Comparison)],
  ["LIKE", op("like", 9, 2)],
  ["ILIKE", op("ilike", 9, 2)],
  ["NOT LIKE", op("notLike", 9, 2)],
  ["NOT ILIKE", op("notILike", 9, 2)],
  ["REGEXP", op("match", 9, 2)],
  ["~", op("match", 9, 2)],
  ["~*", op("matchCaseInsensitive", 9, 2)],
  ["!~", op("notMatch", 9, 2)],
  ["!~*", op("notMatchCaseInsensitive", 9, 2)],
  ["IN", op("in", 9, 2)],
  ["NOT IN", op("notIn", 9, 2)],
  ["GLOBAL IN", op("globalIn", 9, 2)],
  ["GLOBAL NOT IN", op("globalNotIn", 9, 2)],
  ["SIMILAR TO", op("similarTo", 9, 2)],
  ["NOT SIMILAR TO", op("notSimilarTo", 9, 2)],
  ["||", op("concat", 10, 2, Op.Mergeable)],
  ["AT TIME ZONE", op("toTimeZone", 13, 2)],
  ["+", op("plus", 11, 2)],
  ["-", op("minus", 11, 2)],
  ["−", op("minus", 11, 2)],
  ["*", op("multiply", 12, 2)],
  ["/", op("divide", 12, 2)],
  ["%", op("modulo", 12, 2)],
  ["MOD", op("modulo", 12, 2)],
  ["DIV", op("intDiv", 12, 2)],
  [".", op("tupleElement", 14, 2, Op.TupleElement)],
  ["[", op("arrayElement", 14, 2, Op.ArrayElement)],
  ["::", op("CAST", 14, 2, Op.Cast)],
];

const UNARY_OPERATORS: [string, Operator][] = [
  ["NOT", op("not", 5, 1, Op.Not)],
  ["-", op("negate", 13, 1)],
  ["−", op("negate", 13, 1)],
];

const FINISH_BETWEEN = op("", 8, 0, Op.FinishBetween);

function isWordStart(text: string): boolean {
  const c = text[0]!;
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

/** parseOperator: a keyword operator like AND, or a token with exactly this text. */
function parseOperator(p: P, text: string): boolean {
  if (isWordStart(text)) return kw(p, text);
  if (p.text() === text) {
    p.i++;
    return true;
  }
  return false;
}

function makeOperator(operator: Operator, args: Ast[] = []): Ast {
  const node = func(operator.name, args).flag("operator");
  if (operator.type === Op.Lambda) node.flag("lambda");
  return node;
}

function makeBetween(negative: boolean, args: Ast[]): Ast {
  const [subject, left, right] = args as [Ast, Ast, Ast];
  if (negative) return func("or", [func("less", [subject, left]), func("greater", [subject, right])]);
  return func("and", [func("greaterOrEquals", [subject, left]), func("lessOrEquals", [subject, right])]);
}

function makeTruthValuePredicate(name: string, argument: Ast): Ast | null {
  const truth = (value: boolean): Ast => literal({ t: "Bool", v: value });
  switch (name) {
    case "isTruePredicate":
      return func("isNotDistinctFrom", [argument, truth(true)]);
    case "isFalsePredicate":
      return func("isNotDistinctFrom", [argument, truth(false)]);
    case "isUnknownPredicate":
      return func("isNull", [argument]);
    case "isNotTruePredicate":
      return func("isDistinctFrom", [argument, truth(true)]);
    case "isNotFalsePredicate":
      return func("isDistinctFrom", [argument, truth(false)]);
    case "isNotUnknownPredicate":
      return func("isNotNull", [argument]);
    default:
      return null;
  }
}

/** The state shared by the main loop and the layer it calls. */
interface Step {
  next: Action;
}

/** A Layer collects the operands and operators of one element, like f(x1, x2, x3). */
abstract class Layer {
  operators: Operator[] = [];
  operands: Ast[] = [];
  elements: Ast[] = [];
  finished = false;
  state = 0;
  isTableFunction = false;
  /** The AND of BETWEEN ... AND mirrors the logical AND, so unmatched BETWEENs are counted. */
  betweenCounter = 0;
  parsedAlias = false;
  savedCheckpoint: { pos: number; checkpoint: Checkpoint } | null = null;
  currentCheckpoint = Checkpoint.None;

  constructor(
    readonly allowAlias = true,
    readonly allowAliasWithoutAs = false,
  ) {}

  abstract parse(p: P, step: Step): boolean;

  getResult(): Ast | null {
    if (!this.finished) return null;
    return this.getResultImpl();
  }

  protected getResultImpl(): Ast | null {
    return this.elements.length === 1 ? this.elements[0]! : null;
  }

  previousPriority(): number {
    return this.operators.length ? this.operators[this.operators.length - 1]!.priority : 0;
  }

  previousType(): Op {
    return this.operators.length ? this.operators[this.operators.length - 1]!.type : Op.None;
  }

  previousOperator(): Operator | undefined {
    return this.operators[this.operators.length - 1];
  }

  hasPendingOperator(type: Op): boolean {
    return this.operators.some((operator) => operator.type === type);
  }

  isCurrentElementEmpty(): boolean {
    return !this.operators.length && !this.operands.length;
  }

  popLastOperands(n: number): Ast[] | null {
    if (n > this.operands.length) return null;
    return this.operands.splice(this.operands.length - n, n);
  }

  /** Merges the operators and operands into one element; false if the query is incorrect. */
  mergeElement(pushToElements = true): boolean {
    this.parsedAlias = false;
    let current: Operator | undefined;
    while ((current = this.operators.pop())) {
      let fn: Ast;
      if (current.type === Op.StartIf || current.type === Op.StartBetween || current.type === Op.StartNotBetween)
        return false;
      if (current.type === Op.FinishIf) {
        const start = this.operators.pop();
        if (!start || start.type !== Op.StartIf) return false;
      }
      if (current.type === Op.FinishBetween) {
        const start = this.operators.pop();
        if (!start) return false;
        if (start.type !== Op.StartBetween && start.type !== Op.StartNotBetween) return false;
        const args = this.popLastOperands(3);
        if (!args) return false;
        fn = makeBetween(start.type === Op.StartNotBetween, args);
      } else {
        const args = this.popLastOperands(current.arity);
        if (!args) return false;
        fn = makeOperator(current, args);
      }
      this.operands.push(fn);
    }
    const node = this.operands.pop();
    if (!node) return false;
    const result = this.isCurrentElementEmpty();
    if (pushToElements) this.elements.push(node);
    else this.operands.push(node);
    return result;
  }

  /** Turns the current element into the tuple of lambda arguments. */
  parseLambda(): boolean {
    if (this.isCurrentElementEmpty()) {
      this.operands.push(func("tuple"));
      return true;
    }
    if (this.operands.length !== 1 || this.operators.length || !this.mergeElement()) return false;
    const last = this.elements[this.elements.length - 1]!;
    if (last.kind === "Function" && last.name === "tuple") {
      this.operands.push(this.elements.pop()!);
    } else {
      this.operands.push(func("tuple", this.elements));
      this.elements = [];
    }
    return this.operands[this.operands.length - 1]!.children.every((child) => child.kind === "Identifier");
  }

  /** Puts the alias on the last operand. */
  insertAlias(alias: Ast): boolean {
    if (!this.mergeElement(false)) return false;
    const last = this.operands[this.operands.length - 1];
    if (!last) return false;
    if (!canHaveAlias(last)) return false;
    last.alias = alias.name;
    return true;
  }
}

class ExpressionLayer extends Layer {
  constructor(
    isTableFunction: boolean,
    private readonly allowTrailingCommas = false,
  ) {
    super(false, false);
    this.isTableFunction = isTableFunction;
  }

  override getResult(): Ast | null {
    if (!this.mergeElement()) return null;
    return this.getResultImpl();
  }

  parse(p: P): boolean {
    if (p.kind() !== T.Comma) return true;
    this.finished = true;
    if (!this.allowTrailingCommas) return true;
    // A trailing comma before FROM: SELECT a, b, FROM t. But FROM may also be a column name.
    const isTrailing = lookahead(
      p,
      () => {
        p.i++;
        if (!p.valid() || p.kind() === T.Semicolon || p.kind() === T.PipeOperator) return true;
        if (!kw(p, "FROM")) return false;
        if (p.kind() === T.Comma) return false;
        if (kw(p, "FROM")) return false;
        if (parseAlias(p, false)) return false;
        for (const [text] of OPERATORS) if (parseOperator(p, text)) return false;
        return true;
      },
      new Expected(),
    );
    if (isTrailing) p.i++;
    return true;
  }
}

/** A layer for a function with a separator and an end token. */
class LayerWithSeparator extends Layer {
  constructor(
    private readonly separator: T,
    private readonly end: T,
    allowAlias = true,
    allowAliasWithoutAs = false,
  ) {
    super(allowAlias, allowAliasWithoutAs);
  }

  parse(p: P, step: Step): boolean {
    if (tok(p, this.separator)) {
      step.next = Action.Operand;
      return this.mergeElement();
    }
    if (tok(p, this.end)) {
      step.next = Action.Operator;
      if (!this.isCurrentElementEmpty() || this.elements.length) if (!this.mergeElement()) return false;
      this.finished = true;
    }
    return true;
  }
}

const TO_DATE_ARGUMENT = /^[23]\d\d\d-\d\d-\d\d$/;

class FunctionLayer extends Layer {
  private hasAll = false;
  private hasDistinct = false;
  private parameters: Ast[] | null = null;
  private contentsBegin = 0;

  constructor(
    private functionName: string,
    private readonly allowFunctionParameters = true,
  ) {
    super();
  }

  /** ALL and DISTINCT after a bracket; they are names when a comma or bracket follows. */
  private parseQualifiers(p: P, first: boolean): boolean {
    const afterBracket = p.i;
    const savedExpected = p.e.copy();
    if (kw(p, "ALL")) this.hasAll = true;
    if (kw(p, "DISTINCT")) this.hasDistinct = true;
    if (!this.hasAll && kw(p, "ALL")) this.hasAll = true;
    if (this.hasAll && this.hasDistinct) return false;
    if ((this.hasAll || this.hasDistinct) && (p.kind() === T.Comma || p.kind() === T.ClosingRoundBracket)) {
      p.restore(afterBracket);
      p.e.assign(savedExpected);
      if (first) this.hasAll = false;
      this.hasDistinct = false;
    }
    return true;
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      this.state = 1;
      if (!this.parseQualifiers(p, true)) return false;
      this.contentsBegin = p.tok().start;
    }
    if (this.state === 1) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        return this.mergeElement();
      }
      if (tok(p, T.ClosingRoundBracket)) {
        step.next = Action.Operator;
        if (!this.isCurrentElementEmpty() || this.elements.length) if (!this.mergeElement()) return false;
        // toDate(2014-01-01) is a common mistake for toDate('2014-01-01').
        const contents = p.sql.slice(this.contentsBegin, p.tok().start);
        if (this.functionName === "toDate" && TO_DATE_ARGUMENT.test(contents))
          p.fail(`Argument of function toDate is unquoted: toDate(${contents}), must be: toDate('${contents}')`);
        if (this.allowFunctionParameters && !this.parameters && tok(p, T.OpeningRoundBracket)) {
          this.parameters = this.elements;
          this.elements = [];
          step.next = Action.Operand;
          if (this.hasDistinct) return false;
          if (!this.parseQualifiers(p, false)) return false;
        } else {
          this.state = 2;
        }
      }
    }
    if (this.state === 2) {
      if (this.hasDistinct) this.functionName += "Distinct";
      const fn = func(this.functionName, this.elements);
      if (this.parameters) fn.params = this.parameters;
      if (kw(p, "FILTER") && !parseFilterClause(p, fn)) return false;
      if (kw(p, "RESPECT NULLS") || kw(p, "IGNORE NULLS")) fn.flag("nulls");
      if (kw(p, "OVER")) {
        fn.flag("window");
        if (!parseWindowReference(p, fn)) return false;
      }
      this.elements = [fn];
      this.finished = true;
    }
    return true;
  }
}

/** Every element is a literal without alias, and nested only in the same kind of brackets. */
function allCompatibleLiterals(elements: Ast[], compound: "Array" | "Tuple"): boolean {
  return elements.every((element) => {
    if (element.kind !== "Literal" || element.alias) return false;
    const type = element.value!.t;
    return !((type === "Array" || type === "Tuple") && type !== compound);
  });
}

/** Round brackets: priority brackets or a tuple. */
class RoundBracketsLayer extends Layer {
  private isTuple = false;

  parse(p: P, step: Step): boolean {
    if (tok(p, T.Comma)) {
      step.next = Action.Operand;
      this.isTuple = true;
      if (!this.mergeElement()) return false;
    }
    if (tok(p, T.ClosingRoundBracket)) {
      step.next = Action.Operator;
      if (!this.isCurrentElementEmpty()) if (!this.mergeElement()) return false;
      if (!this.isTuple && this.elements.length === 1) {
        const only = this.elements[0]!;
        if (only.kind === "Literal" && only.value!.t === "Tuple" && !only.alias) {
          this.elements = (only.value as { v: Lit[] }).v.map((value) => literal(value));
          this.isTuple = true;
        }
        // f(x, (y) -> z) means f(x, tuple(y) -> z).
        if (p.kind() === T.Arrow) this.isTuple = true;
      }
      this.finished = true;
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    if (!this.isTuple && this.elements.length === 1) return this.elements[0]!;
    if (this.elements.length >= 2 && allCompatibleLiterals(this.elements, "Tuple"))
      return literal({ t: "Tuple", v: this.elements.map((element) => element.value!) });
    return makeOperator(op("tuple", 0, 0), this.elements);
  }
}

class ArrayLayer extends LayerWithSeparator {
  constructor() {
    super(T.Comma, T.ClosingSquareBracket);
  }

  protected override getResultImpl(): Ast | null {
    if (allCompatibleLiterals(this.elements, "Array"))
      return literal({ t: "Array", v: this.elements.map((element) => element.value!) });
    return makeOperator(op("array", 0, 0), this.elements);
  }
}

/** The [y] of x[y]: returns the one element. */
class ArrayElementLayer extends LayerWithSeparator {
  constructor() {
    super(T.Comma, T.ClosingSquareBracket);
  }
}

/** CAST(x AS T), CAST(x, 'T') and TRY_CAST. */
class CastLayer extends Layer {
  constructor(private readonly isTry = false) {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      this.peekLiteralArgument(p);
      if (kw(p, "AS")) {
        const afterAs = p.i;
        const alias = parseIdentifier(p);
        if (alias && kw(p, "AS")) {
          const type = parseDataTypeAsText(p);
          if (type !== null && tok(p, T.ClosingRoundBracket)) {
            if (!this.insertAlias(alias)) return false;
            if (!this.mergeElement()) return false;
            this.elements = [this.makeCast(this.elements[0]!, type)];
            this.finished = true;
            return true;
          }
        }
        p.restore(afterAs);
        const alias2 = parseIdentifier(p);
        if (alias2 && tok(p, T.Comma)) {
          step.next = Action.Operand;
          if (!this.insertAlias(alias2)) return false;
          if (!this.mergeElement()) return false;
          this.state = 1;
          return true;
        }
        p.restore(afterAs);
        const type = parseDataTypeAsText(p);
        if (type !== null && tok(p, T.ClosingRoundBracket)) {
          if (!this.mergeElement()) return false;
          this.elements = [this.makeCast(this.elements[0]!, type)];
          this.finished = true;
          return true;
        }
        return false;
      }
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
        return true;
      }
    }
    if (this.state === 1) {
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        if (this.elements.length !== 2) return false;
        this.elements = [func(this.isTry ? "accurateCastOrNull" : "CAST", this.elements)];
        this.finished = true;
        return true;
      }
    }
    return true;
  }

  /** rememberLiteralArgument: only looks ahead, which still counts the tokens it reads. */
  private peekLiteralArgument(p: P): void {
    if (this.elements.length || !this.isCurrentElementEmpty()) return;
    lookahead(p, () => {
      if (parseLiteralAsText(p) && p.kind() !== T.Comma) peekKwQuiet(p, "AS");
    });
  }

  private makeCast(argument: Ast, type: string): Ast {
    return func(this.isTry ? "accurateCastOrNull" : "CAST", [argument, literal({ t: "String", v: type })]);
  }
}

const INTERVAL_KINDS: [string, string[]][] = [
  ["Nanosecond", ["NANOSECOND", "NANOSECONDS", "SQL_TSI_NANOSECOND", "NS"]],
  ["Microsecond", ["MICROSECOND", "MICROSECONDS", "SQL_TSI_MICROSECOND"]],
  ["Millisecond", ["MILLISECOND", "MILLISECONDS", "SQL_TSI_MILLISECOND", "MS"]],
  ["Second", ["SECOND", "SECONDS", "SQL_TSI_SECOND", "SS", "S"]],
  ["Minute", ["MINUTE", "MINUTES", "SQL_TSI_MINUTE", "MI", "N"]],
  ["Hour", ["HOUR", "HOURS", "SQL_TSI_HOUR", "HH", "H"]],
  ["Day", ["DAY", "DAYS", "SQL_TSI_DAY", "DD", "D"]],
  ["Week", ["WEEK", "WEEKS", "SQL_TSI_WEEK", "WK", "WW"]],
  ["Month", ["MONTH", "MONTHS", "SQL_TSI_MONTH", "MM", "M"]],
  ["Quarter", ["QUARTER", "QUARTERS", "SQL_TSI_QUARTER", "QQ", "Q"]],
  ["Year", ["YEAR", "YEARS", "SQL_TSI_YEAR", "YYYY", "YY"]],
];

/** parseIntervalKind: DAY, DAYS, SQL_TSI_DAY, DD, D and so on; returns the kind or null. */
export function parseIntervalKind(p: P): string | null {
  for (const [kind, words] of INTERVAL_KINDS) for (const word of words) if (kw(p, word)) return kind;
  return null;
}

const EXTRACT_ONLY_UNITS = [
  "EPOCH", "DOW", "DOY", "ISODOW", "ISOYEAR", "CENTURY", "DECADE", "MILLENNIUM", "TIMEZONE_HOUR", "TIMEZONE_MINUTE",
];

/** EXTRACT(unit FROM expr) or extract(haystack, pattern). */
class ExtractLayer extends LayerWithSeparator {
  constructor() {
    super(T.Comma, T.ClosingRoundBracket, true, true);
  }

  override parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      const begin = p.i;
      if ((parseIntervalKind(p) !== null || EXTRACT_ONLY_UNITS.some((unit) => kw(p, unit))) && kw(p, "FROM")) {
        this.state = 2;
        return true;
      }
      this.state = 1;
      p.restore(begin);
    }
    if (this.state === 1) return super.parse(p, step);
    if (this.state === 2) {
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    if (this.state === 2) return this.elements.length ? func("extractTimePart", [this.elements[0]!]) : null;
    return func("extract", this.elements);
  }
}

const DATE_PART_UNITS = new Set([
  "nanosecond", "microsecond", "millisecond", "second", "minute", "hour", "day", "week", "month", "quarter", "year",
  "nanoseconds", "sql_tsi_nanosecond", "ns", "microseconds", "sql_tsi_microsecond", "milliseconds",
  "sql_tsi_millisecond", "ms", "seconds", "sql_tsi_second", "ss", "s", "minutes", "sql_tsi_minute", "mi", "n",
  "hours", "sql_tsi_hour", "hh", "h", "days", "sql_tsi_day", "dd", "d", "weeks", "sql_tsi_week", "wk", "ww",
  "months", "sql_tsi_month", "mm", "m", "quarters", "sql_tsi_quarter", "qq", "q", "years", "sql_tsi_year",
  "yyyy", "yy", "epoch", "dow", "doy", "isodow", "isoyear", "century", "decade", "millennium", "timezone_hour",
  "timezone_minute",
]);

/** date_part('unit', expr): the unit must be a known constant string. */
class DatePartLayer extends LayerWithSeparator {
  constructor() {
    super(T.Comma, T.ClosingRoundBracket, true, true);
  }

  protected override getResultImpl(): Ast | null {
    if (this.elements.length !== 2) return null;
    const unit = this.elements[0]!;
    if (unit.kind !== "Literal" || unit.value!.t !== "String") return null;
    if (!DATE_PART_UNITS.has(stringValue(unit)!.toLowerCase())) return null;
    return func("extractTimePart", [this.elements[1]!]);
  }
}

/** SUBSTRING(x FROM a [FOR b]) or substring(x, a, b, ...). */
class SubstringLayer extends Layer {
  private commaMode = false;
  private secondSeparatorWasComma = false;

  constructor() {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (tok(p, T.Comma)) {
        this.commaMode = true;
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
      } else if (kw(p, "FROM")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
      } else if (this.hasPendingOperator(Op.Lambda) && tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    if (this.state === 1) {
      if (tok(p, T.Comma)) {
        this.secondSeparatorWasComma = true;
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 2;
      } else if (kw(p, "FOR")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 2;
      }
    } else if (this.commaMode && this.secondSeparatorWasComma && this.state === 2) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
      }
    }
    if (this.state === 1 || this.state === 2) {
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return func("substring", this.elements);
  }
}

/** OVERLAY(x PLACING y FROM a [FOR b]) or overlay(x, y, a[, b]). */
class OverlayLayer extends Layer {
  private keywordMode = false;
  private commaMode = false;

  constructor(private readonly functionName: string) {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (!this.keywordMode && tok(p, T.Comma)) {
        this.commaMode = true;
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
      } else if (!this.commaMode && kw(p, "PLACING")) {
        this.keywordMode = true;
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
      }
    }
    if (this.state === 1) {
      if (this.commaMode && tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 2;
      } else if (this.keywordMode && kw(p, "FROM")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 2;
      }
    }
    if (this.state === 2) {
      if (this.commaMode && tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 3;
      } else if (this.keywordMode && kw(p, "FOR")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 3;
      }
    }
    if (this.commaMode && this.state === 3) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
      }
    }
    if (
      !this.finished &&
      ((this.commaMode && this.state >= 0) || (this.keywordMode && this.state >= 2) || this.state === 0) &&
      tok(p, T.ClosingRoundBracket)
    ) {
      if (!this.mergeElement()) return false;
      this.finished = true;
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return func(this.functionName, this.elements);
  }
}

/** position(haystack, needle[, start]) or position(needle IN haystack). */
class PositionLayer extends Layer {
  constructor() {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 1;
      } else if (kw(p, "IN")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.state = 2;
      } else if (this.hasPendingOperator(Op.Lambda) && tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    if (this.state === 1) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
      }
    }
    if (this.state === 1 || this.state === 2) {
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return func("position", this.elements);
  }
}

/** EXISTS(SELECT ...). */
class ExistsLayer extends Layer {
  constructor() {
    super(true, true);
  }

  parse(p: P): boolean {
    const query = parseSelectWithUnionQuery(p);
    if (!query) return false;
    if (!tok(p, T.ClosingRoundBracket)) return false;
    const subquery = new Ast("Subquery");
    subquery.children = [query];
    this.elements = [func("exists", [subquery])];
    this.finished = true;
    return true;
  }
}

/** TRIM([BOTH|LEADING|TRAILING] x FROM y), LTRIM and RTRIM. */
class TrimLayer extends Layer {
  private charOverride = false;
  private toRemove: Ast | null = null;

  constructor(
    private trimLeft: boolean,
    private trimRight: boolean,
  ) {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (!this.trimLeft && !this.trimRight) {
        if (kw(p, "BOTH")) {
          this.trimLeft = this.trimRight = this.charOverride = true;
        } else if (kw(p, "LEADING")) {
          this.trimLeft = this.charOverride = true;
        } else if (kw(p, "TRAILING")) {
          this.trimRight = this.charOverride = true;
        } else {
          this.trimLeft = this.trimRight = true;
        }
        this.state = this.charOverride ? 1 : 2;
      } else {
        this.state = 2;
      }
    }
    if (this.state === 1) {
      if (kw(p, "FROM")) {
        step.next = Action.Operand;
        if (!this.mergeElement()) return false;
        this.toRemove = this.elements[0]!;
        this.elements = [];
        this.state = 2;
      }
    }
    if (this.state === 2) {
      if (tok(p, T.Comma)) {
        step.next = Action.Operand;
        return this.mergeElement();
      }
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        if (this.charOverride && this.toRemove) this.elements.push(this.toRemove);
        this.finished = true;
      }
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    const name = this.trimLeft && this.trimRight ? "trimBoth" : this.trimLeft ? "trimLeft" : "trimRight";
    return func(name, this.elements);
  }
}

/** DATE_ADD(YEAR, 1, date), DATE_ADD(INTERVAL 1 YEAR, date) and the DATE_SUB forms. */
class DateAddLayer extends LayerWithSeparator {
  private parsedIntervalKind = false;

  constructor(private readonly functionName: string) {
    super(T.Comma, T.ClosingRoundBracket, true, true);
  }

  override parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (parseIntervalKind(p) !== null) {
        if (!tok(p, T.Comma)) return false;
        step.next = Action.Operand;
        this.parsedIntervalKind = true;
      }
      this.state = 1;
    }
    if (this.state === 1) return super.parse(p, step);
    return true;
  }

  protected override getResultImpl(): Ast | null {
    if (this.parsedIntervalKind) {
      if (this.elements.length < 2) return null;
      return func(this.functionName, [this.elements[1]!, this.elements[0]!]);
    }
    return func(this.functionName, this.elements);
  }
}

/** DATE_DIFF(unit, a, b[, tz]). */
class DateDiffLayer extends LayerWithSeparator {
  private parsedIntervalKind = false;

  constructor() {
    super(T.Comma, T.ClosingRoundBracket, true, true);
  }

  override parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      if (parseIntervalKind(p) !== null) {
        this.parsedIntervalKind = true;
        if (!tok(p, T.Comma)) return false;
      }
      this.state = 1;
    }
    if (this.state === 1) return super.parse(p, step);
    return true;
  }

  protected override getResultImpl(): Ast | null {
    if (this.parsedIntervalKind && this.elements.length !== 2 && this.elements.length !== 3) return null;
    return func("dateDiff", this.elements);
  }
}

class TupleLayer extends LayerWithSeparator {
  constructor() {
    super(T.Comma, T.ClosingRoundBracket);
  }

  override parse(p: P, step: Step): boolean {
    const result = super.parse(p, step);
    // tuple(...) cannot be followed by a lambda arrow.
    if (this.finished && p.kind() === T.Arrow) return false;
    return result;
  }

  protected override getResultImpl(): Ast | null {
    return func("tuple", this.elements);
  }
}

const COMPOUND_GROUPS: string[][] = [
  ["Year", "Month"],
  ["Day", "Hour", "Minute", "Second"],
];

const COMPOUND_SEPARATORS: Record<string, string> = { Month: "-", Hour: " ", Minute: ":", Second: ":" };
const COMPOUND_LIMITS: Record<string, number> = { Month: 11, Hour: 23, Minute: 59, Second: 59 };

/** parseCompoundIntervalString: '1:30' for HOUR TO MINUTE and the like. */
function compoundIntervalParts(text: string, from: string, to: string): number | null {
  let range: string[] | null = null;
  for (const group of COMPOUND_GROUPS) {
    const a = group.indexOf(from);
    const b = group.indexOf(to);
    if (a >= 0 && b >= 0 && a < b) {
      range = group.slice(a, b + 1);
      break;
    }
  }
  if (!range) return null;
  let i = 0;
  for (let field = 0; field < range.length; field++) {
    if (field > 0) {
      if (text[i] !== COMPOUND_SEPARATORS[range[field]!]) return null;
      i++;
    }
    if (field === 0 && (text[i] === "+" || text[i] === "-")) i++;
    const start = i;
    while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i++;
    if (i === start) return null;
    const value = BigInt(text.slice(start, i));
    if (field === 0) {
      if (value > 2n ** 63n - 1n) return null;
    } else if (value > BigInt(COMPOUND_LIMITS[range[field]!] ?? 59)) {
      return null;
    }
  }
  return i === text.length ? range.length : null;
}

/** The tokens of a string, for the parts of the parser that read inside literals. */
export function subParser(text: string): P {
  return new P(tokenize(text).filter((token) => isSignificant(token.kind)), text);
}

/** INTERVAL x KIND, INTERVAL '1 HOUR 30 MINUTE' and INTERVAL '1:30' HOUR TO MINUTE. */
class IntervalLayer extends Layer {
  constructor() {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      this.state = 1;
      const begin = p.i;
      const initExpected = p.e.copy();
      const string = parseStringLiteral(p);
      if (!string) return true;
      const text = stringValue(string)!;
      const sub = subParser(text);
      const subExpected = new Expected();
      const first = sub.quiet(() => parseNumber(sub), subExpected);
      if (!first) return this.parseCompoundTo(p, text);
      if (!sub.valid()) {
        p.restore(begin);
        p.e.assign(initExpected);
        return true;
      }
      if (sub.quiet(() => parseIntervalKind(sub), subExpected) === null) return this.parseCompoundTo(p, text);
      this.elements.push(func("toInterval"));
      while (sub.valid()) {
        const ok = sub.quiet(() => parseNumber(sub) !== null && parseIntervalKind(sub) !== null, subExpected);
        if (!ok) return false;
        this.elements.push(func("toInterval"));
      }
      this.finished = true;
      return true;
    }
    if (this.state === 1) {
      if (step.next === Action.Operator && parseIntervalKind(p) !== null) {
        if (!this.mergeElement()) return false;
        this.elements = [func("toInterval", this.elements)];
        this.finished = true;
      }
    }
    return true;
  }

  private parseCompoundTo(p: P, text: string): boolean {
    const from = parseIntervalKind(p);
    if (from === null || !kw(p, "TO")) return false;
    const to = parseIntervalKind(p);
    if (to === null) return false;
    const parts = compoundIntervalParts(text, from, to);
    if (parts === null) return false;
    for (let part = 0; part < parts; part++) this.elements.push(func("toInterval"));
    this.finished = true;
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return this.elements.length === 1 ? this.elements[0]! : func("tuple", this.elements);
  }
}

/** CASE [x] WHEN a THEN b [...] [ELSE c] END. */
class CaseLayer extends Layer {
  private hasCaseExpression = false;

  constructor() {
    super(true, true);
  }

  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      const begin = p.i;
      this.hasCaseExpression = !kw(p, "WHEN");
      p.restore(begin);
      this.state = 1;
    }
    if (this.state === 1) {
      if (kw(p, "WHEN")) {
        if ((this.hasCaseExpression || this.elements.length) && !this.mergeElement()) return false;
        step.next = Action.Operand;
        this.state = 2;
      } else if (kw(p, "ELSE")) {
        if (!this.mergeElement()) return false;
        step.next = Action.Operand;
        this.state = 3;
      } else if (kw(p, "END")) {
        if (!this.mergeElement()) return false;
        this.elements.push(literal({ t: "Null" }));
        this.elements = [func(this.hasCaseExpression ? "caseWithExpression" : "multiIf", this.elements)];
        this.finished = true;
      }
    }
    if (this.state === 2) {
      if (kw(p, "THEN")) {
        if (!this.mergeElement()) return false;
        step.next = Action.Operand;
        this.state = 1;
      }
    }
    if (this.state === 3) {
      if (kw(p, "END")) {
        if (!this.mergeElement()) return false;
        this.elements = [func(this.hasCaseExpression ? "caseWithExpression" : "multiIf", this.elements)];
        this.finished = true;
      }
    }
    return true;
  }
}

/** The table function obfuscate(SELECT ...). */
class ObfuscateLayer extends Layer {
  override getResult(): Ast | null {
    return func("obfuscate", this.elements);
  }

  parse(p: P): boolean {
    const maybeSubquery = p.kind() === T.OpeningRoundBracket;
    const query = parseSelectWithUnionQuery(p);
    if (!query) return false;
    if (query.children.length === 1 && maybeSubquery) return false;
    this.elements.push(query);
    if (!tok(p, T.ClosingRoundBracket)) return false;
    this.finished = true;
    return true;
  }
}

/** The table functions view(SELECT ...) and viewIfPermitted(SELECT ... ELSE f(...)). */
class ViewLayer extends Layer {
  constructor(private readonly ifPermitted: boolean) {
    super();
  }

  parse(p: P): boolean {
    if (this.state === 0) {
      const maybeSubquery = p.kind() === T.OpeningRoundBracket;
      const query = parseSelectWithUnionQuery(p);
      if (!query) return false;
      if (query.children.length === 1 && maybeSubquery) return false;
      this.elements.push(query);
      if (!this.ifPermitted) {
        if (!tok(p, T.ClosingRoundBracket)) return false;
        this.finished = true;
        return true;
      }
      if (!kw(p, "ELSE")) return false;
      this.state = 1;
      return true;
    }
    if (this.state === 1) {
      if (tok(p, T.ClosingRoundBracket)) {
        if (!this.mergeElement()) return false;
        this.finished = true;
      }
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return func(this.ifPermitted ? "viewIfPermitted" : "view", this.elements);
  }
}

/** The table function eval, which takes an expression or a bare SELECT. */
class EvalLayer extends Layer {
  parse(p: P, step: Step): boolean {
    if (this.state === 0) {
      this.state = 1;
      const begin = p.i;
      const savedExpected = p.e.copy();
      const query = p.quiet(() => {
        const node = parseSelectWithUnionQuery(p);
        return node && tok(p, T.ClosingRoundBracket) ? node : null;
      }, savedExpected);
      if (query) {
        p.e = savedExpected;
        const subquery = new Ast("Subquery");
        subquery.children = [query];
        this.elements = [subquery];
        this.finished = true;
        return true;
      }
      p.i = begin;
    }
    if (tok(p, T.Comma)) {
      step.next = Action.Operand;
      return this.mergeElement();
    }
    if (tok(p, T.ClosingRoundBracket)) {
      step.next = Action.Operator;
      if (!this.isCurrentElementEmpty() || this.elements.length) if (!this.mergeElement()) return false;
      this.finished = true;
    }
    return true;
  }

  protected override getResultImpl(): Ast | null {
    return func("eval", this.elements);
  }
}

function isFirstIdentifier(layers: Layer[]): boolean {
  return layers.length === 1 && layers[0] instanceof ExpressionLayer;
}

function getFunctionLayer(name: Ast, isTableFunction: boolean, isFirst: boolean, allowParameters = true): Layer {
  const functionName = identifierName(name)!;
  const lower = functionName.toLowerCase();
  if (isTableFunction) {
    if (lower === "view") return new ViewLayer(false);
    if (lower === "viewifpermitted") return new ViewLayer(true);
    if (lower === "obfuscate") return new ObfuscateLayer();
    if (lower === "eval") return new EvalLayer();
  }
  if (functionName === "tuple") return new TupleLayer();
  switch (lower) {
    case "cast":
      return new CastLayer();
    case "try_cast":
      return new CastLayer(true);
    case "extract":
      return new ExtractLayer();
    case "date_part":
    case "datepart":
      return new DatePartLayer();
    case "substring":
      return new SubstringLayer();
    case "overlay":
      return new OverlayLayer("overlay");
    case "overlayutf8":
      return new OverlayLayer("overlayUTF8");
    case "position":
      return new PositionLayer();
    case "exists":
      return new ExistsLayer();
    case "trim":
      return new TrimLayer(false, false);
    case "ltrim":
      return new TrimLayer(true, false);
    case "rtrim":
      return new TrimLayer(false, true);
    case "dateadd":
    case "date_add":
    case "timestampadd":
    case "timestamp_add":
      return new DateAddLayer("plus");
    case "datesub":
    case "date_sub":
    case "timestampsub":
    case "timestamp_sub":
      return new DateAddLayer("minus");
    case "datediff":
    case "date_diff":
    case "timestampdiff":
    case "timestamp_diff":
      return new DateDiffLayer();
    case "grouping":
      return new FunctionLayer(lower, allowParameters);
  }
  // NOT is an operator, except as the name of a table function.
  if (lower === "not" && (!isTableFunction || !isFirst)) return new FunctionLayer(lower, allowParameters);
  return new FunctionLayer(functionName, allowParameters);
}

/** ARRAY[] or ARRAY[x, y, ...]; a single ARRAY[x] is read as a subscript. */
function isArrayConstructorWithKeyword(p: P): boolean {
  let i = p.i;
  if (!p.isWord("array", i)) return false;
  i++;
  if (p.kindAt(i) !== T.OpeningSquareBracket) return false;
  i++;
  if (p.kindAt(i) === T.ClosingSquareBracket) return true;
  let depth = 0;
  for (; p.validAt(i); i++) {
    switch (p.kindAt(i)) {
      case T.OpeningRoundBracket:
      case T.OpeningSquareBracket:
      case T.OpeningCurlyBrace:
        depth++;
        break;
      case T.ClosingRoundBracket:
      case T.ClosingSquareBracket:
      case T.ClosingCurlyBrace:
        if (depth === 0) return false;
        depth--;
        break;
      case T.Comma:
        if (depth === 0) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function parseCastExpression(p: P): Ast | null {
  const cast = parseCastOperator(p);
  if (cast) return cast;
  // Negative numbers are literals rather than the negate operator.
  if (p.kind() === T.Minus) return parseLiteral(p);
  return null;
}

function parseDateOperator(p: P, keyword: string, name: string): Ast | null {
  const begin = p.i;
  if (!kw(p, keyword)) return null;
  const value = parseStringLiteral(p);
  if (!value) {
    p.restore(begin);
    return null;
  }
  return func(name, [value]);
}

/** ParserFunctionName: a compound name that is not a query parameter. */
function parseFunctionName(p: P): Ast | null {
  return base(p, "function name", () => {
    const begin = p.i;
    const node = parseCompoundIdentifier(p, false, true);
    if (!node || node.has("param")) return null;
    p.mark(begin, "function");
    return node;
  });
}

const ARRAY_QUANTIFIER_PREDICATES = new Set([
  "isDistinctFrom", "isNotDistinctFrom", "like", "ilike", "notLike", "notILike", "match", "matchCaseInsensitive",
  "notMatch", "notMatchCaseInsensitive", "similarTo", "notSimilarTo",
]);

const ESCAPE_PREDICATES = new Set(["like", "ilike", "notLike", "notILike", "similarTo", "notSimilarTo"]);

/** x = ANY|SOME|ALL (subquery) and x OP SOME|ALL (array). */
function tryParseQuantifier(top: Layer, p: P): Action | null {
  const previous = top.previousOperator();
  const isComparison = previous?.type === Op.Comparison;
  const isArrayPredicate = previous !== undefined && !isComparison && ARRAY_QUANTIFIER_PREDICATES.has(previous.name);
  if (!isComparison && !isArrayPredicate) return null;
  const begin = p.i;
  const anyKeyword = kw(p, "ANY");
  const someKeyword = !anyKeyword && kw(p, "SOME");
  const allKeyword = !anyKeyword && !someKeyword && kw(p, "ALL");
  let quantified = false;
  let isSubquery = true;
  let rhs: Ast | null = null;
  if (anyKeyword || someKeyword || allKeyword) {
    quantified = true;
    if (isComparison && (rhs = parseSubquery(p))) {
      // The subquery form, rewritten to IN or NOT IN.
    } else if ((someKeyword || allKeyword) && p.kind() === T.OpeningRoundBracket) {
      const open = p.i;
      p.i++;
      rhs = parseExpression(p);
      if (rhs && p.kind() === T.ClosingRoundBracket) {
        p.i++;
        isSubquery = false;
      } else {
        p.restore(open);
        quantified = false;
      }
    } else {
      quantified = false;
    }
  }
  if (quantified) {
    const operator = top.operators.pop();
    if (!operator) return Action.None;
    const argument = top.operands.pop();
    if (!argument) return Action.None;
    if (isSubquery) {
      const name = operator.name;
      const supported = ["equals", "notEquals", "greaterOrEquals", "greater", "lessOrEquals", "less"];
      if (!supported.includes(name)) return Action.None;
    } else if (ESCAPE_PREDICATES.has(operator.name) && peekKwQuiet(p, "ESCAPE")) {
      const escapeBegin = p.i;
      kw(p, "ESCAPE");
      if (!parseStringLiteral(p)) p.restore(escapeBegin);
    }
    top.operands.push(func(operator.name, [argument, rhs!]));
    return Action.Operator;
  }
  p.restore(begin);
  return null;
}

function tryParseOperand(layers: Layer[], p: P): Action {
  const top = layers[layers.length - 1]!;
  if (layers[0]!.isTableFunction) {
    if (top instanceof ViewLayer) {
      const name = parseFunctionName(p);
      if (name && tok(p, T.OpeningRoundBracket)) {
        layers.push(getFunctionLayer(name, layers[0]!.isTableFunction, isFirstIdentifier(layers)));
        return Action.Operand;
      }
      return Action.None;
    }
    // SETTINGS inside a table function, when the current element is empty.
    if (top.isCurrentElementEmpty()) {
      const begin = p.i;
      if (kw(p, "SETTINGS")) {
        const settings = parseSetQuery(p, true);
        if (settings) {
          top.operands.push(settings);
          return Action.Operand;
        }
        p.restore(begin);
      }
    }
  }

  if (top.previousType() !== Op.TupleElement) {
    const cast = parseCastExpression(p);
    if (cast) {
      top.operands.push(cast);
      return Action.Operator;
    }
  }

  const quantifier = tryParseQuantifier(top, p);
  if (quantifier !== null) return quantifier;

  while (p.kind() === T.Plus) p.i++;

  for (const [text, operator] of UNARY_OPERATORS) {
    if (parseOperator(p, text)) {
      top.operators.push({ ...operator });
      return Action.Operand;
    }
  }

  const begin = p.i;
  const checkpoint = top.currentCheckpoint;
  top.currentCheckpoint = Checkpoint.None;
  if (checkpoint !== Checkpoint.Interval && parseOperator(p, "INTERVAL")) {
    top.savedCheckpoint = { pos: begin, checkpoint: Checkpoint.Interval };
    layers.push(new IntervalLayer());
    return Action.Operand;
  }
  if (checkpoint !== Checkpoint.Case && parseOperator(p, "CASE")) {
    top.savedCheckpoint = { pos: begin, checkpoint: Checkpoint.Case };
    layers.push(new CaseLayer());
    return Action.Operand;
  }

  const operand =
    parseDateOperator(p, "DATE", "toDate") ??
    parseDateOperator(p, "TIMESTAMP", "toDateTime") ??
    parseTupleOfLiterals(p) ??
    parseArrayOfLiterals(p) ??
    parseNumber(p) ??
    parseLiteral(p) ??
    parseAsterisk(p) ??
    parseQualifiedAsterisk(p) ??
    parseColumnsMatcher(p) ??
    parseQualifiedColumnsMatcher(p);
  if (operand) {
    top.operands.push(operand);
    return Action.Operator;
  }

  if (isArrayConstructorWithKeyword(p)) {
    p.i += 2;
    // ClickHouse colours ARRAY as the name that an earlier attempt read it as.
    p.mark(p.i - 2, "identifier");
    layers.push(new ArrayLayer());
    return Action.Operand;
  }

  const beforeName = p.i;
  const name = parseFunctionName(p);
  if (name && p.kind() === T.OpeningRoundBracket) {
    p.i++;
    layers.push(getFunctionLayer(name, layers[0]!.isTableFunction, isFirstIdentifier(layers)));
    return Action.Operand;
  }
  p.restore(beforeName);

  const ident = parseCompoundIdentifier(p, false, true) ?? parseSubstitution(p);
  if (ident) {
    top.operands.push(ident);
    return Action.Operator;
  }
  if (p.kind() === T.OpeningRoundBracket) {
    const out = { startsValid: false };
    const subquery = parseSubquery(p, out);
    if (subquery) {
      top.operands.push(subquery);
      return Action.Operator;
    }
    // A subquery that starts with SELECT or EXPLAIN but fails later is a syntax error.
    if (out.startsValid) return Action.None;
    p.i++;
    layers.push(new RoundBracketsLayer());
    return Action.Operand;
  }
  if (p.kind() === T.OpeningSquareBracket) {
    p.i++;
    layers.push(new ArrayLayer());
    return Action.Operand;
  }
  const variable = parseMySQLGlobalVariable(p);
  if (variable) {
    top.operands.push(variable);
    return Action.Operator;
  }
  return Action.None;
}

/** Folds the operators on top of the stack with a priority above `priority`. */
function foldAbove(top: Layer, priority: number, inclusive: boolean): boolean {
  while (inclusive ? top.previousPriority() >= priority : top.previousPriority() > priority) {
    const previous = top.operators.pop()!;
    const args = top.popLastOperands(previous.arity);
    if (!args) {
      top.operators.push(previous);
      return false;
    }
    top.operands.push(makeOperator(previous, args));
  }
  return true;
}

function tryParseOperator(layers: Layer[], p: P): Action {
  let top = layers[layers.length - 1]!;
  // IN PARTITION, as in CLEAR INDEX i IN PARTITION ALL, is not the IN operator.
  if (peekKwQuiet(p, "IN PARTITION")) return Action.None;

  if (peekKwQuiet(p, "ESCAPE")) {
    foldAbove(top, 9, false);
    const previous = top.operators.pop();
    if (previous && ESCAPE_PREDICATES.has(previous.name)) {
      const begin = p.i;
      kw(p, "ESCAPE");
      if (parseStringLiteral(p)) {
        const args = top.popLastOperands(2);
        if (args) {
          top.operands.push(func(previous.name, args).flag("operator"));
          return Action.Operator;
        }
      }
      p.restore(begin);
      top.operators.push(previous);
      return Action.None;
    }
    if (previous) top.operators.push(previous);
  }

  if (peekKwQuiet(p, "AT")) {
    const begin = p.i;
    kw(p, "AT");
    if (kw(p, "LOCAL")) {
      const afterLocal = p.i;
      p.i = begin;
      while (top.previousPriority() >= 13) {
        const previous = top.operators.pop()!;
        const args = top.popLastOperands(previous.arity);
        if (!args) return Action.None;
        top.operands.push(makeOperator(previous, args));
      }
      const operand = top.operands.pop();
      if (operand) {
        p.i = afterLocal;
        top.operands.push(func("toTimeZone", [operand, func("timeZone")]).flag("operator"));
        return Action.Operator;
      }
    } else {
      p.i = begin;
    }
  }

  const saved = p.i;
  let found: Operator | undefined;
  for (const [text, operator] of OPERATORS) {
    if (parseOperator(p, text)) {
      found = { ...operator };
      break;
    }
  }
  if (!found) {
    if (!top.allowAlias || top.parsedAlias) return Action.None;
    const alias = parseAlias(p, top.allowAliasWithoutAs);
    if (!alias || !top.insertAlias(alias)) return Action.None;
    top.parsedAlias = true;
    return Action.Operator;
  }
  let current = found;

  if (current.type === Op.Lambda) {
    if (!top.parseLambda()) {
      p.restore(saved);
      return Action.None;
    }
    top.operators.push(current);
    return Action.Operand;
  }

  if (current.name === "and" && top.betweenCounter) {
    top.betweenCounter--;
    current = { ...FINISH_BETWEEN };
  }

  while (top.previousPriority() >= current.priority) {
    const previous = top.operators.pop()!;
    if (previous.type === Op.Mergeable && current.name === previous.name) {
      current.arity += previous.arity - 1;
      break;
    }
    let fn: Ast;
    if (previous.type === Op.FinishBetween) {
      const start = top.operators.pop();
      if (!start) return Action.None;
      if (start.type !== Op.StartBetween && start.type !== Op.StartNotBetween) return Action.None;
      const args = top.popLastOperands(3);
      if (!args) return Action.None;
      fn = makeBetween(start.type === Op.StartNotBetween, args);
    } else {
      const args = top.popLastOperands(previous.arity);
      if (!args) return Action.None;
      fn = makeOperator(previous, args);
    }
    top.operands.push(fn);
  }

  // A dot can start x.* or x.COLUMNS(...).
  if (current.type === Op.TupleElement) {
    const matcher = parseAsterisk(p) ?? parseColumnsMatcher(p);
    if (matcher) {
      if (!top.operands.pop()) return Action.None;
      top.operands.push(matcher);
      return Action.Operator;
    }
    const name = parseIdentifier(p);
    if (name) {
      top.operators.push(current);
      top.operands.push(literal({ t: "String", v: name.name }));
      return Action.Operator;
    }
  }

  if (current.type === Op.IsNull) {
    const args = top.popLastOperands(1);
    if (!args) return Action.None;
    top.operands.push(makeOperator(current, args));
    return Action.Operator;
  }
  if (current.type === Op.IsTruthValue) {
    const argument = top.operands.pop();
    if (!argument) return Action.None;
    const fn = makeTruthValuePredicate(current.name, argument);
    if (!fn) return Action.None;
    top.operands.push(fn);
    return Action.Operator;
  }
  top.operators.push(current);

  if (current.type === Op.Cast) {
    const type = parseDataTypeAsText(p);
    if (type === null) return Action.None;
    const argument = top.operands.pop();
    if (!argument) return Action.None;
    top.operands.push(argument);
    top.operands.push(literal({ t: "String", v: type }));
    return Action.Operator;
  }
  if (current.type === Op.ArrayElement) {
    layers.push(new ArrayElementLayer());
    top = layers[layers.length - 1]!;
  }
  if (current.type === Op.StartBetween || current.type === Op.StartNotBetween) top.betweenCounter++;
  return Action.Operand;
}

/** ParserExpressionImpl::parse: the main loop over layers. */
function parseLayers(p: P, start: Layer): Ast | null {
  const step: Step = { next: Action.Operand };
  const layers: Layer[] = [start];
  for (;;) {
    while (p.valid()) {
      const top = layers[layers.length - 1]!;
      if (!top.parse(p, step)) break;
      if (top.finished) {
        if (layers.length === 1) break;
        step.next = Action.Operator;
        const result = top.getResult();
        if (!result) break;
        layers.pop();
        layers[layers.length - 1]!.operands.push(result);
        continue;
      }
      step.next = step.next === Action.Operand ? tryParseOperand(layers, p) : tryParseOperator(layers, p);
      if (step.next === Action.None) break;
    }
    if (layers.length === 1) {
      const node = layers[0]!.getResult();
      if (node) return node;
    }
    layers.pop();
    while (layers.length && !layers[layers.length - 1]!.savedCheckpoint) layers.pop();
    if (!layers.length) return null;
    step.next = Action.Operand;
    const top = layers[layers.length - 1]!;
    const saved = top.savedCheckpoint!;
    top.savedCheckpoint = null;
    p.restore(saved.pos);
    top.currentCheckpoint = saved.checkpoint;
  }
}

/** ParserExpression: any expression, including lambdas. */
export function parseExpression(p: P, allowTrailingCommas = false): Ast | null {
  return base(p, "lambda expression", () => parseLayers(p, new ExpressionLayer(false, allowTrailingCommas)));
}

/** ParserTableFunctionExpression: an argument of a table function. */
export function parseTableFunctionExpression(p: P): Ast | null {
  return base(p, "table function expression", () => parseLayers(p, new ExpressionLayer(true)));
}

/** ParserArray: [x, y]. */
export function parseArray(p: P): Ast | null {
  return base(p, "array", () => (tok(p, T.OpeningSquareBracket) ? parseLayers(p, new ArrayLayer()) : null));
}

/** ParserFunction: f(args), with parameters f(p)(args) if allowed. */
export function parseFunction(p: P, allowParameters = true, isTableFunction = false): Ast | null {
  return base(p, "function", () => {
    const name = parseFunctionName(p);
    if (!name || !tok(p, T.OpeningRoundBracket)) return null;
    const start = getFunctionLayer(name, isTableFunction, true, allowParameters);
    start.isTableFunction = isTableFunction;
    return parseLayers(p, start);
  });
}

/** ParserExpressionWithOptionalArguments: f(args) or just f. */
export function parseExpressionWithOptionalArguments(p: P): Ast | null {
  return base(p, "expression with optional parameters", () => {
    const fn = parseFunction(p, false, false);
    if (fn) return fn;
    const name = parseIdentifier(p);
    return name ? func(name.name) : null;
  });
}

/** ParserLeftAssociativeBinaryOperatorList, for the few places that still use it. */
export function parseLeftAssociativeOperators(p: P, operators: [string, string][], element: () => Ast | null): Ast | null {
  return base(p, "list, delimited by binary operators", () => {
    const depth = p.depth;
    let node = element();
    if (!node) return null;
    for (;;) {
      const found = operators.find(([text]) => parseOperator(p, text));
      if (!found) break;
      const right = element();
      if (!right) return null;
      node = func(found[1], [node, right]);
      if (found[0] === "[") {
        if (p.kind() !== T.ClosingSquareBracket) return null;
        p.i++;
      }
      p.increaseDepth();
    }
    p.depth = depth;
    return node;
  });
}

/** ParserExpressionWithOptionalAlias. */
export function parseExpressionWithOptionalAlias(
  p: P,
  allowWithoutAs: boolean,
  isTableFunction = false,
  allowTrailingCommas = false,
): Ast | null {
  return base(p, "expression with optional alias", () =>
    parseWithOptionalAlias(
      p,
      () => (isTableFunction ? parseTableFunctionExpression(p) : parseExpression(p, allowTrailingCommas)),
      allowWithoutAs,
    ),
  );
}

/** ParserExpressionList: a comma-separated list of expressions, possibly empty. */
export function parseExpressionList(
  p: P,
  allowWithoutAs: boolean,
  isTableFunction = false,
  allowTrailingCommas = false,
): Ast | null {
  return base(p, "list of expressions", () =>
    parseList(p, () => parseExpressionWithOptionalAlias(p, allowWithoutAs, isTableFunction, allowTrailingCommas)),
  );
}

/** ParserNotEmptyExpressionList. */
export function parseNotEmptyExpressionList(p: P, allowWithoutAs: boolean, allowTrailingCommas = false): Ast | null {
  return base(p, "not empty list of expressions", () => {
    const node = parseExpressionList(p, allowWithoutAs, false, allowTrailingCommas);
    return node && node.children.length ? node : null;
  });
}

export function parseStorageOrderByExpressionList(p: P, allowOrder: boolean): Ast | null {
  return base(p, "storage order by expression", () =>
    parseList(p, () => parseStorageOrderByElement(p, allowOrder), undefined, false),
  );
}

export function parseOrderByExpressionList(p: P): Ast | null {
  return base(p, "order by expression", () => parseList(p, () => parseOrderByElement(p), undefined, false));
}

export function parseAliasesExpressionList(p: P): Ast | null {
  return base(p, "list of aliases expressions", () => parseList(p, () => parseIdentifier(p), undefined, false));
}

/** GROUPING SETS ((a, b), c, ()). */
export function parseGroupingSetsExpressionList(p: P): Ast | null {
  return base(p, "grouping sets expression", () =>
    base(p, "grouping sets expression elements", () => {
      const sets: Ast[] = [];
      do {
        const begin = p.i;
        let set: Ast | null;
        if (!tok(p, T.OpeningRoundBracket)) {
          p.restore(begin);
          set = parseExpressionWithOptionalAlias(p, false);
          if (!set) return null;
        } else {
          set = parseList(p, () => parseExpressionWithOptionalAlias(p, false), undefined, true);
          if (!set) return null;
          if (!tok(p, T.ClosingRoundBracket)) break;
        }
        sets.push(set);
      } while (tok(p, T.Comma));
      return list(sets);
    }),
  );
}

export function parseInterpolateExpressionList(p: P): Ast | null {
  return base(p, "interpolate expression", () => parseList(p, () => parseInterpolateElement(p), undefined, true));
}

export function parseTTLExpressionList(p: P): Ast | null {
  return base(p, "ttl expression list", () => parseList(p, () => parseTTLElement(p), undefined, false));
}

/** ParserKeyValuePair: key value, where the value may be a nested (list of pairs). */
function parseKeyValuePair(p: P): Ast | null {
  return base(p, "key-value pair", () => {
    const key = parseIdentifier(p);
    if (!key) return null;
    let value =
      parseFunction(p) ??
      parseLiteral(p) ??
      (p.kind() === T.OpeningSquareBracket ? parseAllCollectionsOfLiterals(p, false) : null) ??
      parseIdentifier(p);
    if (!value) {
      if (!tok(p, T.OpeningRoundBracket)) return null;
      value = parseKeyValuePairsList(p);
      if (!value) return null;
      if (!tok(p, T.ClosingRoundBracket)) return null;
    }
    const pair = new Ast("Pair");
    pair.name = key.name.toLowerCase();
    pair.children = [value];
    return pair;
  });
}

/** ParserKeyValuePairsList: pairs separated by nothing. */
export function parseKeyValuePairsList(p: P): Ast | null {
  return base(p, "list of pairs", () =>
    parseList(
      p,
      () => parseKeyValuePair(p),
      () => base(p, "nothing", () => true) !== null,
      true,
    ),
  );
}

/**
 * Whether the brackets at `open` hold an expression over a column named `from`
 * rather than a FROM-first subquery. Does not move the position.
 */
export function parenthesesHoldExpressionOverColumnNamedFrom(p: P, open: number): boolean {
  return lookahead(
    p,
    () => {
      let i = open;
      if (p.kindAt(i) !== T.OpeningRoundBracket) return false;
      i++;
      const contents = i;
      if (!p.isWord("from", i)) return false;
      i++;
      let operatorFollows = false;
      for (const [text] of OPERATORS) {
        p.i = i;
        if (parseOperator(p, text)) {
          operatorFollows = true;
          break;
        }
      }
      if (!operatorFollows) return false;
      p.i = contents;
      return parseExpressionList(p, false) !== null && p.kind() === T.ClosingRoundBracket;
    },
    new Expected(),
  );
}

