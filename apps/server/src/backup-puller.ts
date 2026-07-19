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
 *   BACKUP_ADMIN_PASSWORD         required — the primary's admin password (shared
 *                                 operator secret); sent in X-Admin-Password
 *   BACKUP_PULL_INTERVAL_MS       optional — default 60000 (60s)
 *
 * The backup must ALSO have the primary configured as a single passive `mirror`
 * connector (enabled:false, address containing /p2p/<primaryPeerId>) so the
 * import signature gate recognizes the primary's signing key without dialing it.
 *
 * For self-signed-CA LAN primaries, point NODE_EXTRA_CA_CERTS at the primary's
 * CA pem (Node honors it for fetch); public Let's Encrypt nodes need nothing.
 */

import { importRemoteState, getNodeRole, getReplicaConsistency, clearReplicatedTables, getStateHash, getSyncCursor, setSyncCursor, type ImportResult, type SyncPayload, type ReplicaConsistency } from './state-engine.js';
import { logger } from './logger.js';
import { getLocalConfig } from './local-config.js';

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

let pullTimer: ReturnType<typeof setInterval> | null = null;
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
    return parts.length === 0 ? 'no changes' : parts.join(', ');
}

type PullMode = 'delta' | 'full' | 'resync';

/** Pull once from the primary and import it. Never throws.
 *  - 'delta'  : incremental — X-Since-Cursor, only rows changed since. Falls back to a
 *               full seed automatically if we have no cursor yet.
 *  - 'full'   : full snapshot (initial seed or periodic reconcile), with a conditional
 *               304 when unchanged.
 *  - 'resync' : force a full rebuild — clear the replicated tables first, bypass the
 *               stale-skip, and reset every cursor so the replica is rebuilt 1:1. */
async function pullOnce(mode: PullMode = 'delta'): Promise<{ ok: boolean; error?: string }> {
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

    // Prefer the scoped replication token; fall back to the admin password during
    // rollout (before a token is provisioned on both ends).
    const authHeader: Record<string, string> = replicationToken
        ? { 'X-Replication-Token': replicationToken }
        : { 'X-Admin-Password': adminPassword as string };

    const fresh = mode === 'resync';
    // Delta only when explicitly asked AND we already have a cursor to delta-from;
    // otherwise this is a full pull (seed / reconcile / resync).
    const isDelta = mode === 'delta' && !!lastImportedCursor;

    inFlight = true;
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

        // Force-resync: wipe the replicated tables so the upsert importer rebuilds an
        // exact copy with no orphan rows. Only after a successful fetch+parse, so the
        // empty window is milliseconds.
        if (fresh) {
            clearReplicatedTables();
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
        // applies partial (delta) or full payloads identically, LWW per row.
        const result = await importRemoteState(payload);

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
                lastConsistency = getReplicaConsistency(payload);
                if (!lastConsistency.ok) {
                    const bad = lastConsistency.tables.filter(t => !t.match).map(t => `${t.name} ${t.backup}/${t.primary}`);
                    logger.warn('P2P', `[Backup] ⚠️ Replica differs from primary snapshot: ${bad.join(', ') || 'balances/commons drift'}`);
                }
            } catch (e: any) {
                logger.warn('P2P', `[Backup] Consistency check failed to run: ${e?.message || e}`);
            }
            logger.sync('P2P', `[Backup] ⬇️ ${fresh ? 'Re-seeded' : 'Full pull'} from primary: ${summarize(result)}`);
        }
        return { ok: true };
    } catch (e: any) {
        consecutiveFailures++;
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

/**
 * Operator-triggered force resync: rebuild this backup from the primary's current
 * snapshot, discarding any drifted/orphan rows. Returns a result for the dashboard.
 */
export async function requestResync(): Promise<{ ok: boolean; error?: string }> {
    if (getNodeRole() !== 'backup') return { ok: false, error: 'This node is not a backup.' };
    logger.info('P2P', '[Backup] 🔄 Force-resync requested by operator.');
    return pullOnce('resync');
}

/**
 * Decide the next pull mode: a periodic (or drift-triggered) FULL reconcile when due
 * and not size-disabled, otherwise an incremental DELTA. A backup with no cursor yet
 * always resolves to a full seed inside pullOnce.
 */
function nextMode(reconcileEveryMs: number): PullMode {
    if (!lastImportedCursor) return 'full'; // seed
    const reconcileDue = pendingReconcile || (Date.now() - lastFullReconcileAt >= reconcileEveryMs);
    if (reconcileDue && !reconcileDisabledForSize) return 'full';
    return 'delta';
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

    const interval = Number(process.env.BACKUP_PULL_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    const reconcileEveryMs = Number(process.env.BACKUP_RECONCILE_EVERY_MS) || DEFAULT_RECONCILE_EVERY_MS;

    // Resume from the persisted delta cursor so a restart continues incrementally
    // instead of re-pulling the whole ledger. Empty/absent → next pull is a full seed.
    try {
        const saved = getSyncCursor(BACKUP_CURSOR_PEER);
        if (saved) { lastImportedCursor = saved; logger.info('P2P', `[Backup] Resuming from saved delta cursor ${saved}`); }
    } catch { /* first boot / no cursor table row yet */ }

    logger.info('P2P', `[Backup] 🔁 One-directional backup active — pulling every ${Math.round(interval / 1000)}s (full reconcile every ${Math.round(reconcileEveryMs / 60000)}m)`);

    // First pull shortly after boot so the replica converges quickly; then on interval.
    const tick = () => { pullOnce(nextMode(reconcileEveryMs)).catch(() => {}); };
    setTimeout(tick, 5_000);
    pullTimer = setInterval(tick, interval);
}

/** Stop the puller (used on promotion / shutdown). */
export function stopBackupPuller(): void {
    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
        logger.info('P2P', '[Backup] Puller stopped.');
    }
}

/** Observability: when the last successful pull landed, failure streak, and the
 * replica-fidelity result of the most recent successful pull. */
export function getBackupStatus(): { lastSuccessAt: number | null; consecutiveFailures: number; running: boolean; consistency: ReplicaConsistency | null; cursor: string | null; lastFullReconcileAt: number; reconcileDisabledForSize: boolean } {
    return {
        lastSuccessAt,
        consecutiveFailures,
        running: pullTimer !== null,
        consistency: lastConsistency,
        cursor: lastImportedCursor,
        lastFullReconcileAt,
        reconcileDisabledForSize,
    };
}
