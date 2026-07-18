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

import { importRemoteState, getNodeRole, getReplicaConsistency, clearReplicatedTables, type ImportResult, type SyncPayload, type ReplicaConsistency } from './state-engine.js';
import { logger } from './logger.js';
import { getLocalConfig } from './local-config.js';

const SNAPSHOT_PATH = '/api/local/admin/sync-snapshot';
const DEFAULT_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;

let pullTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastSuccessAt: number | null = null;
let consecutiveFailures = 0;
// Replica-fidelity of the most recent successful pull: does our local DB hold the
// same row counts / balances / commons the primary sent? Surfaced on the dashboard.
let lastConsistency: ReplicaConsistency | null = null;
// A2-17: the highest snapshot generatedAt we've imported. A snapshot whose
// generatedAt is older-or-equal is a replay (or a no-op) and is skipped.
let lastGeneratedAtMs = 0;
// Raw generatedAt string of the last imported snapshot — sent to the primary as
// X-Snapshot-Cursor so unchanged pulls come back as a bodyless 304.
let lastImportedGeneratedAt: string | null = null;

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

/** Pull one snapshot from the primary and import it. Never throws.
 *  fresh=true performs a force-resync: clears the replicated tables before import
 *  and bypasses the stale-snapshot skip so the replica is rebuilt 1:1. */
async function pullOnce(fresh = false): Promise<{ ok: boolean; error?: string }> {
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

    inFlight = true;
    const url = primaryUrl.replace(/\/$/, '') + SNAPSHOT_PATH;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        // Conditional pull: tell the primary what we last imported so it can answer
        // 304 (no body) when nothing changed — instead of exporting, signing and
        // streaming the entire ledger every interval. A force-resync (`fresh`)
        // deliberately omits the cursor to always receive a full snapshot.
        const headers: Record<string, string> = { ...authHeader };
        if (!fresh && lastImportedGeneratedAt) headers['X-Snapshot-Cursor'] = lastImportedGeneratedAt;
        const res = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
        });
        if (res.status === 304) {
            lastSuccessAt = Date.now();
            if (consecutiveFailures > 0) {
                logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
            }
            consecutiveFailures = 0;
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

        const payload = (await res.json()) as SyncPayload;

        // A2-17: reject a replayed/stale snapshot before importing. The signed
        // base payload carries `generatedAt`; a value older-or-equal to the last
        // one we imported is a replay (or a no-op) and is skipped. (Tampering with
        // generatedAt invalidates the signature, which importRemoteState rejects.)
        if (!fresh && payload.generatedAt) {
            const genMs = Date.parse(payload.generatedAt);
            if (Number.isFinite(genMs) && genMs <= lastGeneratedAtMs) {
                logger.sync('P2P', `[Backup] ↩︎ Skipped stale/replayed snapshot (generatedAt ${payload.generatedAt} ≤ last imported)`);
                return { ok: true };
            }
        }

        // Force-resync: wipe the replicated tables so the upsert importer rebuilds an
        // exact copy with no orphan rows. Done only after a successful fetch+parse, so
        // the empty window is milliseconds.
        if (fresh) {
            clearReplicatedTables();
            lastGeneratedAtMs = 0;
            // Tables are now empty: forget the cursor so a failed import can't leave
            // the next pull 304-ing ("unchanged") against a cleared replica.
            lastImportedGeneratedAt = null;
            logger.info('P2P', '[Backup] 🧹 Force-resync: replicated tables cleared, importing fresh snapshot…');
        }

        // The import path enforces: valid signature → signer maps to a trusted
        // `mirror` connector (the primary) → conservation guard (runs on a backup
        // unconditionally, A2-8). A forged/tampered snapshot is rejected there.
        const result = await importRemoteState(payload);

        if (payload.generatedAt) {
            const genMs = Date.parse(payload.generatedAt);
            if (Number.isFinite(genMs)) lastGeneratedAtMs = genMs;
            lastImportedGeneratedAt = payload.generatedAt; // conditional-pull cursor
        }
        lastSuccessAt = Date.now();
        if (consecutiveFailures > 0) {
            logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
        }
        consecutiveFailures = 0;
        // Verify the replica actually matches what the primary just sent. Never let a
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
        logger.sync('P2P', `[Backup] ⬇️ Pulled snapshot from primary: ${summarize(result)}`);
        return { ok: true };
    } catch (e: any) {
        consecutiveFailures++;
        const msg = e?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (e?.message || String(e));
        // Conservation/trust rejections are security-relevant — surface loudly.
        if (/conservation|untrusted|mirror|signature/i.test(msg)) {
            logger.security('P2P', `[Backup] ❌ Snapshot REJECTED by import guard: ${msg}`);
        } else {
            logger.warn('P2P', `[Backup] Pull #${consecutiveFailures} failed: ${msg} (will retry in interval)`);
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
    return pullOnce(true);
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
    logger.info('P2P', `[Backup] 🔁 One-directional backup active — checking config and pulling every ${Math.round(interval / 1000)}s`);

    // First pull shortly after boot so the replica converges quickly; then on interval.
    setTimeout(() => { pullOnce().catch(() => {}); }, 5_000);
    pullTimer = setInterval(() => { pullOnce().catch(() => {}); }, interval);
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
export function getBackupStatus(): { lastSuccessAt: number | null; consecutiveFailures: number; running: boolean; consistency: ReplicaConsistency | null } {
    return { lastSuccessAt, consecutiveFailures, running: pullTimer !== null, consistency: lastConsistency };
}
