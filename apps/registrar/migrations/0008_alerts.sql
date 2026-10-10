-- 0008: the control room's alerts to the registrar's admin (design scratch/global-node/DESIGN-alerts-fable.md §2, S1;
-- decided by Marty 2026-10-10). The Worker tells its admin's phone, through one ntfy topic (Worker secrets NTFY_URL and
-- NTFY_TOKEN, never here), about name requests waiting for approval, new communities, names the sweep paused, a sweep
-- that suspended itself, and the admin's own actions. src/alerts.js is the alert book; its words carry a name, the
-- community name its operator published, and counts — never the `contact` column.
--
--   alert_settings  one row per category (names, health, uptake, admin): on = sent at once, digest = held for the daily
--                   summary (the S2 slice sends it), off = nothing. /admin's toggles write it.
--   alert_state     a condition that is raised (a suspended sweep, deletions Cloudflare keeps refusing): told once when
--                   it starts, again every 24 h while it lasts (last_told_at), once when it ends (the row goes).
--   alert_outbox    events waiting to be sent (sent_at NULL), sent, held for the digest (held 1) or muted by the hourly cap
--                   (muted 1). A failed send keeps them; the next try sends everything waiting, at most 50, in one message.
--                   claim/claim_at let one sender take the waiting rows at a time. Sent and muted rows go after 7 days.
--   alert_channel   the channel's state (one row, 'ntfy'): last good send, failures in a row and the next try (every 5 min
--                   while it fails), the hour's count for the cap of 20 messages an hour, and waiting events dropped over 50.
--
-- Additive: four new tables, their two indexes and the four category rows. Apply before deploying the Worker that
-- writes them (an older Worker never reads them; a newer one without them sends nothing and logs why). Re-running
-- changes nothing.

CREATE TABLE IF NOT EXISTS alert_settings (
    category TEXT PRIMARY KEY,                                        -- names | health | uptake | admin
    mode     TEXT NOT NULL DEFAULT 'on' CHECK (mode IN ('on', 'digest', 'off'))
);
INSERT OR IGNORE INTO alert_settings (category, mode) VALUES ('names', 'on'), ('health', 'on'), ('uptake', 'on'), ('admin', 'on');

CREATE TABLE IF NOT EXISTS alert_state (
    key            TEXT PRIMARY KEY,   -- the condition, e.g. 'sweep-suspended'
    since          INTEGER NOT NULL,   -- when it was raised (unix s)
    last_told_at   INTEGER NOT NULL,   -- when it was last told (raised, or a 24 h reminder)
    detail         TEXT,               -- its words as last seen
    last_seen_json TEXT,               -- the condition as last evaluated (category, priority, title)
    told_id        INTEGER             -- the alert_outbox row that last told it (muted: told again in the next hour)
);

CREATE TABLE IF NOT EXISTS alert_outbox (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,             -- when it happened (unix s)
    category TEXT NOT NULL,                -- names | health | uptake | admin | test
    priority INTEGER NOT NULL,             -- ntfy: 1 min … 5 urgent
    tag      TEXT,                         -- ntfy tag (an emoji short code)
    title    TEXT NOT NULL,
    body     TEXT NOT NULL,
    name     TEXT,                         -- the name it is about, for the tap (/admin#<name>)
    held     INTEGER NOT NULL DEFAULT 0,   -- 1 = held for the digest
    muted    INTEGER NOT NULL DEFAULT 0,   -- 1 = not sent: over the hourly cap
    sent_at  INTEGER,
    claim    TEXT,
    claim_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_waiting ON alert_outbox(sent_at, held, muted);
CREATE INDEX IF NOT EXISTS idx_alert_outbox_at ON alert_outbox(at);   -- the 7-day prune each event runs reads by it

CREATE TABLE IF NOT EXISTS alert_channel (
    channel         TEXT PRIMARY KEY,               -- 'ntfy'
    last_ok_at      INTEGER,
    last_try_at     INTEGER,
    last_status     TEXT,                           -- 'HTTP 503', 'timed out', 'unreachable' — never the address
    failed_in_a_row INTEGER NOT NULL DEFAULT 0,
    next_try_at     INTEGER NOT NULL DEFAULT 0,
    hour_start      INTEGER NOT NULL DEFAULT 0,     -- the UTC hour the counts below are for (unix s)
    hour_sent       INTEGER NOT NULL DEFAULT 0,     -- messages sent in it (the cap is 20)
    hour_muted      INTEGER NOT NULL DEFAULT 0,     -- events not sent in it
    dropped         INTEGER NOT NULL DEFAULT 0      -- waiting events dropped over 50
);
