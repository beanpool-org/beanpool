-- 0009: the control room's outside checks (design scratch/global-node/DESIGN-alerts-fable.md §2.3, slice S2; decided by
-- Marty 2026-10-10). Every 5 minutes the Worker looks at our servers from outside (WATCH_TARGETS in wrangler.toml: global,
-- the vault, mullum, castlemaine, test) and tells the admin's phone through src/alerts.js when one stops answering, the
-- vault stays locked or its signed report says something is wrong, a release changes, or the host watchdog restarted
-- a node; and once a day, at 08:00 Brisbane, one quiet line with how they all are and what the digest held.
--
--   watch_log    one row per target per look: whether it answered (2xx), how fast, what it said (status), and what it
--                runs (version, commit); for the vault its state and what its signed report came to; for a node its
--                host watchdog's recoveries. Kept 30 days. The conditions are read from it (two failed looks in a row
--                = down), and /admin's "Our servers" panel shows its newest row per target.
--   watch_marks  small marks the checks keep between ticks: since when our nodes run different releases, and the
--                Brisbane day whose daily line is sent (a conditional write, so two ticks never both send it).
--
-- Additive: two new tables and two indexes. Apply before deploying the Worker that writes them (an older
-- Worker never reads them; a newer one without them watches nothing and logs why — the sweep is not touched).
-- Re-running changes nothing.

CREATE TABLE IF NOT EXISTS watch_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at     INTEGER NOT NULL,             -- the look (unix s)
    target     TEXT NOT NULL,                -- its name in WATCH_TARGETS
    ok         INTEGER NOT NULL,             -- 1 = it answered 2xx
    ms         INTEGER,                      -- how long the answer took
    status     TEXT,                         -- 'HTTP 200', 'HTTP 302', 'timed out', 'unreachable'
    version    TEXT,                         -- what it runs, as it says (a node's /api/version; the vault's release)
    commit_sha TEXT,                         -- a node's commit
    state      TEXT,                         -- the vault: open | locked
    report     TEXT,                         -- the vault's signed report: fine | unverifiable | stale | missing | unreadable | not checked
    recoveries INTEGER                       -- a node's host watchdog restarts, as its health says
);
CREATE INDEX IF NOT EXISTS idx_watch_log_target ON watch_log(target, id);   -- a target's newest looks
CREATE INDEX IF NOT EXISTS idx_watch_log_ran ON watch_log(ran_at);          -- the 30-day prune

CREATE TABLE IF NOT EXISTS watch_marks (
    key   TEXT PRIMARY KEY,                  -- 'fleet-differs' | 'daily'
    since INTEGER,                           -- fleet-differs: since when (unix s)
    value TEXT                               -- daily: the Brisbane day sent (YYYY-MM-DD)
);
