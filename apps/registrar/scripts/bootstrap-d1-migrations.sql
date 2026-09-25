-- ONE TIME, on the LIVE database, before the deploy workflow's first run (the workflow refuses to apply migrations
-- until this has run — scripts/deploy-checks.mjs `bootstrapped`):
--
--   npx wrangler d1 execute beanpool-registrar --remote --file scripts/bootstrap-d1-migrations.sql
--
-- The live database predates `wrangler d1 migrations`: it was made from schema.sql (now migrations/0001_init.sql,
-- which must never run against it), and 0002–0004 are applied by hand with `d1 execute --file` (README "Schema and
-- migrations"). This records, in the table wrangler keeps its migrations in, each migration whose objects the
-- database already has, so `wrangler d1 migrations apply --remote` applies only the ones it doesn't. A migration
-- not recorded here is applied by the workflow; one only half there fails at its first statement, changing nothing.
--
-- Safe to re-run, and on a database at any stage: it makes the table only if it's missing and records each
-- migration at most once. The table is exactly the one wrangler makes (initMigrationsTable in wrangler 3).

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

SELECT id, name, applied_at FROM d1_migrations ORDER BY id;
