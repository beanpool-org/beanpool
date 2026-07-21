/**
 * Backup, Replication, Sync, Snapshots, and Restore routes.
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import {
    getNodeRole, exportSyncState,
    getConversationsByMember, getConversationMessages,
    getAdminPubkey, recordReplicationAccess, getReplicationAccessLog,
} from '../state-engine.js';
import {
    getLocalConfig, saveLocalConfig,
    verifyReplicationToken, generateReplicationToken, setReplicationToken,
    clearReplicationToken, hasReplicationToken,
    updateBackupCadence,
} from '../config/local-config.js';
import { getP2PNode } from '../p2p.js';
import { getBackupStatus, requestResync } from '../services/backup-puller.js';
import {
    writeDbSnapshot, createSnapshot, listSnapshots, resolveSnapshotPath,
    getAutoSnapshotConfig, updateAutoSnapshotConfig,
} from '../services/snapshot-scheduler.js';
import { db, getDbDataVersion } from '../db/db.js';
import type { RouteDeps } from './types.js';

export function createBackupRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    // Helper: resolve the public URL for backup enrollment
    function resolvePrimaryUrl(ctx: any): string {
        if (process.env.CF_RECORD_NAME) return 'https://' + process.env.CF_RECORD_NAME;
        const host = ctx.request.header['x-forwarded-host'] || ctx.request.header['host'] || ctx.host;
        const proto = (ctx.request.header['x-forwarded-proto'] as string) || ctx.protocol || 'https';
        return proto + '://' + host;
    }

    /** Real client IP for replication logging */
    function replicationClientIp(ctx: any): string {
        const h = ctx?.request?.header || {};
        const cf = h['cf-connecting-ip'];
        if (cf) return String(cf);
        const fwd = h['x-forwarded-for'];
        if (fwd) return String(fwd).split(',')[0].trim();
        return ctx?.ip || 'unknown';
    }

    // Conditional pull state for sync-snapshot
    let lastSnapshotExport: { generatedAt: string; dataVersion: number } | null = null;

// ======================== DATABASE BACKUP ========================

router.post('/api/local/admin/backup', async (ctx) => {
    const token = ctx.request.header['x-replication-token'];
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;
    const { execFileSync } = await import('node:child_process');
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const tmpDir = path.join(DATA_DIR, '.backup-tmp');
    const tarPath = path.join(DATA_DIR, '.backup-tmp.tar.gz');

    try {
        // Clean up any previous temp files
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Use SQLite VACUUM INTO for a consistent snapshot (no WAL corruption
        // risk) via the shared helper. NOTE: this tar is built ONLY from
        // `tmpDir` (state.db + node_config.json below), so it deliberately
        // does NOT recurse into data/snapshots/ — auto-snapshots never get
        // swallowed into the manual backup archive.
        const snapshotPath = path.join(tmpDir, 'state.db');
        writeDbSnapshot(snapshotPath);

        // Copy node_config.json if it exists
        const configPath = path.join(DATA_DIR, 'node_config.json');
        if (fs.existsSync(configPath)) {
            fs.copyFileSync(configPath, path.join(tmpDir, 'node_config.json'));
        } else {
            // Export config from DB
            const config = getLocalConfig();
            fs.writeFileSync(path.join(tmpDir, 'node_config.json'), JSON.stringify(config, null, 2));
        }

        // Create tar.gz
        execFileSync('tar', ['-czf', tarPath, '-C', tmpDir, '.']);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        ctx.set('Content-Type', 'application/gzip');
        ctx.set('Content-Disposition', `attachment; filename="beanpool-backup-${timestamp}.tar.gz"`);
        ctx.body = fs.createReadStream(tarPath);

        // Clean up after stream finishes
        ctx.res.on('finish', () => {
            try {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
                if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
            } catch { /* ignore cleanup errors */ }
        });
    } catch (e: any) {
        console.error('Backup failed:', e);
        // Clean up on error
        try {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        } catch { /* ignore */ }
        ctx.status = 500;
        ctx.body = { error: 'Backup failed: ' + e.message };
    }
});

// ======================== IDENTITY BUNDLE ========================
// Returns a tar.gz of all critical identity files needed for a full
// node restore. These files are generated once on first boot and
// cannot be regenerated without losing the node's identity.
router.post('/api/local/admin/identity-bundle', async (ctx) => {
    const token = ctx.request.header['x-replication-token'];
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;

    const { execFileSync } = await import('node:child_process');
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const tmpDir = path.join(DATA_DIR, '.identity-tmp');
    const tarPath = path.join(DATA_DIR, '.identity-tmp.tar.gz');

    try {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Collect all critical identity files
        const identityFiles = [
            { src: 'genesis.json', required: true },
            { src: 'community.key', required: true },
            { src: 'libp2p_key', required: false },
            { src: 'local-config.json', required: false },
            { src: 'connectors.json', required: false },
        ];

        const collected: string[] = [];
        for (const file of identityFiles) {
            const srcPath = path.join(DATA_DIR, file.src);
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, path.join(tmpDir, file.src));
                collected.push(file.src);
            } else if (file.required) {
                ctx.status = 503;
                ctx.body = { error: `Required identity file missing: ${file.src}` };
                fs.rmSync(tmpDir, { recursive: true });
                return;
            }
        }

        // Also export local-config from memory if file doesn't exist on disk
        if (!collected.includes('local-config.json')) {
            const config = getLocalConfig();
            fs.writeFileSync(path.join(tmpDir, 'local-config.json'), JSON.stringify(config, null, 2));
            collected.push('local-config.json');
        }

        // Create tar.gz
        execFileSync('tar', ['-czf', tarPath, '-C', tmpDir, '.']);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        ctx.set('Content-Type', 'application/gzip');
        ctx.set('Content-Disposition', `attachment; filename="identity-bundle-${timestamp}.tar.gz"`);
        ctx.set('X-Identity-Files', collected.join(','));
        ctx.body = fs.createReadStream(tarPath);

        ctx.res.on('finish', () => {
            try {
                if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
                if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
            } catch { /* ignore cleanup errors */ }
        });
    } catch (e: any) {
        console.error('Identity bundle failed:', e);
        try {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        } catch { /* ignore */ }
        ctx.status = 500;
        ctx.body = { error: 'Identity bundle failed: ' + e.message };
    }
});

// ======================== BACKUP TAB ========================
// Read-only enrollment bundle for standing up a NEW backup server that joins
// THIS node's community. The operator runs `scripts/setup-backup.mjs` on the
// would-be backup machine; it GETs this with the X-Admin-Password header,
// writes genesis.json + community.key into the backup's data dir, and configures
// the backup to pull from this primary. Returns ONLY material the backup needs
// to recognize this primary's identity — it mutates nothing.


router.get('/api/local/admin/backup-enroll', async (ctx) => {
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
        const genesisPath = path.join(DATA_DIR, 'genesis.json');
        const communityKeyPath = path.join(DATA_DIR, 'community.key');
        if (!fs.existsSync(genesisPath)) {
            ctx.status = 503;
            ctx.body = { error: 'Genesis not initialized yet' };
            return;
        }
        const genesis = JSON.parse(fs.readFileSync(genesisPath, 'utf-8'));
        const communityKey = fs.existsSync(communityKeyPath)
            ? fs.readFileSync(communityKeyPath).toString('base64')
            : null;
        const node = getP2PNode();
        const primaryPeerId = node?.peerId?.toString() ?? null;
        if (!primaryPeerId) {
            ctx.status = 503;
            ctx.body = { error: 'Node signing identity not ready yet — try again shortly' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.body = {
            communityId: genesis.communityId,
            genesis,
            communityKey,
            primaryPeerId,
            primaryUrl: resolvePrimaryUrl(ctx),
        };
    } catch (e: any) {
        console.error('[Backup] backup-enroll failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Failed to build enrollment bundle' };
    }
});

// Live health tile for the Backup tab: this node's role + (if a backup) the
// primary it's pulling, plus the puller's last-success / failure-streak state.
router.post('/api/local/admin/backup-status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    ctx.body = {
        role: getNodeRole(),
        primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || null,
        intervalMs: Number(process.env.BACKUP_PULL_INTERVAL_MS) || 60000,
        ...getBackupStatus(),
    };
});

router.post('/api/local/admin/replication-config/get', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    ctx.body = {
        primaryUrl: config.backupPrimaryUrl || process.env.BACKUP_PRIMARY_URL || '',
        hasPassword: !!(config.backupAdminPassword || process.env.BACKUP_ADMIN_PASSWORD),
        hasToken: !!(config.backupReplicationToken || process.env.BACKUP_REPLICATION_TOKEN),
    };
});

router.post('/api/local/admin/replication-config/save', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { primaryUrl, primaryPassword, primaryToken } = (ctx as any).requestBody || {};
    if (primaryUrl === undefined) {
        ctx.status = 400;
        ctx.body = { error: 'primaryUrl is required' };
        return;
    }

    const config = getLocalConfig();
    config.backupPrimaryUrl = primaryUrl.trim() || null;
    if (primaryPassword) {
        config.backupAdminPassword = primaryPassword;
    }
    // Replication token this backup presents to its primary. Empty string clears it
    // (revert to admin-password auth); undefined leaves it unchanged.
    if (primaryToken !== undefined) {
        config.backupReplicationToken = (typeof primaryToken === 'string' && primaryToken.trim()) ? primaryToken.trim() : null;
    }
    saveLocalConfig(config);
    ctx.body = { success: true };
});

// ---------- Replication token (primary side) ----------
// A dedicated, scoped credential for the snapshot-pull endpoint, distinct from the
// admin password: least-privilege (read-only replication only) and independently
// rotatable. Stored hashed; the plaintext is shown to the operator exactly once.
router.post('/api/local/admin/replication-token/status', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const config = getLocalConfig();
    ctx.body = {
        hasToken: hasReplicationToken(),
        tokenOnly: !!config.replicationTokenOnly,
        createdAt: config.replicationTokenCreatedAt || null,
    };
});

router.post('/api/local/admin/replication-token/generate', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const token = generateReplicationToken();
    setReplicationToken(token);
    // Returned ONCE — only the hash is persisted, so it can never be shown again.
    ctx.body = { success: true, token };
});

router.post('/api/local/admin/replication-token/mode', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { tokenOnly } = (ctx as any).requestBody || {};
    const config = getLocalConfig();
    if (tokenOnly && !hasReplicationToken()) {
        ctx.status = 400;
        ctx.body = { error: 'Generate a replication token before enabling token-only mode.' };
        return;
    }
    config.replicationTokenOnly = !!tokenOnly;
    saveLocalConfig(config);
    ctx.body = { success: true, tokenOnly: config.replicationTokenOnly };
});

router.post('/api/local/admin/replication-token/clear', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    clearReplicationToken();
    ctx.body = { success: true };
});

// ---------- Replication access log (primary side) ----------
router.post('/api/local/admin/replication-access', async (ctx) => {
    const token = ctx.request.header['x-replication-token'] || (ctx as any).requestBody?.token;
    const isTokenValid = token && (await verifyReplicationToken(String(token)));
    if (!isTokenValid && !(await checkAdminAuth(ctx as any))) return;
    ctx.body = {
        ...getReplicationAccessLog(),
        tokenOnly: !!getLocalConfig().replicationTokenOnly,
        hasToken: hasReplicationToken(),
    };
});

// ---------- Force resync (backup side) ----------
router.post('/api/local/admin/replication-resync', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const result = await requestResync();
    if (!result.ok) {
        ctx.status = 400;
        ctx.body = { error: result.error || 'Resync failed' };
        return;
    }
    ctx.body = { success: true };
});

// ---------- Auto-snapshots (local point-in-time archive) ----------
// All snapshot file ops are path-traversal-safe: a caller-supplied `name` is
// resolved via resolveSnapshotPath(), which accepts only a bare basename that
// resolves directly inside data/snapshots/.
router.post('/api/local/admin/snapshots/list', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    ctx.body = { success: true, snapshots: listSnapshots(), config: getAutoSnapshotConfig() };
});

router.post('/api/local/admin/snapshots/create', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    try {
        const info = createSnapshot();
        ctx.body = { success: true, snapshot: info };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Snapshot failed' };
    }
});

router.post('/api/local/admin/snapshots/delete', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const { name } = (ctx as any).requestBody || {};
    const target = resolveSnapshotPath(name);
    if (!target) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid snapshot name' };
        return;
    }
    try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        ctx.body = { success: true };
    } catch (e: any) {
        ctx.status = 500;
        ctx.body = { error: e?.message || 'Delete failed' };
    }
});

// Download via GET so the browser can stream it; auth via the X-Admin-Password
// header (the name is in the query string, never the password).
router.get('/api/local/admin/snapshots/download', async (ctx) => {
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) (ctx as any).requestBody = { password: headerPassword };
    if (!(await checkAdminAuth(ctx as any))) return;
    const name = ctx.query.name as string;
    const target = resolveSnapshotPath(name);
    if (!target || !fs.existsSync(target)) {
        ctx.status = 404;
        ctx.body = { error: 'Snapshot not found' };
        return;
    }
    ctx.set('Content-Type', 'application/octet-stream');
    ctx.set('Content-Disposition', `attachment; filename="${path.basename(target)}"`);
    ctx.body = fs.createReadStream(target);
});

// Get (no body) or set (with {enabled,intervalHours,keep}) the auto-snapshot config.
router.post('/api/local/admin/snapshots/config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    const hasUpdate = body.enabled !== undefined || body.intervalHours !== undefined || body.keep !== undefined;
    const config = hasUpdate
        ? updateAutoSnapshotConfig({ enabled: body.enabled, intervalHours: body.intervalHours, keep: body.keep })
        : getAutoSnapshotConfig();
    ctx.body = { success: true, config };
});

// Backup pull cadence — operator-tunable from the fleet manager. GET returns the
// effective values (config → env → default) + live puller status; POST overrides
// them in local-config, read live by the backup puller on its next tick (no restart).
// pullSeconds = how often to ask "what changed?" (cheap delta). reconcileMinutes =
// how often to do a full re-read (0 = off; drift-triggered fulls still run).
router.post('/api/local/admin/backup-config', async (ctx) => {
    if (!(await checkAdminAuth(ctx as any))) return;
    const body = (ctx as any).requestBody || {};
    if (body.pullSeconds !== undefined || body.reconcileMinutes !== undefined) {
        updateBackupCadence({ pullSeconds: body.pullSeconds, reconcileMinutes: body.reconcileMinutes });
    }
    ctx.body = { success: true, status: getBackupStatus() };
});

// Phase 1 (one-directional live backup): the read-only snapshot the BACKUP
// pulls over HTTPS. This is the entire inbound channel of the new topology —
// state flows primary → backup ONLY, so the primary never imports peer data
// and the SRV-20/21 ledger-forgery vector has no trusted writer.
//
// It is a pure EXPORT: it returns the same signed `SyncPayload` the P2P sync
// path produces (exportSyncState already signs with the node's libp2p key),
// and calls NOTHING that mutates state — serving it adds zero inbound trust.
// Gated by the admin password (shared operator secret, sent in the
// X-Admin-Password header like /restore, never in the URL); routes under
// /api/local/* bypass the member-signature middleware. The backup verifies
// the signature against its single configured `mirror` connector (the
// primary) inside importRemoteState, so a forged snapshot is rejected there.
// The last full snapshot this primary exported: its signed generatedAt stamp and
// the DB data_version at build time. Lets the handler below answer "unchanged"
// (304) to the mirror's every-60s pull without rebuilding the whole ledger.


router.get('/api/local/admin/sync-snapshot', async (ctx) => {
    // This endpoint emits the ENTIRE ledger (incl. DMs + recovery data). It is
    // authenticated with a dedicated, scoped replication TOKEN (least privilege,
    // independently rotatable). The all-powerful admin password is still accepted
    // during rollout — until the operator enables token-only — so existing backups
    // keep working. Every pull (and every rejected attempt) is logged for the
    // primary's Replication Access panel.
    const ip = replicationClientIp(ctx);
    const token = ctx.request.header['x-replication-token'];
    const headerPassword = ctx.request.header['x-admin-password'];
    const cfg = getLocalConfig();
    let authMode: 'token' | 'admin-pw' | null = null;

    if (token) {
        if (await verifyReplicationToken(String(token))) {
            authMode = 'token';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid replication token' });
            ctx.status = 401;
            ctx.body = { error: 'Invalid replication token' };
            return;
        }
    } else if (headerPassword && !cfg.replicationTokenOnly) {
        (ctx as any).requestBody = { password: headerPassword };
        if (await checkAdminAuth(ctx as any)) {
            authMode = 'admin-pw';
        } else {
            // checkAdminAuth already set 401 + applied the brute-force tarpit delay.
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid admin password' });
            return;
        }
    } else {
        recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: cfg.replicationTokenOnly ? 'replication token required' : 'no credentials' });
        ctx.status = 401;
        ctx.body = { error: cfg.replicationTokenOnly ? 'Replication token required' : 'Authentication required' };
        return;
    }

    try {
        // Conditional pull: the mirror sends the generatedAt of its last successful
        // import. If the DB hasn't changed since we built that exact snapshot,
        // answer 304 with no body. Without this, every 60s pull exported, signed
        // and streamed the ENTIRE ledger (~19MB observed = ~27GB/day of transfer)
        // and stalled the event loop for every API client while doing it.
        const cursor = String(ctx.request.header['x-snapshot-cursor'] || '');
        const dataVersionNow = getDbDataVersion();
        if (cursor && lastSnapshotExport &&
            cursor === lastSnapshotExport.generatedAt &&
            dataVersionNow === lastSnapshotExport.dataVersion) {
            ctx.set('Cache-Control', 'no-store');
            ctx.set('X-Node-Role', getNodeRole());
            ctx.status = 304;
            recordReplicationAccess({ at: Date.now(), ip, auth: authMode, reason: 'not modified (304)' });
            return;
        }

        const node = getP2PNode();
        const nodeId = node?.peerId?.toString() ?? 'unknown';
        // data_version is read BEFORE the export: a write that lands mid-export
        // bumps it, so the next conditional check conservatively rebuilds rather
        // than ever serving a stale 304.
        const payload = await exportSyncState(nodeId);
        if (!payload.signature || !payload.publicKey) {
            // No libp2p identity loaded → the backup couldn't verify authorship.
            ctx.status = 503;
            ctx.body = { error: 'Snapshot unavailable: node signing identity not ready' };
            return;
        }
        if (payload.generatedAt) {
            lastSnapshotExport = { generatedAt: payload.generatedAt, dataVersion: dataVersionNow };
        }
        ctx.set('Cache-Control', 'no-store');
        // Advertise our role so a puller can warn if it is replicating from
        // another backup (chained replication is a misconfiguration).
        ctx.set('X-Node-Role', getNodeRole());
        ctx.body = payload;
        recordReplicationAccess({ at: Date.now(), ip, auth: authMode });
    } catch (e: any) {
        console.error('[Backup] Snapshot export failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Snapshot export failed' };
    }
});

// Cursor-based delta pull. Same scoped replication auth as sync-snapshot, but the
// caller passes X-Since-Cursor (the `cursor` it last imported) and gets back only
// rows mutated since — plus tombstones deleted since — instead of the whole ledger.
// An empty/absent cursor seeds the replica with a full export (its `cursor` is then
// used for subsequent delta pulls). This is the path that scales past the 10 MB
// full-snapshot import cap as DBs grow toward GB. See docs/delta-backup-plan.md.
router.get('/api/local/admin/sync-delta', async (ctx) => {
    const ip = replicationClientIp(ctx);
    const token = ctx.request.header['x-replication-token'];
    const headerPassword = ctx.request.header['x-admin-password'];
    const cfg = getLocalConfig();
    let authMode: 'token' | 'admin-pw' | null = null;

    if (token) {
        if (await verifyReplicationToken(String(token))) {
            authMode = 'token';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid replication token' });
            ctx.status = 401;
            ctx.body = { error: 'Invalid replication token' };
            return;
        }
    } else if (headerPassword && !cfg.replicationTokenOnly) {
        (ctx as any).requestBody = { password: headerPassword };
        if (await checkAdminAuth(ctx as any)) {
            authMode = 'admin-pw';
        } else {
            recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: 'invalid admin password' });
            return;
        }
    } else {
        recordReplicationAccess({ at: Date.now(), ip, auth: 'rejected', reason: cfg.replicationTokenOnly ? 'replication token required' : 'no credentials' });
        ctx.status = 401;
        ctx.body = { error: cfg.replicationTokenOnly ? 'Replication token required' : 'Authentication required' };
        return;
    }

    try {
        const since = String(ctx.request.header['x-since-cursor'] || '');
        const node = getP2PNode();
        const nodeId = node?.peerId?.toString() ?? 'unknown';
        // Empty since → no cursor yet → full seed export (its payload.cursor drives
        // subsequent deltas). Otherwise ship only rows with watermark >= since.
        const payload = await exportSyncState(nodeId, since || null);
        if (!payload.signature || !payload.publicKey) {
            ctx.status = 503;
            ctx.body = { error: 'Delta unavailable: node signing identity not ready' };
            return;
        }
        ctx.set('Cache-Control', 'no-store');
        ctx.set('X-Node-Role', getNodeRole());
        ctx.body = payload;
        recordReplicationAccess({ at: Date.now(), ip, auth: authMode, reason: since ? 'delta' : 'delta (full seed)' });
    } catch (e: any) {
        console.error('[Backup] Delta export failed:', e);
        ctx.status = 500;
        ctx.body = { error: 'Delta export failed' };
    }
});

router.post('/api/local/admin/restore', async (ctx) => {
    // Handle auth via custom header for binary uploads to prevent password exposure in query string
    const headerPassword = ctx.request.header['x-admin-password'];
    if (headerPassword) {
        (ctx as any).requestBody = { password: headerPassword };
    }
    if (!(await checkAdminAuth(ctx as any))) return;

    const { execFileSync } = await import('node:child_process');
    const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const tmpDir = path.join(DATA_DIR, '.restore-tmp');
    const tarPath = path.join(DATA_DIR, 'uploaded-backup.tar.gz');

    try {
        // SECURITY (SRV-11): cap the restore upload so an oversized archive can't
        // exhaust disk. Reject an over-limit Content-Length up front, then enforce
        // the cap on the bytes actually streamed (a lying/absent length is the real
        // attack vector), aborting on overflow. The catch below already removes the
        // partial tarball + tmpDir.
        const MAX_RESTORE_BYTES = 500 * 1024 * 1024; // 500 MB
        const declaredLen = Number(ctx.request.header['content-length']);
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESTORE_BYTES) {
            ctx.status = 413;
            ctx.body = { error: 'Backup archive too large (max 500 MB)' };
            return;
        }
        // Read binary body to file
        const bodyStream = ctx.req;
        const writeStream = fs.createWriteStream(tarPath);
        let received = 0;
        await new Promise<void>((resolve, reject) => {
            bodyStream.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > MAX_RESTORE_BYTES) {
                    bodyStream.destroy();
                    writeStream.destroy();
                    reject(Object.assign(new Error('Backup archive too large (max 500 MB)'), { httpStatus: 413 }));
                }
            });
            bodyStream.pipe(writeStream);
            writeStream.on('finish', () => resolve());
            bodyStream.on('error', reject);
            writeStream.on('error', reject);
        });

        // Extract the tar
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        // SECURITY (SRV-9a): a restore archive is fully attacker-controlled
        // input. `tar -x` does NOT sanitize member paths — GNU tar (the prod
        // image) follows `../` and absolute names and will materialise
        // symlinks/hardlinks — so a crafted archive could write or redirect
        // files anywhere the node process can reach (cron dirs,
        // authorized_keys, the app's own JS) → RCE / node takeover. Inspect
        // the listing and refuse the WHOLE archive if any member would escape
        // the extraction dir or is a link, BEFORE extracting a single byte.
        // Legitimate backups are written with `tar -C tmpDir .` (see the
        // backup route above), so members are plain `./`-prefixed relative
        // paths and pass cleanly.
        const listing = execFileSync('tar', ['-tzf', tarPath], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }).split('\n').map((s: string) => s.trim()).filter(Boolean);
        for (const entry of listing) {
            // Reject POSIX/Windows-absolute paths and any `..` traversal segment.
            if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split('/').some(seg => seg === '..')) {
                throw new Error('Invalid backup archive: unsafe member path');
            }
        }
        // Reject symlink/hardlink members (type char 'l'/'h' in the verbose
        // listing) so a link can't redirect a later write outside tmpDir.
        const verboseListing = execFileSync('tar', ['-tvzf', tarPath], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }).split('\n').map((s: string) => s.trim()).filter(Boolean);
        for (const line of verboseListing) {
            if (line[0] === 'l' || line[0] === 'h') {
                throw new Error('Invalid backup archive: links are not permitted');
            }
        }

        execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir]);

        // Validate that state.db exists and is a regular file
        const restoredDb = path.join(tmpDir, 'state.db');
        if (!fs.existsSync(restoredDb) || !fs.lstatSync(restoredDb).isFile()) {
            throw new Error('Invalid backup archive: state.db missing');
        }

        // Close current DB connection safely before overwriting
        const { db } = await import('../db/db.js');
        try { db.close(); } catch (e) { console.error('Error closing DB:', e); }

        // Replace files
        fs.copyFileSync(path.join(tmpDir, 'state.db'), path.join(DATA_DIR, 'state.db'));
        if (fs.existsSync(path.join(tmpDir, 'node_config.json'))) {
            fs.copyFileSync(path.join(tmpDir, 'node_config.json'), path.join(DATA_DIR, 'node_config.json'));
        }

        // Clean up
        fs.rmSync(tmpDir, { recursive: true });
        fs.unlinkSync(tarPath);

        ctx.body = { success: true };
        
        // Wait 1 second then exit
        setTimeout(() => {
            console.log('Restore successful, rebooting node...');
            process.exit(0);
        }, 1000);

    } catch (e: any) {
        console.error('Restore failed:', e);
        try {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
            if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
        } catch { /* ignore */ }
        ctx.status = e?.httpStatus || 500;
        ctx.body = { error: e?.httpStatus === 413 ? e.message : ('Restore failed: ' + e.message) };
    }
});

    return router;
}
