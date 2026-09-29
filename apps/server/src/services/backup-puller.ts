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

import fs from 'node:fs';
import path from 'node:path';
import {
    importRemoteState, verifyCopyPage, getNodeRole, getReplicaConsistency, getStateHash, getSyncCursor, setSyncCursor,
    type ImportResult, type SyncPayload, type ReplicaConsistency,
} from '../state-engine.js';
import { logger } from '../logger.js';
import { db, noteWholeCopyOfVisitorMarks, visitorMarksWantWholeCopy, TOMBSTONE_RETENTION_MS } from '../db/db.js';
import { noteWholeCopyOfReplacedKeys, replacedKeysWantWholeCopy } from '../engine/key-move.js';
import { noteWholeCopyOfMemberBlocks, memberBlocksWantWholeCopy } from '../engine/member-blocks.js';
import {
    REPLICA_FORMAT, replicaFormatOfCopy, noteLedgerMismatch, valueLeftOutName, OversizedCopyError, deleteSyncCursor, mergeCopyPages, isCopyPage,
    type CopyPage, type ValueLeftOut,
} from '../engine/sync.js';
import { StagedCopy, StagedCopyRefused, roomForStaging, stagingDir, READY_FILE, PREVIOUS_DB, SWAPPED_COPY_KEY } from './stager.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { pullTakeoverEnvelope } from './standby-envelopes.js';
import { takeRecoverySealFullPull, clearCopiesDroppedBeforeSeal, noteWholeCopyThisProcess } from './recovery-seal-key.js';
import { getNodeProfile, readProfileRecord, writeProfileRecord } from '../config/node-profile.js';
import { compareTableHashes, readTableHashes, tableContentHashes } from '../engine/replica-hashes.js';
import { LEDGER_DIFFERS, STANDBY_REPORT_HEADER } from './standby-report.js';
import {
    HEALING_MS, lastMismatchResyncAt, noteCopyFailed, noteCopyLanded, noteMismatchResyncAsked, noteMismatchResyncTaken,
    notePastRetention, noteUncomparedCheck, noteWholeCopyCheck, noteWholeCopyTaken, pendingMismatchResync, readCopyRecord, standbyReport, whyOf,
} from './standby-copy-record.js';
import { errorMessage } from '../error-message.js';
import { STATE_HASH_TABLES } from '@beanpool/engine';
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

/** A copy in pages (routes/backup.ts, engine/copy-pages.ts): opened here, its pages asked for at `<copyId>/<n>`. */
const COPY_PATH = '/api/local/admin/sync-copy';
const DEFAULT_INTERVAL_MS = 60_000;
/** Each request of a copy (its opening, each page) is abandoned after this long. */
const FETCH_TIMEOUT_MS = 30_000;
// How often to fall back to a FULL reconcile instead of a delta. A full pull re-reads
// every row, so it catches the rare mutations that don't advance a per-row watermark
// (chiefly the social-recovery mass pubkey rewrite across immutable-timestamp tables)
// and lets getReplicaConsistency verify exact row-count/balance parity. Deltas carry
// the whole-state stateHash as a cheap per-cycle canary in between.
const DEFAULT_RECONCILE_EVERY_MS = 15 * 60_000;
/**
 * A whole copy of more than one page is built in a staging database and swapped in at a restart (services/stager.ts): the
 * routine one is taken this often at most, not every reconcile interval, and sooner only when the copy has drifted (the
 * delta canary, a whole copy that didn't match) or a delta is too big to take (design scratch/global-node/DESIGN-paged-
 * copies-fable.md §4.5). BACKUP_BIG_COPY_EVERY_MS.
 */
const DEFAULT_BIG_COPY_EVERY_MS = 24 * 60 * 60_000;
/**
 * A delta is taken whole in memory and imported in one transaction, as one payload (design §5): at most this many pages of
 * it (32 MB of JSON at the main server's 8 MB a page). One bigger is not taken: a whole copy is, instead. BACKUP_DELTA_PAGES.
 */
const DEFAULT_DELTA_PAGES = 4;
/**
 * The least time between two requests of one copy, so a copy of any size never trips the main server's limit on
 * administrative requests (300 a minute from one address, https-server.ts): at most 240 a minute, with room for the
 * standby's other requests. BACKUP_PAGE_GAP_MS.
 */
const DEFAULT_PAGE_GAP_MS = 250;
/** A page whose text is bigger than this is refused unread (a page is 8 MB of rows, and never splits one). */
const DEFAULT_PAGE_MAX_BYTES = 64 * 1024 * 1024;
function envMs(name: string, fallback: number, min = 1): number {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= min ? v : fallback;
}
const deltaPages = () => Math.max(1, Math.floor(envMs('BACKUP_DELTA_PAGES', DEFAULT_DELTA_PAGES)));
const pageGapMs = () => envMs('BACKUP_PAGE_GAP_MS', DEFAULT_PAGE_GAP_MS, 0);
const bigCopyEveryMs = () => envMs('BACKUP_BIG_COPY_EVERY_MS', DEFAULT_BIG_COPY_EVERY_MS);
const pageMaxBytes = () => envMs('BACKUP_PAGE_MAX_BYTES', DEFAULT_PAGE_MAX_BYTES);
// sync_cursors sentinel under which we persist the delta cursor, so a backup restart
// resumes deltas instead of re-pulling a full snapshot. Only a copy that lands moves it:
// a refused one, a force-resync's included, leaves it where the last copy that landed put it.
const BACKUP_CURSOR_PEER = 'backup:primary';
// After a force-resync, or the first copy of a standby that has none, came and was refused (design
// scratch/global-node/DESIGN-replica-flood-bounds-opus.md §4.2, N2): no other is asked for in this long. The same rows
// would be refused again, and each one costs the main server a whole copy built, signed and sent. The format re-seed is
// asked for again after it, until one lands; meanwhile deltas carry on from the cursor this standby kept.
const DEFAULT_RESYNC_RETRY_MS = 60 * 60_000;
function resyncRetryMs(): number {
    const v = Number(process.env.BACKUP_RESYNC_RETRY_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RESYNC_RETRY_MS;
}

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
// Raw generatedAt string of the last imported snapshot.
let lastImportedGeneratedAt: string | null = null;
// Delta watermark: the payload.cursor of the last successful import. Sent as
// X-Since-Cursor so the primary ships only rows changed since. Persisted across
// restarts in sync_cursors. Null → no cursor yet → next pull is a full seed.
let lastImportedCursor: string | null = null;
// Full-reconcile bookkeeping, kept in the standby's record across restarts (standby-copy-record.ts lastWholeCopy): a whole
// copy of more than one page restarts the standby to be swapped in, and the next routine one is due from when it landed.
let lastFullReconcileAt = 0;
// How many pages the last whole copy took: more than one, and the routine whole copy is taken daily (nextMode).
let lastWholePages = 0;
// P3 removes it: the 8 MB gate that turned routine whole copies off is gone, and a whole copy's cadence follows its size in
// pages instead (nextMode). Kept, false, for the status the fleet manager reads.
const reconcileDisabledForSize = false;
let pendingReconcile = false; // set when a delta's stateHash canary detects drift
// A delta would have taken more than BACKUP_DELTA_PAGES pages: the next pull is a whole copy (design §5).
let deltaTooBig = false;
// The first pull of this process reads what the database says of the copies before it (restoreFromDatabase).
let restored = false;
// The database the last swap replaced (db/swap-at-boot.ts), deleted once a copy lands on the new one.
let previousToDelete = false;
// A whole copy is ready to be swapped in: this process restarts (requestSwapRestart), and pulls nothing more.
let swapReady = false;
// N2 (design §4.2): after a copy that came and was refused, when the next of its kind may be asked for. A whole copy waits
// for the next routine one (a reconcile interval); a force-resync, and a first copy, RESYNC_RETRY_MS. An operator's
// force-resync is always taken. A force-resync or a first copy that never came (the main server restarting) keeps the usual
// cadence; a whole copy taken over deltas that never came waits for the next routine one too, and the retention resync
// RESYNC_RETRY_MS (pullOnce).
let wholeRetryAt = 0;
let resyncRetryAt = 0;
// The last whole copy landed with tables left out (more rows than one copy carries, design §5): the next of any kind waits
// for the next routine one, read at the interval set now (nextMode).
let lastWholeLeftOut = false;
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
export const LEDGER_RESYNC_EVERY_MS = 6 * 60 * 60_000;

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
    if (r.plainChanges) parts.push(`in-flight~${r.plainChanges}`);
    if (r.plainTablesLeftOut?.length) parts.push(`in-flight left out:${r.plainTablesLeftOut.length}`);
    if (r.conflictsSkipped) parts.push(`skipped:${r.conflictsSkipped}`);
    if (r.valuesLeftOut?.length) parts.push(`values left out:${r.valuesLeftOut.length}`);
    if (r.tablesLeftOut?.length) parts.push(`tables left out (over the row cap): ${r.tablesLeftOut.join(', ')}`);
    return parts.length === 0 ? 'no changes' : parts.join(', ');
}

type PullMode = 'delta' | 'full' | 'resync';
/**
 * Why a force-resync: a whole copy built from nothing in a staging database (services/stager.ts), whatever its size. The
 * format re-seed (REPLICA_FORMAT) and an operator's are seeds, decided by this standby alone; one the loop takes after a
 * whole copy that didn't match (checkWholeCopy), or after a delta that left the main server's deletions out, isn't: a
 * main server can make a copy fail that check, so its copy is held to the ledger this standby holds (the stager's
 * conservation guard). Nor is `retention`, the one for a cursor older than the main server keeps its deletes (nextMode).
 */
type ResyncKind = 'format' | 'operator' | 'mismatch' | 'retention';

/**
 * A cursor older than this has missed deletes: the main server keeps them TOMBSTONE_RETENTION_MS (db/db.ts), and a day
 * less leaves room for the two servers' clocks and their daily prunes (design §6.3 T6).
 */
const PAST_RETENTION_MS = TOMBSTONE_RETENTION_MS - 24 * 60 * 60_000;
function pastRetention(cursor: string, now: number): boolean {
    const at = Date.parse(cursor);
    return Number.isFinite(at) && at < now - PAST_RETENTION_MS;
}

/** A copy's opening page or next page, as it came: its text (what the stager imports, byte for byte) and what it says. */
interface CopyPageRead {
    page: CopyPage & { copyId: string; n: number };
    text: string;
}

/** The main server answered with no copy: `status` its HTTP status (routes/backup.ts sync-copy). */
class NoCopy extends Error {
    constructor(readonly status: number) {
        super(`primary returned HTTP ${status}`);
    }
}

/**
 * The requests of copies served in pages (routes/backup.ts, engine/copy-pages.ts), each abandoned after FETCH_TIMEOUT_MS
 * and read up to BACKUP_PAGE_MAX_BYTES, and paced BACKUP_PAGE_GAP_MS apart.
 */
class CopyRequests {
    private lastAt = 0;

    constructor(private readonly base: string, private readonly headers: Record<string, string>) {}

    private async request(method: 'POST' | 'GET' | 'DELETE', route: string): Promise<Response> {
        const wait = this.lastAt + pageGapMs() - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastAt = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(this.base + route, { method, headers: this.headers, signal: controller.signal });
            // The body is read under the same timer: a copy's page that stops arriving is abandoned like one that never came.
            if (res.status === 200) (res as Response & { text_?: string }).text_ = await readUpTo(res, pageMaxBytes());
            return res;
        } finally {
            clearTimeout(timeout);
        }
    }

    private read(res: Response): CopyPageRead {
        const text = (res as Response & { text_?: string }).text_ ?? '';
        const page = JSON.parse(text) as unknown;
        if (!isCopyPage(page)) throw new SyntaxError('the main server sent something that is not a page of a copy');
        return { page: page as CopyPageRead['page'], text };
    }

    /**
     * Open a copy: a whole one, or a delta of the rows written at or after `since`. No "unchanged" answer as the old whole
     * payload had (a 304): each pull's own bookkeeping on the main server (its access log, the standby's report, the
     * take-over keys it holds) is a write, so the database it would ask about has always changed since the last copy.
     */
    async open(since: string | null): Promise<CopyPageRead> {
        const res = await this.request('POST', `${COPY_PATH}${since ? `?since=${encodeURIComponent(since)}` : ''}`);
        if (res.status !== 200) throw new NoCopy(res.status);
        // A snapshot must come from a primary; warn (but still import — the mirror-trust gate is the real authority) if
        // we're chained off a backup.
        const remoteRole = res.headers.get('X-Node-Role');
        if (remoteRole && remoteRole !== 'primary') {
            logger.warn('P2P', `[Backup] ⚠️ Snapshot source advertises role '${remoteRole}', expected 'primary' — chained replication?`);
        }
        const read = this.read(res);
        if (read.page.n !== 0 || !read.page.rowCounts) throw new SyntaxError('the main server\'s copy did not start with its opening page');
        return read;
    }

    /** Page `n` of copy `copyId`: that page of that copy, or the pull fails. */
    async page(copyId: string, n: number): Promise<CopyPageRead> {
        const res = await this.request('GET', `${COPY_PATH}/${encodeURIComponent(copyId)}/${n}`);
        if (res.status !== 200) throw new NoCopy(res.status);
        const read = this.read(res);
        if (read.page.copyId !== copyId || read.page.n !== n) {
            throw new CopyPageRefused(`page ${n} of copy ${copyId.slice(0, 8)} came as page ${read.page.n} of copy ${String(read.page.copyId).slice(0, 8)}`);
        }
        return read;
    }

    /** The main server may close a copy this standby won't finish (it serves one at a time). Never throws. */
    async close(copyId: string): Promise<void> {
        try { await this.request('DELETE', `${COPY_PATH}/${encodeURIComponent(copyId)}`); } catch { /* it closes by itself when idle */ }
    }
}

/** A page that came but is not the one asked for, or not one this standby takes: the copy came and was refused. */
class CopyPageRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CopyPageRefused';
    }
}

/** A response's text, up to `max` bytes: one longer is refused unread past that. */
async function readUpTo(res: Response, max: number): Promise<string> {
    const length = Number(res.headers.get('content-length'));
    if (Number.isFinite(length) && length > max) {
        try { await res.body?.cancel(); } catch { /* gone */ }
        throw new CopyPageRefused(`a page of ${length} bytes, more than the ${max} this standby reads`);
    }
    if (!res.body) return '';
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        n += chunk.length;
        if (n > max) throw new CopyPageRefused(`a page of more than the ${max} bytes this standby reads`);
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

/** Rows in a copy, as its opening page counts them. */
function rowsOfCopy(counts: unknown): number {
    const c = counts as Record<string, unknown> & { plainTables?: Record<string, unknown> };
    let n = 0;
    for (const [k, v] of Object.entries(c ?? {})) if (k !== 'plainTables' && typeof v === 'number') n += v;
    for (const v of Object.values(c?.plainTables ?? {})) if (typeof v === 'number') n += v;
    return n;
}

/**
 * What a copy carries beside its tables, kept: the main server's node profile and switch overrides, and its community
 * settings (signed with the copy the import verified; a primary too old to send them leaves the records alone), and, from a
 * whole copy, that every row carries its main server's visitor mark, and every replaced key and block list is here
 * (db.ts, engine/key-move.ts, engine/member-blocks.ts). A whole copy built in a staging database keeps them there
 * (services/stager.ts); `payload` names each category its copy carries.
 */
export function keepMainServerRecords(payload: SyncPayload, whole: boolean): void {
    // The main server's node profile and switch overrides, signed with the payload the import just verified:
    // kept as this database's record, so a take-over or a hand promotion from here meets the main server's
    // profile, not this standby's (config/node-profile.ts). A primary too old to send it leaves the record alone.
    if (payload.nodeProfile) noteMainServerProfile(payload.nodeProfile);
    // The community's own settings, signed with it too: kept, not applied, while this is a standby. A primary too old to
    // send them leaves this standby's record alone, and a take-over from here then keeps this standby's own.
    if (payload.communitySettings !== undefined) noteMainServerCommunitySettings(payload.communitySettings, payload.generatedAt ?? null);
    // A whole copy from a main server whose visitors are marked: every row here has its mark now (db.ts).
    if (whole && payload.visitorsMarked === true) noteWholeCopyOfVisitorMarks();
    // A whole copy that carries the main server's replaced keys: every one is here now (engine/key-move.ts).
    if (whole && Array.isArray(payload.invalidatedKeys)) noteWholeCopyOfReplacedKeys();
    // A whole copy that carries the main server's block lists: every one is here now (engine/member-blocks.ts).
    if (whole && Array.isArray(payload.memberBlocks)) noteWholeCopyOfMemberBlocks();
}

/** Pull once from the primary and import it. Never throws.
 *  - 'delta'  : incremental — a copy of the rows changed since the cursor, at most BACKUP_DELTA_PAGES pages of it, imported
 *               as one payload over this standby's rows. Falls back to a whole copy automatically if we have no cursor
 *               yet; one bigger than that is not taken, and the next pull is a whole copy.
 *  - 'full'   : a whole copy (initial seed or periodic reconcile). One page, over a copy this standby holds, is imported
 *               over its rows and checked (checkWholeCopy); anything bigger, or a first copy, is built in a staging
 *               database and swapped in at a restart (services/stager.ts).
 *  - 'resync' : a whole copy built from nothing in a staging database, whatever its size, bypassing the stale-skip: the
 *               replica is rebuilt 1:1 when the copy is swapped in, and left exactly as it was when it is refused. */
async function pullOnce(mode: PullMode = 'delta', why: ResyncKind | null = null): Promise<{ ok: boolean; error?: string; staged?: boolean }> {
    if (inFlight) return { ok: false, error: 'A pull is already in progress.' };
    if (swapReady) return { ok: false, error: 'A whole copy is ready to be swapped in: this standby is restarting.' };

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
    // this standby's own records before anything is fetched, and never from its ledger, which a copy can change: the
    // format re-seed, an operator's force-resync, and a first copy (it holds none: no record of a format and no cursor).
    // Any other copy is held to the ledger here: a whole copy built in a staging database, to this standby's live ledger
    // (services/stager.ts).
    // A cursor with no format record is a copy an older importer made (every standby that copied before the record): its
    // deltas are held to its ledger like any other's while its re-seed waits, never taken as seeds. Held, not stopped: a
    // re-seed refused for good would otherwise leave this standby taking seeds from every delta, with no guard, or none at all.
    const hadCursor = !!lastImportedCursor;
    const seed = (fresh && (why === 'format' || why === 'operator')) || (replicaFormatOfCopy() === 0 && !hadCursor);

    inFlight = true;
    // Where a failure happened: no copy came ('fetch'), or it came and was not imported ('import'). Only the second counts
    // toward "refused in a row" in the report.
    let stage: 'fetch' | 'import' = 'fetch';
    const requests = new CopyRequests(primaryUrl.replace(/\/$/, ''), authHeader);
    // The copy open on the main server, closed there when this pull leaves it unfinished; the one being built here.
    let openCopy: string | null = null;
    let staged: StagedCopy | null = null;
    try {
        const opened = await requests.open(isDelta ? lastImportedCursor : null);
        const opening = opened.page;
        openCopy = opening.copyId;

        // A2-17: reject a replayed/stale payload before importing. Older-or-equal
        // generatedAt is a replay or no-op. Harmless for deltas (LWW dedupes) but kept
        // uniform. (Tampering with generatedAt invalidates the signature, rejected below.)
        if (!fresh && opening.generatedAt) {
            const genMs = Date.parse(opening.generatedAt);
            if (Number.isFinite(genMs) && genMs <= lastGeneratedAtMs) {
                logger.sync('P2P', `[Backup] ↩︎ Skipped stale/replayed ${isDelta ? 'delta' : 'snapshot'} (generatedAt ${opening.generatedAt} ≤ last imported)`);
                return { ok: true };
            }
        }

        // The force-resync a copy that didn't match asked for is taken once a copy came for it, in this process and in
        // the standby's record, whatever its import does: one whose fetch failed (a main server restarting with the
        // same update) is asked for again on the next pull, and none is taken twice.
        if (fresh && why === 'mismatch') {
            ledgerResyncAskedAt = null;
            recordQuietly(() => noteMismatchResyncTaken());
        }

        // ── A whole copy built in a staging database: a force-resync, a first copy, or one of more than one page ──
        if (!isDelta && (fresh || !hadCursor || opening.last !== true)) {
            stage = 'import';
            const room = roomForStaging();
            if (!room.ok) {
                throw new StagedCopyRefused(`There is no room on this server's disk for a second copy of its database while a whole copy is built: `
                    + `${Math.round(room.free / 1048576)} MB free, ${Math.round(room.need / 1048576)} MB needed`, 'import-error');
            }
            await verifyCopyPage(opening);
            staged = await StagedCopy.start(opening.copyId);
            logger.info('P2P', `[Backup] ${fresh ? 'Force-resync' : 'Whole copy'}: building copy ${opening.copyId.slice(0, 8)} of the main server `
                + `(${rowsOfCopy(opening.rowCounts)} rows) in a staging database; it replaces this standby's copy only if every check passes.`);
            await staged.page(0, opened.text);
            let last = opening.last === true;
            for (let n = 1; !last; n++) {
                stage = 'fetch';
                const next = await requests.page(opening.copyId, n).catch((e) => {
                    // A page that came but is not the one asked for: the copy came, and is refused.
                    if (e instanceof CopyPageRefused) stage = 'import';
                    throw e;
                });
                stage = 'import';
                await verifyCopyPage(next.page);
                await staged.page(n, next.text);
                last = next.page.last === true;
            }
            openCopy = null;
            const checked = await staged.finish({ seed, resync: fresh });
            staged.markReady({ pages: checked.pages, rows: checked.rows, generatedAt: checked.generatedAt, cursor: checked.cursor, why: why ?? mode });
            staged = null;
            // Landed, as far as this process goes: the next start swaps it in, and the standby's record in it already says so.
            lastSuccessAt = Date.now();
            if (consecutiveFailures > 0) logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
            consecutiveFailures = 0;
            lastFullReconcileAt = Date.now();
            swapReady = true;
            logger.sync('P2P', `[Backup] ⬇️ ${fresh ? 'Re-seeded' : 'Whole copy'} from primary in ${checked.pages} page(s), ${checked.rows} rows, `
                + `${checked.exact ? 'exact' : checked.hashed ? `not exact (${checked.differs.join(', ')}: values this server's tables refuse)` : 'not compared'}: `
                + 'restarting to swap it in.');
            requestSwapRestart();
            return { ok: true, staged: true };
        }

        // ── A delta, or a whole copy of one page over the copy this standby holds: imported as one payload ──
        const pages: CopyPage[] = [opening];
        if (isDelta && opening.last !== true) {
            const most = deltaPages();
            const pageRows = typeof opening.pageRows === 'number' && opening.pageRows > 0 ? opening.pageRows : Infinity;
            // More rows than that many pages hold: not fetched at all.
            let tooBig = rowsOfCopy(opening.rowCounts) > most * pageRows;
            while (!tooBig && pages[pages.length - 1].last !== true) {
                if (pages.length >= most) { tooBig = true; break; }
                pages.push((await requests.page(opening.copyId, pages.length)).page);
            }
            if (tooBig) {
                await requests.close(opening.copyId);
                openCopy = null;
                deltaTooBig = true;
                logger.warn('P2P', `[Backup] The changes since this standby's last copy are more than ${most} page(s) of a copy `
                    + `(${rowsOfCopy(opening.rowCounts)} rows): not taken. The next pull is a whole copy.`);
                return { ok: true };
            }
        }
        openCopy = null;
        stage = 'import';
        // The import path enforces: each page's valid signature → signer maps to a trusted `mirror` connector (the
        // primary) → the pages are one copy, every page in order → conservation guard (runs on a backup unconditionally,
        // A2-8). A forged/tampered page is rejected there. It applies a delta or a whole copy identically, LWW per row; only
        // the recovery seal's clean-up needs to know which this was.
        const result = await importRemoteState(pages, { full: !isDelta, seed });
        const payload = mergeCopyPages(pages);
        keepMainServerRecords(payload, !isDelta);

        if (payload.generatedAt) {
            const genMs = Date.parse(payload.generatedAt);
            if (Number.isFinite(genMs)) lastGeneratedAtMs = genMs;
            lastImportedGeneratedAt = payload.generatedAt;
        }
        const leftOut = result.tablesLeftOut ?? [];
        // Advance the delta watermark and persist it so a restart resumes deltas. Not past a whole copy that left a table
        // out and was taken over deltas (a routine one, the canary's, or a once-a-process one; not a force-resync of any
        // kind, and not a first copy): it carried none of that table's rows, so a cursor it moved would skip the ones
        // written since the last delta, for good (#1315 review 4132483095). The cursor stays at the last delta's, and the
        // next delta carries that window again, every table of it: the importer takes a row it already holds as a no-op
        // (the same stamp, the same transaction id). Nor kept when it would be past retention (nextMode) before the next
        // pull, unless this copy left the deletes out too (#1315 review 4133485540). The next pull starts a pull interval
        // after this one and the take-over keys' fetch end, so two intervals of margin.
        // A copy served in pages leaves no table out (engine/sync.ts importRemoteState): `leftOut` is empty for every copy
        // this puller takes, and this rule, with the record's lastLacking and the canary's reading of it below, keeps
        // nothing back. P3 removes them.
        const nearRetention = !!lastImportedCursor && !leftOut.includes('tombstones')
            && pastRetention(lastImportedCursor, Date.now() + 2 * getPullMs());
        const keepCursor = !isDelta && !fresh && hadCursor && leftOut.length > 0 && !nearRetention;
        if (payload.cursor && !keepCursor) {
            lastImportedCursor = payload.cursor;
            try { setSyncCursor(BACKUP_CURSOR_PEER, payload.cursor); } catch { /* best-effort */ }
        }
        lastSuccessAt = Date.now();
        if (consecutiveFailures > 0) logger.info('P2P', `[Backup] ✅ Recovered after ${consecutiveFailures} failed pull(s)`);
        consecutiveFailures = 0;
        deltaTooBig = false;
        // A table a whole copy leaves out, this standby lacks rows of (the record's lastLacking, which the canary doesn't
        // read) unless the copy's own hash of it equals this standby's rows of it now (#1315 review 4131868827).
        const current = !isDelta && leftOut.length > 0 ? leftOutTablesCurrent(payload, leftOut) : [];
        recordQuietly(() => noteCopyLanded(lastSuccessAt!, { whole: !isDelta, leftOut, current, resync: fresh }));
        if (leftOut.length > 0) {
            logger.warn('P2P', `[Backup] ⚠️ This copy landed without ${leftOut.join(', ')}: the main server holds more rows of `
                + `${leftOut.length === 1 ? 'it' : 'them'} than one copy carries. This standby keeps its own rows of ${leftOut.length === 1 ? 'it' : 'them'}; the rest is copied.`
                + (keepCursor ? ' The next delta starts where the last one ended, so it brings the rows written since.' : ''));
        }
        // The database the last swap replaced is not needed once a copy has landed on the new one.
        if (previousToDelete) deletePreviousDatabase();

        if (isDelta) {
            // Deltas carry only changed rows, so a row-count compare is meaningless.
            // Use the whole-state stateHash as a cheap per-cycle canary; on mismatch,
            // schedule a full reconcile to re-establish exact parity (catches the rare
            // watermark-less mutation, e.g. a social-recovery pubkey rewrite).
            if (payload.stateHash) {
                const localHash = getStateHash();
                // A table the hash reads that this standby lacks rows of (lastLacking, from copies before this version): the
                // hash differs until a whole copy carries that table again. The copy is reported not exact by that table's
                // name instead, and the next routine whole copy compares every table by its own hash (checkWholeCopy).
                const stale = staleTablesOfCopy(leftOut).filter((t) => STATE_HASH_TABLES.includes(t));
                if (localHash !== payload.stateHash && stale.length > 0) {
                    logger.sync('P2P', `[Backup] Delta stateHash canary not read: ${stale.join(', ')} left out of this standby's copies, so the hash `
                        + 'differs until a whole copy carries them. No whole copy asked for; the next routine one checks every table.');
                } else if (localHash !== payload.stateHash) {
                    pendingReconcile = true;
                    logger.warn('P2P', `[Backup] ⚠️ Delta stateHash canary drift (local ${localHash} ≠ primary ${payload.stateHash}) — scheduling full reconcile`);
                }
            }
            logger.sync('P2P', `[Backup] ⬇️ Delta applied (${pages.length} page${pages.length === 1 ? '' : 's'}): ${summarize(result)}`);
            // The main server's deletions this delta left out: the rows they remove are still here. One force-resync, the
            // held kind, mends it, under the same six-hour limit as the one a whole copy that didn't match asks for.
            if (leftOut.includes('tombstones')) {
                const asked = askMismatchResync(Date.now());
                if (asked) recordQuietly(() => noteMismatchResyncAsked(lastLedgerResyncAt));
                logger.warn('P2P', `[Backup] The main server's deletions were left out of this delta. ${asked ? 'Taking a force-resync next.'
                    : `No force-resync before ${new Date(lastLedgerResyncAt + LEDGER_RESYNC_EVERY_MS).toISOString()}.`}`);
            }
        } else {
            lastFullReconcileAt = Date.now();
            pendingReconcile = false;
            // A whole copy landed: whatever held the last one back when it was refused is gone. One that landed with tables
            // left out holds the next back instead, as a refused one does (N2, nextMode).
            wholeRetryAt = 0;
            lastWholeLeftOut = leftOut.length > 0;
            lastWholePages = 1;
            recordQuietly(() => noteWholeCopyTaken({ at: lastFullReconcileAt, pages: 1, generatedAt: payload.generatedAt ?? null }));
            // Verify the replica matches what the primary sent. Never let a
            // consistency-check error mask an otherwise-successful pull.
            try {
                checkWholeCopy(payload, result.valuesLeftOut, result.plainTablesLeftOut, leftOut);
            } catch (e: any) {
                logger.warn('P2P', `[Backup] Consistency check failed to run: ${e?.message || e}`);
            }
            logger.sync('P2P', `[Backup] ⬇️ Full pull from primary (one page): ${summarize(result)}`);
        }
        return { ok: true };
    } catch (e: any) {
        // A copy left unfinished: its stager stopped and its staging deleted (this standby's copy is as it was), and the
        // main server told it may close its snapshot.
        if (staged) staged.abort(e?.message || String(e));
        if (openCopy) void requests.close(openCopy);
        consecutiveFailures++;
        const oversized = e instanceof OversizedCopyError ? e.tables : [];
        const whyCode = e instanceof StagedCopyRefused ? e.why : whyOf(stage, e);
        recordQuietly(() => noteCopyFailed(stage === 'import' ? 'refused' : 'fetch-failed', whyCode, Date.now(), oversized, !isDelta));
        // N2: a whole copy that came and was refused is not asked for again on the next tick: the same rows would be
        // refused, and each one costs the main server a whole copy built, signed and sent. A delta is: it costs little, and
        // its cursor stays where the last copy that landed put it.
        if (stage === 'import' && !isDelta) {
            const now = Date.now();
            wholeRetryAt = now + (getReconcileMs() || resyncRetryMs());
            if (fresh || !hadCursor) resyncRetryAt = now + resyncRetryMs();
        }
        // So does one taken over deltas that never came (the main server answering 503 or 500, a page it no longer has, or
        // a request timing out): asked for again on the next tick, it would be every tick's pull, and no delta would land
        // meanwhile (#1315 review 4132485902). Deltas carry on, and the next routine time asks again. A force-resync or a
        // first copy that never came is asked for on the next tick (the main server may be restarting with the same
        // update); the retention one waits RESYNC_RETRY_MS (below).
        const wholeNeverCame = stage === 'fetch' && !isDelta && !fresh && hadCursor;
        if (wholeNeverCame) wholeRetryAt = Date.now() + (getReconcileMs() || resyncRetryMs());
        // The retention resync waits RESYNC_RETRY_MS after any failure, a copy that never came too. Asked for on the next
        // tick instead, it would be every tick's pull, and no delta would ever land. Deltas carry on meanwhile; the record
        // keeps it owed (nextMode).
        if (why === 'retention') resyncRetryAt = Date.now() + resyncRetryMs();
        const msg = e?.name === 'AbortError' ? `timeout after ${FETCH_TIMEOUT_MS}ms` : (e?.message || String(e));
        // Conservation/trust rejections are security-relevant — surface loudly.
        if (/conservation|untrusted|mirror|signature/i.test(msg)) {
            logger.security('P2P', `[Backup] ❌ ${isDelta ? 'Delta' : 'Snapshot'} REJECTED by import guard: ${msg}`);
        } else {
            const next = why === 'retention'
                ? `no force-resync asked for before ${new Date(resyncRetryAt).toISOString()}; deltas meanwhile`
                : stage === 'import' && !isDelta
                ? `no ${fresh || !hadCursor ? 'force-resync or first copy' : 'whole copy'} asked for before ${new Date(fresh || !hadCursor ? resyncRetryAt : wholeRetryAt).toISOString()}`
                : wholeNeverCame
                ? `no whole copy asked for before ${new Date(wholeRetryAt).toISOString()}; deltas meanwhile`
                : 'will retry in interval';
            logger.warn('P2P', `[Backup] Pull #${consecutiveFailures} (${fresh ? 'resync' : isDelta ? 'delta' : 'full'}) failed: ${msg} (${next})`);
        }
        return { ok: false, error: msg };
    } finally {
        inFlight = false;
    }
}

/** The database the last swap replaced (db/swap-at-boot.ts), gone once a copy lands on the new one. Never throws. */
function deletePreviousDatabase(): void {
    previousToDelete = false;
    const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    for (const s of ['', '-wal', '-shm']) {
        try { fs.rmSync(path.join(dir, PREVIOUS_DB + s), { force: true }); } catch (e) {
            logger.warn('P2P', `[Backup] ${PREVIOUS_DB}${s} could not be deleted: ${errorMessage(e)}`);
        }
    }
}

/**
 * After a whole copy is made ready in the staging directory (services/stager.ts): the server restarts, as a take-over's
 * does (services/takeover.ts), and the swap at boot puts the copy in place (db/swap-at-boot.ts). Docker's restart policy
 * starts it again. Tests replace it (setSwapRestartForTests).
 */
function restartToSwap(): void {
    stopBackupPuller();
    setTimeout(() => {
        // Called off meanwhile (a take-over confirmed: services/stager.ts abortStagedCopy): nothing to swap in.
        if (!fs.existsSync(path.join(stagingDir(), READY_FILE))) {
            logger.warn('P2P', '[Backup] The whole copy made ready was called off: not restarting for it.');
            swapReady = false;
            return;
        }
        logger.warn('P2P', '[Backup] Restarting to swap in the whole copy just made…');
        process.exit(0);
    }, 500).unref?.();
}
let swapRestart: () => void = restartToSwap;
function requestSwapRestart(): void {
    swapRestart();
}
/** A test's own restart after a whole copy is made ready (takeover-test-harness.ts), or the real one again (null). */
export function setSwapRestartForTests(fn: (() => void) | null): void {
    swapRestart = fn ?? restartToSwap;
}

/**
 * The tables this standby lacks rows of, because copies left them out (more rows than one copy carries): the ones its
 * record keeps until a whole copy carries them again (services/standby-copy-record.ts lastLacking), and this delta's.
 */
function staleTablesOfCopy(thisDelta: readonly string[]): string[] {
    let recorded: readonly string[] = [];
    try { recorded = readCopyRecord().lastLacking?.tables ?? []; } catch { /* the record unreadable: this delta's alone */ }
    return [...new Set([...recorded, ...thisDelta])];
}

/**
 * Of the tables a whole copy left out, the ones this standby holds exactly as the main server did when it made the copy:
 * the copy's own hash of each (SyncPayload `tableHashes`, as checkWholeCopy reads them) equals this standby's, hashed now.
 * None when the copy sent no hashes (one written to while it was being made), or they can't be read here.
 */
function leftOutTablesCurrent(payload: SyncPayload, leftOut: readonly string[]): string[] {
    try {
        const theirs = readTableHashes((payload as SyncPayload & { tableHashes?: unknown }).tableHashes);
        if (!theirs) return [];
        const hashed = leftOut.filter((t) => Object.hasOwn(theirs, t));
        if (hashed.length === 0) return [];
        const photosLeftOut = new Set((Array.isArray(payload.photosOmitted) ? payload.photosOmitted : []).filter((k): k is string => typeof k === 'string'));
        const mine = tableContentHashes({ only: hashed, photosLeftOut }).tables;
        return hashed.filter((t) => mine[t] !== undefined && mine[t].rows === theirs[t].rows && mine[t].hash === theirs[t].hash);
    } catch (e: any) {
        logger.warn('P2P', `[Backup] The tables this whole copy left out could not be hashed here: ${e?.message || e}`);
        return [];
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
 * brings such rows into the table's rules, and the next whole copy is exact again. The members table's content is
 * compared with those values read as the copy names them, so it differs only where the import copied a row other than
 * verbatim, which a force-resync mends.
 * `plainTablesLeftOut`: the same for the plain tables (engine/plain-tables.ts, `<table>:<key>` for a row this standby's
 * table refuses whatever is left out, or its unique indexes refuse; `<table>:<key>.<column>` for a value). Each such
 * table is not exact, reported, and asks for no force-resync: a whole copy deletes every row it doesn't name before it
 * writes, so the refusal is of the main server's own rows, and a force-resync reads the same ones (review 4123472786).
 * Such a table's other rows are not compared on their own: its count and content differ by the rows left out.
 * `tablesLeftOut`: the tables the import left out whole, over the row cap (engine/sync.ts ImportResult.tablesLeftOut,
 * design §5). The copy isn't exact, and says which, but none of them is a difference a force-resync mends (it would read
 * the same rows): they are neither compared nor counted in `differs`, and ask for none.
 * Exported so a suite can run it on a copy it fetched.
 */
export function checkWholeCopy(
    payload: SyncPayload, valuesLeftOut: readonly ValueLeftOut[] = [], plainTablesLeftOut: readonly string[] = [],
    tablesLeftOut: readonly string[] = [],
): ReplicaConsistency {
    const c = getReplicaConsistency(payload);
    // The deletions are no table the check compares: left out, they are the rows they would have removed, which differ.
    const tablesOut = new Set(tablesLeftOut.filter((t) => t !== 'tombstones'));
    if (valuesLeftOut.length > 0) {
        c.valuesLeftOut = { count: valuesLeftOut.length, examples: valuesLeftOut.slice(0, 5).map(valueLeftOutName) };
        c.ok = false;
    }
    // The plain tables a row or value was left out of, by the table's name before the `:`.
    const plainLeftOut = new Set(plainTablesLeftOut.map((x) => x.slice(0, x.indexOf(':'))).filter((t) => t.length > 0));
    if (plainTablesLeftOut.length > 0) {
        c.plainTablesLeftOut = { count: plainTablesLeftOut.length, tables: [...plainLeftOut].sort(), examples: plainTablesLeftOut.slice(0, 5) };
        c.ok = false;
    }
    lastConsistency = c;
    // Each table's content, when the main server sent its hashes with this copy (it sends none with one written to while
    // it was being made). The listing photos the main server could not read from its own storage are not in the copy,
    // which names them, nor in its hash of that table (routes/backup.ts): no copy brings them, so they are left out here
    // too, and never read as a copy gone wrong that a force-resync would mend (review 4118340860).
    const theirs = readTableHashes((payload as SyncPayload & { tableHashes?: unknown }).tableHashes);
    const photosLeftOut = new Set((Array.isArray(payload.photosOmitted) ? payload.photosOmitted : []).filter((k): k is string => typeof k === 'string'));
    // The members values the import left out, as the copy names them: the main server's hash has them, this standby's row
    // can't, and they are reported on their own (valuesLeftOut above), never as a difference a force-resync would mend.
    const membersLeftOut = new Map<string, Record<string, unknown>>();
    if (valuesLeftOut.length > 0) {
        const standingOf = new Map((Array.isArray(payload.members) ? payload.members : []).map((m) => [m?.publicKey, m?.standing]));
        for (const v of valuesLeftOut) {
            const standing = standingOf.get(v.publicKey);
            if (!standing || typeof standing !== 'object' || !Object.hasOwn(standing, v.column)) continue;
            const cells = membersLeftOut.get(v.publicKey) ?? {};
            cells[v.column] = standing[v.column];
            membersLeftOut.set(v.publicKey, cells);
        }
    }
    const contents = theirs ? compareTableHashes(theirs, { photosLeftOut, membersLeftOut }) : null;
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
    for (const t of c.tables) if (!t.match && t.name !== 'accounts' && !plainLeftOut.has(t.name) && !tablesOut.has(t.name)) differs.add(t.name);
    for (const d of contents?.differing ?? []) {
        if (tablesOut.has(d.table)) continue;
        // The accounts' content only with the ledger compared whole and alike: a balance that differs is the ledger's line
        // below, and entries this server can't hold differ on every copy.
        if (d.table === 'accounts' && (!ledgerWhole || ledgerDiffering > 0)) continue;
        if (plainLeftOut.has(d.table)) continue;
        differs.add(d.table);
    }
    if (c.commons && !c.commons.match) differs.add(LEDGER_DIFFERS.commons);
    if (ledgerDiffering > 0) differs.add(LEDGER_DIFFERS.ledger);
    // Everything in it is something a force-resync can mend.
    const wrong = differs.size > 0;
    // Values of this copy's members rows this standby's table refuses, left out by the import (#1276): the copy isn't the
    // main server's, so never exact, but no force-resync mends it (one would leave the same values out): after `wrong`.
    if (c.valuesLeftOut) differs.add('members');
    // And each plain table a row or value of the copy was left out of, the same way (review 4123472786).
    for (const t of plainLeftOut) differs.add(t);
    // A verdict only from a check that compared everything: each table's content (a copy the main server sent without its
    // hashes, one written to while it was being made, can't show it differing) and every account. Finding nothing short
    // of that is no "exact": it neither ends nor starts anything the last verdict says, and the last exact copy's time
    // stays the older one (review 4118340714).
    const notCompared: ('content' | 'ledger')[] = [...(contents ? [] : ['content' as const]), ...(ledgerWhole ? [] : ['ledger' as const])];
    const verdict: 'exact' | 'inexact' | 'uncompared' = differs.size > 0 || tablesOut.size > 0 ? 'inexact' : notCompared.length === 0 ? 'exact' : 'uncompared';
    const exact = verdict === 'exact';
    if (tablesOut.size > 0) {
        logger.warn('P2P', `[Backup] ⚠️ This whole copy left out ${[...tablesOut].sort().join(', ')} (more rows than one copy carries): not compared, `
            + 'and no force-resync asked for them, which would read the same rows.');
    }
    if (differs.size > 0) {
        const bad = c.tables.filter(t => !t.match && !tablesOut.has(t.name)).map(t => `${t.name} ${t.backup}/${t.primary}`);
        if (c.ledger && !c.ledger.match) bad.push(`${c.ledger.differing} account(s) differ`);
        for (const d of contents?.differing ?? []) if (!bad.some((b) => b.startsWith(`${d.table} `))) bad.push(`${d.table} content`);
        if (c.valuesLeftOut) bad.push(`${c.valuesLeftOut.count} members value(s) this server's table refuses, left out (${c.valuesLeftOut.examples.join(', ')})`);
        if (c.plainTablesLeftOut) {
            bad.push(`${c.plainTablesLeftOut.count} row(s) or value(s) of ${c.plainTablesLeftOut.tables.join(', ')} this server's tables refuse, left out `
                + `(${c.plainTablesLeftOut.examples.join(', ')})`);
        }
        logger.warn('P2P', `[Backup] ⚠️ Replica differs from primary snapshot: ${bad.join(', ') || 'balances/commons drift'}`);
    }
    const now = Date.now();
    const resync = wrong && askMismatchResync(now);
    const lastResyncAt = lastLedgerResyncAt;
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
 * Ask for the force-resync a copy that isn't the main server's needs (the held kind, not a seed): at most one every six
 * hours, restarts included. The last one asked for is read from the standby's record too, so a restart allows no sooner
 * one and a difference no resync mends never loops; this process's memory stays a floor, should the record be unwritable.
 * Returns whether it asked; `lastLedgerResyncAt` is then now.
 */
function askMismatchResync(now: number): boolean {
    let lastResyncAt = lastLedgerResyncAt;
    try { lastResyncAt = Math.max(lastResyncAt, lastMismatchResyncAt()); } catch { /* the floor */ }
    lastLedgerResyncAt = lastResyncAt;
    if (now - lastResyncAt < LEDGER_RESYNC_EVERY_MS) return false;
    ledgerResyncAskedAt = now;
    lastLedgerResyncAt = now;
    return true;
}

/**
 * Operator-triggered force resync: rebuild this backup from the primary's current
 * snapshot, discarding any drifted/orphan rows. Returns a result for the dashboard. Always taken, whatever the loop is
 * waiting for (N2); one refused leaves this backup as it was, and says why. One that lands is built in a staging database
 * and swapped in at a restart (services/stager.ts): `restarting`.
 */
export async function requestResync(): Promise<{ ok: boolean; error?: string; restarting?: boolean }> {
    if (getNodeRole() !== 'backup') return { ok: false, error: 'This node is not a backup.' };
    logger.info('P2P', '[Backup] 🔄 Force-resync requested by operator.');
    restoreFromDatabase();
    const r = await pullOnce('resync', 'operator');
    return r.staged ? { ok: r.ok, restarting: true } : { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
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

/** The record says this standby owes the force-resync for the deletes its main server pruned (nextMode). */
function owesRetentionResync(): boolean {
    try { return readCopyRecord().pastRetentionAt !== null; } catch { return false; }
}

/** No pull this tick: the last copy of the only kind this standby can take now was refused, and N2 waits (pullOnce). */
type Wait = 'wait';

function nextMode(): PullMode | ResyncKind | Wait {
    const now = Date.now();
    // A force-resync, or a first copy, refused at its import in the last RESYNC_RETRY_MS (N2), or a retention resync that
    // failed in it at any stage (pullOnce): none asked for until then.
    const resyncWaits = now < resyncRetryAt;
    // A copy an older importer made, or none yet (engine/sync.ts REPLICA_FORMAT): one force-resync, first, since no whole
    // copy repairs a row the old importer got wrong (it skips every row whose stamp hasn't moved). A new standby's first
    // pull is this one too, which also clears whatever its own boot seeded. Asked for until one lands (it records the
    // format): one whose fetch fails is asked for again on the next tick, since the main server may be restarting with the
    // same update; one whose import is refused leaves this standby as it was, and is asked for again after
    // RESYNC_RETRY_MS, deltas carrying on from the cursor it kept meanwhile.
    if (!resyncWaits && replicaFormatOfCopy() < REPLICA_FORMAT) {
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
        if (now - ledgerResyncAskedAt < HEALING_MS) {
            if (!resyncWaits) return 'mismatch';
        } else {
            logger.warn('P2P', '[Backup] The force-resync asked for a copy that did not match got no copy from the main server in an hour: '
                + 'dropped. The main server tells its owners; the next one waits for the six-hour limit.');
            ledgerResyncAskedAt = null;
        }
    }
    // A cursor older than the main server keeps its deletes (PAST_RETENTION_MS: design §6.3 T6): a delta from it would miss
    // every delete the main server has pruned since, and no whole copy deletes a row (the importer upserts). One
    // force-resync, not a seed, owed until one lands: the record keeps it, so neither a delta that lands meanwhile (after a
    // refused one, N2) nor a restart forgets it. The delta moves the cursor, not what it missed.
    if (lastImportedCursor && pastRetention(lastImportedCursor, now)) recordQuietly(() => notePastRetention(now));
    if (!resyncWaits && owesRetentionResync()) {
        logger.info('P2P', `[Backup] This standby's copy is older than the ${Math.round(TOMBSTONE_RETENTION_MS / 86_400_000)} days the main server `
            + 'keeps its deletes: taking one force-resync, so nothing it deleted meanwhile stays here');
        return 'retention';
    }
    // No copy landed yet: a whole one, the seed, unless the last was refused (N2).
    if (!lastImportedCursor) return resyncWaits ? 'wait' : 'full';
    // The changes since the cursor were more than a delta takes (BACKUP_DELTA_PAGES pages): a whole copy, at once, unless
    // the last one was refused or never came (N2); then nothing until it may be asked again, since the delta would be too
    // big again.
    if (deltaTooBig) return now < wholeRetryAt ? 'wait' : 'full';
    // A whole copy refused at its import (N2), or one taken over deltas that never came: none of any kind before the next
    // routine one; deltas meanwhile. The once-a-process ones below are not used up while it waits.
    if (now < wholeRetryAt) return 'delta';
    // The last whole copy landed with tables left out: none of any kind before the next routine one, as after a refused
    // one. Drift the canary finds meanwhile waits for it; deltas carry on.
    if (lastWholeLeftOut && now - lastFullReconcileAt < (getReconcileMs() || resyncRetryMs())) return 'delta';
    // A drift-triggered reconcile ALWAYS wins, even for a large DB — correctness beats
    // bandwidth when the stateHash canary says the copy has actually diverged, and it
    // only fires on a real mismatch. A big copy's daily cadence and the operator "off" setting
    // only hold back the *routine* timer-based whole copy (below), which the reliable deltas
    // make optional at scale.
    if (pendingReconcile) return 'full';
    // The recovery seal asks once for a whole copy, even for a large database: the rows the main server holds tell which
    // copies here it deleted before the seal (services/recovery-seal-key.ts).
    if (takeRecoverySealFullPull()) return 'full';
    // Once a process, a whole copy for a standby that has its main server's word that its visitors are marked but no whole
    // copy since: the rows it copied before it had the column carry no mark, and no delta brings them (db.ts
    // visitorMarksWantWholeCopy). One that fails isn't tried on every tick: the next routine one, or the next boot, brings it.
    if (!visitorMarksAsked && visitorMarksWantWholeCopy()) {
        visitorMarksAsked = true;
        logger.info('P2P', "[Backup] Visitors' rows: taking one whole copy of the main server, so the rows copied before this version get its marks");
        return 'full';
    }
    // Once a process, the same for the keys the main server replaced: a delta brings the ones replaced since this standby's
    // cursor, and the ones from before either server had this version come only in a whole copy (engine/key-move.ts).
    if (!replacedKeysAsked && replacedKeysWantWholeCopy()) {
        replacedKeysAsked = true;
        logger.info('P2P', '[Backup] Replaced keys: taking one whole copy of the main server, so the keys it replaced before this version are refused here too');
        return 'full';
    }
    // Once a process, the same for the members' block lists: the blocks made while this standby ran a version without them
    // come only in a whole copy (engine/member-blocks.ts).
    if (!memberBlocksAsked && memberBlocksWantWholeCopy()) {
        memberBlocksAsked = true;
        logger.info('P2P', "[Backup] Block lists: taking one whole copy of the main server, so every member's blocks from before this version are here too");
        return 'full';
    }
    // The routine whole copy: every reconcile interval while the last one was one page (imported over this standby's rows
    // and checked), and at most daily once it took more (built in a staging database and swapped in at a restart: design
    // scratch/global-node/DESIGN-paged-copies-fable.md §4.5). Sooner only for drift (above). The operator's interval of 0
    // turns it off.
    const reconcileMs = getReconcileMs();
    const every = lastWholePages > 1 ? Math.max(reconcileMs, bigCopyEveryMs()) : reconcileMs;
    if (reconcileMs > 0 && now - lastFullReconcileAt >= every) return 'full';
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
export function pullNow(): Promise<{ ok: boolean; error?: string; staged?: boolean }> {
    // Before nextMode, which spends the once-a-process asks: a pull already running (an operator's resync) must not use one up.
    if (inFlight) return Promise.resolve({ ok: false, error: 'A pull is already in progress.' });
    if (swapReady) return Promise.resolve({ ok: false, error: 'A whole copy is ready to be swapped in: this standby is restarting.' });
    restoreFromDatabase();
    const next = nextMode();
    if (next === 'wait') {
        const until = Math.max(resyncRetryAt, deltaTooBig ? wholeRetryAt : 0);
        return Promise.resolve({ ok: false, error: `This standby's last copy was refused; the next is asked for at ${new Date(until).toISOString()}.` });
    }
    return next === 'format' || next === 'mismatch' || next === 'operator' || next === 'retention' ? pullOnce('resync', next) : pullOnce(next);
}

/**
 * The cursor, and when the last whole copy landed and how many pages it took (the routine one's cadence,
 * standby-copy-record.ts lastWholeCopy), from this database, once a process: what a status read shows, and what the next
 * pull decides by. Reads only.
 */
let cadenceRestored = false;
function restoreCadence(): void {
    if (cadenceRestored || getNodeRole() !== 'backup') return;
    cadenceRestored = true;
    try {
        const saved = getSyncCursor(BACKUP_CURSOR_PEER);
        if (saved && !lastImportedCursor) lastImportedCursor = saved;
    } catch { /* first boot / no cursor table row yet */ }
    try {
        const whole = readCopyRecord().lastWholeCopy;
        if (whole) {
            lastFullReconcileAt = Math.max(lastFullReconcileAt, whole.at);
            lastWholePages = whole.pages;
        }
    } catch { /* the record unreadable: a whole copy is due, as at a first start */ }
}

/**
 * What this process takes from its database of the copies before it, once, before its first pull: the cursor, when the
 * last whole copy landed and how many pages it took (the routine one's cadence, standby-copy-record.ts lastWholeCopy), and,
 * at the first start on a whole copy swapped in (db/swap-at-boot.ts; services/stager.ts wrote SWAPPED_COPY_KEY into it),
 * that copy's time, the recovery seal's clean-up after a whole copy (services/recovery-seal-key.ts), and the database it
 * replaced, deleted once the next copy lands. Never throws.
 */
function restoreFromDatabase(): void {
    restoreCadence();
    if (restored) return;
    restored = true;
    let swapped: { generatedAt?: unknown; sealEpoch?: unknown; pages?: unknown } | null = null;
    try {
        const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(SWAPPED_COPY_KEY) as { value: string } | undefined;
        if (row) swapped = JSON.parse(row.value);
    } catch { swapped = null; }
    if (!swapped) return;
    const generatedAt = typeof swapped.generatedAt === 'string' ? swapped.generatedAt : null;
    if (generatedAt) {
        const genMs = Date.parse(generatedAt);
        if (Number.isFinite(genMs)) lastGeneratedAtMs = Math.max(lastGeneratedAtMs, genMs);
        lastImportedGeneratedAt = generatedAt;
    }
    // The recovery seal's clean-up after a whole copy, as an import runs it (state-engine.ts importRemoteState): the rows
    // here are every copy the main server holds, and nothing else. This process has its whole copy: none is asked for again.
    try {
        const shares = (db.prepare('SELECT owner_pubkey AS ownerPubkey, generation, holder_type AS holderType, holder_ref AS holderRef, kdf_params AS kdfParams FROM recovery_shares')
            .all() as { ownerPubkey: string; generation: number; holderType: string; holderRef: string; kdfParams: string | null }[]);
        clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy: shares, imported: shares, mainEpoch: swapped.sealEpoch ?? undefined });
        noteWholeCopyThisProcess();
    } catch (e) {
        logger.warn('P2P', `[Backup] The recovery seal's clean-up after the whole copy swapped in could not run: ${errorMessage(e)}`);
    }
    try { db.prepare('DELETE FROM node_config WHERE key = ?').run(SWAPPED_COPY_KEY); } catch { /* read again at the next start */ }
    const dir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    previousToDelete = fs.existsSync(path.join(dir, PREVIOUS_DB));
    logger.info('P2P', `[Backup] This standby started on the whole copy of its main server made at ${generatedAt ?? '?'} `
        + `(${String(swapped.pages ?? '?')} page(s)), swapped in at this start.`);
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
    restoreFromDatabase();

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

/**
 * A take-over (services/takeover.ts `pull-config`): this server copies from nobody now, so the cursor of its last pull
 * goes, here and in its database. No pull follows it: a server made a standby again later starts from a first copy, never
 * a delta from before its time as the main server (design §6.3 T6).
 */
export function forgetPullCursor(): void {
    deleteSyncCursor(BACKUP_CURSOR_PEER);
    lastImportedCursor = null;
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
export function getBackupStatus(): {
    lastSuccessAt: number | null; consecutiveFailures: number; running: boolean; consistency: ReplicaConsistency | null; cursor: string | null;
    lastFullReconcileAt: number; reconcileDisabledForSize: boolean; pullSeconds: number; reconcileMinutes: number; lastPullMode: PullMode | null;
    wholeRetryAt: number | null; resyncRetryAt: number | null; lastWholePages: number; swapReady: boolean;
} {
    restoreCadence();
    const now = Date.now();
    return {
        // How many pages the last whole copy took, and a whole copy made ready to swap in at the restart under way.
        lastWholePages,
        swapReady,
        lastSuccessAt,
        consecutiveFailures,
        lastPullMode,
        // After a refused copy (N2): no whole copy, or no force-resync or first copy, before these; null when none waits.
        wholeRetryAt: wholeRetryAt > now ? wholeRetryAt : null,
        resyncRetryAt: resyncRetryAt > now ? resyncRetryAt : null,
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
