/** Access types of GRANT, REVOKE and CHECK GRANT, from the privileges ClickHouse lists in system.privileges. */
import { SOURCE_NAMES } from "../generated/privileges.js";
/** Every privilege name and alias, which AccessFlags::tryFromKeyword accepts. */
export declare const ACCESS_TYPE_KEYWORDS: ReadonlySet<string>;
/** Privileges granted on a parameter instead of a table, like NAMED COLLECTION ON name. */
export declare const PARAMETER_ACCESS_TYPES: ReadonlySet<string>;
/** NONE, USAGE and NO PRIVILEGES, which grant nothing. */
export declare const NO_ACCESS_TYPES: ReadonlySet<string>;
/** READ and WRITE are granted on a source, which must be one of SOURCE_NAMES or *. */
export declare const SOURCE_ACCESS_TYPES: ReadonlySet<string>;
export { SOURCE_NAMES };
//# sourceMappingURL=privileges.d.ts.map