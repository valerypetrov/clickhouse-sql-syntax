/** Access types of GRANT, REVOKE and CHECK GRANT, from the privileges ClickHouse lists in system.privileges. */
import { type Privilege, PRIVILEGES, SOURCE_NAMES } from "../generated/privileges.js";

function namesOf(privileges: readonly Privilege[]): ReadonlySet<string> {
  return new Set(privileges.flatMap((privilege) => [privilege.name, ...privilege.aliases]));
}

const PARAMETER_LEVELS = new Set(["NAMED_COLLECTION", "USER_NAME", "TABLE_ENGINE", "DEFINER", "SOURCE"]);

/** Every privilege name and alias, which AccessFlags::tryFromKeyword accepts. */
export const ACCESS_TYPE_KEYWORDS = namesOf(PRIVILEGES);

/** Privileges granted on a parameter instead of a table, like NAMED COLLECTION ON name. */
export const PARAMETER_ACCESS_TYPES = namesOf(PRIVILEGES.filter((privilege) => PARAMETER_LEVELS.has(privilege.level ?? "")));

/** READ and WRITE are granted on a source, which must be one of SOURCE_NAMES or *. */
export const SOURCE_ACCESS_TYPES = namesOf(PRIVILEGES.filter((privilege) => privilege.level === "SOURCE"));

export { SOURCE_NAMES };
