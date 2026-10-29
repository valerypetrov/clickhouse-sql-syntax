// Golden cases of format(): a name, the input and the expected output.
export const GOLDEN: [name: string, input: string, output: string][] = [
  [
    "SELECT with every clause",
    `with a as (select 1 as x) select distinct a.x, count(*) as c from a left join b on a.x = b.x array join arr as e prewhere y = 1 where x in (1, 2) group by a.x, c with totals having c > 1 window w as (partition by x order by y) qualify row_number() over w = 1 order by c desc, x limit 1 by x limit 10 offset 5 settings max_threads = 1, a = 2 format JSON`,
    `WITH a AS (
    SELECT 1 AS x
)
SELECT DISTINCT
    a.x,
    count(*) AS c
FROM a
LEFT JOIN b ON a.x = b.x
ARRAY JOIN arr AS e
PREWHERE y = 1
WHERE x IN (1, 2)
GROUP BY
    a.x,
    c
WITH TOTALS
HAVING c > 1
WINDOW w AS (PARTITION BY x ORDER BY y)
QUALIFY row_number() OVER w = 1
ORDER BY
    c DESC,
    x
LIMIT 1 BY x
LIMIT 10 OFFSET 5
SETTINGS max_threads = 1, a = 2
FORMAT JSON`,
  ],
  [
    "one item stays on the clause line",
    `select a from t where b order by c`,
    `SELECT a
FROM t
WHERE b
ORDER BY c`,
  ],
  [
    "subqueries are indented",
    `select * from (select a from (select 1 as a) as s1) as s2 where a in (select 1 union all select 2)`,
    `SELECT *
FROM (
    SELECT a
    FROM (
        SELECT 1 AS a
    ) AS s1
) AS s2
WHERE a IN (
    SELECT 1
    UNION ALL
    SELECT 2
)`,
  ],
  [
    "CTE bodies are indented",
    `with x as (select 1), y as (select 2) select * from x, y`,
    `WITH
    x AS (
        SELECT 1
    ),
    y AS (
        SELECT 2
    )
SELECT *
FROM x, y`,
  ],
  [
    "set operations between queries",
    `select 1 union all select 2 except select 3 intersect distinct select 4`,
    `SELECT 1
UNION ALL
SELECT 2
EXCEPT
SELECT 3
INTERSECT DISTINCT
SELECT 4`,
  ],
  [
    "joins",
    `select * from a inner join b on a.k = b.k left any join c using (k) cross join d global full outer join e using k, j`,
    `SELECT *
FROM a
INNER JOIN b ON a.k = b.k
LEFT ANY JOIN c USING (k)
CROSS JOIN d
GLOBAL FULL OUTER JOIN e USING k, j`,
  ],
  [
    "expressions are spaced",
    `select a+b*c, -x, not y, (1,2), [1,2], arr[1], t.1, x::Int32, f(x)(y), x->x+1, a?b:c, a||b, a<=>b from t`,
    `SELECT
    a + b * c,
    -x,
    NOT y,
    (1, 2),
    [1, 2],
    arr[1],
    t.1,
    x::Int32,
    f(x)(y),
    x -> x + 1,
    a ? b : c,
    a || b,
    a <=> b
FROM t`,
  ],
  [
    "keyword operators",
    `select x between 1 and 2, y not like 'a%', z is not null, w global not in (1), v is not distinct from u from t`,
    `SELECT
    x BETWEEN 1 AND 2,
    y NOT LIKE 'a%',
    z IS NOT NULL,
    w GLOBAL NOT IN (1),
    v IS NOT DISTINCT FROM u
FROM t`,
  ],
  [
    "CASE, INTERVAL and literals",
    `select case when a then 1 else 2 end, interval 1 day, date '2020-01-01', true, null from t`,
    `SELECT
    CASE WHEN a THEN 1 ELSE 2 END,
    INTERVAL 1 DAY,
    DATE '2020-01-01',
    TRUE,
    NULL
FROM t`,
  ],
  [
    "window functions and aggregate modifiers",
    `select sum(x) over (partition by a order by b rows between unbounded preceding and current row), count(distinct y), any(z) respect nulls, sum(x) filter (where x > 0) from t`,
    `SELECT
    sum(x) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
    count(DISTINCT y),
    any(z) RESPECT NULLS,
    sum(x) FILTER (WHERE x > 0)
FROM t`,
  ],
  [
    "ORDER BY modifiers and WITH FILL",
    `select a from t order by a desc nulls first, b collate 'en' with fill from 1 to 10 step 1 interpolate (c as c + 1) limit 3 with ties`,
    `SELECT a
FROM t
ORDER BY
    a DESC NULLS FIRST,
    b COLLATE 'en' WITH FILL FROM 1 TO 10 STEP 1
INTERPOLATE (c AS c + 1)
LIMIT 3 WITH TIES`,
  ],
  [
    "column transformers",
    `select * except (a) replace (b + 1 as b) apply (toString), columns('^x') from t`,
    `SELECT
    * EXCEPT (a) REPLACE (b + 1 AS b) APPLY (toString),
    COLUMNS('^x')
FROM t`,
  ],
  [
    "CREATE TABLE",
    `create table if not exists db.t (id UInt64 comment 'the id', s String default 'a' codec(ZSTD(1)), d Nullable(DateTime64(3, 'UTC')), index i s type bloom_filter granularity 1, projection p (select id order by s), constraint c check id > 0) engine = MergeTree partition by toYYYYMM(d) primary key id order by (id, s) sample by id ttl d + interval 1 day settings index_granularity = 8192 comment 'tbl'`,
    `CREATE TABLE IF NOT EXISTS db.t
(
    id UInt64 COMMENT 'the id',
    s String DEFAULT 'a' CODEC(ZSTD(1)),
    d Nullable(DateTime64(3, 'UTC')),
    INDEX i s TYPE bloom_filter GRANULARITY 1,
    PROJECTION p (
        SELECT id
        ORDER BY s
    ),
    CONSTRAINT c CHECK id > 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(d)
PRIMARY KEY id
ORDER BY (id, s)
SAMPLE BY id
TTL d + INTERVAL 1 DAY
SETTINGS index_granularity = 8192
COMMENT 'tbl'`,
  ],
  [
    "CREATE TABLE AS SELECT",
    `create table t engine = Memory as select 1 as a`,
    `CREATE TABLE t
ENGINE = Memory
AS SELECT 1 AS a`,
  ],
  [
    "CREATE MATERIALIZED VIEW",
    `create materialized view mv to dst as select a, count() from src group by a`,
    `CREATE MATERIALIZED VIEW mv TO dst
AS SELECT
    a,
    count()
FROM src
GROUP BY a`,
  ],
  [
    "CREATE DICTIONARY",
    `create dictionary d (id UInt64, v String default '') primary key id source(clickhouse(table 't')) layout(flat()) lifetime(min 0 max 1000)`,
    `CREATE DICTIONARY d
(
    id UInt64,
    v String DEFAULT ''
)
PRIMARY KEY id
SOURCE(clickhouse(table 't'))
LAYOUT(flat())
LIFETIME(min 0 max 1000)`,
  ],
  [
    "ALTER with several commands",
    `alter table t add column if not exists x UInt8 after y, drop column z, modify ttl d + interval 1 day`,
    `ALTER TABLE t
    ADD COLUMN IF NOT EXISTS x UInt8 AFTER y,
    DROP COLUMN z,
    MODIFY TTL d + INTERVAL 1 DAY`,
  ],
  [
    "ALTER with one command",
    `alter table t update a = 1 where b = 2`,
    `ALTER TABLE t UPDATE a = 1 WHERE b = 2`,
  ],
  [
    "INSERT VALUES keeps its data",
    `insert into t (a, b) values (1,'x;y'),(2, 'it''s')  ,  (3,NULL)`,
    `INSERT INTO t (a, b) VALUES (1,'x;y'),(2, 'it''s')  ,  (3,NULL)`,
  ],
  [
    "INSERT FORMAT keeps its data",
    `insert into t format CSV
1,"a,b"
2,'c'`,
    `INSERT INTO t FORMAT CSV
1,"a,b"
2,'c'`,
  ],
  [
    "INSERT SELECT",
    `insert into t (a) select a from s where a > 0`,
    `INSERT INTO t (a)
SELECT a
FROM s
WHERE a > 0`,
  ],
  [
    "EXPLAIN",
    `explain syntax select 1 from t where a`,
    `EXPLAIN SYNTAX
SELECT 1
FROM t
WHERE a`,
  ],
  [
    "other statements on one line",
    `drop table if exists db.t on cluster c sync`,
    `DROP TABLE IF EXISTS db.t ON CLUSTER c SYNC`,
  ],
  [
    "SET",
    `set max_threads=8,  log_queries = 1`,
    `SET max_threads = 8, log_queries = 1`,
  ],
  [
    "SYSTEM and SHOW",
    `show create table db.t`,
    `SHOW CREATE TABLE db.t`,
  ],
];
