/**
 * Test Suite: Backup Identity Bundle Endpoint
 *
 * Verifies POST /api/local/admin/identity-bundle in apps/server/src/routes/backup.ts:
 * 1. Unauthenticated request is rejected with HTTP 401.
 * 2. Request when required identity files (genesis.json / community.key) are missing returns 503.
 * 3. Request with valid admin password when identity files exist returns 200, application/gzip,
 *    and X-Identity-Files header containing collected file names.
 * 4. A valid X-Replication-Token is REFUSED (401): the token copies the database, never the node keys.
 *    (Until slice 0 of the sealed-keys design this asserted 200 — that encoded the leak.)
 * 5. The same token still gets 200 on sync-snapshot, sync-delta and /backup (unchanged in this slice).
 * 6. Owner/admin sign-in still gets the bundle: password + 2FA code, and an owner's key session;
 *    a token sent alongside a valid admin sign-in does not get in the way.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-identity-bundle.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initStateEngine, seedGenesisMember, grantNodeRole } from './state-engine.js';
import { db } from './db/db.js';
import { createAdminChallenge, verifyAndSolveChallenge, consumeHandshakeToken } from './admin-key-auth.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';
import { createBackupRoutes } from './routes/backup.js';
import { startP2P } from './p2p.js';
import { updateLocalConfig, setReplicationToken } from './config/local-config.js';
import { checkAdminAuth, resetAdminAuthTarpit } from './admin-auth.js';
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
        throw new Error(`Assertion failed: ${msg}`);
    }
}

const deps: RouteDeps = {
    checkAdminAuth: async (ctx: any) => checkAdminAuth(ctx),
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
};

async function callRouter(
    router: any,
    method: string,
    urlPath: string,
    opts: {
        headers?: Record<string, string>;
        body?: Record<string, unknown>;
    } = {}
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
    const layer = router.stack.find((l: any) =>
        (l.path === urlPath || l.regexp.test(urlPath)) && l.methods.includes(method.toUpperCase())
    );
    if (!layer) throw new Error(`${method} ${urlPath} is not mounted in router`);

    const reqHeaders = { ...(opts.headers || {}) };
    const responseHeaders: Record<string, string> = {};

    const ctx: any = {
        method: method.toUpperCase(),
        path: urlPath,
        headers: reqHeaders,
        request: {
            header: reqHeaders,
            headers: reqHeaders,
            body: opts.body || {},
        },
        requestBody: opts.body || {},
        status: 200,
        body: undefined,
        set: (key: string, val: string) => {
            responseHeaders[key.toLowerCase()] = val;
        },
        get: (key: string) => reqHeaders[key.toLowerCase()],
        res: {
            on: (_event: string, _cb: () => void) => {},
        },
    };

    try {
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
    } catch (err: any) {
        if (!ctx.status || ctx.status === 200) {
            ctx.status = err.status || 500;
            ctx.body = { error: err.message };
        }
    }

    return { status: ctx.status, body: ctx.body, headers: responseHeaders };
}

async function runSuite() {
    console.log('📦 Running Backup Identity Bundle Test Suite...\n');

    const dataDir = process.env.BEANPOOL_DATA_DIR;
    assert(!!dataDir, 'BEANPOOL_DATA_DIR environment variable is set');

    initStateEngine();
    const router = createBackupRoutes(deps);

    // Set up admin password in local config
    const testPass = 'IdentityBundleSecret123!';
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16).toString('hex');
    const adminHash = scryptSync(testPass, salt, 64).toString('hex');
    updateLocalConfig({ adminHash, salt });

    // 1. Unauthenticated request -> 401
    resetAdminAuthTarpit();
    const resUnauth = await callRouter(router, 'POST', '/api/local/admin/identity-bundle');
    assert(resUnauth.status === 401, '1. Unauthenticated POST /api/local/admin/identity-bundle returns 401');

    // 2. Request when required identity files are missing -> 503
    resetAdminAuthTarpit();
    const resMissing = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-admin-password': testPass },
    });
    assert(resMissing.status === 503, '2. Request returns 503 when required identity files are missing');
    assert(
        typeof resMissing.body?.error === 'string' && resMissing.body.error.includes('Required identity file missing'),
        '2. Error message specifies missing required identity file'
    );

    // 3. Create mock identity files in dataDir
    const genesisPath = path.join(dataDir!, 'genesis.json');
    const communityKeyPath = path.join(dataDir!, 'community.key');
    const localConfigPath = path.join(dataDir!, 'local-config.json');

    fs.writeFileSync(genesisPath, JSON.stringify({ communityId: 'test-community-123' }));
    fs.writeFileSync(communityKeyPath, 'mock-community-key-bytes');

    // Request with valid admin password -> 200 with tar.gz
    resetAdminAuthTarpit();
    const resOk = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-admin-password': testPass },
    });
    assert(resOk.status === 200, '3. Request with valid admin password returns 200 when identity files exist');
    assert(resOk.headers['content-type'] === 'application/gzip', '3. Content-Type is application/gzip');
    assert(
        resOk.headers['x-identity-files']?.includes('genesis.json') &&
            resOk.headers['x-identity-files']?.includes('community.key'),
        '3. X-Identity-Files header lists genesis.json and community.key'
    );
    assert(resOk.body && typeof resOk.body.pipe === 'function', '3. Response body is a readable stream');

    // 4. Request with valid replication token -> 401. The token never reaches the node keys.
    const repToken = 'rep-token-secret-999';
    setReplicationToken(repToken);

    resetAdminAuthTarpit();
    const resToken = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-replication-token': repToken },
    });
    assert(resToken.status === 401, `4. Request with a valid x-replication-token is refused with 401 (got ${resToken.status})`);
    assert(!resToken.headers['content-type'] && !resToken.headers['x-identity-files'], '4. No bundle, not even its file list, goes to the token');
    assert(resToken.body?.tokenRefused === true && /cannot fetch the node keys/.test(resToken.body?.hint || ''), '4. The refusal says why, in words');

    resetAdminAuthTarpit();
    const resTokenBody = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        body: { token: repToken },
    });
    assert(resTokenBody.status === 401, '4. The token in the request body is refused too');

    // 5. The token still copies the database: sync-snapshot, sync-delta and /backup are unchanged.
    // A libp2p identity is needed to sign the snapshot/delta (random ports).
    const p2pNode = await startP2P(0, 0);
    for (const route of ['/api/local/admin/sync-snapshot', '/api/local/admin/sync-delta']) {
        resetAdminAuthTarpit();
        const r = await callRouter(router, 'GET', route, { headers: { 'x-replication-token': repToken } });
        assert(r.status === 200 && !!r.body?.signature, `5. ${route} with the token answers 200 with a signed payload (got ${r.status})`);
    }
    resetAdminAuthTarpit();
    const resDbToken = await callRouter(router, 'POST', '/api/local/admin/backup', {
        headers: { 'x-replication-token': repToken },
    });
    assert(resDbToken.status === 200 && resDbToken.headers['content-type'] === 'application/gzip', `5. /backup with the token still answers 200 with the database (got ${resDbToken.status})`);

    // 6a. A token sent alongside a valid admin password does not get in the way.
    resetAdminAuthTarpit();
    const resBoth = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-admin-password': testPass, 'x-replication-token': repToken },
    });
    assert(resBoth.status === 200, '6. Admin password with a token alongside still gets the bundle');

    // 6b. Password + 2FA.
    const totpSecret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret });
    resetAdminAuthTarpit();
    const resNoCode = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-admin-password': testPass, 'x-replication-token': repToken },
    });
    assert(resNoCode.status === 401 && resNoCode.body?.totpRequired === true, '6. With 2FA on, the password alone is refused (the token adds nothing)');
    resetAdminAuthTarpit();
    const res2fa = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-admin-password': testPass, 'x-admin-totp': generateTotpCode(totpSecret) },
    });
    assert(res2fa.status === 200 && res2fa.headers['content-type'] === 'application/gzip', `6. Password + 2FA code gets the bundle (got ${res2fa.status})`);

    // 6c. An owner's key session, and an admin's.
    const makeKeypair = () => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        return { privateKey, pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
    };
    const keySession = (kp: ReturnType<typeof makeKeypair>): string => {
        const chal = createAdminChallenge();
        const signature = crypto.sign(null, Buffer.from(chal.challenge, 'utf-8'), kp.privateKey).toString('hex');
        const solved = verifyAndSolveChallenge({
            challengeId: chal.challengeId, memberPubkey: kp.pubKeyHex, signature, totpCode: generateTotpCode(totpSecret),
        });
        if (!solved.ok) throw new Error('key sign-in failed: ' + solved.error);
        const ex = consumeHandshakeToken(solved.handshakeToken!);
        if (!ex.ok) throw new Error('handshake failed: ' + ex.error);
        return ex.sessionId!;
    };
    const owner = makeKeypair();
    const admin = makeKeypair();
    seedGenesisMember(owner.pubKeyHex, 'Olive');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?)`)
        .run(admin.pubKeyHex, 'Adam', new Date().toISOString(), owner.pubKeyHex, 'TEST');
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(admin.pubKeyHex);
    grantNodeRole(admin.pubKeyHex, 'admin', 'owner:password');
    for (const [kp, who] of [[owner, 'owner'], [admin, 'admin']] as const) {
        resetAdminAuthTarpit();
        const r = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
            headers: { 'x-admin-session': keySession(kp) },
        });
        assert(r.status === 200 && r.headers['content-type'] === 'application/gzip', `6. An ${who}'s key session gets the bundle (got ${r.status})`);
    }
    updateLocalConfig({ totpEnabled: false, totpSecret: null });
    await p2pNode.stop();

    console.log(`\n🎉 All ${testsPassed}/${testsRun} Backup Identity Bundle tests PASSED!\n`);
    process.exit(0);
}

runSuite().catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
