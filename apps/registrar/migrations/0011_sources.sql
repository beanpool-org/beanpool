-- 0011: where new names come from, holding rather than refusing, probation, and the private settings (slice S3 of
-- scratch/global-node/DESIGN-registrar-trust-fable.md §4; decided by Marty 2026-10-18: D6 = hold, never refuse; "open
-- code, private settings"; the DNS cap). src/index.js takeName, src/settings.js.
--
--   claim_sources    one row per new name claimed (a new tenure: auto or gated, held or not; never a heal, a status or a
--                    key's own name): where its claim came from, as Cloudflare's edge saw it — a keyed hash of the
--                    connecting address (HMAC-SHA-256 under the Worker secret SOURCE_KEY; the address itself is never
--                    stored, and without the secret nothing is), the network (ASN, its organisation) and the country.
--                    The per-source budgets count it; /admin groups the last 24 h by it. The sweep deletes rows older
--                    than 24 h, except a name's still held for approval (kept until the name is decided).
--   blocked_sources  a source (its hash) or a network (an ASN) the admin blocked: a claim of a new name from it is refused
--                    403 before anything is written, until `until`. "Block all" on a source group writes one for 7 days.
--   settings         the live limits (per-source and global budgets, names per key, probation, the sweep's strikes, the
--                    DNS capacity) and the "Hold all new names" switch, edited in /admin. Absent = the code's safe
--                    default (src/settings.js); the live numbers are kept here, not in the public wrangler.toml or README.
--   name_allocations.held_reason  a pending row held for the admin's approval although its name is auto (over a limit,
--                    the hold switch, the DNS near full): it waits as a gated claim does, and the sweep never finishes it.
--   name_allocations.verified_at  when a live name ended its probation (enough ok sweeps in a row, and old enough):
--                    until then it is routed but off the switchboard (/i/), its node is told `probation: true` (its
--                    directory listing waits), and the "New community" alert waits. NULL = on probation.
--   name_allocations.ok_sweeps    ok sweeps in a row, while on probation (NULL counts as 0).
--
-- Every existing name that is not pending is set verified here: none goes back on probation at deploy. Apply before
-- deploying the Worker that reads it (the deploy workflow applies migrations/ first; an older Worker ignores all of it).
-- Re-running stops at the first ALTER ("duplicate column name") and changes nothing.

ALTER TABLE name_allocations ADD COLUMN held_reason TEXT;
ALTER TABLE name_allocations ADD COLUMN verified_at INTEGER;
ALTER TABLE name_allocations ADD COLUMN ok_sweeps INTEGER;
UPDATE name_allocations SET verified_at = COALESCE(decided_at, requested_at, 0) WHERE status <> 'pending';

CREATE TABLE IF NOT EXISTS claim_sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,   -- the claim (unix s)
    name        TEXT NOT NULL,
    node_pubkey TEXT NOT NULL,      -- the key that claimed it (public: its node signs with it)
    source_hash TEXT,               -- HMAC-SHA-256(SOURCE_KEY, connecting address), hex; NULL without the secret
    asn         INTEGER,            -- request.cf.asn
    as_org      TEXT,               -- request.cf.asOrganization
    country     TEXT,               -- request.cf.country
    held_reason TEXT                -- why the claim was held for approval, or NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_sources_at ON claim_sources(at);
CREATE INDEX IF NOT EXISTS idx_claim_sources_source ON claim_sources(source_hash, at);
CREATE INDEX IF NOT EXISTS idx_claim_sources_asn ON claim_sources(asn, at);

CREATE TABLE IF NOT EXISTS blocked_sources (
    kind  TEXT NOT NULL CHECK (kind IN ('source', 'asn')),
    value TEXT NOT NULL,            -- the source hash, or the ASN as text
    until INTEGER NOT NULL,         -- refused until then (unix s)
    at    INTEGER NOT NULL,         -- when it was blocked
    by    TEXT,                     -- the admin (Access email), or NULL
    label TEXT,                     -- what the admin saw: the network's name, the country, how many names
    PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,    -- src/settings.js SETTINGS
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);
