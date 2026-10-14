-- 0007: a content swap behind a live name is acted on (design D2, decided 2026-09-24: b; M3 of the 2026-10-01 review).
-- The attestation sweep asks every live name for /api/attest. An answer that is a 2xx but no attestation at all (a web
-- page, a parked domain, JSON with no signature) means something other than a BeanPool node answers at the name: the
-- community's direct IP address handed to a stranger, or a second connector on a leaked tunnel token. Until now it was
-- only counted (sweep_log.content_swap). swap_fails counts the applied sweeps in a row in which something other than the
-- name's own node answered there (a content swap, or another node's key); at SWAP_FAIL_LIMIT (12, about an hour) the
-- name is paused, pause_reason 'content-swap': routing off, the name kept for its key, and its owner's heal resumes it.
-- An 'ok' (asked again while a run is open) or an answer from no origin at all ends the run; a sweep that judged
-- itself wrong (suspended) changes nothing. src/index.js applyVerdict.
--
-- NULL on every existing row (and on a new claim's row) until its first sweep: the code counts NULL as 0. Apply before
-- deploying the Worker that reads it (the deploy workflow applies migrations/ first). Re-running stops at the ALTER
-- ("duplicate column name") and changes nothing.

ALTER TABLE name_allocations ADD COLUMN swap_fails INTEGER;
