/**
 * Test Suite: Backup Identity Bundle Endpoint
 *
 * Verifies POST /api/local/admin/identity-bundle in apps/server/src/routes/backup.ts:
 * 1. Unauthenticated request is rejected with HTTP 401.
 * 2. Request when required identity files (genesis.json / community.key) are missing returns 503.
 * 3. Request with valid admin password when identity files exist returns 200, application/gzip,
 *    and X-Identity-Files header containing collected file names.
 * 4. Request with valid X-Replication-Token header succeeds with 200.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-backup-identity-bundle.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { initStateEngine } from './state-engine.js';
import { createBackupRoutes } from './routes/backup.js';
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

    // 4. Request with valid replication token -> 200
    const repToken = 'rep-token-secret-999';
    setReplicationToken(repToken);

    resetAdminAuthTarpit();
    const resToken = await callRouter(router, 'POST', '/api/local/admin/identity-bundle', {
        headers: { 'x-replication-token': repToken },
    });
    assert(resToken.status === 200, '4. Request with valid x-replication-token returns 200');
    assert(resToken.headers['content-type'] === 'application/gzip', '4. Replication token response is application/gzip');

    console.log(`\n🎉 All ${testsPassed}/${testsRun} Backup Identity Bundle tests PASSED!\n`);
    process.exit(0);
}

runSuite().catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
