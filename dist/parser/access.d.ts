import { Ast } from "./ast.js";
import { P } from "./state.js";
/** ParserUserNameWithHost. */
export declare function parseUserNameWithHost(p: P, allowParam?: boolean): Ast | null;
/** ParserUserNamesWithHost: a non-empty list of user names; returns how many there are. */
export declare function parseUserNamesWithHost(p: P, allowParam?: boolean): number | null;
/** ParserCreateUserQuery: CREATE USER ... and ALTER USER ... */
export declare function parseCreateUserQuery(p: P): Ast | null;
/** ParserCreateRoleQuery: CREATE ROLE ... and ALTER ROLE ... */
export declare function parseCreateRoleQuery(p: P): Ast | null;
/** ParserCreateQuotaQuery: CREATE QUOTA ... and ALTER QUOTA ... */
export declare function parseCreateQuotaQuery(p: P): Ast | null;
/** ParserCreateRowPolicyQuery: CREATE [ROW] POLICY ... and ALTER [ROW] POLICY ... */
export declare function parseCreateRowPolicyQuery(p: P): Ast | null;
/** ParserCreateMaskingPolicy: CREATE|ALTER|ATTACH MASKING POLICY name ON table UPDATE ... [WHERE ...] [TO ...] [PRIORITY n]. */
export declare function parseCreateMaskingPolicyQuery(p: P): Ast | null;
/** ParserCreateSettingsProfileQuery: CREATE [SETTINGS] PROFILE ... and ALTER [SETTINGS] PROFILE ... */
export declare function parseCreateSettingsProfileQuery(p: P): Ast | null;
/** ParserCreateTokenQuery: CREATE TOKEN [VALID UNTIL ...] [GRANTS (...)]. */
export declare function parseCreateTokenQuery(p: P): Ast | null;
/** ParserDropAccessEntityQuery: DROP USER|ROLE|QUOTA|[ROW|MASKING] POLICY|[SETTINGS] PROFILE ... */
export declare function parseDropAccessEntityQuery(p: P): Ast | null;
/** ParserMoveAccessEntityQuery: MOVE USER|ROLE|... names TO storage. */
export declare function parseMoveAccessEntityQuery(p: P): Ast | null;
/** ParserShowAccessEntitiesQuery: SHOW USERS, ROLES, CURRENT ROLES, QUOTAS, [ROW] POLICIES [ON t] and so on. */
export declare function parseShowAccessEntitiesQuery(p: P): Ast | null;
/** ParserShowCreateAccessEntityQuery: SHOW CREATE USER|ROLE|QUOTA|POLICY|PROFILE ... and their plurals. */
export declare function parseShowCreateAccessEntityQuery(p: P): Ast | null;
/** ParserShowGrantsQuery: SHOW GRANTS [FOR users] [WITH IMPLICIT] [FINAL]. */
export declare function parseShowGrantsQuery(p: P): Ast | null;
/** ParserShowPrivilegesQuery. */
export declare function parseShowPrivilegesQuery(p: P): Ast | null;
/** ParserShowAccessQuery. */
export declare function parseShowAccessQuery(p: P): Ast | null;
/** ParserGrantQuery: GRANT|REVOKE [ON CLUSTER c] rights or roles TO|FROM grantees [WITH ... OPTION]. */
export declare function parseGrantQuery(p: P): Ast | null;
/** ParserCheckGrantQuery: CHECK GRANT rights. */
export declare function parseCheckGrantQuery(p: P): Ast | null;
/** ParserSetRoleQuery: SET ROLE DEFAULT, SET ROLE roles, SET DEFAULT ROLE roles TO users. */
export declare function parseSetRoleQuery(p: P): Ast | null;
/** ParserExecuteAsQuery: EXECUTE AS user [query]. */
export declare function parseExecuteAsQuery(p: P, parseSubquery: () => Ast | null): Ast | null;
//# sourceMappingURL=access.d.ts.map