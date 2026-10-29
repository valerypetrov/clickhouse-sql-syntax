// Positions and messages are what ClickHouse 26.11 reports; where it gives no position, check() points at the clause.
import { describe } from "node:test";

import { accepts, rejects } from "./helpers.js";

describe("ALTER", () => {
  accepts([
    "ALTER TABLE t ADD COLUMN c UInt8 DEFAULT 0 AFTER b",
    "ALTER TABLE t DROP COLUMN IF EXISTS c, MODIFY COLUMN b String, RENAME COLUMN a TO z, COMMENT COLUMN b 'text'",
    "ALTER TABLE t MODIFY COLUMN b REMOVE DEFAULT",
    "ALTER TABLE t ALTER COLUMN b TYPE String",
    "ALTER TABLE t ADD INDEX i a TYPE minmax GRANULARITY 1, DROP INDEX j, MATERIALIZE INDEX i IN PARTITION 1",
    "ALTER TABLE t ADD PROJECTION p (SELECT a ORDER BY a), MATERIALIZE PROJECTION p",
    "ALTER TABLE t ADD CONSTRAINT c CHECK a > 0, DROP CONSTRAINT d",
    "ALTER TABLE t DROP PARTITION 202401, DETACH PART 'all_1_1_0', ATTACH PARTITION ID '1' FROM other",
    "ALTER TABLE t MOVE PARTITION 1 TO DISK 'd', MOVE PARTITION 2 TO TABLE other",
    "ALTER TABLE t FREEZE PARTITION 1 WITH NAME 'backup'",
    "ALTER TABLE t DELETE WHERE a = 1",
    "ALTER TABLE t UPDATE a = a + 1, b = 'x' IN PARTITION 1 WHERE c > 0",
    "ALTER TABLE t MODIFY TTL d + INTERVAL 1 DAY, MATERIALIZE TTL",
    "ALTER TABLE t MODIFY ORDER BY (a, b), MODIFY SAMPLE BY a",
    "ALTER TABLE t MODIFY COMMENT 'x'",
    "ALTER TABLE mv MODIFY QUERY SELECT 1",
    "ALTER TABLE t ON CLUSTER c FETCH PARTITION 1 FROM '/zk/path'",
    "ALTER DATABASE db MODIFY SETTING x = 1",
    "ALTER TABLE t (DROP COLUMN a), (DROP COLUMN b)",
  ]);

  rejects([
    ["ALTER TABLE t MODIFY SETTING index_granularity = 1024, RESET SETTING max_parts", 61, "Maybe you meant: SETTINGS. Expected one of: token sequence, Dot, token, Equals, Comma, INTO OUTFILE…"],
    ["ALTER TABLE t", 13, "Expected one of: ON, a list of ALTER commands, ALTER command, ADD COLUMN, RENAME COLUMN, MATERIALIZE…"],
    ["ALTER TABLE t ADD COLUMN", 24, "Expected one of: IF NOT EXISTS, column declaration, compound identifier, identifier"],
    ["ALTER TABLE t DROP", 18, "Expected one of: PARTITION, PART, DETACHED PARTITION, DETACHED PART, COLUMN, INDEX, STATISTICS, PROJECTION, CONSTRAINT"],
    ["ALTER TABLE t MODIFY COLUMN a UInt8 REMOVE DEFAULT", 43, "Cannot specify column properties before 'REMOVE'"],
    ["ALTER TABLE t DELETE a = 1", 21, "Expected one of: IN PARTITION, WHERE"],
    ["ALTER TABLE t UPDATE WHERE 1", 27, "Expected one of: token, Equals"],
    ["ALTER TABLE t MOVE PARTITION 1 TO 'd'", 34, "Expected one of: DISK, VOLUME, TABLE"],
    ["ALTER TABLE t UNFREEZE", 22, "Expected one of: PARTITION, WITH"],
    ["ALTER TABLE t, DROP COLUMN a", 13, "Expected one of: ON, a list of ALTER commands, ALTER command, ADD COLUMN, RENAME COLUMN, MATERIALIZE…"],
    ["ALTER t DROP COLUMN a", 6, "Expected one of: TABLE, TEMPORARY TABLE, DATABASE, USER, ROLE, QUOTA, POLICY, ROW POLICY, MASKING PO…"],
  ]);
});
