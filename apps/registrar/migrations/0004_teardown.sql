-- 0004: Cloudflare resources the registrar let go of but Cloudflare refused to delete — owed deletions.
-- A request that lets go of a tunnel or DNS record (another key taking a name over, a tunnel a failed request made,
-- one an undo or a resume could not delete, a take-down's record, the record a failed re-attest took back down) and
-- has its delete refused writes it here instead of dropping it: a live bp-<name> tunnel nobody records makes
-- Cloudflare refuse every later tunnel for the name (error 1013), and a record left up keeps routing a node the
-- registrar no longer routes. The sweep retries every row each run; a row goes once the resource is gone (deleted, or
-- already a 404), or, for a record, once the name's live row records it as its own. A tunnel a live row, or an admin
-- pause, still keeps stays owed until no row keeps it.
--
-- Additive: one new table. Apply before deploying the Worker that writes it. Re-running changes nothing.

CREATE TABLE IF NOT EXISTS teardown (
    kind       TEXT NOT NULL,              -- 'tunnel' | 'dns'
    cf_id      TEXT NOT NULL,              -- the tunnel's id, or the DNS record's
    name       TEXT NOT NULL,              -- the name it served (tunnel bp-<name>, record at <name>.<BASE_DOMAIN>)
    since      INTEGER NOT NULL,           -- unix s it was first owed
    tries      INTEGER NOT NULL DEFAULT 0, -- retries Cloudflare has refused since
    last_error TEXT,
    PRIMARY KEY (kind, cf_id)
);
CREATE INDEX IF NOT EXISTS idx_teardown_name ON teardown(name);
