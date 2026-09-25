-- 0003: every decision on a row is visible to a request in flight, even one that changes no status.
-- A request reads a row, works at Cloudflare, then writes only if the row is still as it read it (db.js
-- updateIfUnchanged). Blocking a blocked name, or pausing a paused one, changes no status or reason, so an admin
-- resume in flight used to go live over it. decision_seq is bumped by every write that takes routing down (the
-- admin's pause, block and release, the owner's release, the sweep's pause — a repeat included), by admin resume's
-- first write and by a new tenure, and the conditional writes compare it.
--
-- NULL on every existing row (and on a new claim's row) until its first decision: the code counts NULL as 0.
-- Apply after 0002 and before deploying the Worker that reads it. Re-running stops at the ALTER ("duplicate column
-- name") and changes nothing.

ALTER TABLE name_allocations ADD COLUMN decision_seq INTEGER;
