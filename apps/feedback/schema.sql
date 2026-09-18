-- BeanPool feedback — D1 schema (database `beanpool-feedback`).
--
-- What is NOT here, on purpose: no IP address, no user agent, no member key, no node address.
-- The rate-limit tables hold only a salted hash whose salt is deleted at the end of each UTC day,
-- and nothing in them references a feedback row.

CREATE TABLE IF NOT EXISTS feedback_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT    NOT NULL,              -- 10–2000 characters after trim
    kind        TEXT    NOT NULL,              -- 'idea' | 'problem' | 'other'
    source      TEXT    NOT NULL,              -- 'member-app' | 'web' | 'settings-app'
    app_version TEXT,                          -- e.g. '1.2.37'
    platform    TEXT,                          -- e.g. 'android' | 'ios' | 'web'
    lang        TEXT,                          -- BCP-47 tag the app was running in, e.g. 'es-AR'
    community   TEXT,                          -- only if the member chose to say; free text ≤ 80
    received_at INTEGER NOT NULL,              -- unix seconds
    status      TEXT    NOT NULL DEFAULT 'new',-- 'new' | 'spam' | 'triaged' | 'filed'
    github_url  TEXT,                          -- set when Marty files it as a Discussion/issue
    note        TEXT,                          -- triage note (digest cluster, reason for spam, …)
    updated_at  INTEGER                        -- unix seconds of the last status change
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_items(status, id);

-- One random salt per UTC day. Yesterday's row is deleted as soon as today's is made (and by the
-- daily cron), so a hash from a past day can no longer be tested against a guessed IP.
CREATE TABLE IF NOT EXISTS rate_salts (
    day  TEXT PRIMARY KEY,                     -- 'YYYY-MM-DD' (UTC)
    salt TEXT NOT NULL                         -- 32 random bytes, hex
);

-- Submission counters per salted hash. bucket is 'h<hour-of-epoch>' or 'd<day>'.
CREATE TABLE IF NOT EXISTS rate_buckets (
    hash   TEXT    NOT NULL,
    bucket TEXT    NOT NULL,
    day    TEXT    NOT NULL,                   -- for the daily purge
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hash, bucket)
);

CREATE INDEX IF NOT EXISTS idx_rate_day ON rate_buckets(day);
