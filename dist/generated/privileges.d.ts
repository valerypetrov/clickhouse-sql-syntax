export interface Privilege {
    name: string;
    /** Other names GRANT accepts for it. */
    aliases: readonly string[];
    /** What it is granted on, such as GLOBAL, TABLE or SOURCE; null for a group like ALL. */
    level: string | null;
}
export declare const PRIVILEGES: readonly Privilege[];
/** The sources READ and WRITE are granted on, with their aliases, in the order ClickHouse lists them. */
export declare const SOURCE_NAMES: readonly string[];
//# sourceMappingURL=privileges.d.ts.map