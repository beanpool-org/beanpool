/**
 * Fleet Manager Backup & Replication API Routes
 */

import Router from '@koa/router';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    loadHarvestState, harvestNode, harvestAllNodes, getNodes, nodeSlug, type FleetNodeConfig
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

    // Status of all harvested backups
    router.get('/api/manager/backups/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        ctx.body = {
            nodes: getNodes(),
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

    // Download harvested state.db for a node
    router.get('/api/manager/backups/download-db', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        if (!nodeId) {
            ctx.status = 400;
            ctx.body = { error: 'nodeId required' };
            return;
        }

        const slug = nodeSlug(nodeId);
        const dbPath = path.join(BACKUPS_DIR, slug, 'state.db');
        if (!fs.existsSync(dbPath)) {
            ctx.status = 404;
            ctx.body = { error: `Backup DB not found for node (${slug})` };
            return;
        }

        ctx.set('Content-Type', 'application/x-sqlite3');
        ctx.set('Content-Disposition', `attachment; filename="beanpool-backup-${slug}.db"`);
        ctx.body = fs.createReadStream(dbPath);
    });

    // List 30-day historical snapshot archives for a node
    router.get('/api/manager/backups/history', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        if (!nodeId) {
            ctx.status = 400;
            ctx.body = { error: 'nodeId required' };
            return;
        }

        const slug = nodeSlug(nodeId);
        const historyDir = path.join(BACKUPS_DIR, slug, 'history');
        if (!fs.existsSync(historyDir)) {
            ctx.body = { history: [] };
            return;
        }

        const files = fs.readdirSync(historyDir)
            .filter(f => f.startsWith('beanpool-') && f.endsWith('.db'))
            .map(f => {
                const p = path.join(historyDir, f);
                const stat = fs.statSync(p);
                return {
                    filename: f,
                    date: f.replace('beanpool-', '').replace('.db', ''),
                    sizeBytes: stat.size,
                    modifiedAt: new Date(stat.mtimeMs).toISOString(),
                };
            })
            .sort((a, b) => b.filename.localeCompare(a.filename));

        ctx.body = { history: files };
    });

    // Download specific historical archive file
    router.get('/api/manager/backups/download-history', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        const filename = String(ctx.query.filename || '');

        if (!nodeId || !filename || filename.includes('/') || filename.includes('..')) {
            ctx.status = 400;
            ctx.body = { error: 'Invalid parameters' };
            return;
        }

        const slug = nodeSlug(nodeId);
        const filePath = path.join(BACKUPS_DIR, slug, 'history', filename);
        if (!fs.existsSync(filePath)) {
            ctx.status = 404;
            ctx.body = { error: 'Archive file not found' };
            return;
        }

        ctx.set('Content-Type', 'application/x-sqlite3');
        ctx.set('Content-Disposition', `attachment; filename="${filename}"`);
        ctx.body = fs.createReadStream(filePath);
    });

    // Download identity bundle tarball
    router.get('/api/manager/backups/download-identity', async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        const nodeId = String(ctx.query.nodeId || '');
        if (!nodeId) {
            ctx.status = 400;
            ctx.body = { error: 'nodeId required' };
            return;
        }

        const slug = nodeSlug(nodeId);
        const identityDir = path.join(BACKUPS_DIR, slug, 'identity');
        if (!fs.existsSync(identityDir)) {
            ctx.status = 404;
            ctx.body = { error: `Identity bundle not found for node (${slug})` };
            return;
        }

        // eslint-disable-next-line no-control-regex
        const safeNodeId = nodeId.replace(/[\r\n"\x00-\x1F\x7F]/g, '_');
        const tmpTar = path.join(BACKUPS_DIR, slug, `.identity-export-${Date.now()}.tar.gz`);
        try {
            execFileSync('tar', ['-czf', tmpTar, '-C', identityDir, '.']);
            ctx.set('Content-Type', 'application/gzip');
            ctx.set('Content-Disposition', `attachment; filename="identity-bundle-${safeNodeId}.tar.gz"`);
            const stream = fs.createReadStream(tmpTar);
            stream.on('close', () => {
                try { if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar); } catch {}
            });
            ctx.body = stream;
        } catch (e: any) {
            ctx.status = 500;
            ctx.body = { error: 'Failed to create identity tarball: ' + e.message };
        }
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
