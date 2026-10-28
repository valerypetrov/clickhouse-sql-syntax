-- A .sql file that the workspace settings map to ClickHouse SQL.
SELECT toYear(event_time) AS year, count() FROM hits GROUP BY year ORDER BY year;
