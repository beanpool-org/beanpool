# Delta backup restoration — implementation plan

Status: **planned, not built** (2026-07-20). Supersedes the full-DB backup pull for
scale. Owner decision pending on staging order.

## Why

The fleet manager currently backs up each node by pulling the **entire DB**
(`POST /api/local/admin/backup` → `VACUUM INTO` → tar.gz) whenever any
member/post/transaction count changes. That does not scale: at GB-scale DBs it
moves gigabytes per change, and the P2P/import path has a hard **10 MB payload
cap** (state-engine.ts ~3845 — a full snapshot past 10 MB is *rejected*). rsync
was evaluated and rejected: it works (proven ~20 MB → 2 KB) but its cost lands on
the node host (reads+hashes the whole file every sync) and grows with DB size on
the same 1-core VMs that froze on 2026-07-18. So: **application-level delta**,
whose cost scales with the change, using the machinery already in the repo.

## What already exists (reuse, don't rebuild)

- `SyncPayload` envelope with per-row timestamps + `tombstones[]` + `cursor` (state-engine.ts:3544)
- `sync_cursors` table + `getSyncCursor` / `setSyncCursor` (per-peer watermarks)
- `importRemoteState` — the 634-line **security-critical** LWW applier (role guard, signature verify, balance recompute, tombstone apply). Handles partial payloads already.
- `applyTombstone` + `writeTombstone` (LWW-aware deletes)
- `updated_at` columns **+ indexes + touch-triggers** on: `members`, `post_photos`, `projects`, `transactions`, `marketplace_transactions`, `recovery_requests`
- The proven pattern (from the two-way mirror, per the comment at 3535): **delta pull every 30s + full reconcile every 15 min**.

## What's missing / to build

1. **Delta export** — `exportSyncState` is full `SELECT *`. Add an optional
   `since` cursor so each table selects `WHERE <watermark> > ?` (using the
   indexes), plus `tombstones WHERE deleted_at > ?`, and set `payload.cursor` to
   a timestamp captured *before* the read (so a row written mid-export is
   re-sent next time, not lost — LWW dedupes). Sign identically to the snapshot.
2. **Endpoint** — `POST /api/local/admin/sync-delta` taking `X-Since-Cursor`,
   auth + signing mirrored from `/api/local/admin/sync-snapshot`.
3. **Mutation watermarks on the mutable tables that lack them** — `messages`
   (chat: reactions/edits!), `ratings` (editable), `posts`, `friends`,
   `conversations`, `conversation_participants`, `accounts` (has `last_updated_at`,
   confirm), `abuse_reports`, `recovery_approvals`. Add `updated_at` + a
   `_touch_updated_at` trigger each, mirroring the existing ones. **Backfill**
   existing rows (`updated_at = COALESCE(created_at, timestamp, now)`) in an
   idempotent migration. Without this, edits to those tables are invisible to
   delta and only caught by full reconcile — which breaks past 10 MB.
4. **Consumer** — the manager tracks a per-node cursor, pulls the delta, verifies
   signature, applies (LWW upsert + tombstones), advances the cursor.
   `importRemoteState` is the safe applier but is TS-in-the-node; the manager is
   JS. Two options (decision needed):
   - **(A) manager-side applier** — port the LWW upsert + tombstone apply (~250
     lines) into the manager, keep the node's signature-verify. Lower infra, but
     duplicates applier logic.
   - **(B) backup-mode node replica** — run a `NODE_ROLE=backup` instance per
     node that pulls deltas via `importRemoteState` (the exact proven code); the
     manager reads its DB. Zero reimplementation, more infra (N replica procs).
     This is closest to "what worked before" (the mirror was node-based).
5. **Scalable verification** — `getStateHash()` (already on the payload) compared
   per-cycle; on mismatch, a **targeted per-table re-sync** (not a full-state
   pull — that hits the 10 MB cap). Keep a 15-min full reconcile only while DBs
   are < ~8 MB; disable it above that and rely on watermark-complete deltas.

## Staging (each step tested before the next; schema steps tested on a DB copy first)

1. **Watermarks migration** (#3) — idempotent `ALTER TABLE ADD COLUMN updated_at`
   + triggers + backfill. Test on a *copy* of a real node DB; verify no data
   loss, triggers fire, backfill correct. Deploy to fleet. **Highest-risk step —
   it touches live ledger schemas.**
2. **Delta export + endpoint** (#1, #2) — additive; test in isolation by curling
   `sync-delta` with a cursor and diffing against `sync-snapshot`.
3. **Consumer** (#4) — build behind a flag; run in shadow (delta-apply into a
   scratch replica) and hash-compare against the full-pull replica until they
   match for N cycles, then cut over.
4. **Cut over + retire the full-tar pull**; keep it as the break-glass path.

## Risks

- Schema migration on live ledger DBs — mitigate: idempotent, tested on copy, backup-before.
- Applier drift corrupting the backup — mitigate: shadow-run + hash-compare before cutover; keep full-tar break-glass.
- Cursor edge cases (clock skew, mid-export writes) — mitigate: cursor = pre-read timestamp; LWW dedupe.
