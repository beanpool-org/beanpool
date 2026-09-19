/**
 * Harvester service unit/integration test.
 *
 * Tests node slug generation, fleet node config load/save persistence,
 * and harvest state load/save in isolated temporary data directory.
 * Then harvests a real (in-process, local HTTP) node: with only a replication token the database is
 * collected and identity is 'partial', with a reason; with the admin password it is 'secured'.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-harvester.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { nodeSlug, getNodes, saveNodes, loadHarvestState, harvestNode, type FleetNodeConfig } from './services/harvester.js';
import { initStateEngine } from './state-engine.js';
import { createBackupRoutes } from './routes/backup.js';
import { hashPassword, updateLocalConfig, setReplicationToken } from './config/local-config.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
import type { RouteDeps } from './routes/types.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

/** Harvest a node served in-process over local HTTP, the way the harvester reaches a real one. */
async function harvestLocalNode(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    initStateEngine();
    const PW = 'HarvesterAdmin123!';
    const TOKEN = 'harvester-test-token-0123456789abcdef';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    setReplicationToken(TOKEN);
    fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify({ communityId: 'harvest-test' }));
    fs.writeFileSync(path.join(dataDir, 'community.key'), 'test-community-key');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), 'test-node-identity');

    const deps: RouteDeps = {
        checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    };
    const app = new Koa();
    app.use(createBackupRoutes(deps).routes());
    const server = http.createServer(app.callback());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        // Token only: the database comes, the keys do not, and the status says so. No crash.
        const tokenOnly: FleetNodeConfig = { id: 'tok-node', name: 'Token Node', url, replicationToken: TOKEN };
        resetAdminAuthTarpit();
        const a = await harvestNode(tokenOnly, true);
        assert(a.status === 'ok' && a.error === null, `token-only harvest completes without error (${a.status}: ${a.error})`);
        assert(a.dbSizeBytes > 0, 'token-only harvest still collects the database');
        assert(a.identityStatus === 'partial', `token-only node: identity is partial (got ${a.identityStatus})`);
        assert(/replication token cannot fetch the node keys/.test(a.identityNote || ''), 'token-only node: the status says why, in words');
        const idDir = path.join(dataDir, 'backups', nodeSlug(tokenOnly), 'identity');
        assert(!fs.existsSync(idDir) || fs.readdirSync(idDir).filter(f => !f.startsWith('.')).length === 0, 'token-only node: no key files were collected');
        assert(a.identityFiles.length === 0, 'token-only node: no key files are listed');

        // Admin password: the keys come, and secured means the node identity (libp2p_key) is held.
        const withPw: FleetNodeConfig = { ...tokenOnly, adminPassword: PW };
        resetAdminAuthTarpit();
        const b = await harvestNode(withPw, true);
        assert(b.identityStatus === 'secured' && b.identityNote === null, `with the admin password: identity secured (got ${b.identityStatus}: ${b.identityNote})`);
        assert(b.identityFiles.includes('libp2p_key') && b.identityFiles.includes('genesis.json'), 'with the admin password: libp2p_key and genesis.json are held');

        // Back to token only (an unforced run): the status does not stay 'secured'.
        resetAdminAuthTarpit();
        const c = await harvestNode(tokenOnly, false);
        assert(c.identityStatus === 'partial', `token-only again: no longer reported secured (got ${c.identityStatus})`);
        assert(/older copy/.test(c.identityNote || ''), 'token-only again: says the key files shown are an older copy');

        // A wrong admin password: partial, with the reason; the harvest itself does not crash.
        const wrongPw: FleetNodeConfig = { ...tokenOnly, adminPassword: 'wrong-password-1!' };
        resetAdminAuthTarpit();
        const d = await harvestNode(wrongPw, true);
        assert(d.status === 'ok' && d.identityStatus === 'partial' && /refused the admin password/.test(d.identityNote || ''),
            `a refused admin password: partial with the reason (got ${d.status}/${d.identityStatus}: ${d.identityNote})`);
    } finally {
        await new Promise<void>(r => server.close(() => r()));
    }
}

async function main() {
    console.log('Running harvester service test...\n');

    // 1. Test nodeSlug
    assert(nodeSlug('') === 'unknown', 'nodeSlug handles empty target');
    assert(nodeSlug('mullum') === 'mullum', 'nodeSlug handles exact default node id');
    assert(nodeSlug({ id: 'custom-1', name: 'Mullumbimby Node', url: 'https://mullum.example.com' }) === 'mullum', 'nodeSlug detects mullum keyword in name/url');
    assert(nodeSlug({ id: 'custom-2', name: 'Local Dev Node', url: 'http://localhost:8450' }) === 'local-node', 'nodeSlug detects localhost url');
    assert(nodeSlug({ id: 'special@node/1', name: 'Special Node', url: 'https://special.org' }) === 'special_node_1', 'nodeSlug sanitizes special characters');

    // 2. Test getNodes default fallback
    const initialNodes = getNodes();
    assert(Array.isArray(initialNodes) && initialNodes.length > 0, 'getNodes returns default nodes when no config file exists');
    assert(initialNodes.some(n => n.id === 'mullum'), 'default nodes include mullum');

    // 3. Test saveNodes & getNodes persistence roundtrip
    const customNodes: FleetNodeConfig[] = [
        { id: 'custom-pool', name: 'Custom Pool Node', url: 'https://custom.beanpool.org', adminPassword: 'secret-pass' },
    ];
    saveNodes(customNodes);
    const reloadedNodes = getNodes();
    assert(reloadedNodes.length === 1 && reloadedNodes[0].id === 'custom-pool', 'saveNodes persists custom node configuration');
    assert(reloadedNodes[0].adminPassword === 'secret-pass', 'adminPassword field preserved');

    // 4. Test loadHarvestState default
    const initialState = loadHarvestState();
    assert(typeof initialState === 'object' && Object.keys(initialState).length === 0, 'loadHarvestState returns empty object when state file does not exist');

    // 5. A real harvest against a local node
    await harvestLocalNode();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
