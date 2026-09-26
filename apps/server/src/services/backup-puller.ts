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
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { pullTakeoverEnvelope } from './standby-envelopes.js';
import { getNodeProfile, readProfileRecord, writeProfileRecord } from '../config/node-profile.js';

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

    // Prefer the scoped replication token. The admin password is only a fallback for a
    // legacy standby that migrateStandbyPassword could not swap yet (it warns every start).
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
            clearReplicatedTables(keepPhotos);
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
        // The main server's node profile and switch overrides, signed with the payload the import just verified:
        // kept as this database's record, so a take-over or a hand promotion from here meets the main server's
        // profile, not this standby's (config/node-profile.ts). A primary too old to send it leaves the record alone.
        if (payload.nodeProfile) noteMainServerProfile(payload.nodeProfile);
        // A whole copy from a main server whose visitors are marked: every row here has its mark now (db.ts).
        if (!isDelta && payload.visitorsMarked === true) noteWholeCopyOfVisitorMarks();

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

function nextMode(): PullMode {
    if (!lastImportedCursor) return 'full'; // seed
    // A drift-triggered reconcile ALWAYS wins, even for a large DB — correctness beats
    // bandwidth when the stateHash canary says the copy has actually diverged, and it
    // only fires on a real mismatch. The SIZE cutoff and the operator "off" setting
    // only suppress the *routine* timer-based full re-read (belt-and-suspenders), which
    // the reliable deltas make optional at scale. So at GB size / reconcile-off: tiny
    // deltas every tick, no periodic full, and a full only if drift is truly detected.
    if (pendingReconcile) return 'full';
    // Once a process, a whole copy for a standby that has its main server's word that its visitors are marked but no whole
    // copy since: the rows it copied before it had the column carry no mark, and no delta brings them (db.ts
    // visitorMarksWantWholeCopy). One that fails isn't tried on every tick: the next routine one, or the next boot, brings it.
    if (!visitorMarksAsked && visitorMarksWantWholeCopy()) {
        visitorMarksAsked = true;
        lastImportedGeneratedAt = null; // a whole one, never a 304 "unchanged"
        logger.info('P2P', "[Backup] Visitors' rows: taking one whole copy of the main server, so the rows copied before this version get its marks");
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
    return pullOnce(nextMode());
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
export function getBackupStatus(): { lastSuccessAt: number | null; consecutiveFailures: number; running: boolean; consistency: ReplicaConsistency | null; cursor: string | null; lastFullReconcileAt: number; reconcileDisabledForSize: boolean; pullSeconds: number; reconcileMinutes: number } {
    return {
        lastSuccessAt,
        consecutiveFailures,
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
