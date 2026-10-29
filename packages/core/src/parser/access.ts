/**
 * Access management: users, roles, quotas, row and masking policies, settings profiles and tokens,
 * GRANT and REVOKE, SET ROLE, SHOW of access entities, DROP and MOVE of them, and EXECUTE AS.
 * Ports of src/Parsers/Access/*.cpp.
 */
import { parseStringAndSubstitution } from "./alter.js";
import { Ast, isParam, stringValue } from "./ast.js";
import {
  parseCluster,
  parseDatabaseAndTableName,
  parseDatabaseAndTableNameOrAsterisks,
  parseIdentifierOrStringLiteral,
  parseIdentifiersOrStringLiterals,
} from "./common.js";
import {
  parseAssignment,
  parseCompoundIdentifier,
  parseIdentifier,
  parseList,
  parseLiteral,
  parseNumber,
  parseStringLiteral,
  parseUnsignedInteger,
} from "./elements.js";
import { parseExpression, parseIntervalKind, subParser } from "./expression.js";
import { ACCESS_TYPE_KEYWORDS, PARAMETER_ACCESS_TYPES, SOURCE_ACCESS_TYPES, SOURCE_NAMES } from "./privileges.js";
import { attempt, base, kw, listUtil, P, peekKw, T, tok } from "./state.js";

/** [ON CLUSTER c], moving back if ON is not followed by a cluster. */
function parseOnCluster(p: P): boolean {
  return attempt(p, () => kw(p, "ON") && parseCluster(p)) !== null;
}

/** parseAccessStorageName: the name of an access storage after IN, FROM or TO. */
function parseAccessStorageName(p: P): boolean {
  return parseIdentifierOrStringLiteral(p) !== null;
}

/** atQueryOutputTail: FORMAT, SETTINGS, INTO OUTFILE or PARALLEL WITH follow, not a name. */
function atQueryOutputTail(p: P): boolean {
  return peekKw(p, "FORMAT") || peekKw(p, "SETTINGS") || peekKw(p, "INTO OUTFILE") || peekKw(p, "PARALLEL WITH");
}

// --- User names --------------------------------------------------------------------------------

/** parseUserNameWithHost: name, name@host, 'name' or 'name@host'; the node has the flag "param" for {x:Identifier}. */
function parseUserNameWithHostBody(p: P, allowParam: boolean): Ast | null {
  return attempt(p, () => {
    const name = parseIdentifier(p, allowParam);
    if (name) {
      if (tok(p, T.At)) {
        const host = parseIdentifierOrStringLiteral(p);
        if (host === null || host === "") return null;
      }
      return new Ast("UserName").flag("param", isParam(name));
    }
    const literal = parseStringLiteral(p);
    if (!literal) return null;
    const text = stringValue(literal)!;
    if (text === "") return null;
    const inner = subParser(text);
    const param = inner.quiet(() => parseIdentifier(inner, true));
    if (param && isParam(param))
      p.failOther(
        "String literals don't support query parameters substitution, remove single quotes surrounding the query parameter",
        p.i - 1,
      );
    return new Ast("UserName");
  });
}

/** ParserUserNameWithHost. */
export function parseUserNameWithHost(p: P, allowParam = false): Ast | null {
  return base(p, "UserNameWithHost", () => parseUserNameWithHostBody(p, allowParam));
}

/** ParserUserNamesWithHost: a non-empty list of user names; returns how many there are. */
export function parseUserNamesWithHost(p: P, allowParam = false): number | null {
  let count = 0;
  const name = () => {
    if (!parseUserNameWithHostBody(p, allowParam)) return false;
    count++;
    return true;
  };
  const ok = base(p, "UserNamesWithHost", () => listUtil(p, name, undefined, false));
  return ok ? count : null;
}

/** parseCurrentUserTag: CURRENT_USER, CURRENTUSER, with optional (). */
function parseCurrentUserTag(p: P): boolean {
  return (
    attempt(p, () => {
      if (!kw(p, "CURRENTUSER") && !kw(p, "CURRENT_USER")) return false;
      return !tok(p, T.OpeningRoundBracket) || tok(p, T.ClosingRoundBracket);
    }) !== null
  );
}

// --- Sets of roles or users ----------------------------------------------------------------------

interface RolesOptions {
  all?: boolean;
  any?: boolean;
  currentUser?: boolean;
  idMode?: boolean;
  params?: boolean;
}

/** A name, or ID('...') in ID mode. */
function parseNameOrId(p: P, options: RolesOptions): Ast | null {
  if (!options.idMode) return parseUserNameWithHost(p, options.params);
  return attempt(p, () => {
    if (!kw(p, "ID") || !tok(p, T.OpeningRoundBracket) || !parseStringLiteral(p)) return null;
    return tok(p, T.ClosingRoundBracket) ? new Ast("UserName") : null;
  });
}

/** The list before EXCEPT: names, NONE, ALL, ANY and CURRENT_USER as the options allow. */
function parseRolesBeforeExcept(p: P, options: RolesOptions): { all: boolean; params: boolean } | null {
  let all = false;
  let params = false;
  const element = () => {
    if (kw(p, "NONE")) return true;
    if (options.all && kw(p, "ALL")) return (all = true);
    if (options.any && kw(p, "ANY")) return (all = true);
    if (options.currentUser && parseCurrentUserTag(p)) return true;
    const name = parseNameOrId(p, options);
    if (name?.has("param")) params = true;
    return name !== null;
  };
  return listUtil(p, element, undefined, false) ? { all, params } : null;
}

/** ParserRolesOrUsersSet: role, user, ..., ALL, ANY, NONE, CURRENT_USER [EXCEPT ...]. */
function parseRolesOrUsersSet(p: P, options: RolesOptions): Ast | null {
  return base(p, "RolesOrUsersSet", () => {
    const before = parseRolesBeforeExcept(p, options);
    if (!before) return null;
    attempt(p, () => kw(p, "EXCEPT") && parseRolesBeforeExcept(p, { ...options, all: false, any: false }));
    // ALL with a name that is a query parameter cannot be formatted back.
    if (before.all && before.params) return null;
    return new Ast("RolesOrUsersSet");
  });
}

/** TO roles, as in CREATE QUOTA ... TO r1, r2. */
function parseToRoles(p: P): boolean {
  return (
    attempt(
      p,
      () => kw(p, "TO") && parseRolesOrUsersSet(p, { all: true, currentUser: true }) !== null,
    ) !== null
  );
}

// --- Row policy names ----------------------------------------------------------------------------

/** [db.]table or db.* of a row policy, with ON CLUSTER left for the caller. */
function parseRowPolicyTable(p: P): boolean {
  return (
    attempt(p, () => {
      const name = parseDatabaseAndTableNameOrAsterisks(p);
      if (!name || name.wildcard || (!name.database && !name.table && !name.defaultDatabase)) return false;
      const end = p.i;
      if (!name.database && kw(p, "ON")) {
        if (!parseCluster(p)) return false;
        p.restore(end);
      }
      return true;
    }) !== null
  );
}

/** ON table or ON table, table, ...; returns how many tables there are. */
function parseOnRowPolicyTables(p: P, multiple: boolean): number {
  let count = 0;
  const table = () => {
    if (!parseRowPolicyTable(p)) return false;
    count++;
    return true;
  };
  const ok = attempt(p, () => kw(p, "ON") && (multiple ? listUtil(p, table, undefined, false) : table()));
  return ok ? count : 0;
}

/** parseRowPolicyNamesAroundON: name[, name] [ON CLUSTER c] ON table[, table] [ON CLUSTER c]. */
function parseRowPolicyNamesAroundOn(
  p: P,
  multipleNames: boolean,
  multipleTables: boolean,
  onCluster: boolean,
): { count: number; cluster: boolean } | null {
  return attempt(p, () => {
    const names = multipleNames ? parseIdentifiersOrStringLiterals(p) : parseIdentifierOrStringLiteral(p) === null ? null : [""];
    if (!names) return null;
    let cluster = onCluster && parseOnCluster(p);
    const tables = parseOnRowPolicyTables(p, multipleTables && names.length === 1);
    if (!tables) return null;
    if (onCluster && !cluster) cluster = parseOnCluster(p);
    return { count: names.length * tables, cluster };
  });
}

/** ParserRowPolicyNames; returns whether an ON CLUSTER clause was read. Its Expected name is ClickHouse's. */
function parseRowPolicyNames(p: P, onCluster: boolean): { cluster: boolean; count: number } | null {
  let count = 0;
  let lastAdded = 0;
  let cluster = false;
  const ok = base(p, "SettingsProfileElements", () => {
    const element = () => {
      if (count && (lastAdded !== 1 || cluster)) return false;
      const names = parseRowPolicyNamesAroundOn(p, count === 0, count === 0, onCluster);
      if (!names) return false;
      lastAdded = names.count;
      count += names.count;
      cluster ||= names.cluster;
      return true;
    };
    return listUtil(p, element, undefined, false);
  });
  return ok ? { cluster, count } : null;
}

// --- Settings profile elements -------------------------------------------------------------------

/** A profile name, or ID('...') in ID mode. */
function parseProfileNameOrId(p: P, idMode: boolean): boolean {
  return (
    attempt(p, () => {
      if (!idMode) return parseIdentifierOrStringLiteral(p) !== null;
      return kw(p, "ID") && tok(p, T.OpeningRoundBracket) && parseStringLiteral(p) !== null && tok(p, T.ClosingRoundBracket);
    }) !== null
  );
}

/** name [= value] [MIN [=] x] [MAX [=] y] [READONLY|CONST|WRITABLE|CHANGEABLE_IN_READONLY], with at least one of them. */
function parseSettingNameWithValueOrConstraints(p: P): boolean {
  return (
    attempt(p, () => {
      const name = parseCompoundIdentifier(p);
      if (!name) return false;
      let value = false;
      let range = false;
      let writability = "";
      for (;;) {
        if (attempt(p, () => tok(p, T.Equals) && parseLiteral(p) !== null)) {
          value = true;
        } else if (
          attempt(p, () => {
            if (!kw(p, "MIN") && !kw(p, "MAX")) return false;
            tok(p, T.Equals);
            return parseLiteral(p) !== null;
          })
        ) {
          range = true;
        } else {
          const keyword = attempt(p, () =>
            kw(p, "READONLY") || kw(p, "CONST") ? "CONST" : kw(p, "WRITABLE") || kw(p, "CHANGEABLE_IN_READONLY") ? "OTHER" : null,
          );
          if (!keyword) break;
          writability = keyword;
        }
      }
      if (!value && !range && !writability) return false;
      // PROFILE READONLY is not a setting named PROFILE.
      return !(name.name.toUpperCase() === "PROFILE" && !value && !range && writability === "CONST");
    }) !== null
  );
}

/** parseSettingsProfileElements: [SETTINGS] name = value, PROFILE 'p', [INHERIT] 'p', NONE, ... */
function parseSettingsProfileElementList(p: P, idMode: boolean, inherit: boolean): boolean {
  let count = 0;
  let foundNone = false;
  let expectProfiles = false;
  let expectSettings = false;
  const element = () => {
    if (kw(p, "SETTINGS") || kw(p, "SETTING")) expectSettings = true;
    const settingsNext = expectSettings;
    if (kw(p, "PROFILES") || kw(p, "PROFILE")) {
      expectProfiles = true;
      expectSettings = false;
    } else if (inherit && kw(p, "INHERIT")) {
      if (!kw(p, "PROFILES")) kw(p, "PROFILE");
      expectProfiles = true;
      expectSettings = false;
    }
    if (!expectProfiles && !expectSettings) return false;
    if (kw(p, "NONE")) {
      foundNone = true;
      expectSettings = settingsNext;
      return true;
    }
    if (expectSettings && parseSettingNameWithValueOrConstraints(p)) {
      count++;
      expectProfiles = false;
      expectSettings = settingsNext;
      return true;
    }
    if (expectProfiles && parseProfileNameOrId(p, idMode)) {
      count++;
      expectSettings = settingsNext;
      return true;
    }
    return false;
  };
  if (!listUtil(p, element, undefined, false)) return false;
  return count > 0 || foundNone;
}

/** ParserSettingsProfileElements. */
function parseSettingsProfileElements(p: P, idMode = false, inherit = false): boolean {
  return attempt(p, () => base(p, "SettingsProfileElements", () => parseSettingsProfileElementList(p, idMode, inherit))) !== null;
}

/** ParserAlterSettingsProfileElements: the list of CREATE, or ADD|MODIFY|DROP|SET of settings and profiles. */
function parseAlterSettingsProfileElements(p: P, inherit = false): boolean {
  const body = () => {
    if (parseSettingsProfileElementList(p, false, inherit)) return true;
    let action = "";
    let target = "";
    let added = 0;
    let modified = 0;
    let dropped = 0;
    let dropAllProfiles = false;
    let dropAllSettings = false;
    const element = () => {
      if (kw(p, "ADD")) {
        action = "ADD";
        target = "";
      } else if (kw(p, "DROP")) {
        if (added || modified) return false;
        action = "DROP";
        target = "";
      } else if (kw(p, "MODIFY")) {
        action = "MODIFY";
        target = "";
      } else if (kw(p, "SET")) {
        action = "MODIFY";
        target = "SETTINGS";
      }
      if (action) {
        if (kw(p, "ALL PROFILES")) target = "ALL PROFILES";
        else if (kw(p, "ALL SETTINGS")) target = "ALL SETTINGS";
        else if (kw(p, "PROFILES") || kw(p, "PROFILE")) target = "PROFILES";
        else if (kw(p, "SETTINGS") || kw(p, "SETTING")) target = "SETTINGS";
      }
      if (!target) return false;
      if (target === "PROFILES") {
        if (!parseProfileNameOrId(p, false)) return false;
        if (action === "ADD") added++;
        else if (action === "DROP") dropped++;
        else return false;
        return true;
      }
      if (target === "SETTINGS") {
        if (action === "ADD" || action === "MODIFY") {
          if (!parseSettingNameWithValueOrConstraints(p)) return false;
          if (action === "ADD") added++;
          else modified++;
          return true;
        }
        if (action !== "DROP" || !parseCompoundIdentifier(p)) return false;
        dropped++;
        return true;
      }
      if (action === "DROP" && target === "ALL PROFILES" && !dropAllProfiles) return (dropAllProfiles = true);
      if (action === "DROP" && target === "ALL SETTINGS" && !dropAllSettings) return (dropAllSettings = true);
      return false;
    };
    if (!listUtil(p, element, undefined, false)) return false;
    return added + modified + dropped > 0 || dropAllProfiles || dropAllSettings;
  };
  return attempt(p, () => base(p, "AlterSettingsProfileElements", body)) !== null;
}

// --- Access rights -------------------------------------------------------------------------------

/** parseAccessFlags: the words of an access type, like SELECT or ALTER UPDATE; returns its keyword. */
function parseAccessFlags(p: P): string | null {
  p.expect("access type");
  const isAccessWord = () => p.kind() === T.BareWord && !["on", "to", "from"].includes(p.lower());
  return attempt(p, () => {
    if (!isAccessWord()) return null;
    const begin = p.i;
    const words: string[] = [];
    do {
      words.push(p.text());
      p.i++;
    } while (isAccessWord());
    p.mark(begin, "keyword");
    const text = words.join(" ");
    if (ACCESS_TYPE_KEYWORDS.has(text)) return text;
    const upper = text.toUpperCase();
    return ACCESS_TYPE_KEYWORDS.has(upper) ? upper : null;
  });
}

/** (column, ...) after an access type. */
function parseColumnNames(p: P): boolean {
  return (
    attempt(
      p,
      () =>
        tok(p, T.OpeningRoundBracket) &&
        parseList(p, () => parseIdentifier(p), undefined, false) !== null &&
        tok(p, T.ClosingRoundBracket),
    ) !== null
  );
}

/** ('regexp') after the parameter of NAMED COLLECTION, READ and the like; "" when there is none. */
function parseParameterRegExp(p: P): string | null {
  return attempt(p, () => {
    if (!tok(p, T.OpeningRoundBracket)) return "";
    const filter = parseIdentifierOrStringLiteral(p);
    if (filter === null || !tok(p, T.ClosingRoundBracket)) return null;
    return filter;
  });
}

/** access types ON what: a table, *.*, db.*, or a parameter for the global privileges that take one. */
function parseAccessRightsAroundOn(p: P): boolean {
  const flags: { keyword: string; columns: boolean }[] = [];
  const parsedFlags = listUtil(
    p,
    () => {
      const keyword = parseAccessFlags(p);
      if (!keyword) return false;
      flags.push({ keyword, columns: parseColumnNames(p) });
      return true;
    },
    undefined,
    false,
  );
  if (!parsedFlags) return false;
  const withParameter = flags.filter((flag) => PARAMETER_ACCESS_TYPES.has(flag.keyword)).length;
  if (!kw(p, "ON")) return false;
  let wildcard = false;
  let table = "";
  if (withParameter && withParameter === flags.length) {
    let parameter = "";
    if (tok(p, T.Asterisk)) {
      tok(p, T.Dot);
      tok(p, T.Asterisk);
    } else {
      const name = parseIdentifier(p);
      if (!name) return false;
      parameter = name.name;
    }
    for (const flag of flags) {
      if (SOURCE_ACCESS_TYPES.has(flag.keyword) && !SOURCE_NAMES.includes(parameter)) {
        for (const source of SOURCE_NAMES) p.expect(source);
        return false;
      }
    }
    if (tok(p, T.Asterisk)) wildcard = true;
    const filter = parseParameterRegExp(p);
    if (filter === null) return false;
    if ((wildcard || !parameter) && filter) return false;
  } else {
    const name = parseDatabaseAndTableNameOrAsterisks(p);
    if (!name) return false;
    wildcard = name.wildcard;
    table = name.table;
  }
  return !flags.some((flag) => (wildcard || !table) && flag.columns);
}

/** parseAccessRightsElementsWithoutOptions: SELECT(a) ON db.t, INSERT ON *.*, ... */
function parseAccessRightsElements(p: P): boolean {
  return attempt(p, () => listUtil(p, () => parseAccessRightsAroundOn(p), undefined, false)) !== null;
}

// --- Authentication ------------------------------------------------------------------------------

/** VALID UNTIL 'time' or VALID FOR interval; IN after the interval is left for the storage clause. */
function parseAuthenticationValidUntil(p: P): boolean {
  return (
    attempt(p, () => {
      if (kw(p, "VALID UNTIL")) return parseStringAndSubstitution(p) !== null;
      if (!kw(p, "VALID FOR")) return false;
      const interval = parseExpression(p);
      if (!interval) return false;
      if (interval.kind === "Function" && interval.name === "in" && interval.children.length === 2) {
        const storage = interval.children[1]!;
        const isStorageName =
          (storage.kind === "Identifier" && storage.parts?.length === 1) ||
          (storage.kind === "Literal" && storage.value?.t === "String");
        if (isStorageName) {
          const end = p.i;
          p.restore(p.i - 2);
          if (!peekKw(p, "IN")) p.i = end;
        }
      }
      return true;
    }) !== null
  );
}

/** GRANTS (access rights) of an authentication method or a token. */
function parseAuthenticationGrants(p: P): boolean {
  return (
    attempt(p, () => kw(p, "GRANTS") && tok(p, T.OpeningRoundBracket) && parseAccessRightsElements(p) && tok(p, T.ClosingRoundBracket)) !== null
  );
}

/** AuthenticationType keywords in enum order. */
const AUTHENTICATION_TYPES = [
  "NO_PASSWORD", "PLAINTEXT_PASSWORD", "SHA256_PASSWORD", "DOUBLE_SHA1_PASSWORD", "LDAP", "KERBEROS", "SSL_CERTIFICATE",
  "BCRYPT_PASSWORD", "SSH_KEY", "HTTP", "JWT", "SCRAM_SHA256_PASSWORD", "NO_AUTHENTICATION",
];

const HASH_TYPES: [string, string][] = [
  ["SHA256_HASH", "SHA256_PASSWORD"],
  ["SCRAM_SHA256_HASH", "SCRAM_SHA256_PASSWORD"],
  ["DOUBLE_SHA1_HASH", "DOUBLE_SHA1_PASSWORD"],
  ["BCRYPT_HASH", "BCRYPT_PASSWORD"],
];

/** ParserPublicSSHKey: KEY 'base64' TYPE 'ssh-rsa'. */
function parsePublicSSHKey(p: P): Ast | null {
  return base(p, "PublicSSHKey", () =>
    attempt(
      p,
      () =>
        kw(p, "KEY") && parseIdentifierOrStringLiteral(p) !== null && kw(p, "TYPE") && parseIdentifierOrStringLiteral(p) !== null,
    ) ? new Ast("PublicSSHKey") : null,
  );
}

/** parseAuthenticationData: [type] BY 'password', SERVER 'ldap', CN 'name', BY KEY ..., then VALID UNTIL and GRANTS. */
function parseAuthenticationData(p: P, typeMandatory: boolean, typeAllowed: boolean, noPassword: boolean): boolean {
  return (
    attempt(p, () => {
      let type = (noPassword ? AUTHENTICATION_TYPES : AUTHENTICATION_TYPES.slice(1)).find((name) => kw(p, name));
      if (type === "JWT") p.failOther("CREATE USER is not supported for JWT");
      let hash = false;
      if (!type) {
        const found = HASH_TYPES.find(([keyword]) => kw(p, keyword));
        if (found) {
          type = found[1];
          hash = true;
        } else if (typeMandatory) {
          return false;
        }
      } else if (!typeAllowed) {
        return false;
      }
      const password = !type || !["NO_AUTHENTICATION", "LDAP", "KERBEROS", "SSL_CERTIFICATE", "SSH_KEY", "HTTP", "NO_PASSWORD"].includes(type);
      if (password || hash) {
        if (!kw(p, "BY") || !parseStringAndSubstitution(p)) return false;
        if (hash && (type === "SHA256_PASSWORD" || type === "SCRAM_SHA256_PASSWORD") && kw(p, "SALT") && !parseStringAndSubstitution(p))
          return false;
      } else if (type === "LDAP") {
        if (!kw(p, "SERVER") || !parseStringAndSubstitution(p)) return false;
      } else if (type === "KERBEROS") {
        if (kw(p, "REALM") && !parseStringAndSubstitution(p)) return false;
      } else if (type === "SSL_CERTIFICATE") {
        if (!kw(p, "CN") && !kw(p, "SAN")) return false;
        if (!parseList(p, () => parseStringAndSubstitution(p), undefined, false)) return false;
      } else if (type === "SSH_KEY") {
        if (!kw(p, "BY")) return false;
        if (!parseList(p, () => parsePublicSSHKey(p), undefined, false)) return false;
      } else if (type === "HTTP") {
        if (!kw(p, "SERVER") || !parseStringAndSubstitution(p)) return false;
        if (kw(p, "SCHEME") && !parseStringAndSubstitution(p)) return false;
      }
      parseAuthenticationValidUntil(p);
      parseAuthenticationGrants(p);
      return true;
    }) !== null
  );
}

/** IDENTIFIED [WITH type] BY ..., more methods after commas. */
function parseIdentifiedWith(p: P, noPassword: boolean): boolean {
  return (
    attempt(p, () => {
      if (!kw(p, "IDENTIFIED")) return false;
      const mandatory = kw(p, "WITH");
      if (!parseAuthenticationData(p, mandatory, mandatory, noPassword)) return false;
      for (;;) {
        const before = p.i;
        if (!tok(p, T.Comma)) break;
        if (!parseAuthenticationData(p, false, true, noPassword)) {
          p.restore(before);
          break;
        }
      }
      return true;
    }) !== null
  );
}

/** NOT IDENTIFIED [VALID UNTIL ...] [GRANTS (...)] or IDENTIFIED ... */
function parseIdentifiedOrNotIdentified(p: P): boolean {
  return (
    attempt(p, () => {
      if (kw(p, "NOT IDENTIFIED")) {
        parseAuthenticationValidUntil(p);
        parseAuthenticationGrants(p);
        return true;
      }
      return parseIdentifiedWith(p, true);
    }) !== null
  );
}

/** [ADD|DROP] HOST ANY | NONE | LOCAL | NAME 'n' | REGEXP 'r' | IP 'a' | LIKE 'p', ... */
function parseHosts(p: P, prefix: string): boolean {
  const host = () => {
    if (kw(p, "NONE") || kw(p, "ANY") || kw(p, "LOCAL")) return true;
    if (kw(p, "REGEXP") || kw(p, "NAME") || kw(p, "IP") || kw(p, "LIKE"))
      return parseList(p, () => parseStringLiteral(p), undefined, false) !== null;
    return false;
  };
  return (
    attempt(p, () => {
      if (prefix && !kw(p, prefix)) return false;
      return kw(p, "HOST") && listUtil(p, host, undefined, false);
    }) !== null
  );
}

/** RENAME TO name of users and roles. */
function parseRenameToUser(p: P): boolean {
  return attempt(p, () => kw(p, "RENAME TO") && parseUserNameWithHost(p, true) !== null) !== null;
}

/** RENAME TO name of quotas, policies and profiles. */
function parseRenameTo(p: P): boolean {
  return attempt(p, () => kw(p, "RENAME TO") && parseIdentifierOrStringLiteral(p) !== null) !== null;
}

/** IF EXISTS for ALTER; IF NOT EXISTS or OR REPLACE for CREATE. */
function parseIfExistsOrReplace(p: P, alter: boolean): void {
  if (alter) kw(p, "IF EXISTS");
  else if (!kw(p, "IF NOT EXISTS")) kw(p, "OR REPLACE");
}

/** IN storage, which leaves IN read when no storage name follows. */
function parseInStorage(p: P): boolean {
  return kw(p, "IN") && parseAccessStorageName(p);
}

// --- CREATE and ALTER of access entities ---------------------------------------------------------

/** ParserCreateUserQuery: CREATE USER ... and ALTER USER ... */
export function parseCreateUserQuery(p: P): Ast | null {
  return base(p, "CREATE USER or ALTER USER query", () => {
    let alter = false;
    if (kw(p, "ALTER USER")) alter = true;
    else if (!kw(p, "CREATE USER")) return null;
    parseIfExistsOrReplace(p, alter);
    const names = parseUserNamesWithHost(p, true);
    if (names === null) return null;
    const afterNames = p.i;
    let auth = false;
    let reset = false;
    let roles = false;
    let defaultRoles = false;
    let cluster = false;
    let grantees = false;
    let defaultDatabase = false;
    let newName = false;
    let storage = false;
    let validUntil = false;
    for (;;) {
      if (!auth && !reset) {
        if (parseIdentifiedOrNotIdentified(p) || (alter && attempt(p, () => kw(p, "ADD") && parseIdentifiedWith(p, false)))) {
          auth = true;
          continue;
        }
      }
      if (!reset && alter && !auth && attempt(p, () => kw(p, "RESET AUTHENTICATION METHODS TO NEW"))) {
        reset = true;
        continue;
      }
      if (parseHosts(p, "")) continue;
      if (alter ? parseAlterSettingsProfileElements(p) : parseSettingsProfileElements(p)) continue;
      if (!roles && !alter && attempt(p, () => kw(p, "ROLE") && parseRolesOrUsersSet(p, {}))) {
        roles = true;
        continue;
      }
      if (!defaultRoles && attempt(p, () => kw(p, "DEFAULT ROLE") && parseRolesOrUsersSet(p, { all: true }))) {
        defaultRoles = true;
        continue;
      }
      if (!cluster && parseOnCluster(p)) {
        cluster = true;
        continue;
      }
      if (!grantees && attempt(p, () => kw(p, "GRANTEES") && parseRolesOrUsersSet(p, { any: true, currentUser: true }))) {
        grantees = true;
        continue;
      }
      if (!defaultDatabase && attempt(p, () => kw(p, "DEFAULT DATABASE") && parseDatabaseOrNone(p))) {
        defaultDatabase = true;
        continue;
      }
      if (alter) {
        if (!newName && names === 1 && parseRenameToUser(p)) {
          newName = true;
          continue;
        }
        if (parseHosts(p, "ADD") || parseHosts(p, "DROP")) continue;
      }
      if (!storage && parseInStorage(p)) {
        storage = true;
        continue;
      }
      if (!auth && !validUntil && parseAuthenticationValidUntil(p)) {
        validUntil = true;
        continue;
      }
      break;
    }
    // ALTER USER with nothing to change.
    if (alter && p.i === afterNames) return null;
    return new Ast("CreateUserQuery");
  });
}

/** ParserDatabaseOrNone: NONE or a database name. */
function parseDatabaseOrNone(p: P): boolean {
  return base(p, "DatabaseOrNone", () => kw(p, "NONE") || parseIdentifierOrStringLiteral(p) !== null) !== null;
}

/** ParserCreateRoleQuery: CREATE ROLE ... and ALTER ROLE ... */
export function parseCreateRoleQuery(p: P): Ast | null {
  return base(p, "CREATE ROLE or ALTER ROLE query", () => {
    let alter = false;
    if (kw(p, "ALTER ROLE")) alter = true;
    else if (!kw(p, "CREATE ROLE")) return null;
    parseIfExistsOrReplace(p, alter);
    const names = parseUserNamesWithHost(p, true);
    if (names === null) return null;
    let newName = false;
    let cluster = false;
    let storage = false;
    for (;;) {
      if (alter && !newName && names === 1 && parseRenameToUser(p)) {
        newName = true;
        continue;
      }
      if (alter ? parseAlterSettingsProfileElements(p) : parseSettingsProfileElements(p)) continue;
      if (!cluster && parseOnCluster(p)) {
        cluster = true;
        continue;
      }
      if (!storage && parseInStorage(p)) {
        storage = true;
        continue;
      }
      break;
    }
    return new Ast("CreateRoleQuery");
  });
}

const QUOTA_KEY_TYPES = [
  "none", "user_name", "ip_address", "forwarded_ip_address", "client_key", "client_key_or_user_name",
  "client_key_or_ip_address", "normalized_query_hash",
];

/** NOT KEYED or KEYED BY name [, name]; an unknown key is an error. */
function parseQuotaKeyType(p: P): string | null {
  return attempt(p, () => {
    if (kw(p, "NOT KEYED")) return "none";
    if (!kw(p, "KEY BY") && !kw(p, "KEYED BY")) return null;
    const at = p.i;
    const names = parseIdentifiersOrStringLiterals(p);
    if (!names) return null;
    const name = names.join("_or_").replace(/[A-Z]/g, (c) => c.toLowerCase()).replaceAll(" ", "_");
    if (QUOTA_KEY_TYPES.includes(name)) return name;
    p.fail(
      `Quota cannot be keyed by '${name}'. Expected one of the following identifiers: ` +
        QUOTA_KEY_TYPES.map((type) => `'${type}'`).join(", "),
      at,
    );
  });
}

/** IPV4_PREFIX_BITS n and IPV6_PREFIX_BITS n of quotas keyed by IP address. */
function parseIpPrefixBits(p: P, bits: { v4: boolean; v6: boolean }): boolean {
  const prefix = (keyword: string, max: number) =>
    attempt(p, () => {
      if (!kw(p, keyword)) return false;
      const value = parseUnsignedInteger(p);
      if (!value) p.fail("Expected integer prefix length for IP address masking");
      if ((value.value as { v: number }).v > max) p.fail(`${keyword} prefix must be between 0 and ${max}`, p.i - 1);
      return true;
    }) !== null;
  const v4 = prefix("IPV4_PREFIX_BITS", 32);
  const v6 = prefix("IPV6_PREFIX_BITS", 128);
  bits.v4 ||= v4;
  bits.v6 ||= v6;
  return v4 || v6;
}

/** QuotaType keywords and names in enum order. */
const QUOTA_TYPE_KEYWORDS = [
  "QUERIES", "QUERY SELECTS", "QUERY INSERTS", "ERRORS", "RESULT ROWS", "RESULT BYTES", "READ ROWS", "READ BYTES",
  "EXECUTION TIME", "WRITTEN BYTES", "WRITTEN ROWS", "FAILED SEQUENTIAL AUtheNTICATIONS", "QUERIES PER NORMALIZED HASH",
];
const QUOTA_TYPE_NAMES = QUOTA_TYPE_KEYWORDS.map((keyword) => keyword.toLowerCase().replaceAll(" ", "_"));

function parseQuotaType(p: P): boolean {
  return (
    attempt(p, () => {
      if (QUOTA_TYPE_KEYWORDS.some((keyword) => kw(p, keyword))) return true;
      const name = parseIdentifier(p);
      return name !== null && QUOTA_TYPE_NAMES.includes(name.name);
    }) !== null
  );
}

/** MAX queries = 100, errors = 10 or queries MAX 100, ... */
function parseQuotaLimits(p: P): boolean {
  let maxPrefix = false;
  const limit = () => {
    if (kw(p, "MAX")) maxPrefix = true;
    if (!parseQuotaType(p)) return false;
    if (maxPrefix) tok(p, T.Equals);
    else if (!kw(p, "MAX")) return false;
    return parseNumber(p) !== null || parseStringLiteral(p) !== null;
  };
  return listUtil(p, limit, undefined, false);
}

/** IntervalKind::toAvgSeconds. */
const AVERAGE_SECONDS: Record<string, number> = {
  Nanosecond: 1e-9, Microsecond: 1e-6, Millisecond: 1e-3, Second: 1, Minute: 60, Hour: 3600, Day: 86400,
  Week: 604800, Month: 2629746, Quarter: 7889238, Year: 31556952,
};

/** FOR [RANDOMIZED] INTERVAL n unit {MAX ... | NO LIMITS | TRACKING ONLY}, ... */
function parseIntervalsWithLimits(p: P): boolean {
  const interval = () => {
    if (!kw(p, "FOR")) return false;
    kw(p, "RANDOMIZED");
    kw(p, "INTERVAL");
    const count = parseNumber(p);
    if (!count) return false;
    const kind = parseIntervalKind(p);
    if (kind === null) return false;
    const value = count.value!;
    const amount = value.t === "UInt64" || value.t === "Int64" || value.t === "Float64" ? value.v : 0;
    const seconds = amount * AVERAGE_SECONDS[kind]!;
    if (!Number.isFinite(seconds) || Math.abs(seconds) >= 2 ** 63) p.failOther("Quota interval duration is out of range");
    return kw(p, "NO LIMITS") || kw(p, "TRACKING ONLY") || parseQuotaLimits(p);
  };
  return listUtil(p, interval, undefined, false);
}

/** ParserCreateQuotaQuery: CREATE QUOTA ... and ALTER QUOTA ... */
export function parseCreateQuotaQuery(p: P): Ast | null {
  return base(p, "CREATE QUOTA or ALTER QUOTA query", () => {
    let alter = false;
    if (kw(p, "ALTER QUOTA")) alter = true;
    else if (!kw(p, "CREATE QUOTA")) return null;
    parseIfExistsOrReplace(p, alter);
    const names = parseIdentifiersOrStringLiterals(p);
    if (!names) return null;
    let newName = false;
    let keyType: string | null = null;
    const bits = { v4: false, v6: false };
    let cluster = false;
    let storage = false;
    for (;;) {
      if (alter && !newName && names.length === 1 && parseRenameTo(p)) {
        newName = true;
        continue;
      }
      if (!keyType) {
        keyType = parseQuotaKeyType(p);
        if (keyType) {
          if (keyType === "ip_address" || keyType === "forwarded_ip_address") parseIpPrefixBits(p, bits);
          continue;
        }
      }
      if ((!bits.v4 || !bits.v6) && parseIpPrefixBits(p, bits)) continue;
      if (parseIntervalsWithLimits(p)) continue;
      if (!cluster && parseOnCluster(p)) {
        cluster = true;
        continue;
      }
      if (!storage && parseInStorage(p)) {
        storage = true;
        continue;
      }
      break;
    }
    parseToRoles(p);
    if (!cluster) parseOnCluster(p);
    if ((bits.v4 || bits.v6) && keyType && keyType !== "ip_address" && keyType !== "forwarded_ip_address")
      p.fail("IP prefix bits can only be specified for quotas KEYED BY ip_address or forwarded_ip_address");
    return new Ast("CreateQuotaQuery");
  });
}

/** USING or WITH CHECK condition of a row policy, or NONE. */
function parseFilterExpression(p: P): boolean {
  return (
    attempt(p, () => {
      if (kw(p, "NONE")) return true;
      const filter = parseExpression(p);
      if (!filter) return false;
      if (filter.alias) p.fail("Top-level aliases are not allowed in row policy filter expressions.");
      return true;
    }) !== null
  );
}

/** [FOR SELECT|ALL, ...] [USING condition] [WITH CHECK condition], ... */
function parseRowPolicyForClauses(p: P): boolean {
  const clause = () => {
    if (kw(p, "FOR") && !listUtil(p, () => kw(p, "ALL") || kw(p, "SELECT"), undefined, false)) return false;
    let filter = false;
    if (kw(p, "USING")) {
      if (!parseFilterExpression(p)) return false;
      filter = true;
    }
    if (kw(p, "WITH CHECK")) {
      if (!parseFilterExpression(p)) return false;
      filter = true;
    }
    return filter;
  };
  return listUtil(p, clause, undefined, false);
}

/** ParserCreateRowPolicyQuery: CREATE [ROW] POLICY ... and ALTER [ROW] POLICY ... */
export function parseCreateRowPolicyQuery(p: P): Ast | null {
  return base(p, "CREATE ROW POLICY or ALTER ROW POLICY query", () => {
    let alter = false;
    if (kw(p, "ALTER POLICY") || kw(p, "ALTER ROW POLICY")) alter = true;
    else if (!kw(p, "CREATE POLICY") && !kw(p, "CREATE ROW POLICY")) return null;
    parseIfExistsOrReplace(p, alter);
    const names = parseRowPolicyNames(p, true);
    if (!names) return null;
    let cluster = names.cluster;
    let newName = false;
    let restrictive = false;
    let storage = false;
    for (;;) {
      if (alter && names.count === 1 && !newName && parseRenameTo(p)) {
        newName = true;
        continue;
      }
      if (!restrictive && attempt(p, () => kw(p, "AS") && (kw(p, "RESTRICTIVE") || kw(p, "PERMISSIVE")))) {
        restrictive = true;
        continue;
      }
      if (parseRowPolicyForClauses(p)) continue;
      if (!cluster && parseOnCluster(p)) {
        cluster = true;
        continue;
      }
      if (!storage && parseInStorage(p)) {
        storage = true;
        continue;
      }
      break;
    }
    parseToRoles(p);
    if (!cluster) parseOnCluster(p);
    return new Ast("CreateRowPolicyQuery");
  });
}

/** ParserCreateMaskingPolicy: CREATE|ALTER|ATTACH MASKING POLICY name ON table UPDATE ... [WHERE ...] [TO ...] [PRIORITY n]. */
export function parseCreateMaskingPolicyQuery(p: P): Ast | null {
  return base(p, "CREATE MASKING POLICY or ALTER MASKING POLICY query", () => {
    let attach = false;
    let alter = false;
    if (kw(p, "ATTACH MASKING POLICY")) attach = true;
    else if (kw(p, "ALTER MASKING POLICY")) alter = true;
    else if (!kw(p, "CREATE MASKING POLICY")) return null;
    parseIfExistsOrReplace(p, alter);
    if (parseIdentifierOrStringLiteral(p) === null) return null;
    if (!kw(p, "ON")) return null;
    if (!parseDatabaseAndTableName(p)) return null;
    const seen = new Set<string>();
    const once = (name: string, parse: () => boolean): boolean => {
      if (seen.has(name) || !parse()) return false;
      seen.add(name);
      return true;
    };
    for (;;) {
      if (alter && once("rename", () => parseRenameTo(p))) continue;
      if (once("update", () => attempt(p, () => kw(p, "UPDATE") && parseList(p, () => parseAssignment(p), undefined, false)) !== null))
        continue;
      if (once("where", () => attempt(p, () => kw(p, "WHERE") && parseExpression(p)) !== null)) continue;
      if (once("roles", () => parseToRoles(p))) continue;
      if (
        once("priority", () =>
          attempt(p, () => {
            if (!kw(p, "PRIORITY")) return false;
            const priority = parseNumber(p);
            return priority?.value?.t === "UInt64";
          }) !== null,
        )
      )
        continue;
      if (once("cluster", () => parseOnCluster(p))) continue;
      if (!seen.has("storage") && parseInStorage(p)) {
        seen.add("storage");
        continue;
      }
      break;
    }
    if (!seen.has("cluster")) parseOnCluster(p);
    if (!seen.has("update") && !alter && !attach) return null;
    return new Ast("CreateMaskingPolicyQuery");
  });
}

/** ParserCreateSettingsProfileQuery: CREATE [SETTINGS] PROFILE ... and ALTER [SETTINGS] PROFILE ... */
export function parseCreateSettingsProfileQuery(p: P): Ast | null {
  return base(p, "CREATE SETTINGS PROFILE or ALTER SETTINGS PROFILE query", () => {
    let alter = false;
    if (kw(p, "ALTER SETTINGS PROFILE") || kw(p, "ALTER PROFILE")) alter = true;
    else if (!kw(p, "CREATE SETTINGS PROFILE") && !kw(p, "CREATE PROFILE")) return null;
    parseIfExistsOrReplace(p, alter);
    const names = parseIdentifiersOrStringLiterals(p);
    if (!names) return null;
    let newName = false;
    let cluster = false;
    let storage = false;
    for (;;) {
      if (alter && !newName && names.length === 1 && parseRenameTo(p)) {
        newName = true;
        continue;
      }
      if (alter ? parseAlterSettingsProfileElements(p, true) : parseSettingsProfileElements(p, false, true)) continue;
      if (!cluster && parseOnCluster(p)) {
        cluster = true;
        continue;
      }
      if (!storage && parseInStorage(p)) {
        storage = true;
        continue;
      }
      break;
    }
    parseToRoles(p);
    if (!cluster) parseOnCluster(p);
    return new Ast("CreateSettingsProfileQuery");
  });
}

/** ParserCreateTokenQuery: CREATE TOKEN [VALID UNTIL ...] [GRANTS (...)]. */
export function parseCreateTokenQuery(p: P): Ast | null {
  return base(p, "CREATE TOKEN query", () => {
    if (!kw(p, "CREATE TOKEN")) return null;
    let validUntil = false;
    let grants = false;
    for (;;) {
      if (!validUntil && parseAuthenticationValidUntil(p)) {
        validUntil = true;
        continue;
      }
      if (!grants && parseAuthenticationGrants(p)) {
        grants = true;
        continue;
      }
      break;
    }
    return new Ast("CreateTokenQuery");
  });
}

// --- DROP, MOVE and SHOW of access entities ------------------------------------------------------

/** AccessEntityTypeInfo in enum order: name, alias, plural name and plural alias. */
const ENTITY_TYPES: { type: string; name: string; alias: string; plural: string; pluralAlias: string }[] = [
  { type: "USER", name: "USER", alias: "", plural: "USERS", pluralAlias: "" },
  { type: "ROLE", name: "ROLE", alias: "", plural: "ROLES", pluralAlias: "" },
  { type: "SETTINGS_PROFILE", name: "SETTINGS PROFILE", alias: "PROFILE", plural: "SETTINGS PROFILES", pluralAlias: "PROFILES" },
  { type: "ROW_POLICY", name: "ROW POLICY", alias: "POLICY", plural: "ROW POLICIES", pluralAlias: "POLICIES" },
  { type: "QUOTA", name: "QUOTA", alias: "", plural: "QUOTAS", pluralAlias: "" },
  { type: "MASKING_POLICY", name: "MASKING POLICY", alias: "POLICY", plural: "MASKING POLICIES", pluralAlias: "POLICIES" },
];

/** The entity type keyword; each type info string is its own keyword, so the two POLICY aliases both show. */
function parseEntityType(p: P, plural: boolean): string | null {
  for (const info of ENTITY_TYPES) {
    const name = plural ? info.plural : info.name;
    const alias = plural ? info.pluralAlias : info.alias;
    const id = `AccessEntityTypeInfo.${info.type}.${plural ? "plural" : "single"}`;
    if (kw(p, name, id) || (alias && kw(p, alias, `${id}.alias`))) return info.type;
  }
  return null;
}

/** name [ON CLUSTER c] ON [db.]table of DROP MASKING POLICY; returns whether ON CLUSTER was read. */
function parseMaskingPolicyName(p: P): { cluster: boolean } | null {
  return attempt(p, () => {
    if (parseIdentifierOrStringLiteral(p) === null) return null;
    let cluster = false;
    if (kw(p, "ON") && parseCluster(p)) {
      cluster = true;
      if (!kw(p, "ON")) return null;
    }
    return parseDatabaseAndTableName(p) ? { cluster } : null;
  });
}

/** ParserDropAccessEntityQuery: DROP USER|ROLE|QUOTA|[ROW|MASKING] POLICY|[SETTINGS] PROFILE ... */
export function parseDropAccessEntityQuery(p: P): Ast | null {
  return base(p, "DROP access entity query", () => {
    if (!kw(p, "DROP")) return null;
    const type = parseEntityType(p, false);
    if (!type) return null;
    kw(p, "IF EXISTS");
    let cluster = false;
    if (type === "USER" || type === "ROLE") {
      if (parseUserNamesWithHost(p, true) === null) return null;
    } else if (type === "ROW_POLICY") {
      const names = parseRowPolicyNames(p, true);
      if (!names) return null;
      cluster = names.cluster;
    } else if (type === "MASKING_POLICY") {
      const name = parseMaskingPolicyName(p);
      if (!name) return null;
      cluster = name.cluster;
    } else if (!parseIdentifiersOrStringLiterals(p)) {
      return null;
    }
    if (kw(p, "FROM")) parseAccessStorageName(p);
    if (!cluster) parseOnCluster(p);
    return new Ast("DropAccessEntityQuery");
  });
}

/** ParserMoveAccessEntityQuery: MOVE USER|ROLE|... names TO storage. */
export function parseMoveAccessEntityQuery(p: P): Ast | null {
  return base(p, "MOVE access entity query", () => {
    if (!kw(p, "MOVE")) return null;
    const type = parseEntityType(p, false);
    if (!type) return null;
    let cluster = false;
    if (type === "USER" || type === "ROLE") {
      if (parseUserNamesWithHost(p, false) === null) return null;
    } else if (type === "ROW_POLICY") {
      const names = parseRowPolicyNames(p, true);
      if (!names) return null;
      cluster = names.cluster;
    } else if (!parseIdentifiersOrStringLiterals(p)) {
      return null;
    }
    if (!kw(p, "TO") || !parseAccessStorageName(p)) return null;
    if (!cluster) parseOnCluster(p);
    return new Ast("MoveAccessEntityQuery");
  });
}

/** ON [db.]table without a wildcard; *.* is allowed. */
function parseOnTableNoWildcard(p: P): boolean {
  return (
    attempt(p, () => {
      if (!kw(p, "ON")) return false;
      const name = parseDatabaseAndTableNameOrAsterisks(p);
      return name !== null && !name.wildcard;
    }) !== null
  );
}

/** ParserShowAccessEntitiesQuery: SHOW USERS, ROLES, CURRENT ROLES, QUOTAS, [ROW] POLICIES [ON t] and so on. */
export function parseShowAccessEntitiesQuery(p: P): Ast | null {
  return base(p, "ShowAccessEntitiesQuery", () => {
    if (!kw(p, "SHOW")) return null;
    let type = parseEntityType(p, true);
    if (!type) {
      if (kw(p, "CURRENT ROLES") || kw(p, "ENABLED ROLES")) type = "ROLE";
      else if (kw(p, "CURRENT QUOTA") || kw(p, "QUOTA")) type = "QUOTA";
      else return null;
    }
    if ((type === "ROW_POLICY" || type === "MASKING_POLICY") && !parseOnTableNoWildcard(p) && !atQueryOutputTail(p))
      parseIdentifierOrStringLiteral(p);
    return new Ast("ShowAccessEntitiesQuery");
  });
}

/** ParserShowCreateAccessEntityQuery: SHOW CREATE USER|ROLE|QUOTA|POLICY|PROFILE ... and their plurals. */
export function parseShowCreateAccessEntityQuery(p: P): Ast | null {
  return base(p, "SHOW CREATE QUOTA query", () => {
    if (!kw(p, "SHOW CREATE")) return null;
    let plural = false;
    let type = parseEntityType(p, false);
    if (!type) {
      type = parseEntityType(p, true);
      plural = true;
    }
    if (!type) return null;
    const node = new Ast("ShowCreateAccessEntityQuery");
    const notAtTail = () => !atQueryOutputTail(p);
    switch (type) {
      case "USER":
        if (!parseCurrentUserTag(p) && notAtTail()) parseUserNamesWithHost(p, false);
        return node;
      case "ROLE":
        if (notAtTail() && parseUserNamesWithHost(p, false) !== null) return node;
        return plural ? node : null;
      case "ROW_POLICY":
        if (parseRowPolicyNames(p, false) || parseOnTableNoWildcard(p)) return node;
        if (notAtTail() && parseIdentifierOrStringLiteral(p) !== null) return node;
        return plural ? node : null;
      case "SETTINGS_PROFILE":
        if (notAtTail() && parseIdentifiersOrStringLiterals(p)) return node;
        return plural ? node : null;
      case "QUOTA":
        if (!kw(p, "CURRENT") && notAtTail()) parseIdentifiersOrStringLiterals(p);
        return node;
      default: {
        let named = false;
        if (notAtTail() && (named = parseIdentifierOrStringLiteral(p) !== null) && parseOnTableNoWildcard(p)) return node;
        if (parseOnTableNoWildcard(p) || named) return node;
        if (notAtTail() && parseIdentifiersOrStringLiterals(p)) return node;
        return plural ? node : null;
      }
    }
  });
}

/** ParserShowGrantsQuery: SHOW GRANTS [FOR users] [WITH IMPLICIT] [FINAL]. */
export function parseShowGrantsQuery(p: P): Ast | null {
  return base(p, "SHOW GRANTS query", () => {
    if (!kw(p, "SHOW GRANTS")) return null;
    if (kw(p, "FOR") && !parseRolesOrUsersSet(p, { all: true, currentUser: true })) return null;
    let implicit = false;
    let final = false;
    for (;;) {
      if (!implicit && kw(p, "WITH IMPLICIT")) implicit = true;
      else if (!final && kw(p, "FINAL")) final = true;
      else break;
    }
    return new Ast("ShowGrantsQuery");
  });
}

/** ParserShowPrivilegesQuery. */
export function parseShowPrivilegesQuery(p: P): Ast | null {
  return base(p, "SHOW PRIVILEGES query", () => (kw(p, "SHOW PRIVILEGES") ? new Ast("ShowPrivilegesQuery") : null));
}

/** ParserShowAccessQuery. */
export function parseShowAccessQuery(p: P): Ast | null {
  return base(p, "SHOW ACCESS query", () => (kw(p, "SHOW ACCESS") ? new Ast("ShowAccessQuery") : null));
}

// --- GRANT, REVOKE, CHECK GRANT, SET ROLE and EXECUTE AS ----------------------------------------

/** CURRENT GRANTS (rights) or CURRENT GRANTS ON table. */
function parseCurrentGrants(p: P): boolean {
  if (tok(p, T.OpeningRoundBracket)) return parseAccessRightsElements(p) && tok(p, T.ClosingRoundBracket);
  return kw(p, "ON") && parseDatabaseAndTableNameOrAsterisks(p) !== null;
}

/** ParserGrantQuery: GRANT|REVOKE [ON CLUSTER c] rights or roles TO|FROM grantees [WITH ... OPTION]. */
export function parseGrantQuery(p: P): Ast | null {
  return base(p, "GRANT or REVOKE query", () => {
    let revoke = false;
    if (kw(p, "REVOKE")) revoke = true;
    else if (!kw(p, "GRANT")) return null;
    let cluster = parseOnCluster(p);
    let grantOption = false;
    let adminOption = false;
    if (revoke) {
      if (kw(p, "GRANT OPTION FOR")) grantOption = true;
      else if (kw(p, "ADMIN OPTION FOR")) adminOption = true;
    }
    let rights = false;
    let roles = false;
    if (!revoke && kw(p, "CURRENT GRANTS")) {
      if (!parseCurrentGrants(p)) return null;
      rights = true;
    } else if (parseAccessRightsElements(p)) {
      rights = true;
    } else if (attempt(p, () => parseRolesOrUsersSet(p, { params: true, all: revoke }))) {
      roles = true;
    } else {
      return null;
    }
    if (!cluster) cluster = parseOnCluster(p);
    const grantees = attempt(
      p,
      () => kw(p, revoke ? "FROM" : "TO") && parseRolesOrUsersSet(p, { currentUser: true, all: revoke, params: true }),
    );
    if (!grantees) return null;
    if (!cluster) cluster = parseOnCluster(p);
    if (!revoke) {
      if (kw(p, "WITH GRANT OPTION")) grantOption = true;
      else if (kw(p, "WITH ADMIN OPTION")) adminOption = true;
      kw(p, "WITH REPLACE OPTION");
    }
    if (!cluster) parseOnCluster(p);
    if (grantOption && roles) p.fail("GRANT OPTION should be specified for access types");
    if (adminOption && rights) p.fail("ADMIN OPTION should be specified for roles");
    return new Ast("GrantQuery");
  });
}

/** ParserCheckGrantQuery: CHECK GRANT rights. */
export function parseCheckGrantQuery(p: P): Ast | null {
  return base(p, "CHECK GRANT", () => (kw(p, "CHECK GRANT") && parseAccessRightsElements(p) ? new Ast("CheckGrantQuery") : null));
}

/** ParserSetRoleQuery: SET ROLE DEFAULT, SET ROLE roles, SET DEFAULT ROLE roles TO users. */
export function parseSetRoleQuery(p: P): Ast | null {
  return base(p, "SET ROLE or SET DEFAULT ROLE query", () => {
    if (kw(p, "SET ROLE DEFAULT")) return new Ast("SetRoleQuery");
    let defaultRole = false;
    if (kw(p, "SET ROLE")) {
      // SET ROLE roles.
    } else if (kw(p, "SET DEFAULT ROLE")) {
      defaultRole = true;
    } else {
      return null;
    }
    const cluster = defaultRole && parseOnCluster(p);
    if (!attempt(p, () => parseRolesOrUsersSet(p, { all: true }))) return null;
    if (defaultRole) {
      if (!attempt(p, () => kw(p, "TO") && parseRolesOrUsersSet(p, { currentUser: true }))) return null;
      if (!cluster) parseOnCluster(p);
    }
    return new Ast("SetRoleQuery");
  });
}

/** ParserExecuteAsQuery: EXECUTE AS user [query]. */
export function parseExecuteAsQuery(p: P, parseSubquery: () => Ast | null): Ast | null {
  return base(p, "EXECUTE AS query", () => {
    if (!kw(p, "EXECUTE AS")) return null;
    if (!parseUserNameWithHost(p, false)) return null;
    parseSubquery();
    return new Ast("ExecuteAsQuery");
  });
}
