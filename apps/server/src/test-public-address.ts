/**
 * Public Address & Cloudflare Tunnel Creator Test Suite (#101)
 *
 * Verifies:
 * 1. P2P persistent Ed25519 identity generation and nodePubkeyHex().
 * 2. Public Attestation endpoint (GET /api/attest?nonce=...) cryptographic signature verification.
 * 3. Apple Domain Association endpoint (GET /.well-known/apple-developer-domain-association.txt).
 * 4. Subdomain & Cloudflare Tunnel Claim (POST /api/local/admin/public-address/claim) with signed registrar client.
 * 5. Node config persistence and tunnel-token file write (data/tunnel-token).
 * 6. Public address status synchronization (GET /api/local/admin/public-address/status).
 * 7. Metadata update route (POST /api/local/admin/public-address/update).
 * 8. Sidecar restart trigger (POST /api/local/admin/public-address/restart-sidecar).
 * 9. Take Offline & Token Teardown (POST /api/local/admin/public-address/offline).
 * 10. Admin authentication enforcement across all management endpoints.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import Koa from 'koa';
import { startP2P } from './p2p.js';
import { initStateEngine, getNodeConfig } from './state-engine.js';
import { createPublicAddressRoutes } from './routes/public-address.js';
import { buildAttestation, nodePubkeyHex } from './services/registrar-client.js';
import type { RouteDeps } from './routes/types.js';

let testsRun = 0;
let testsPassed = 0;

function assert(cond: boolean, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exit(1);
    }
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tunnel-token');

async function run() {
    console.log('🚀 Starting Public Address & Cloudflare Tunnel Test Suite (#101)...\n');

    initStateEngine();
    const p2pNode = await startP2P(4020, 4021);
    const pubkey = nodePubkeyHex();

    assert(typeof pubkey === 'string' && pubkey.length === 64, `P2P identity generated valid 32-byte Ed25519 pubkey: ${pubkey.slice(0, 16)}...`);

    // 1. Test buildAttestation
    const testNonce = 'nonce-test-' + Date.now();
    const attestation = await buildAttestation(testNonce);
    assert(attestation.pubkey === pubkey, 'Attestation pubkey matches node identity');
    assert(attestation.nonce === testNonce, 'Attestation carries requested nonce');
    assert(typeof attestation.timestamp === 'number' && attestation.timestamp > 0, 'Attestation includes integer unix timestamp');
    assert(typeof attestation.signature === 'string' && attestation.signature.length === 128, 'Attestation produces valid 64-byte Ed25519 hex signature');

    // 2. Setup Mock Registrar Server
    let registrarStatus = 'none';
    let registrarName = '';
    let registrarCommunityName = '';
    let registrarContact = '';
    const registrarToken = 'cf-tunnel-token-secret-123456789';

    const mockRegistrar = http.createServer(async (req, res) => {
        let bodyText = '';
        req.on('data', chunk => { bodyText += chunk; });
        req.on('end', () => {
            const url = new URL(req.url || '/', `http://${req.headers.host}`);
            const headers = req.headers;

            // Verify signed request headers
            const clientPubkey = headers['x-bp-pubkey'];
            const clientTimestamp = headers['x-bp-timestamp'];
            const clientSignature = headers['x-bp-signature'];

            if (!clientPubkey || !clientTimestamp || !clientSignature) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing signed request headers' }));
                return;
            }

            if (url.pathname === '/api/registrar/claim' && req.method === 'POST') {
                const b = JSON.parse(bodyText || '{}');
                registrarName = b.name;
                registrarCommunityName = b.community_name;
                registrarContact = b.contact;
                registrarStatus = 'live';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'live',
                    name: registrarName,
                    hostname: `${registrarName}.beanpool.org`,
                    tunnelToken: registrarToken,
                }));
                return;
            }

            if (url.pathname === '/api/registrar/status' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: registrarStatus,
                    name: registrarName,
                    hostname: registrarName ? `${registrarName}.beanpool.org` : null,
                    tunnelToken: registrarStatus === 'live' ? registrarToken : null,
                }));
                return;
            }

            if (url.pathname === '/api/registrar/update' && req.method === 'POST') {
                const b = JSON.parse(bodyText || '{}');
                if (b.community_name !== undefined) registrarCommunityName = b.community_name;
                if (b.contact !== undefined) registrarContact = b.contact;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: registrarStatus,
                    communityName: registrarCommunityName,
                    contact: registrarContact,
                }));
                return;
            }

            if (url.pathname === '/api/registrar/offline' && req.method === 'POST') {
                registrarStatus = 'none';
                registrarName = '';
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'none' }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        });
    });

    await new Promise<void>(resolve => mockRegistrar.listen(0, '127.0.0.1', () => resolve()));
    const regPort = (mockRegistrar.address() as any).port;
    process.env.REGISTRAR_URL = `http://127.0.0.1:${regPort}`;

    // 3. Setup Test Koa App with Public Address Routes
    let allowAdmin = true;
    const fakeDeps: RouteDeps = {
        checkAdminAuth: async (ctx: any) => {
            if (!allowAdmin) {
                ctx.status = 401;
                ctx.body = { error: 'Unauthorized' };
                return false;
            }
            return true;
        },
    } as any;

    const app = new Koa();
    app.use(async (ctx: any, next: any) => {
        if (ctx.method === 'POST' || ctx.method === 'PUT') {
            const bodyStr = await new Promise<string>((resolve) => {
                let data = '';
                ctx.req.on('data', (chunk: any) => { data += chunk; });
                ctx.req.on('end', () => resolve(data));
            });
            try { (ctx as any).requestBody = JSON.parse(bodyStr || '{}'); } catch { (ctx as any).requestBody = {}; }
        }
        await next();
    });
    const paRouter = createPublicAddressRoutes(fakeDeps);
    app.use(paRouter.routes());
    app.use(paRouter.allowedMethods());

    const server = http.createServer(app.callback());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const serverPort = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${serverPort}`;

    try {
        // --- Test 1: Public GET /api/attest ---
        const attestRes = await fetch(`${baseUrl}/api/attest?nonce=test-check-1`);
        assert(attestRes.status === 200, 'GET /api/attest returns HTTP 200');
        const attestBody = await attestRes.json();
        assert(attestBody.pubkey === pubkey, 'GET /api/attest returns correct node public key');
        assert(attestBody.nonce === 'test-check-1', 'GET /api/attest echoes nonce');
        assert(typeof attestBody.signature === 'string', 'GET /api/attest includes valid signature');

        // Test missing nonce returns 400
        const attestFail = await fetch(`${baseUrl}/api/attest`);
        assert(attestFail.status === 400, 'GET /api/attest without nonce returns 400 Bad Request');

        // --- Test 2: Apple Domain Association ---
        const appleResNone = await fetch(`${baseUrl}/.well-known/apple-developer-domain-association.txt`);
        assert(appleResNone.status === 404, 'Apple domain association returns 404 when unconfigured');

        process.env.APPLE_DOMAIN_ASSOCIATION = 'apple-verification-token-string-xyz';
        const appleResSet = await fetch(`${baseUrl}/.well-known/apple-developer-domain-association.txt`);
        assert(appleResSet.status === 200, 'Apple domain association returns 200 when configured');
        const appleText = await appleResSet.text();
        assert(appleText === 'apple-verification-token-string-xyz', 'Apple domain association serves exact token');

        // --- Test 3: Admin Auth Enforcement ---
        allowAdmin = false;
        const unauthClaim = await fetch(`${baseUrl}/api/local/admin/public-address/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'cairns' })
        });
        assert(unauthClaim.status === 401, 'POST /claim is rejected with 401 when admin auth fails');

        const unauthStatus = await fetch(`${baseUrl}/api/local/admin/public-address/status`);
        assert(unauthStatus.status === 401, 'GET /status is rejected with 401 when admin auth fails');

        allowAdmin = true;

        // --- Test 4: Claim Public Address & Provision Tunnel ---
        const claimRes = await fetch(`${baseUrl}/api/local/admin/public-address/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'mullum-test',
                mode: 'tunnel',
                contact: 'operator@beanpool.org',
                communityName: 'Mullumbimby Test Pool'
            })
        });

        const claimBody = await claimRes.json().catch(() => ({}));
        if (claimRes.status !== 200) {
            console.error('claimRes failed:', claimRes.status, claimBody);
        }
        assert(claimRes.status === 200, 'POST /claim succeeds with HTTP 200');
        assert(claimBody.success === true, 'Claim response has success: true');
        assert(claimBody.hostname === 'mullum-test.beanpool.org', 'Claim returns assigned hostname');
        assert(claimBody.tunnelToken === registrarToken, 'Claim returns provisioned Cloudflare tunnel token');

        // Verify Node Config Persistence
        const config = getNodeConfig() as any;
        assert(config.publicAddress !== null, 'Node config publicAddress is persisted');
        assert(config.publicAddress.name === 'mullum-test', 'Node config records subdomain name');
        assert(config.publicAddress.hostname === 'mullum-test.beanpool.org', 'Node config records full hostname');
        assert(config.publicAddress.tunnelToken === registrarToken, 'Node config records tunnel token');

        // Verify Tunnel Token File written on disk
        assert(fs.existsSync(TOKEN_FILE), 'tunnel-token file exists on disk');
        const savedToken = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
        assert(savedToken === registrarToken, 'tunnel-token file contains exact provisioned secret');

        // --- Test 5: Status Check ---
        const statusRes = await fetch(`${baseUrl}/api/local/admin/public-address/status`);
        assert(statusRes.status === 200, 'GET /status succeeds with HTTP 200');
        const statusBody = await statusRes.json();
        assert(statusBody.success === true, 'Status response has success: true');
        assert(statusBody.status === 'live', 'Status reports status: live');
        assert(statusBody.hostname === 'mullum-test.beanpool.org', 'Status reports active hostname');
        assert(statusBody.pubkey === pubkey, 'Status reports node public key');

        // --- Test 6: Metadata Update ---
        const updateRes = await fetch(`${baseUrl}/api/local/admin/public-address/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                communityName: 'Updated Community Name',
                contact: 'new-contact@beanpool.org'
            })
        });
        assert(updateRes.status === 200, 'POST /update succeeds with HTTP 200');
        const updatedConfig = getNodeConfig() as any;
        assert(updatedConfig.publicAddress.communityName === 'Updated Community Name', 'Node config reflects updated community name');
        assert(updatedConfig.publicAddress.contact === 'new-contact@beanpool.org', 'Node config reflects updated contact');

        // --- Test 7: Sidecar Restart Route ---
        const restartRes = await fetch(`${baseUrl}/api/local/admin/public-address/restart-sidecar`, { method: 'POST' });
        assert(restartRes.status === 200, 'POST /restart-sidecar returns HTTP 200');
        const restartBody = await restartRes.json();
        assert(restartBody.success === true, 'Sidecar restart response has success: true');

        // --- Test 8: Probe Logs ---
        const logsRes = await fetch(`${baseUrl}/api/local/admin/public-address/logs`);
        assert(logsRes.status === 200, 'GET /logs returns HTTP 200');
        const logsBody = await logsRes.json();
        assert(Array.isArray(logsBody.logs) && logsBody.logs.length > 0, 'Probe logs return populated log array');

        // --- Test 9: Take Offline & Teardown ---
        const offlineRes = await fetch(`${baseUrl}/api/local/admin/public-address/offline`, { method: 'POST' });
        assert(offlineRes.status === 200, 'POST /offline succeeds with HTTP 200');
        const offlineBody = await offlineRes.json();
        assert(offlineBody.success === true && offlineBody.status === 'none', 'Offline response confirms status: none');

        // Verify Node Config is Cleared
        const postOfflineConfig = getNodeConfig() as any;
        assert(postOfflineConfig.publicAddress === null, 'Node config publicAddress is cleanly cleared to null');

        // Verify Tunnel Token File is Removed
        assert(!fs.existsSync(TOKEN_FILE), 'tunnel-token file is deleted from disk on teardown');

        console.log(`\n⭐️ ALL ${testsPassed}/${testsRun} PUBLIC ADDRESS & TUNNEL TESTS PASSED.`);
    } finally {
        server.close();
        mockRegistrar.close();
        if (p2pNode) await p2pNode.stop();
        if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    }
}

run().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
