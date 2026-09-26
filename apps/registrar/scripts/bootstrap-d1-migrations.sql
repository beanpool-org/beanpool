-- ONE TIME, on the LIVE database, before the deploy workflow's first run (the workflow refuses to apply migrations
-- until this has run — scripts/deploy-checks.mjs `bootstrapped`):
--
--   npx wrangler d1 execute beanpool-registrar --remote --file scripts/bootstrap-d1-migrations.sql
--
-- The live database predates `wrangler d1 migrations`: it was made from schema.sql (now migrations/0001_init.sql,
-- which must never run against it), and 0002–0005 are applied by hand with `d1 execute --file` (README "Schema and
-- migrations"). This records, in the table wrangler keeps its migrations in, each migration whose objects the
-- database already has, so `wrangler d1 migrations apply --remote` applies only the ones it doesn't. A migration
-- not recorded here is applied by the workflow; one only half there fails at its first statement, changing nothing.
--
-- Safe to re-run, and on a database at any stage: it makes the table only if it's missing and records each
-- migration at most once. The table is exactly the one wrangler makes (initMigrationsTable in wrangler 3). The only
-- other thing it ever makes is 0001's name_policy, on a database that has no name_policy at all (see 0005 below).

CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 0001: its three tables.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0001_init.sql'
WHERE (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('name_allocations', 'name_policy', 'invites')) = 3;

-- 0002: its seven columns (an added column is appended to the table's CREATE text as written), both tables and
-- all three indexes.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0002_states.sql'
WHERE (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('sweep_log', 'name_events')) = 2
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('idx_sweep_ran', 'idx_events_name', 'idx_events_at')) = 3
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%pause_reason TEXT%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%paused_at INTEGER%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%released_at INTEGER%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%last_ok_at INTEGER%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%last_contact_at INTEGER%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%warned_at INTEGER%'
  AND (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%proto TEXT%';

-- 0003: its column.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0003_decision_seq.sql'
WHERE (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'name_allocations') LIKE '%decision_seq INTEGER%';

-- 0004: its table and index.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0004_teardown.sql'
WHERE (SELECT COUNT(*) FROM sqlite_master WHERE (type = 'table' AND name = 'teardown') OR (type = 'index' AND name = 'idx_teardown_name')) = 2;

-- 0005: all three of its policy rows, at any tier (the admin may have moved one since). The live table has global and
-- earth, put there by hand before 0005 existed, but not ssh-global, so there 0005 is not recorded: the workflow applies
-- it, and its INSERT OR IGNORE adds only the missing row. Looking for rows needs name_policy there: SQLite refuses a
-- statement that names a missing table, whatever its WHERE says, and wrangler runs this file as one batch, so on a
-- database 0001 never reached the whole file would fail. So name_policy is made first where it is missing, exactly as
-- 0001 makes it (the same text, so a later 0001 finds it and changes nothing); on a database 0001 has reached this does
-- nothing. It comes after 0001's clause, which needs all three of 0001's tables, so it is never taken for 0001.
CREATE TABLE IF NOT EXISTS name_policy (
    pattern TEXT PRIMARY KEY,   -- exact name
    tier    TEXT NOT NULL       -- 'blocked' | 'gated'   (anything absent = auto)
);
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0005_reserve_global.sql'
WHERE (SELECT COUNT(*) FROM name_policy WHERE pattern IN ('global', 'earth', 'ssh-global')) = 3;

SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
