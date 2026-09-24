/**
 * Fleet Manager Backup & Replication API Routes
 */

import Router from '@koa/router';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    loadHarvestState, harvestNode, harvestAllNodes, getNodes, nodeSlug, listSealedBackups, listPlainHistory,
    imagesDirFor, missingManifestFor, type FleetNodeConfig,
} from '../services/harvester.js';
import { MISSING_MEMBER } from '../services/sealed-backup.js';
import type { RouteDeps } from './types.js';

const execFileAsync = promisify(execFile);

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

export function createManagerBackupsRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    function findNodeConfig(nodeId: string, customUrl?: string, adminPassword?: string): FleetNodeConfig {
        const nodes = getNodes();
        const found = nodes.find(n => n.id === nodeId);
        if (found) {
            return {
                ...found,
                adminPassword: adminPassword || found.adminPassword,
            };
        }
        return {
            id: nodeId || 'custom',
            name: nodeId || 'Target Node',
            url: customUrl || 'https://localhost:8443',
            adminPassword,
        };
    }

    // Status of all harvested backups.
    //
    // Stays behind checkAdminAuth. /api/manager/* is on the requireSignature bypass list
    // precisely because these handlers are contracted to do their own admin check, so dropping
    // it here would leave the route wide open — and it is internet-reachable, serving fleet
    // topology, node URLs, member and post counts, backup sizes and sealed-backup filenames.
    //
    // The payload is sanitised regardless: getNodes() returns FleetNodeConfig, which carries
    // adminPassword and replicationToken. The dashboard has never needed either, and a
    // credential that is never serialised cannot leak through a logged response, a cached
    // proxy, or the next handler that forgets the auth check.
    router.get('/api/manager/backups/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const safeNodes = getNodes().map(n => ({
            id: n.id,
            name: n.name,
            url: n.url,
            isPrimary: (n as any).isPrimary,
        }));
        ctx.body = {
            nodes: safeNodes,
            harvestState: loadHarvestState(),
        };
    });

    // Trigger immediate manual harvest
    router.post('/api/manager/backups/trigger', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx.request as any).body || {};
        const nodeId = body.nodeId;

        try {
            if (nodeId === 'all' || !nodeId) {
                const results = await harvestAllNodes(true);
                ctx.body = { success: true, results };
                return;
            }

            const slug = nodeSlug(nodeId);
            const nodes = getNodes();
            const found = nodes.find(n => n.id === nodeId || n.id === slug || nodeSlug(n) === slug);

            const node: FleetNodeConfig = found ? {
                ...found,
                url: body.url || found.url,
                adminPassword: body.adminPassword || body.password || found.adminPassword,
            } : {
                id: slug,
                name: body.name || slug,
                url: body.url || '',
                adminPassword: body.adminPassword || body.password,
            };

            const result = await harvestNode(node, true);
            ctx.body = { success: true, result };
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Harvest failed: ' + e.message };
        }
    });

    function resolveNodeSlug(ctx: any): string | null {
        const nodeId = String(ctx.query.nodeId || '');
        if (!nodeId) {
            ctx.status = 400;
            ctx.body = { error: 'nodeId required' };
            return null;
        }
        if (nodeId.includes('/') || nodeId.includes('\\') || nodeId.includes('..')) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid nodeId parameter' };
            return null;
        }
        const slug = nodeSlug(nodeId);
        if (path.dirname(path.resolve(BACKUPS_DIR, slug)) !== path.resolve(BACKUPS_DIR)) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid nodeId parameter' };
            return null;
        }
        return slug;
    }

    /**
     * How many objects the node said it could not put in this backup, from the manifest kept beside the
     * database. For the `X-Backup-Missing-Images` header, so the dashboard can say "this backup is missing N
     * photos" without opening the archive. Zero when the manifest is absent or unreadable — the archive still
     * carries it, and a restore reads it there.
     */
    function missingCount(dbPath: string): number {
        try {
            const parsed = JSON.parse(fs.readFileSync(missingManifestFor(dbPath), 'utf8'));
            return Array.isArray(parsed?.missing) ? parsed.missing.length : 0;
        } catch {
            return 0;
        }
    }

    function sendSealedFile(ctx: any, filePath: string, filename: string): void {
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Content-Type', 'application/octet-stream');
        // eslint-disable-next-line no-control-regex
        ctx.set('Content-Disposition', `attachment; filename="${filename.replace(/[\r\n"\x00-\x1F\x7F]/g, '_')}"`);
        ctx.body = fs.createReadStream(filePath);
    }

    /**
     * A readable backup the harvester holds, served WHOLE: a `.tar.gz` of `state.db`, the `images/` beside it and
     * the short-backup manifest when there is one.
     *
     * This used to stream the bare `.db`. Since the image store, that is a database whose every photo and
     * attachment is a `storage_key` pointing at bytes the file does not carry — and it was not restorable
     * anyway: the restore wizard extracts a tar. The archive here is exactly the shape the node's own
     * `/api/local/admin/backup` sends, so what the operator downloads restores like any other backup.
     *
     * The staging hard-links rather than copies, so a download does not write a second copy of a node's images
     * onto the manager's disk. `Content-Disposition` names it `.tar.gz`, and both clients honour that name.
     *
     * The gzip is ASYNC, for the reason `createPlainBackup` and `createSealedBackup` are: this compresses more
     * bytes than either — a whole node's kept database plus every object beside it, per download — and a
     * synchronous `tar` here holds the fleet manager's single event loop for the duration, stalling every other
     * request including the harvester's own pulls.
     */
    async function sendReadableBackup(ctx: any, dbPath: string, filename: string): Promise<void> {
        const base = filename.replace(/\.db$/i, '');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-backup-dl-'));
        const stage = path.join(work, 'stage');
        let images = 0;
        let short = false;
        try {
            fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
            const place = (from: string, to: string): void => {
                try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
            };
            place(dbPath, path.join(stage, 'state.db'));
            const src = imagesDirFor(dbPath);
            if (fs.existsSync(src)) {
                const walk = (from: string, to: string): void => {
                    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
                    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
                        const a = path.join(from, entry.name);
                        const b = path.join(to, entry.name);
                        if (entry.isSymbolicLink()) continue;
                        if (entry.isDirectory()) { walk(a, b); continue; }
                        if (!entry.isFile()) continue;
                        place(a, b);
                        images++;
                    }
                };
                walk(src, path.join(stage, 'images'));
            }
            const manifest = missingManifestFor(dbPath);
            if (fs.existsSync(manifest)) {
                fs.copyFileSync(manifest, path.join(stage, MISSING_MEMBER));
                short = true;
            }
            const tarPath = path.join(work, 'backup.tar.gz');
            await execFileAsync('tar', ['-czf', tarPath, '-C', stage, '.']);
            ctx.set('Cache-Control', 'no-store');
            ctx.set('Content-Type', 'application/gzip');
            ctx.set('X-Backup-Locked', 'no');
            ctx.set('X-Backup-Contents', short ? 'database+images-partial' : 'database+images');
            // `<staged>/<referenced>`, exactly as a node's own backup route spells it, so one reader in each UI
            // covers both. `referenced` is `staged + missing` here: the manager holds what the node sent plus
            // the node's own list of what it could not send.
            const missing = short ? missingCount(dbPath) : 0;
            ctx.set('X-Backup-Images', `${images}/${images + missing}`);
            if (missing > 0) ctx.set('X-Backup-Missing-Images', String(missing));
            // eslint-disable-next-line no-control-regex
            ctx.set('Content-Disposition', `attachment; filename="${`${base}.tar.gz`.replace(/[\r\n"\x00-\x1F\x7F]/g, '_')}"`);
            const body = fs.createReadStream(tarPath);
            // The temp tree outlives this handler and dies with the response, as createPlainBackup's stage does.
            const clean = () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } };
            body.on('close', clean);
            body.on('error', clean);
            ctx.res.on('close', clean);
            ctx.body = body;
        } catch (e) {
            try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
            throw e;
        }
    }

    // Download the newest harvested backup for a node: the newest locked `.bpsealed` file as the node sent it, or —
    // for a node whose backups are not locked yet (no recovery code, or an older BeanPool) — the readable copy as
    // a restorable tar.gz of state.db AND the images it references. Whichever is newer.
    router.get('/api/manager/backups/download-db', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const slug = resolveNodeSlug(ctx);
        if (!slug) return;
        const newest = listSealedBackups(slug).find(f => !f.identity);
        const plainPath = path.join(BACKUPS_DIR, slug, 'state.db');
        const plain = fs.existsSync(plainPath) ? fs.statSync(plainPath) : null;
        if (plain && (!newest || plain.mtimeMs > newest.mtimeMs)) {
            await sendReadableBackup(ctx, plainPath, `beanpool-backup-${slug}.db`);
            return;
        }
        if (!newest) {
            ctx.status = 404;
            ctx.body = { error: `No backup held for node (${slug})` };
            return;
        }
        sendSealedFile(ctx, newest.path, newest.file);
    });

    // List the backups held for a node: locked files (the newest, and one a day for 30 days; the locked legacy key
    // files too, marked `identity`) and readable daily copies (`sealed: false`), newest first.
    router.get('/api/manager/backups/history', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        if (!nodeId) {
            ctx.status = 400;
            ctx.body = { error: 'nodeId required' };
            return;
        }
        const slug = nodeSlug(nodeId);
        const sealed = listSealedBackups(slug).map(f => ({
            filename: f.file,
            date: new Date(f.mtimeMs).toISOString().slice(0, 10),
            sizeBytes: f.size,
            modifiedAt: new Date(f.mtimeMs).toISOString(),
            sealed: true,
            identity: f.identity,
        }));
        const plain = listPlainHistory(slug).map(f => ({
            filename: f.file,
            date: f.file.replace('beanpool-', '').replace('.db', ''),
            sizeBytes: f.size,
            modifiedAt: new Date(f.mtimeMs).toISOString(),
            sealed: false,
            identity: false,
        }));
        ctx.body = { history: [...sealed, ...plain].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)) };
    });

    // Download one held backup: a locked file from sealed/, or a readable daily copy from history/.
    router.get('/api/manager/backups/download-history', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        const filename = String(ctx.query.filename || '');

        if (
            !nodeId ||
            !filename ||
            filename !== path.basename(filename) ||
            filename.includes('/') ||
            filename.includes('\\') ||
            filename.includes('..') ||
            !/^beanpool-[\w-]+\.(bpsealed|db)$/.test(filename)
        ) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid parameters' };
            return;
        }

        const slug = nodeSlug(nodeId);
        const isSealed = filename.endsWith('.bpsealed');
        const dir = path.resolve(BACKUPS_DIR, slug, isSealed ? 'sealed' : 'history');
        const filePath = path.resolve(dir, filename);
        if (path.dirname(filePath) !== dir || !fs.existsSync(filePath)) {
            ctx.status = 404;
            ctx.body = { error: 'Archive file not found' };
            return;
        }
        if (isSealed) sendSealedFile(ctx, filePath, filename);
        else await sendReadableBackup(ctx, filePath, filename);
    });

    // The plain-text identity bundle is gone (sealed-keys.md §6.1): the node keys travel only inside the sealed
    // backup, which download-db serves. 410 says so, rather than a 404 that reads like a missing harvest.
    router.get('/api/manager/backups/download-identity', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!resolveNodeSlug(ctx)) return;
        ctx.status = 410;
        ctx.body = {
            error: 'Node keys are no longer collected on their own. Once the node has a recovery code they are inside its '
                + 'locked backup (Download backup); a readable backup never carries them.',
        };
    });

    // Proxy: List remote node snapshots
    router.post('/api/manager/backups/snapshots/list', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx.request as any).body || {};
        const node = findNodeConfig(body.nodeId, body.url, body.adminPassword);
        const baseUrl = node.url.replace(/\/+$/, '');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;

        try {
            const res = await fetch(`${baseUrl}/api/local/admin/snapshots/list`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ password: node.adminPassword }),
            });
            // Safely parse JSON in case remote node returns non-JSON error (e.g. 500 HTML/404)
            const data = await res.json().catch(() => ({ error: `Remote HTTP ${res.status}: ${res.statusText}` }));
            ctx.status = res.status;
            ctx.body = data;
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to reach node: ' + e.message };
        }
    });

    // Proxy: Create remote snapshot now
    router.post('/api/manager/backups/snapshots/create', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx.request as any).body || {};
        const node = findNodeConfig(body.nodeId, body.url, body.adminPassword);
        const baseUrl = node.url.replace(/\/+$/, '');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;

        try {
            const res = await fetch(`${baseUrl}/api/local/admin/snapshots/create`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ password: node.adminPassword }),
            });
            // Safely parse JSON in case remote node returns non-JSON error (e.g. 500 HTML/404)
            const data = await res.json().catch(() => ({ error: `Remote HTTP ${res.status}: ${res.statusText}` }));
            ctx.status = res.status;
            ctx.body = data;
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to create snapshot on node: ' + e.message };
        }
    });

    // Proxy: Delete remote snapshot
    router.post('/api/manager/backups/snapshots/delete', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx.request as any).body || {};
        const node = findNodeConfig(body.nodeId, body.url, body.adminPassword);
        const baseUrl = node.url.replace(/\/+$/, '');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;

        try {
            const res = await fetch(`${baseUrl}/api/local/admin/snapshots/delete`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: body.name, password: node.adminPassword }),
            });
            // Safely parse JSON in case remote node returns non-JSON error (e.g. 500 HTML/404)
            const data = await res.json().catch(() => ({ error: `Remote HTTP ${res.status}: ${res.statusText}` }));
            ctx.status = res.status;
            ctx.body = data;
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to delete snapshot: ' + e.message };
        }
    });

    // Proxy: Update replication cadence config
    router.post('/api/manager/backups/replication-config', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const body = (ctx.request as any).body || {};
        const node = findNodeConfig(body.nodeId, body.url, body.adminPassword);
        const baseUrl = node.url.replace(/\/+$/, '');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (node.adminPassword) headers['X-Admin-Password'] = node.adminPassword;

        try {
            const res = await fetch(`${baseUrl}/api/local/admin/backup-config`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    pullSeconds: body.pullSeconds,
                    reconcileMinutes: body.reconcileMinutes,
                    password: node.adminPassword,
                }),
            });
            // Safely parse JSON in case remote node returns non-JSON error (e.g. 500 HTML/404)
            const data = await res.json().catch(() => ({ error: `Remote HTTP ${res.status}: ${res.statusText}` }));
            ctx.status = res.status;
            ctx.body = data;
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to update replication config: ' + e.message };
        }
    });

    return router;
}
