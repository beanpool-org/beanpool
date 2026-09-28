/**
 * Backup Puller — one-directional live backup (Phase 1)
 *
 * This is the BACKUP side of the new replication topology. State flows
 * primary → backup ONLY:
 *
 *   - The PRIMARY (the live authority everyone transacts against) imports state
 *     from NOBODY. `importRemoteState` refuses unless NODE_ROLE=backup, so the
 *     SRV-20/21 ledger-forgery vector has no trusted writer on the primary.
 *   - The BACKUP (NODE_ROLE=backup) periodically PULLS a read-only signed
 *     snapshot from the primary over authenticated HTTPS
 *     (`GET /api/local/admin/sync-snapshot`, X-Admin-Password header) and imports
 *     it locally via the existing `importRemoteState` path. That import enforces
 *     (1) payload Ed25519 signature, (2) the signer maps to a trusted `mirror`
 *     connector (the primary), and (3) the zero-sum conservation guard — which on
 *     a backup runs UNCONDITIONALLY (A2-8), not only under ENFORCE_LEDGER_AUTH —
 *     so a forged/tampered or value-creating snapshot is rejected. A replayed
 *     older snapshot is rejected by the `generatedAt` freshness check below (A2-17).
 *
 * Why HTTPS pull and not P2P sync: the P2P sync protocol is inherently MUTUAL —
 * every handler both serves our state AND imports the peer's in the same
 * round-trip — so any P2P path would rebuild inbound trust on the primary. The
 * pull model keeps the primary with ZERO trusted connectors and importing
 * nothing. See docs/SECURITY-CUTOVER-CHECKLIST.md and SECURITY-AUDIT.md.
 *
 * Config (env):
 *   NODE_ROLE=backup              required — gates this loop AND the import guard
 *   BACKUP_PRIMARY_URL            required — e.g. https://test.beanpool.org
 *   BACKUP_REPLICATION_TOKEN      the primary's replication token (or set it under Live
 *                                 Backup Server, which stores it in local-config.json);
 *                                 sent in X-Replication-Token
 *   BACKUP_ADMIN_PASSWORD         LEGACY — the primary's admin password. Still sent while no
 *                                 token is set (a primary with two-factor or token-only on
 *                                 refuses it), but on start the standby swaps it
 *                                 for a token when it safely can (migrateStandbyPassword) and
 *                                 warns every start while it can't.
 *   BACKUP_PULL_INTERVAL_MS       optional — default 60000 (60s)
 *
 * The backup must ALSO have the primary configured as a single passive `mirror`
 * connector (enabled:false, address containing /p2p/<primaryPeerId>) so the
 * import signature gate recognizes the primary's signing key without dialing it.
 *
 * For self-signed-CA LAN primaries, point NODE_EXTRA_CA_CERTS at the primary's
 * CA pem (Node honors it for fetch); public Let's Encrypt nodes need nothing.
 */

import { importRemoteState, getNodeRole, getReplicaConsistency, clearReplicatedTables, getStateHash, getSyncCursor, setSyncCursor, type ImportResult, type SyncPayload, type ReplicaConsistency } from '../state-engine.js';
import { logger } from '../logger.js';
import { noteWholeCopyOfVisitorMarks, visitorMarksWantWholeCopy } from '../db/db.js';
import { noteWholeCopyOfReplacedKeys, replacedKeysWantWholeCopy } from '../engine/key-move.js';
import { noteWholeCopyOfMemberBlocks, memberBlocksWantWholeCopy } from '../engine/member-blocks.js';
import { REPLICA_FORMAT, replicaFormatOfCopy, noteReplicaFormat, noteLedgerMismatch, heldLedgerSum, clearForResync } from '../engine/sync.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { pullTakeoverEnvelope } from './standby-envelopes.js';
import { takeRecoverySealFullPull } from './recovery-seal-key.js';
import { getNodeProfile, readProfileRecord, writeProfileRecord } from '../config/node-profile.js';
import { compareTableHashes, readTableHashes } from '../engine/replica-hashes.js';
import { LEDGER_DIFFERS, STANDBY_REPORT_HEADER } from './standby-report.js';
import {
    HEALING_MS, lastMismatchResyncAt, noteCopyFailed, noteCopyLanded, noteMismatchResyncTaken, noteUncomparedCheck,
    noteWholeCopyCheck, pendingMismatchResync, standbyReport, whyOf,
} from './standby-copy-record.js';
import { errorMessage } from '../error-message.js';
import { keepMainServerCommunitySettings } from '../config/community-settings.js';

// Said once per value, not on every 60 s pull.
let lastProfileNote: string | null = null;

function noteMainServerProfile(record: unknown): void {
    if (!writeProfileRecord(record)) {
        logger.warn('P2P', '[Backup] The main server sent a node profile this standby could not read; kept the record it had.');
        return;
    }
    const copied = readProfileRecord().profile;
    const here = getNodeProfile();
    const note = `${copied}|${here}`;
    if (copied && copied !== here && note !== lastProfileNote) {
        logger.warn('P2P', `[Backup] ⚠️ The main server runs as ${copied}, but NODE_PROFILE here is ${here}. A take-over from `
            + `this standby is refused until NODE_PROFILE=${copied === 'local' ? '(unset)' : copied} is set here.`);
    }
    lastProfileNote = note;
}

// Said once per list, not on every 60 s pull.
let lastSettingsNote: string | null = null;

/**
 * The main server's own settings (config/community-settings.ts), from a copy the import verified: kept for a take-over
 * or a hand promotion to install, applied to nothing while this is a standby. What this standby can't take is left out,
 * and said.
 */
function noteMainServerCommunitySettings(record: unknown, copiedAt: string | null): void {
    const { kept, left } = keepMainServerCommunitySettings(record, copiedAt);
    const note = `${kept}|${left.join(',')}`;
    if (left.length > 0 && note !== lastSettingsNote) {
        logger.warn('P2P', `[Backup] The main server's settings came with what this standby doesn't take, left out: ${left.join(', ')}.`
            + (kept ? ' The rest is kept.' : ' Kept the record it had.'));
    }
    lastSettingsNote = note;
}

const SNAPSHOT_PATH = '/api/local/admin/sync-snapshot';
const DELTA_PATH = '/api/local/admin/sync-delta';
const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
// How often to fall back to a FULL reconcile instead of a delta. A full pull re-reads
// every row, so it catches the rare mutations that don't advance a per-row watermark
// (chiefly the social-recovery mass pubkey rewrite across immutable-timestamp tables)
// and lets getReplicaConsistency verify exact row-count/balance parity. Deltas carry
// the whole-state stateHash as a cheap per-cycle canary in between.
const DEFAULT_RECONCILE_EVERY_MS = 15 * 60_000;
// Above this full-payload size a reconcile is skipped and we rely on complete deltas:
// re-shipping the whole ledger as one signed JSON blob stalls the primary's event loop
// and approaches the import cap. The seed path warns separately. Deltas are unbounded-safe.
const DEFAULT_RECONCILE_MAX_BYTES = 8 * 1024 * 1024;
// sync_cursors sentinel under which we persist the delta cursor, so a backup restart
// resumes deltas instead of re-pulling a full snapshot. clearReplicatedTables() does
// NOT touch sync_cursors, so a force-resync resets it explicitly (below).
const BACKUP_CURSOR_PEER = 'backup:primary';

let pullTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let inFlight = false;
let lastSuccessAt: number | null = null;
let consecutiveFailures = 0;
// Replica-fidelity of the most recent FULL pull (delta pulls carry only changed rows,
// so a row-count compare is meaningless for them — the stateHash canary covers deltas).
let lastConsistency: ReplicaConsistency | null = null;
// A2-17: the highest snapshot generatedAt we've imported. A snapshot whose
// generatedAt is older-or-equal is a replay (or a no-op) and is skipped.
let lastGeneratedAtMs = 0;
// Raw generatedAt string of the last imported snapshot — sent to the primary as
// X-Snapshot-Cursor so unchanged full pulls come back as a bodyless 304.
let lastImportedGeneratedAt: string | null = null;
// Delta watermark: the payload.cursor of the last successful import. Sent as
// X-Since-Cursor so the primary ships only rows changed since. Persisted across
// restarts in sync_cursors. Null → no cursor yet → next pull is a full seed.
let lastImportedCursor: string | null = null;
// Full-reconcile bookkeeping.
let lastFullReconcileAt = 0;
let reconcileDisabledForSize = false;
let pendingReconcile = false; // set when a delta's stateHash canary detects drift
// The kind of the last pull tried: 'delta', 'full' or 'resync'.
let lastPullMode: PullMode | null = null;
// A whole copy found this standby's copy isn't its main server's (checkWholeCopy), at this time: the next pull is a
// force-resync, until a copy comes for it (pullOnce), for up to HEALING_MS. The standby's record keeps it too, so a
// restart before then still takes it (nextMode reads it once a process; review 4119011899).
let ledgerResyncAskedAt: number | null = null;
let ledgerResyncRestored = false;
// When this process last asked for one; the standby's record keeps it across restarts (standby-copy-record.ts).
let lastLedgerResyncAt = 0;
// At most one force-resync for a copy that doesn't match in this long: one a resync doesn't cure must not clear this
// standby over and over.
const LEDGER_RESYNC_EVERY_MS = 6 * 60 * 60_000;

/**
 * A2-9: only allow an HTTPS primary URL (loopback http permitted for dev). The
 * puller sends the shared admin password (a primary-takeover credential) and
 * pulls the full ledger; over cleartext to a non-loopback host both leak to any
 * on-path attacker. Mirrors the native client's cleartext-to-public block.
 */
export function isAllowedPrimaryUrl(rawUrl: string): boolean {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return false; }
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
        const h = u.hostname.toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    }
    return false;
}

function summarize(r: ImportResult): string {
    const parts: string[] = [];
    if (r.newMembers || r.updatedMembers) parts.push(`members+${r.newMembers}/~${r.updatedMembers}`);
    if (r.newPosts || r.updatedPosts) parts.push(`posts+${r.newPosts}/~${r.updatedPosts}`);
    if (r.newTransactions) parts.push(`txns+${r.newTransactions}`);
    if (r.accountChanges) parts.push(`accounts~${r.accountChanges}`);
    if (r.marketplaceTxns) parts.push(`escrow~${r.marketplaceTxns}`);
    if (r.newMessages) parts.push(`msgs+${r.newMessages}`);
    if (r.tombstonesApplied) parts.push(`deletes-${r.tombstonesApplied}`);
    if (r.conflictsSkipped) parts.push(`skipped:${r.conflictsSkipped}`);
    if (r.valuesLeftOut?.length) parts.push(`values left out:${r.valuesLeftOut.length}`);
    return parts.length === 0 ? 'no changes' : parts.join(', ');
}

type PullMode = 'delta' | 'full' | 'resync';
/**
 * Why a force-resync. The format re-seed (REPLICA_FORMAT) and an operator's are seeds, decided by this standby alone; one
 * the loop takes after a whole copy that didn't match (checkWholeCopy) isn't: a main server can make a copy fail that
 * check, so its import is held to the ledger this standby had before its clear (engine/sync.ts clearForResync).
 */
type ResyncKind = 'format' | 'operator' | 'mismatch';

/** Pull once from the primary and import it. Never throws.
 *  - 'delta'  : incremental — X-Since-Cursor, only rows changed since. Falls back to a
 *               full seed automatically if we have no cursor yet.
 *  - 'full'   : full snapshot (initial seed or periodic reconcile), with a conditional
 *               304 when unchanged.
 *  - 'resync' : force a full rebuild — clear the replicated tables first, bypass the
 *               stale-skip, and reset every cursor so the replica is rebuilt 1:1. */
async function pullOnce(mode: PullMode = 'delta', why: ResyncKind | null = null): Promise<{ ok: boolean; error?: string }> {
    if (inFlight) return { ok: false, error: 'A pull is already in progress.' };

    const config = getLocalConfig();
    const primaryUrl = config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL;
    const adminPassword = config.backupAdminPassword || process.env.BACKUP_ADMIN_PASSWORD;
    const replicationToken = config.backupReplicationToken || process.env.BACKUP_REPLICATION_TOKEN;

    if (!primaryUrl || (!replicationToken && !adminPassword)) {
        // Quietly return when config is not yet set up
        return { ok: false, error: 'Backup not configured (need a primary URL and a credential).' };
    }

    if (!isAllowedPrimaryUrl(primaryUrl)) {
        logger.security('P2P', `[Backup] Primary URL must be https:// (or http://localhost for dev) — refusing to pull against '${primaryUrl}'`);
        return { ok: false, error: 'Primary URL must be https:// (or http://localhost).' };
    }

    // Prefer the scoped replication token. The admin password is only a fallback for a
    // legacy standby that migrateStandbyPassword could not swap yet (it warns every start).
    const authHeader: Record<string, string> = replicationToken
        ? { 'X-Replication-Token': replicationToken }
        : { 'X-Admin-Password': adminPassword as string };
    // How this standby's copies have gone, for its main server to tell the community's owners when it needs them
    // (services/standby-health.ts). Only on the replication-token channel: the main server reads it nowhere else.
    if (replicationToken) {
        try { authHeader[STANDBY_REPORT_HEADER] = JSON.stringify(standbyReport()); } catch { /* a pull never waits on its report */ }
    }

    const fresh = mode === 'resync';
    // Delta only when explicitly asked AND we already have a cursor to delta-from;
    // otherwise this is a full pull (seed / reconcile / resync).
    const isDelta = mode === 'delta' && !!lastImportedCursor;
    lastPullMode = fresh ? 'resync' : isDelta ? 'delta' : 'full';
    // A seed, which the conservation guard lets in whatever it sums to (engine/sync.ts ImportOptions), decided here from
    // this standby's own records before anything is fetched, and never from its ledger, which a copy can change: its
    // first copy (it holds none it landed, replicaFormatOfCopy: never, or not since a seed of its own cleared it), the
    // format re-seed, and an operator's force-resync. Any other copy is held to the ledger here, or, after a clear this
    // standby made for a copy that didn't match, to the total it had before that clear.
    const seed = (fresh && (why === 'format' || why === 'operator')) || replicaFormatOfCopy() === 0;
    let heldToSum = seed ? null : heldLedgerSum();

    inFlight = true;
    // Where a failure happened: no copy came ('fetch'), or it came and was not imported ('import'). Only the second counts
    // toward "refused in a row" in the report.
    let stage: 'fetch' | 'import' = 'fetch';
    const url = primaryUrl.replace(/\/$/, '') + (isDelta ? DELTA_PATH : SNAPSHOT_PATH);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { ...authHeader };
        if (isDelta) {
            // Ship only rows with watermark >= this cursor (plus tombstones since).
            headers['X-Since-Cursor'] = lastImportedCursor as string;
        } else if (!fresh && lastImportedGeneratedAt) {
            // Full conditional pull: 304 (no body) when the ledger is unchanged since
            // the exact snapshot we last imported, instead of re-streaming everything.
            headers['X-Snapshot-Cursor'] = lastImportedGeneratedAt;
        }
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (res.status === 304) {
            // Only the full path 304s. Nothing changed → treat as a clean success.
            lastSuccessAt = Date.now();
            if (consecutiveFailures > 0) logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
            consecutiveFailures = 0;
            if (!isDelta) lastFullReconcileAt = Date.now();
            recordQuietly(() => noteCopyLanded(lastSuccessAt!));
            return { ok: true };
        }
        if (!res.ok) {
            throw new Error(`primary returned HTTP ${res.status}`);
        }
        // A snapshot must come from a primary; warn (but still import — the
        // mirror-trust gate is the real authority) if we're chained off a backup.
        const remoteRole = res.headers.get('X-Node-Role');
        if (remoteRole && remoteRole !== 'primary') {
            logger.warn('P2P', `[Backup] ⚠️ Snapshot source advertises role '${remoteRole}', expected 'primary' — chained replication?`);
        }

        const rawBody = await res.text();
        const payload = JSON.parse(rawBody) as SyncPayload;

        // A2-17: reject a replayed/stale payload before importing. Older-or-equal
        // generatedAt is a replay or no-op. Harmless for deltas (LWW dedupes) but kept
        // uniform. (Tampering with generatedAt invalidates the signature, rejected below.)
        if (!fresh && payload.generatedAt) {
            const genMs = Date.parse(payload.generatedAt);
            if (Number.isFinite(genMs) && genMs <= lastGeneratedAtMs) {
                logger.sync('P2P', `[Backup] ↩︎ Skipped stale/replayed ${isDelta ? 'delta' : 'snapshot'} (generatedAt ${payload.generatedAt} ≤ last imported)`);
                return { ok: true };
            }
        }

        stage = 'import';
        // Force-resync: wipe the replicated tables so the upsert importer rebuilds an
        // exact copy with no orphan rows. Only after a successful fetch+parse, so the
        // empty window is milliseconds.
        if (fresh) {
            // The photo rows the primary told us it could NOT put in this payload survive the clear. The
            // export omits a row whose object the primary cannot read, precisely so an importer does not blank
            // its own good copy — and this replica's copy may be the only readable one left. Clearing them
            // here would delete the row, orphan its object, and let the daily sweep reclaim the bytes, on the
            // one operation an operator reaches for when a replica "looks wrong".
            const keepPhotos = Array.isArray(payload.photosOmitted) ? payload.photosOmitted : [];
            if (keepPhotos.length > 0) {
                logger.warn('P2P', `[Backup] ⚠️ Force-resync: the primary could not read ${keepPhotos.length} photo object(s) `
                    + 'of its own, so this payload does not carry those rows. Keeping this replica\'s copies of them — '
                    + 'they may be the only readable ones left.');
            }
            // The force-resync a copy that didn't match asked for is taken once a copy came for it, in this process and in
            // the standby's record, whatever its import does: one whose fetch failed (a main server restarting with the
            // same update) is asked for again on the next pull, and none is taken twice.
            if (why === 'mismatch') {
                ledgerResyncAskedAt = null;
                recordQuietly(() => noteMismatchResyncTaken());
            }
            // The replaced keys too, when this copy carries the main server's (it sends every one it has: it never
            // deletes a row). One from a main server older than that sends none, and this standby keeps its own. With the
            // clear, in its transaction, what the copy is held to: nothing for a seed, and the ledger's total now for the
            // resync after a copy that didn't match.
            // And the members' preferences, keepers and pledges, when this copy carries them (every copy of a main server
            // that sends its keepers does, the whole set).
            heldToSum = clearForResync(seed, () => clearReplicatedTables(keepPhotos, {
                invalidatedKeys: Array.isArray(payload.invalidatedKeys), standing: Array.isArray(payload.treasuryOperators),
            }));
            // The format re-seed is used up once a resync has cleared, and not before: one whose fetch failed is asked for
            // again on the next tick. One whose import fails is used up all the same, so a failing import can't clear this
            // standby on every tick; its next pull, a whole copy onto a standby with no copy it landed, is a seed anyway.
            if (seed) replicaFormatAsked = true;
            lastGeneratedAtMs = 0;
            // Forget all cursors so a failed import can't leave the next pull 304-ing
            // ("unchanged") or delta-ing against a cleared replica — it re-seeds fully.
            lastImportedGeneratedAt = null;
            lastImportedCursor = null;
            try { setSyncCursor(BACKUP_CURSOR_PEER, ''); } catch { /* best-effort */ }
            logger.info('P2P', '[Backup] 🧹 Force-resync: replicated tables cleared, importing fresh snapshot…');
        }

        // The import path enforces: valid signature → signer maps to a trusted
        // `mirror` connector (the primary) → conservation guard (runs on a backup
        // unconditionally, A2-8). A forged/tampered payload is rejected there. It
        // applies partial (delta) or full payloads identically, LWW per row; only
        // the recovery seal's clean-up needs to know which this was.
        const result = await importRemoteState(payload, { full: !isDelta, seed, heldToSum });
        // The main server's node profile and switch overrides, signed with the payload the import just verified:
        // kept as this database's record, so a take-over or a hand promotion from here meets the main server's
        // profile, not this standby's (config/node-profile.ts). A primary too old to send it leaves the record alone.
        if (payload.nodeProfile) noteMainServerProfile(payload.nodeProfile);
        // The community's own settings, signed with it too: kept, not applied, while this is a standby. A primary too old to
        // send them leaves this standby's record alone, and a take-over from here then keeps this standby's own.
        if (payload.communitySettings !== undefined) noteMainServerCommunitySettings(payload.communitySettings, payload.generatedAt ?? null);
        // A whole copy from a main server whose visitors are marked: every row here has its mark now (db.ts).
        if (!isDelta && payload.visitorsMarked === true) noteWholeCopyOfVisitorMarks();
        // A whole copy that carries the main server's replaced keys: every one is here now (engine/key-move.ts).
        if (!isDelta && Array.isArray(payload.invalidatedKeys)) noteWholeCopyOfReplacedKeys();
        // A whole copy that carries the main server's block lists: every one is here now (engine/member-blocks.ts).
        if (!isDelta && Array.isArray(payload.memberBlocks)) noteWholeCopyOfMemberBlocks();

        if (payload.generatedAt) {
            const genMs = Date.parse(payload.generatedAt);
            if (Number.isFinite(genMs)) lastGeneratedAtMs = genMs;
            lastImportedGeneratedAt = payload.generatedAt; // full conditional-pull cursor
        }
        // Advance the delta watermark and persist it so a restart resumes deltas.
        if (payload.cursor) {
            lastImportedCursor = payload.cursor;
            try { setSyncCursor(BACKUP_CURSOR_PEER, payload.cursor); } catch { /* best-effort */ }
        }
        lastSuccessAt = Date.now();
        if (consecutiveFailures > 0) logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
        consecutiveFailures = 0;
        recordQuietly(() => noteCopyLanded(lastSuccessAt!));
        // The copy is now one this importer made, from nothing: what the format re-seed waits for (nextMode), and the
        // record that this standby holds a copy it landed, so no later one is a seed of that kind.
        if (fresh || seed) noteReplicaFormat();

        if (isDelta) {
            // Deltas carry only changed rows, so a row-count compare is meaningless.
            // Use the whole-state stateHash as a cheap per-cycle canary; on mismatch,
            // schedule a full reconcile to re-establish exact parity (catches the rare
            // watermark-less mutation, e.g. a social-recovery pubkey rewrite).
            if (payload.stateHash) {
                const localHash = getStateHash();
                if (localHash !== payload.stateHash) {
                    pendingReconcile = true;
                    logger.warn('P2P', `[Backup] ⚠️ Delta stateHash canary drift (local ${localHash} ≠ primary ${payload.stateHash}) — scheduling full reconcile`);
                }
            }
            logger.sync('P2P', `[Backup] ⬇️ Delta applied: ${summarize(result)}`);
        } else {
            lastFullReconcileAt = Date.now();
            pendingReconcile = false;
            // Gate future reconciles on payload size — a giant full JSON stalls the
            // primary's event loop; past the threshold we rely on complete deltas.
            const bytes = rawBody.length;
            if (bytes > (Number(process.env.BACKUP_RECONCILE_MAX_BYTES) || DEFAULT_RECONCILE_MAX_BYTES)) {
                if (!reconcileDisabledForSize) {
                    logger.warn('P2P', `[Backup] Full snapshot is ${(bytes / 1048576).toFixed(1)} MB — disabling periodic full reconcile; relying on deltas. Re-seed via force-resync if ever needed.`);
                }
                reconcileDisabledForSize = true;
            } else {
                reconcileDisabledForSize = false;
            }
            // Verify the replica matches what the primary sent. Never let a
            // consistency-check error mask an otherwise-successful pull.
            try {
                checkWholeCopy(payload, result.valuesLeftOut);
            } catch (e: any) {
                logger.warn('P2P', `[Backup] Consistency check failed to run: ${e?.message || e}`);
            }
            logger.sync('P2P', `[Backup] ⬇️ ${fresh ? 'Re-seeded' : 'Full pull'} from primary: ${summarize(result)}`);
        }
        return { ok: true };
    } catch (e: any) {
        consecutiveFailures++;
        recordQuietly(() => noteCopyFailed(stage === 'import' ? 'refused' : 'fetch-failed', whyOf(stage, e)));
        const msg = e?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (e?.message || String(e));
        // Conservation/trust rejections are security-relevant — surface loudly.
        if (/conservation|untrusted|mirror|signature/i.test(msg)) {
            logger.security('P2P', `[Backup] ❌ ${isDelta ? 'Delta' : 'Snapshot'} REJECTED by import guard: ${msg}`);
        } else {
            logger.warn('P2P', `[Backup] Pull #${consecutiveFailures} (${isDelta ? 'delta' : 'full'}) failed: ${msg} (will retry in interval)`);
        }
        return { ok: false, error: msg };
    } finally {
        clearTimeout(timeout);
        inFlight = false;
    }
}

/** The standby's record of its copies (services/standby-copy-record.ts) never fails a pull, nor masks how one went. */
function recordQuietly(write: () => void): void {
    try { write(); } catch (e) { logger.warn('P2P', `[Backup] Could not record how this pull went: ${errorMessage(e)}`); }
}

/**
 * The whole-copy check, after a full pull: this standby against the copy it just imported, every account included
 * (engine audit.ts getReplicaConsistency), and every copied table's row count and content against the hashes the main
 * server sent with it (engine/replica-hashes.ts; routes/backup.ts sends them). The verdict goes in this standby's record
 * (services/standby-copy-record.ts): its next pull reports it to the main server, which tells the community's owners when
 * it isn't exact (design G8), and the take-over preview reads it.
 *
 * A copy that isn't the main server's asks for one force-resync, at most one every six hours, restarts included (the
 * standby's record keeps when it last asked, and whether a copy has come for it since, so a restart before the resync
 * still takes it); while it takes that resync, its main server tells nobody, and the check
 * after it says whether it cured the copy (standby-copy-record.ts HEALING_MS). A ledger that isn't is also
 * recorded in node_config `replica_ledger_mismatch`. That force-resync is not a seed: a main server can send a copy that
 * fails this check, so its import is held to the total this standby's ledger had before its clear (ResyncKind). An entry
 * of the copy with no key this server can store or no number for a balance is recorded and asks for none: a force-resync
 * would read the same entry.
 * `valuesLeftOut`: the values of this copy's members rows the import left out because this standby's table refuses them
 * (engine/sync.ts writeMemberStanding): any makes the copy not exact (recorded as `members` differing), and is logged,
 * but asks for no force-resync (one would leave the same values out); the main servers' own boot clean-up (db.ts)
 * brings such rows into the table's rules, and the next whole copy is exact again.
 * Exported so a suite can run it on a copy it fetched.
 */
export function checkWholeCopy(payload: SyncPayload, valuesLeftOut: readonly string[] = []): ReplicaConsistency {
    const c = getReplicaConsistency(payload);
    if (valuesLeftOut.length > 0) {
        c.valuesLeftOut = { count: valuesLeftOut.length, examples: valuesLeftOut.slice(0, 5) };
        c.ok = false;
    }
    lastConsistency = c;
    // Each table's content, when the main server sent its hashes with this copy (it sends none with one written to while
    // it was being made). The listing photos the main server could not read from its own storage are not in the copy,
    // which names them, nor in its hash of that table (routes/backup.ts): no copy brings them, so they are left out here
    // too, and never read as a copy gone wrong that a force-resync would mend (review 4118340860).
    const theirs = readTableHashes((payload as SyncPayload & { tableHashes?: unknown }).tableHashes);
    const photosLeftOut = new Set((Array.isArray(payload.photosOmitted) ? payload.photosOmitted : []).filter((k): k is string => typeof k === 'string'));
    const contents = theirs ? compareTableHashes(theirs, { photosLeftOut }) : null;
    // The ledger compared whole: every account the copy names is one this server can hold, each once, and c.ledger
    // compared each. A copy that names none carries no ledger, as the importer reads it: whole only when this server holds
    // none either. Otherwise the accounts' count, their sum and their content say nothing a force-resync would mend: it
    // would read the same entries (review 4118340781; #1268's step 15, a copy whose every entry is unreadable).
    const named: unknown[] = Array.isArray(payload.accounts) ? payload.accounts : [];
    const ledgerWhole = named.length === 0
        ? c.tables.some((t) => t.name === 'accounts' && t.match)
        : !!c.ledger && c.ledger.unreadable === 0 && new Set(named.map((a) => (a as { publicKey?: unknown } | null)?.publicKey)).size === named.length;
    const ledgerDiffering = c.ledger?.differing ?? 0;
    // What differs that a copy from the main server mends, so a force-resync can put it right: a table's count or content,
    // an account's balance (or an account only one side holds), the Commons. Never the accounts' count or sum: each account
    // is compared on its own, or the copy doesn't carry them all.
    const differs = new Set<string>();
    for (const t of c.tables) if (!t.match && t.name !== 'accounts') differs.add(t.name);
    for (const d of contents?.differing ?? []) {
        // The accounts' content only with the ledger compared whole and alike: a balance that differs is the ledger's line
        // below, and entries this server can't hold differ on every copy.
        if (d.table === 'accounts' && (!ledgerWhole || ledgerDiffering > 0)) continue;
        differs.add(d.table);
    }
    if (c.commons && !c.commons.match) differs.add(LEDGER_DIFFERS.commons);
    if (ledgerDiffering > 0) differs.add(LEDGER_DIFFERS.ledger);
    // Everything in it is something a force-resync can mend.
    const wrong = differs.size > 0;
    // Values of this copy's members rows this standby's table refuses, left out by the import (#1276): the copy isn't the
    // main server's, so never exact, but no force-resync mends it (one would leave the same values out): after `wrong`.
    if (c.valuesLeftOut) differs.add('members');
    // A verdict only from a check that compared everything: each table's content (a copy the main server sent without its
    // hashes, one written to while it was being made, can't show it differing) and every account. Finding nothing short
    // of that is no "exact": it neither ends nor starts anything the last verdict says, and the last exact copy's time
    // stays the older one (review 4118340714).
    const notCompared: ('content' | 'ledger')[] = [...(contents ? [] : ['content' as const]), ...(ledgerWhole ? [] : ['ledger' as const])];
    const verdict: 'exact' | 'inexact' | 'uncompared' = differs.size > 0 ? 'inexact' : notCompared.length === 0 ? 'exact' : 'uncompared';
    const exact = verdict === 'exact';
    if (differs.size > 0) {
        const bad = c.tables.filter(t => !t.match).map(t => `${t.name} ${t.backup}/${t.primary}`);
        if (c.ledger && !c.ledger.match) bad.push(`${c.ledger.differing} account(s) differ`);
        for (const d of contents?.differing ?? []) if (!bad.some((b) => b.startsWith(`${d.table} `))) bad.push(`${d.table} content`);
        if (c.valuesLeftOut) bad.push(`${c.valuesLeftOut.count} members value(s) this server's table refuses, left out (${c.valuesLeftOut.examples.join(', ')})`);
        logger.warn('P2P', `[Backup] ⚠️ Replica differs from primary snapshot: ${bad.join(', ') || 'balances/commons drift'}`);
    }
    const now = Date.now();
    // The last force-resync this standby asked for, from its record too: a restart allows no sooner one, so a difference no
    // resync mends never loops. This process's memory stays a floor, should the record be unwritable.
    let lastResyncAt = lastLedgerResyncAt;
    try { lastResyncAt = Math.max(lastResyncAt, lastMismatchResyncAt()); } catch { /* the floor */ }
    const resync = wrong && now - lastResyncAt >= LEDGER_RESYNC_EVERY_MS;
    if (resync) {
        ledgerResyncAskedAt = now;
        lastLedgerResyncAt = now;
        lastResyncAt = now;
    }
    if (verdict === 'uncompared') {
        logger.info('P2P', `[Backup] This whole copy could not be compared in full (${notCompared.map((n) => (n === 'content'
            ? 'no table hashes: the main server was written to while making it' : 'accounts this server cannot hold')).join('; ')}); `
            + 'nothing compared differs. No verdict.');
        recordQuietly(() => noteUncomparedCheck({ at: now, notCompared, photosLeftOut: photosLeftOut.size, snapshotGeneratedAt: c.snapshotGeneratedAt }));
    } else {
        recordQuietly(() => noteWholeCopyCheck({
            at: now, exact, differs: [...differs].sort(), ledgerDiffering, hashed: !!contents, photosLeftOut: photosLeftOut.size,
            resyncAsked: resync, snapshotGeneratedAt: c.snapshotGeneratedAt,
        }));
    }
    if (wrong && !(c.ledger && !c.ledger.match)) {
        logger.warn('P2P', `[Backup] This standby's copy is not its main server's after a whole copy (${[...differs].join(', ')}). `
            + (resync ? 'Taking a force-resync next.' : `No force-resync before ${new Date(lastResyncAt + LEDGER_RESYNC_EVERY_MS).toISOString()}.`));
    }
    if (c.ledger && !c.ledger.match) {
        noteLedgerMismatch({
            at: new Date(now).toISOString(),
            snapshotGeneratedAt: c.snapshotGeneratedAt,
            differing: c.ledger.differing,
            unreadable: c.ledger.unreadable,
            examples: c.ledger.examples,
            resync: resync ? 'scheduled'
                : wrong ? `not before ${new Date(lastResyncAt + LEDGER_RESYNC_EVERY_MS).toISOString()}`
                    : 'none: the copy has entries this server cannot read',
        });
        logger.security('P2P', `[Backup] ❌ This standby's ledger is not its main server's after a whole copy: ${c.ledger.differing} `
            + `account(s) differ${c.ledger.unreadable ? `, ${c.ledger.unreadable} unreadable in the copy` : ''} (${c.ledger.examples.join(', ')}). `
            + (resync ? 'Taking a force-resync next.' : 'No force-resync now.'));
    }
    return c;
}

/**
 * Operator-triggered force resync: rebuild this backup from the primary's current
 * snapshot, discarding any drifted/orphan rows. Returns a result for the dashboard.
 */
export async function requestResync(): Promise<{ ok: boolean; error?: string }> {
    if (getNodeRole() !== 'backup') return { ok: false, error: 'This node is not a backup.' };
    logger.info('P2P', '[Backup] 🔄 Force-resync requested by operator.');
    return pullOnce('resync', 'operator');
}

/**
 * Decide the next pull mode: a periodic (or drift-triggered) FULL reconcile when due
 * and not size-disabled, or the one the recovery seal asks for, otherwise an incremental
 * DELTA. A backup with no cursor yet always resolves to a full seed inside pullOnce.
 */
// Cadence is operator-tunable (fleet manager → local-config) and read LIVE here, so a
// change takes effect on the next tick without restarting the node. Config wins; else
// env; else the built-in default.
function getPullMs(): number {
    const s = getLocalConfig().backupPullSeconds;
    if (typeof s === 'number' && s > 0) return Math.max(5, s) * 1000;
    return Number(process.env.BACKUP_PULL_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
}
function getReconcileMs(): number {
    const m = getLocalConfig().backupReconcileMinutes;
    if (typeof m === 'number') return Math.max(0, m) * 60_000; // 0 → routine reconcile off
    return Number(process.env.BACKUP_RECONCILE_EVERY_MS) || DEFAULT_RECONCILE_EVERY_MS;
}

let visitorMarksAsked = false;
let replacedKeysAsked = false;
let memberBlocksAsked = false;
let replicaFormatAsked = false;

function nextMode(): PullMode | ResyncKind {
    // A copy an older importer made, or none yet (engine/sync.ts REPLICA_FORMAT): one force-resync, first, since no whole
    // copy repairs a row the old importer got wrong (it skips every row whose stamp hasn't moved). A new standby's first
    // pull is this one too, which also clears whatever its own boot seeded. Once a process, used up when it clears
    // (pullOnce): one whose fetch fails is asked for again on the next tick, since the main server may be restarting
    // with the same update; one whose import fails leaves it cleared, and the next pull, a whole copy onto a standby with
    // no copy it landed, is a seed that makes it from nothing and records the format.
    if (!replicaFormatAsked && replicaFormatOfCopy() < REPLICA_FORMAT) {
        logger.info('P2P', `[Backup] This standby's copy was made by an older importer (format ${replicaFormatOfCopy()}, now ${REPLICA_FORMAT}): taking one force-resync`);
        return 'format';
    }
    // The last whole copy found a copy that isn't the main server's, its ledger or any table (checkWholeCopy): not a seed.
    // Taken once a copy comes for it (pullOnce); while none does, only for as long as the copy counts as mending itself.
    // Once a process, the one asked for before this restart that no copy came for yet, from the standby's record.
    if (!ledgerResyncRestored) {
        ledgerResyncRestored = true;
        try {
            const asked = pendingMismatchResync();
            if (asked !== null && ledgerResyncAskedAt === null) {
                ledgerResyncAskedAt = asked;
                logger.info('P2P', '[Backup] Taking the force-resync a whole copy that did not match asked for before this restart');
            }
        } catch { /* the record unreadable: none is asked for from it */ }
    }
    if (ledgerResyncAskedAt !== null) {
        if (Date.now() - ledgerResyncAskedAt < HEALING_MS) return 'mismatch';
        logger.warn('P2P', '[Backup] The force-resync asked for a copy that did not match got no copy from the main server in an hour: '
            + 'dropped. The main server tells its owners; the next one waits for the six-hour limit.');
        ledgerResyncAskedAt = null;
    }
    if (!lastImportedCursor) return 'full'; // seed
    // A drift-triggered reconcile ALWAYS wins, even for a large DB — correctness beats
    // bandwidth when the stateHash canary says the copy has actually diverged, and it
    // only fires on a real mismatch. The SIZE cutoff and the operator "off" setting
    // only suppress the *routine* timer-based full re-read (belt-and-suspenders), which
    // the reliable deltas make optional at scale. So at GB size / reconcile-off: tiny
    // deltas every tick, no periodic full, and a full only if drift is truly detected.
    if (pendingReconcile) return 'full';
    // The recovery seal asks once for a whole copy, even for a large database: the rows the main server holds tell which
    // copies here it deleted before the seal (services/recovery-seal-key.ts). A whole one, never a 304 "unchanged".
    if (takeRecoverySealFullPull()) {
        lastImportedGeneratedAt = null;
        return 'full';
    }
    // Once a process, a whole copy for a standby that has its main server's word that its visitors are marked but no whole
    // copy since: the rows it copied before it had the column carry no mark, and no delta brings them (db.ts
    // visitorMarksWantWholeCopy). One that fails isn't tried on every tick: the next routine one, or the next boot, brings it.
    if (!visitorMarksAsked && visitorMarksWantWholeCopy()) {
        visitorMarksAsked = true;
        lastImportedGeneratedAt = null; // a whole one, never a 304 "unchanged"
        logger.info('P2P', "[Backup] Visitors' rows: taking one whole copy of the main server, so the rows copied before this version get its marks");
        return 'full';
    }
    // Once a process, the same for the keys the main server replaced: a delta brings the ones replaced since this standby's
    // cursor, and the ones from before either server had this version come only in a whole copy (engine/key-move.ts).
    if (!replacedKeysAsked && replacedKeysWantWholeCopy()) {
        replacedKeysAsked = true;
        lastImportedGeneratedAt = null; // a whole one, never a 304 "unchanged"
        logger.info('P2P', '[Backup] Replaced keys: taking one whole copy of the main server, so the keys it replaced before this version are refused here too');
        return 'full';
    }
    // Once a process, the same for the members' block lists: the blocks made while this standby ran a version without them
    // come only in a whole copy (engine/member-blocks.ts).
    if (!memberBlocksAsked && memberBlocksWantWholeCopy()) {
        memberBlocksAsked = true;
        lastImportedGeneratedAt = null; // a whole one, never a 304 "unchanged"
        logger.info('P2P', "[Backup] Block lists: taking one whole copy of the main server, so every member's blocks from before this version are here too");
        return 'full';
    }
    const reconcileMs = getReconcileMs();
    if (reconcileMs > 0 && !reconcileDisabledForSize && Date.now() - lastFullReconcileAt >= reconcileMs) return 'full';
    return 'delta';
}

// ===================== LEGACY ADMIN-PASSWORD STANDBYS =====================
//
// A standby used to be set up with the main server's admin password, which it kept in plain
// text (local-config.json `backupAdminPassword`, or BACKUP_ADMIN_PASSWORD in .env). Anyone with
// that disk, or a backup of it, then had the main server's admin password. A standby now
// copies with a replication token only. One that still holds the password swaps it on start:
//
//   1. It already has a token too → the token is what it copies with; the password is wiped.
//   2. The main server has NO replication token yet → the standby uses the password once to
//      mint one, checks the new token works, stores only the token and wipes the password.
//   3. Otherwise it keeps the password (never wipes it on a guess) and warns loudly every
//      start; Settings shows a banner that says whether this standby is still copying.
//
// Case 3 covers a main server that already has a token (minting another would REPLACE it and
// cut off whichever standby is using it — the server keeps a single token), a main server
// with two-factor sign-in on or a changed password (it refuses the password, so the standby is
// NOT copying), an older server without token routes (still takes the password), and a main
// server that can't be reached right now (retried on a later pull, at most hourly). Token-only
// on the main server also means NOT copying. Two old standbys swapping at the same moment could
// both mint; the token is checked again after a pause so the one whose token was replaced keeps
// its password.
//
// A password that came from BACKUP_ADMIN_PASSWORD in .env can't be wiped by the node (the file
// is outside the container); once a token is stored it is never used, and the warning asks the
// operator to delete the line.

export type StandbyCredentialState = {
    /** What the next pull authenticates with. */
    using: 'token' | 'password' | 'none';
    /** The legacy admin password is still in local-config.json. */
    passwordStored: boolean;
    /** BACKUP_ADMIN_PASSWORD is set in the environment. */
    passwordInEnv: boolean;
    /** Operator-facing warning, or null when all is well. Never contains a secret. */
    warning: string | null;
    /** What the last swap attempt did. */
    lastSwap: 'not-needed' | 'wiped-unused-password' | 'minted-token' | 'failed' | null;
};

const MIGRATE_TIMEOUT_MS = 15_000;
const MIGRATE_RETRY_MS = 60 * 60_000;
let credentialState: StandbyCredentialState = { using: 'none', passwordStored: false, passwordInEnv: false, warning: null, lastSwap: null };
let lastMigrateAttemptAt = 0;
let migrateRetryable = false;

function readCredentials() {
    const config = getLocalConfig();
    return {
        storedPw: config.backupAdminPassword || null,
        envPw: process.env.BACKUP_ADMIN_PASSWORD || null,
        token: config.backupReplicationToken || process.env.BACKUP_REPLICATION_TOKEN || null,
        primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null,
    };
}

function refreshCredentialState(warning: string | null, lastSwap: StandbyCredentialState['lastSwap']): StandbyCredentialState {
    const { storedPw, envPw, token } = readCredentials();
    credentialState = {
        using: token ? 'token' : (storedPw || envPw) ? 'password' : 'none',
        passwordStored: !!storedPw,
        passwordInEnv: !!envPw,
        warning,
        lastSwap,
    };
    return credentialState;
}

/** The standby's credential state for Settings. Recomputed from config so a token saved since is reflected. */
export function getStandbyCredentialState(): StandbyCredentialState {
    const { storedPw, envPw, token } = readCredentials();
    // A token saved under Live Backup Server since the last swap attempt clears its warning.
    const warning = token
        ? (envPw ? ENV_PASSWORD_NOTE : null)
        : (storedPw || envPw) ? (credentialState.warning || PASSWORD_PENDING_NOTE) : null;
    return refreshCredentialState(warning, credentialState.lastSwap);
}

/**
 * A failure reason that never echoes a secret. `copying` is what that failure means for the
 * password pulls this standby falls back to: true = the main server still takes the password,
 * false = it refuses it (two-factor on, password changed, token-only on), null = not known
 * right now (main server unreachable or erroring).
 */
class SwapError extends Error {
    constructor(message: string, readonly retryable: boolean, readonly copying: boolean | null) { super(message); }
}

async function primaryPost(primaryUrl: string, apiPath: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIGRATE_TIMEOUT_MS);
    try {
        return await fetch(primaryUrl.replace(/\/$/, '') + apiPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (e: any) {
        throw new SwapError(e?.name === 'AbortError' ? 'the main server did not answer in time' : 'the main server could not be reached', true, null);
    } finally {
        clearTimeout(timer);
    }
}

/** True when the main server accepts this token for replication. */
async function tokenWorks(primaryUrl: string, token: string): Promise<boolean> {
    const res = await primaryPost(primaryUrl, '/api/local/admin/replication-access', { 'X-Replication-Token': token }, {});
    return res.ok;
}

/** How long a freshly made token must keep working before the password is wiped (see race note). */
function swapRecheckMs(): number {
    const v = Number(process.env.BACKUP_SWAP_RECHECK_MS);
    return Number.isFinite(v) && v >= 0 ? v : 3_000;
}

async function mintTokenWithPassword(primaryUrl: string, password: string): Promise<string> {
    const pwHeaders = { 'X-Admin-Password': password };
    const statusRes = await primaryPost(primaryUrl, '/api/local/admin/replication-token/status', pwHeaders, { password });
    if (!statusRes.ok) {
        const body = await statusRes.json().catch(() => ({} as any));
        if (body?.totpRequired) throw new SwapError('the main server has two-factor sign-in on, so it refuses the password alone', false, false);
        if (statusRes.status === 401 || statusRes.status === 403) throw new SwapError(`the main server refused the stored password (HTTP ${statusRes.status}); it may have been changed`, false, false);
        if (statusRes.status === 404) throw new SwapError('the main server is too old to make replication tokens', false, true);
        throw new SwapError(`the main server answered HTTP ${statusRes.status}`, statusRes.status >= 500, null);
    }
    const status = await statusRes.json().catch(() => ({} as any));
    // Token-only on the main server refuses password pulls: this standby is not copying.
    const passwordStillCopies = !status?.tokenOnly;
    if (status?.hasToken) {
        throw new SwapError('the main server already has a replication token, and making a new one would cut off any standby using it', false, passwordStillCopies);
    }
    const genRes = await primaryPost(primaryUrl, '/api/local/admin/replication-token/generate', pwHeaders, { password });
    const gen = await genRes.json().catch(() => ({} as any));
    if (!genRes.ok || typeof gen?.token !== 'string' || !gen.token) {
        throw new SwapError(`the main server did not make a token (HTTP ${genRes.status})`, genRes.status >= 500, genRes.status >= 500 ? null : passwordStillCopies);
    }
    // Prove the new token opens the replication door before trusting copying to it.
    if (!(await tokenWorks(primaryUrl, gen.token))) throw new SwapError('the new token did not work', false, passwordStillCopies);
    // Race: two old standbys of one tokenless main server can both see "no token" and both
    // make one; the second replaces the first. Check again after a pause, so the standby whose
    // token was replaced keeps its password instead of wiping it and being cut off.
    const pause = swapRecheckMs();
    if (pause > 0) await new Promise(r => setTimeout(r, pause));
    if (!(await tokenWorks(primaryUrl, gen.token))) {
        throw new SwapError('another standby made a replication token on the main server at the same moment, which replaced this one', false, passwordStillCopies);
    }
    return gen.token;
}

// The fix for every swap failure. The main server keeps only a hash of its token and shows it
// once, so "copy it from the main server" is not possible: reuse a saved one or make a new one.
const TOKEN_FIX_STEPS = 'To fix: if you saved the main server\'s replication token when it was made, paste it here under Live Backup Server and save. ' +
    'If not, on the main server open Replication Access, make a new token, and paste it into every standby of that main server ' +
    '(making one replaces the old one, which stops any standby still using it).';

const PASSWORD_PENDING_NOTE = "This server holds the main server's admin password to copy with. It swaps it for a replication token when it starts as a standby; if it can't, this says why.";
const ENV_PASSWORD_NOTE ="BACKUP_ADMIN_PASSWORD is still set in this server's .env. It holds the main server's admin password in plain text and is no longer used: delete that line and restart.";

/** The operator-facing warning for a swap that did not happen. Never contains a secret. */
function swapFailureWarning(why: string, copying: boolean | null, storedPw: boolean): string {
    const where = storedPw ? 'in plain text in local-config.json' : 'in plain text in BACKUP_ADMIN_PASSWORD in .env';
    const lead = copying === false
        ? `This standby is NOT copying: the main server refuses its stored admin password. It could not swap the password for a replication token: ${why}.`
        : copying === true
            ? `This standby still copies with the main server's admin password, which is kept ${where}. It could not swap it for a replication token: ${why}.`
            : `This standby could not swap the main server's admin password for a replication token: ${why}. It tries again every hour. Until then it copies with the password if the main server still takes it.`;
    const tail = copying === false
        ? ` The password is still kept ${where}.`
        : '';
    return `${lead}${tail} ${TOKEN_FIX_STEPS} The stored password is then wiped` +
        (storedPw ? '.' : '; also delete BACKUP_ADMIN_PASSWORD from .env and restart.');
}

/**
 * Swap a legacy stored/env admin password for a replication token (see the block comment
 * above). Never throws and never logs a secret. Returns the resulting credential state.
 */
export async function migrateStandbyPassword(): Promise<StandbyCredentialState> {
    lastMigrateAttemptAt = Date.now();
    migrateRetryable = false;
    const { storedPw, envPw, token, primaryUrl } = readCredentials();

    // 1. A token is already in use: the stored password is dead weight. Wipe it.
    if (token) {
        if (storedPw) {
            updateLocalConfig({ backupAdminPassword: null });
            if (getLocalConfig().backupAdminPassword) {
                const warning = "This standby copies with its replication token, but could not delete the main server's admin password from local-config.json (the file could not be written). Check the data directory is writable and has free space, then restart.";
                logger.security('P2P', `[Backup] ⚠️ ${warning}`);
                return refreshCredentialState(warning, 'failed');
            }
            logger.info('P2P', "[Backup] 🔐 Removed the main server's admin password from this standby. It copies with its replication token.");
        }
        if (envPw) logger.security('P2P', `[Backup] ⚠️ ${ENV_PASSWORD_NOTE}`);
        return refreshCredentialState(envPw ? ENV_PASSWORD_NOTE : null, storedPw ? 'wiped-unused-password' : 'not-needed');
    }

    const password = storedPw || envPw;
    if (!password) return refreshCredentialState(null, 'not-needed');

    // 2. Password only: use it once to mint a token.
    try {
        // The pull refuses a missing or non-https address too, so nothing is copying.
        if (!primaryUrl || !isAllowedPrimaryUrl(primaryUrl)) throw new SwapError('the main server address is missing or not https', false, false);
        const minted = await mintTokenWithPassword(primaryUrl, password);
        updateLocalConfig({ backupReplicationToken: minted, backupAdminPassword: null });
        // saveLocalConfig logs and swallows a failed write: read it back before claiming success.
        const saved = getLocalConfig();
        if (saved.backupReplicationToken !== minted || saved.backupAdminPassword) {
            throw new SwapError('the new token could not be saved to local-config.json (check the data directory is writable and has free space)', true, null);
        }
        logger.info('P2P', "[Backup] 🔐 Swapped the main server's admin password for a replication token. The password is no longer stored on this standby.");
        if (envPw) logger.security('P2P', `[Backup] ⚠️ ${ENV_PASSWORD_NOTE}`);
        return refreshCredentialState(envPw ? ENV_PASSWORD_NOTE : null, 'minted-token');
    } catch (e: any) {
        // 3. Could not swap safely: keep the password (never wipe it on a guess) and say
        // plainly whether this standby is still copying with it.
        migrateRetryable = e instanceof SwapError ? e.retryable : true;
        const why = e instanceof SwapError ? e.message : 'an unexpected error';
        const copying = e instanceof SwapError ? e.copying : null;
        const warning = swapFailureWarning(why, copying, !!storedPw);
        logger.security('P2P', `[Backup] ⚠️ ${warning}`);
        return refreshCredentialState(warning, 'failed');
    }
}

/**
 * Fetch the main server's take-over envelope with the replication token, if it has a new one (services/
 * standby-envelopes.ts checks it against the mirror pin and keeps the last five). Never throws.
 */
export async function pullTakeoverEnvelopeNow(): ReturnType<typeof pullTakeoverEnvelope> {
    const { token, primaryUrl } = readCredentials();
    if (!primaryUrl || !isAllowedPrimaryUrl(primaryUrl)) return 'failed';
    return pullTakeoverEnvelope({ primaryUrl, replicationToken: token });
}

/** One pull, of the kind the loop makes next (nextMode): the loop's own step, which a test drives too. Never throws. */
export function pullNow(): Promise<{ ok: boolean; error?: string }> {
    // Before nextMode, which spends the once-a-process asks: a pull already running (an operator's resync) must not use one up.
    if (inFlight) return Promise.resolve({ ok: false, error: 'A pull is already in progress.' });
    const next = nextMode();
    return next === 'format' || next === 'mismatch' || next === 'operator' ? pullOnce('resync', next) : pullOnce(next);
}

/**
 * Start the backup pull loop if this node is configured as a backup. No-op
 * (with a clear log) on a primary or when required config is missing, so the
 * same image runs in either role purely from env.
 */
export function initBackupPuller(): void {
    if (getNodeRole() !== 'backup') {
        return; // primary: imports from nobody, runs no puller
    }

    // Resume from the persisted delta cursor so a restart continues incrementally
    // instead of re-pulling the whole ledger. Empty/absent → next pull is a full seed.
    try {
        const saved = getSyncCursor(BACKUP_CURSOR_PEER);
        if (saved) { lastImportedCursor = saved; logger.info('P2P', `[Backup] Resuming from saved delta cursor ${saved}`); }
    } catch { /* first boot / no cursor table row yet */ }

    const rm = getReconcileMs();
    logger.info('P2P', `[Backup] 🔁 One-directional backup active — pulling every ${Math.round(getPullMs() / 1000)}s (full reconcile ${rm > 0 ? `every ${Math.round(rm / 60000)}m` : 'off — deltas + drift canary'})`);

    // Self-scheduling loop so a live cadence change (fleet manager → local-config)
    // takes effect on the next tick without restarting the node. The pull interval is
    // re-read each time from getPullMs().
    stopped = false;
    refreshCredentialState(null, null);
    const loop = async () => {
        if (stopped) return;
        // Swap a legacy admin password for a token before the first pull, and retry a swap
        // that failed for a passing reason (main server unreachable) at most hourly.
        if (lastMigrateAttemptAt === 0 || (migrateRetryable && Date.now() - lastMigrateAttemptAt >= MIGRATE_RETRY_MS)) {
            await migrateStandbyPassword().catch(() => {});
        }
        await pullNow().catch(() => {});
        // The main server's locked take-over keys (sealed-keys.md §4): a 304 on most ticks.
        await pullTakeoverEnvelopeNow().catch(() => {});
        if (stopped) return;
        pullTimer = setTimeout(loop, getPullMs());
    };
    // First pull shortly after boot so the replica converges quickly.
    pullTimer = setTimeout(loop, 5_000);
}

/** Stop the puller (used on promotion / shutdown). */
export function stopBackupPuller(): void {
    stopped = true;
    if (pullTimer) {
        clearTimeout(pullTimer);
        pullTimer = null;
        logger.info('P2P', '[Backup] Puller stopped.');
    }
}

/** Observability: when the last successful pull landed, failure streak, and the
 * replica-fidelity result of the most recent successful pull. */
export function getBackupStatus(): { lastSuccessAt: number | null; consecutiveFailures: number; running: boolean; consistency: ReplicaConsistency | null; cursor: string | null; lastFullReconcileAt: number; reconcileDisabledForSize: boolean; pullSeconds: number; reconcileMinutes: number; lastPullMode: PullMode | null } {
    return {
        lastSuccessAt,
        consecutiveFailures,
        lastPullMode,
        running: pullTimer !== null,
        consistency: lastConsistency,
        cursor: lastImportedCursor,
        lastFullReconcileAt,
        reconcileDisabledForSize,
        // Effective cadence in effect right now (config → env → default), so the fleet
        // manager can show what each backup is actually doing.
        pullSeconds: Math.round(getPullMs() / 1000),
        reconcileMinutes: Math.round(getReconcileMs() / 60000),
    };
}
