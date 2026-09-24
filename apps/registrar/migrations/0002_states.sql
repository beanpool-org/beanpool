-- 0002: ownership states — a name belongs to its node's key, and `revoked` no longer means free.
-- Design: scratch/registrar/DESIGN-2026-09-24-fable.md §2.1, §6.1.
--
-- name_allocations.status after this migration:
--   'pending'   claimed, awaiting admin approval (gated names)
--   'live'      routed
--   'paused'    not routed, name kept by its key; pause_reason says why:
--                 'impostor'            another node key answered at the hostname (sweep)
--                 'admin'               paused by the admin — only the admin resumes it
--                 'incident-2026-09-24' revoked by the registrar's own verifier bug; its node heals it
--   'released'  let go (owner `release`/`offline`, or admin `release`). Owner release: held RELEASE_COOLOFF_S
--               (30 d) for the same key, then free. Admin release (pause_reason 'admin'): free at once.
--   'abandoned' free (set by a later PR, after the 12-month clock; nothing sets it yet)
--   'blocked'   killed by the admin: not routed, never free, the owner cannot heal it
-- A legacy 'revoked' row no longer exists after this file; code that meets one treats it as held.
--
-- Additive: new columns and tables only; the old Worker keeps running against the result (a 'paused' row is
-- simply "not revoked" to it). Apply this BEFORE deploying the Worker that reads the new columns.
-- Re-running: SQLite has no ADD COLUMN IF NOT EXISTS, so a second run stops at its first statement (the ALTER
-- below: "duplicate column name") before changing anything. Every data statement is also guarded, so a rerun
-- past the ALTERs would change nothing either.

ALTER TABLE name_allocations ADD COLUMN pause_reason TEXT;       -- why the row is not live (see above)
ALTER TABLE name_allocations ADD COLUMN paused_at INTEGER;       -- unix s routing stopped (paused / blocked)
ALTER TABLE name_allocations ADD COLUMN released_at INTEGER;     -- unix s of the release
ALTER TABLE name_allocations ADD COLUMN last_ok_at INTEGER;      -- last attest 'ok' (last_attest_at kept for rollback)
ALTER TABLE name_allocations ADD COLUMN last_contact_at INTEGER; -- last valid signed request from the owner key
ALTER TABLE name_allocations ADD COLUMN warned_at INTEGER;       -- abandonment warning first served (later PR)
ALTER TABLE name_allocations ADD COLUMN proto TEXT;              -- signing protocol the owner last used ('v1')

-- One row per attestation sweep: the breaker's verdict and what it saw.
CREATE TABLE IF NOT EXISTS sweep_log (
    id           INTEGER PRIMARY KEY,
    ran_at       INTEGER NOT NULL,
    live_count   INTEGER NOT NULL,
    ok           INTEGER NOT NULL,
    unverifiable INTEGER NOT NULL,
    impostor     INTEGER NOT NULL,
    content_swap INTEGER NOT NULL,   -- a 2xx that is no attest at all; counted only (never acted on here)
    action       TEXT NOT NULL       -- 'applied' | 'suspended:canary' | 'suspended:mass' | 'suspended:unverifiable'
);
CREATE INDEX IF NOT EXISTS idx_sweep_ran ON sweep_log(ran_at);

-- What happened to each name, and who did it — the admin's audit trail.
CREATE TABLE IF NOT EXISTS name_events (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL,
    at     INTEGER NOT NULL,
    event  TEXT NOT NULL,            -- 'claimed' | 'healed' | 'released' | 'paused' | 'resumed' | 'blocked' | …
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_name ON name_events(name, at);
CREATE INDEX IF NOT EXISTS idx_events_at ON name_events(at);

UPDATE name_allocations SET last_ok_at = last_attest_at WHERE last_ok_at IS NULL AND last_attest_at IS NOT NULL;

-- ── The 2026-09-24 incident ─────────────────────────────────────────────────────────────────────────────
-- A Worker that could not verify the nodes' signing format revoked names (tunnel + DNS deleted, name free).
-- Cut-off: 2026-09-24 17:00 AEST = 1790233200. Window: from 2026-08-31 (1788134400) until this migration, a
-- revoked name was free to any key.

-- (1) For a human, not for the code: every name claimed inside the window. A claim over a revoked name
-- overwrote that row (one row per name), so the registrar has no record of who held it before — this list is
-- the only way to find a victim whose name another key took. Nobody is evicted.
INSERT INTO name_events (name, at, event, detail)
SELECT a.name, CAST(strftime('%s', 'now') AS INTEGER), 'incident-review',
       'claimed ' || datetime(a.requested_at, 'unixepoch') || 'Z by key ' || substr(a.node_pubkey, 1, 16)
       || '… (now ' || a.status || ') while names revoked in the 2026-09-24 incident were free to any key. '
       || 'The registrar kept no record of earlier holders: if another community held this name before, '
       || 'that is a conflict for you to decide. The current holder was NOT evicted.'
FROM name_allocations a
WHERE a.status IN ('pending', 'live') AND a.requested_at >= 1788134400
  AND NOT EXISTS (SELECT 1 FROM name_events e WHERE e.name = a.name AND e.event = 'incident-review');

-- (2) The victims: revoked by the sweep (attest_fails >= 2 — /offline and admin revoke never set it) and live
-- before the cut-off. Back to their ORIGINAL key as paused/incident; the node's next claim heals it. Every code
-- path that made a row live set decided_at; a row made by hand may lack it, and then its claim time stands in
-- (without it, step 3 would call a victim an impostor).
INSERT INTO name_events (name, at, event, detail)
SELECT a.name, CAST(strftime('%s', 'now') AS INTEGER), 'incident-restore',
       'revoked by the registrar''s own verifier bug (attest_fails=' || a.attest_fails || '); restored to paused '
       || 'for its original key ' || substr(a.node_pubkey, 1, 16) || '…. Its node heals it (a fresh tunnel); '
       || 'no one needs to act.'
FROM name_allocations a
WHERE a.status = 'revoked' AND a.attest_fails >= 2 AND COALESCE(a.decided_at, a.requested_at) < 1790233200
  AND NOT EXISTS (SELECT 1 FROM name_events e WHERE e.name = a.name AND e.event = 'incident-restore');

-- … and if that key has since taken another name, both are now its; say so.
INSERT INTO name_events (name, at, event, detail)
SELECT a.name, CAST(strftime('%s', 'now') AS INTEGER), 'incident-review',
       'restored for key ' || substr(a.node_pubkey, 1, 16) || '…, which meanwhile also holds '
       || group_concat(b.name || ' (' || b.status || ')', ', ') || '. Decide which name that community keeps.'
FROM name_allocations a
JOIN name_allocations b ON b.node_pubkey = a.node_pubkey AND b.name <> a.name AND b.status IN ('pending', 'live')
WHERE a.status = 'revoked' AND a.attest_fails >= 2 AND COALESCE(a.decided_at, a.requested_at) < 1790233200
  AND NOT EXISTS (SELECT 1 FROM name_events e WHERE e.name = a.name AND e.event = 'incident-review')
GROUP BY a.name;

UPDATE name_allocations
SET status = 'paused', pause_reason = 'incident-2026-09-24', paused_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'revoked' AND attest_fails >= 2 AND COALESCE(decided_at, requested_at) < 1790233200;

-- (3) Revoked by the sweep for a name that went live after the cut-off: PR 0's verifier, so a valid signature
-- by another key really answered. Kept for its key as paused/impostor, like the sweep does from now on.
INSERT INTO name_events (name, at, event, detail)
SELECT a.name, CAST(strftime('%s', 'now') AS INTEGER), 'paused',
       'migrated: revoked by the sweep for an impostor (attest_fails=' || a.attest_fails || '); now paused '
       || 'for its key ' || substr(a.node_pubkey, 1, 16) || '…, not free.'
FROM name_allocations a
WHERE a.status = 'revoked' AND a.attest_fails >= 2;

UPDATE name_allocations
SET status = 'paused', pause_reason = 'impostor', paused_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'revoked' AND attest_fails >= 2;

-- (4) Every other revoked row came from /offline or an admin revoke (the old schema cannot tell which). Both
-- were free until now; they become released, held 30 days for the same key from today, then free.
INSERT INTO name_events (name, at, event, detail)
SELECT a.name, CAST(strftime('%s', 'now') AS INTEGER), 'released',
       'migrated: was revoked (/offline or an admin revoke — the old schema cannot tell which). Held 30 days '
       || 'for key ' || substr(a.node_pubkey, 1, 16) || '…, then free. If it was an admin kill, block it again.'
FROM name_allocations a
WHERE a.status = 'revoked';

UPDATE name_allocations
SET status = 'released', released_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE status = 'revoked';
