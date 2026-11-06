-- A .sql file that stays with the built-in SQL language, so its tables are not ClickHouse's.
CREATE TABLE ignored_table (x UInt8) ENGINE = Memory;
