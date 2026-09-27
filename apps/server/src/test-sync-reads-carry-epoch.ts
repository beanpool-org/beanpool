/**
 * Test Suite: the reads a phone syncs by carry the node's identity epoch, and a take-over changes it.
 *
 * Design: scratch/global-node/DESIGN-standby-takeover-gaps-opus.md §2 "G7". A promoted standby never had what the old
 * main server wrote after its last copy; a phone that synced that tail by cursor would keep it for good. So the sync
 * reads say which identity epoch answered them (services/identity-epoch.ts `EPOCH_HEADER`), and a phone that sees it
 * change replaces its cache with a full sync (apps/native services/pillar-sync.ts).
 *
 * Every node is its own process (takeover-test-harness.ts). The harness serves the backup and take-over routes only,
 * so each node also serves the real posts, members and projects routes on a port of its own (`serve-sync` below),
 * mounted from the same route factories https-server.ts mounts.
 *
 *  1. A main server that never took over: the phone's posts pull (`sync=true`, with and without `updatedAfter`), its
 *     members delta and its projects delta each say epoch 0, and so does a 304 that revalidates the posts pull. The
 *     reads that are not a phone's sync (the web board's posts, the plain directory) say nothing.
 *  2. Its standby copies it; the main server dies; the standby takes over with the recovery code and restarts. The
 *     same reads on it now say epoch 1.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sync-reads-carry-epoch.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawnNode, post, runNodeChild, type NodeProc } from './takeover-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Main-Server-Pw-418!';
const PW_STANDBY = 'Standby-Own-Pw-529!';
const HEADER = 'x-beanpool-epoch';

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            se.seedGenesisMember(Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex'), 'Anna');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        pull: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const resync = await requestResync();
            const envelope = await pullTakeoverEnvelopeNow();
            return { resync, envelope };
        },
        // The routes a phone syncs by, as https-server.ts mounts them, on a port of their own.
        'serve-sync': async () => {
            const Koa = (await import('koa')).default;
            const { createMarketplaceRoutes } = await import('./routes/marketplace.js');
            const { createCommunityRoutes } = await import('./routes/community.js');
            const { createCommonsRoutes } = await import('./routes/commons.js');
            const deps: any = {
                checkAdminAuth: async () => false, rateLimit: () => true,
                clampLimit: (v: unknown, d = 50) => { const n = Math.floor(Number(v)); return n > 0 ? Math.min(n, 200) : d; },
                clampOffset: () => 0, activeConnections: new Map(), calculateAnalytics: () => ({}),
                enforceReadAuth: false, broadcast: () => {},
            };
            const app = new Koa();
            for (const r of [createMarketplaceRoutes(deps), createCommunityRoutes(deps), createCommonsRoutes(deps)]) app.use(r.routes());
            const server = http.createServer(app.callback());
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
            return { port: (server.address() as AddressInfo).port };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const SINCE = encodeURIComponent('2026-01-01T00:00:00.000Z');
/** The reads services/pillar-sync.ts makes with a cursor, or to pull the listings whole. */
const SYNC_READS = [
    '/api/marketplace/posts?limit=1000&sync=true&types=offer,need,poll,event',
    `/api/marketplace/posts?limit=1000&sync=true&types=offer,need,poll,event&updatedAfter=${SINCE}`,
    `/api/members?updatedAfter=${SINCE}`,
    `/api/crowdfund/projects?limit=1000&updatedAfter=${SINCE}`,
];
/** Reads that are not a phone's sync. */
const OTHER_READS = ['/api/marketplace/posts', '/api/members'];

async function epochOn(base: string, route: string, headers: Record<string, string> = {}): Promise<{ status: number; epoch: string | null; etag: string | null }> {
    const res = await fetch(base + route, { headers });
    await res.arrayBuffer();
    return { status: res.status, epoch: res.headers.get(HEADER), etag: res.headers.get('etag') };
}

async function serveSync(n: NodeProc): Promise<string> {
    const { port } = await n.send('serve-sync');
    return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const ownerSeedHex = crypto.randomBytes(32).toString('hex');
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    try {
        // ── 1. A main server that never took over ──
        console.log('\n— 1. a main server that never took over: its sync reads say epoch 0 —');
        const old = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(old);
        const setup = await old.send('setup-primary', { ownerSeedHex, replicationToken });
        const mainPeerId = old.ready.peerId;
        const oldSync = await serveSync(old);
        for (const route of SYNC_READS) {
            const r = await epochOn(oldSync, route);
            assert(r.status === 200 && r.epoch === '0', `${route.split('?')[0]} (${route.includes('updatedAfter') ? 'a delta' : 'the whole pull'}) → ${r.status}, epoch ${r.epoch}`);
        }
        const first = await epochOn(oldSync, SYNC_READS[1]);
        const revalidated = await epochOn(oldSync, SYNC_READS[1], first.etag ? { 'If-None-Match': first.etag } : {});
        assert(first.etag && revalidated.status === 304 && revalidated.epoch === '0',
            `a 304 that revalidates the posts pull carries it too, for the phone's platform cache to take over the stored one (${revalidated.status}, ${revalidated.epoch})`);
        for (const route of OTHER_READS) {
            const r = await epochOn(oldSync, route);
            assert(r.status === 200 && r.epoch === null, `${route} with no sync or cursor (the web board, the plain directory) → no epoch (${r.epoch})`);
        }

        // ── 2. Take-over ──
        console.log('\n— 2. the standby takes over: the same reads say epoch 1 —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: old.base, replicationToken, primaryPeerId: mainPeerId });
        const pulled = await standby.send('pull');
        assert(pulled.resync.ok && pulled.envelope === 'stored', 'the standby copied the database and holds the keys');
        await old.kill('SIGKILL');

        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, pw(PW_STANDBY));
        assert(opened.status === 200 && opened.body.preview?.peerId === mainPeerId, `the code opens the keys (${opened.status})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        assert(confirmed.status === 200, `confirmed (${confirmed.status})`);
        assert((await standby.exited) === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        assert(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId, 'it is the main server, with the same PeerId');

        const newSync = await serveSync(standby);
        for (const route of SYNC_READS) {
            const r = await epochOn(newSync, route);
            assert(r.status === 200 && r.epoch === '1', `after the take-over, ${route.split('?')[0]} (${route.includes('updatedAfter') ? 'a delta' : 'the whole pull'}) → ${r.status}, epoch ${r.epoch}`);
        }
        const stale = await epochOn(newSync, SYNC_READS[1], first.etag ? { 'If-None-Match': first.etag } : {});
        assert(stale.epoch === '1', `a phone revalidating the old server's copy is told epoch 1 (${stale.status}, ${stale.epoch})`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} passed`);
    if (testsPassed !== testsRun) process.exit(1);
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        process.exit(1);
    });
}
