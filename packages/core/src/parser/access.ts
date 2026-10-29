// TEMP placeholder, replaced by the real port.
import { Ast, isParam, stringValue } from "./ast.js";
import { parseIdentifierOrStringLiteral } from "./common.js";
import { parseIdentifier, parseStringLiteral } from "./elements.js";
import { subParser } from "./expression.js";
import { attempt, base, listUtil, P, T, tok } from "./state.js";
export function parseCheckGrantQuery(_p: P): Ast | null { return null; }
export function parseCreateMaskingPolicyQuery(_p: P): Ast | null { return null; }
export function parseCreateQuotaQuery(_p: P): Ast | null { return null; }
export function parseCreateRoleQuery(_p: P): Ast | null { return null; }
export function parseCreateRowPolicyQuery(_p: P): Ast | null { return null; }
export function parseCreateSettingsProfileQuery(_p: P): Ast | null { return null; }
export function parseCreateTokenQuery(_p: P): Ast | null { return null; }
export function parseCreateUserQuery(_p: P): Ast | null { return null; }
export function parseDropAccessEntityQuery(_p: P): Ast | null { return null; }
export function parseGrantQuery(_p: P): Ast | null { return null; }
export function parseMoveAccessEntityQuery(_p: P): Ast | null { return null; }
export function parseSetRoleQuery(_p: P): Ast | null { return null; }
export function parseShowAccessEntitiesQuery(_p: P): Ast | null { return null; }
export function parseShowAccessQuery(_p: P): Ast | null { return null; }
export function parseShowCreateAccessEntityQuery(_p: P): Ast | null { return null; }
export function parseShowGrantsQuery(_p: P): Ast | null { return null; }
export function parseShowPrivilegesQuery(_p: P): Ast | null { return null; }
export function parseExecuteAsQuery(_p: P, _q: () => Ast | null): Ast | null { return null; }

/** parseUserNameWithHost: name, name@host, 'name' or 'name@host'. */
function parseUserNameWithHostBody(p: P, allowParam: boolean): boolean {
  return (
    attempt(p, () => {
      if (parseIdentifier(p, allowParam)) {
        if (tok(p, T.At)) {
          const host = parseIdentifierOrStringLiteral(p);
          if (host === null || host === "") return false;
        }
        return true;
      }
      const literal = parseStringLiteral(p);
      if (!literal) return false;
      const name = stringValue(literal)!;
      if (name === "") return false;
      const inner = subParser(name);
      const param = inner.quiet(() => parseIdentifier(inner, true));
      if (param && isParam(param))
        p.failOther(
          "String literals don't support query parameters substitution, remove single quotes surrounding the query parameter",
          p.i - 1,
        );
      return true;
    }) !== null
  );
}

/** ParserUserNameWithHost. */
export function parseUserNameWithHost(p: P, allowParam = false): Ast | null {
  return base(p, "UserNameWithHost", () => (parseUserNameWithHostBody(p, allowParam) ? new Ast("UserName") : null));
}

/** ParserUserNamesWithHost: a non-empty list of user names. */
export function parseUserNamesWithHost(p: P, allowParam = false): Ast | null {
  return base(p, "UserNamesWithHost", () =>
    listUtil(p, () => parseUserNameWithHostBody(p, allowParam), undefined, false) ? new Ast("UserNames") : null,
  );
}
