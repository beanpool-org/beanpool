-- 0012: the public status line (design scratch/global-node/DESIGN-global-mothership-fable.md §3.2 U4, slice A8;
-- accepted by Marty 2026-10-18). At each watch tick src/status.js counts each server's looks by UTC day from watch_log
-- (which keeps 30 days) into watch_days (kept 100), and writes status.json (per server named in STATUS_SERVERS, and
-- the registrar itself: up now, the last incident, the 90-day percentage) to the STATUS KV namespace, which
-- GET /api/registrar/status.json serves and beanpool.org/status draws.
--
--   watch_days   one row per watched server per UTC day: its looks and how many answered as ours. The registrar's own
--                rows are target '(registrar)' (never a WATCH_TARGETS name: those are [a-z0-9-]): the ticks that ran
--                that day. A day is counted again from watch_log at every tick until the next one begins, so a tick
--                that failed loses nothing. Internal, as watch_log is: only the servers in STATUS_SERVERS are published.
--
-- Its marks go in watch_marks (0009): 'status:since' (the first tick counted: the registrar's line starts there) and
-- 'status:incident:<name>' (the last incident: since = when it began, value = {"ended": unix s or null, "why": ...}).
--
-- Additive: one new table. Apply before deploying the Worker that writes it (an older Worker never reads it; a newer
-- one without it publishes nothing and logs why — the watch and the sweep are not touched). Re-running changes nothing.

CREATE TABLE IF NOT EXISTS watch_days (
    target TEXT NOT NULL,                    -- its name in WATCH_TARGETS, or '(registrar)': the watch's own ticks
    day    TEXT NOT NULL,                    -- the UTC day, YYYY-MM-DD
    looks  INTEGER NOT NULL,                 -- looks that day (the registrar's: ticks that ran)
    ok     INTEGER NOT NULL,                 -- of them, answered as ours (watch_log.ok)
    PRIMARY KEY (target, day)
);
