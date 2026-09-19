/**
 * Fleet Manager Backup & Replication API Routes
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import {
    loadHarvestState, harvestNode, harvestAllNodes, getNodes, nodeSlug, listSealedBackups, listPlainHistory, type FleetNodeConfig
} from '../services/harvester.js';
import type { RouteDeps } from './types.js';

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

    function sendSealedFile(ctx: any, filePath: string, filename: string): void {
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Content-Type', 'application/octet-stream');
        // eslint-disable-next-line no-control-regex
        ctx.set('Content-Disposition', `attachment; filename="${filename.replace(/[\r\n"\x00-\x1F\x7F]/g, '_')}"`);
        ctx.body = fs.createReadStream(filePath);
    }

    /** A readable database copy, as these routes served it before locked backups. */
    function sendPlainDb(ctx: any, filePath: string, filename: string): void {
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Content-Type', 'application/x-sqlite3');
        ctx.set('X-Backup-Locked', 'no');
        // eslint-disable-next-line no-control-regex
        ctx.set('Content-Disposition', `attachment; filename="${filename.replace(/[\r\n"\x00-\x1F\x7F]/g, '_')}"`);
        ctx.body = fs.createReadStream(filePath);
    }

    // Download the newest harvested backup for a node: the newest locked `.bpsealed` file as the node sent it, or —
    // for a node whose backups are not locked yet (no recovery code, or an older BeanPool) — the readable state.db,
    // as before locked backups. Whichever is newer.
    router.get('/api/manager/backups/download-db', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const slug = resolveNodeSlug(ctx);
        if (!slug) return;
        const newest = listSealedBackups(slug).find(f => !f.identity);
        const plainPath = path.join(BACKUPS_DIR, slug, 'state.db');
        const plain = fs.existsSync(plainPath) ? fs.statSync(plainPath) : null;
        if (plain && (!newest || plain.mtimeMs > newest.mtimeMs)) {
            sendPlainDb(ctx, plainPath, `beanpool-backup-${slug}.db`);
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
        else sendPlainDb(ctx, filePath, filename);
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
