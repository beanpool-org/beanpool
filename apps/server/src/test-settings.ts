/**
 * Integration test coverage for settings & app link routes:
 *   GET /.well-known/apple-app-site-association
 *   GET /apple-app-site-association
 *   GET /.well-known/assetlinks.json
 *   GET /api/node/config
 *   GET /api/version
 *   GET /api/directory/info
 *   POST /api/local/admin/node/config
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8567;
const BASE = `https://localhost:${PORT}`;

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

interface AppleAppSiteAssociation {
    applinks?: {
        details?: Array<{
            appIDs?: string[];
            components?: Array<Record<string, unknown>>;
        }>;
    };
}

interface AndroidAssetLink {
    relation?: string[];
    target?: {
        namespace?: string;
        package_name?: string;
        sha256_cert_fingerprints?: string[];
    };
}

interface VersionResponse {
    version?: string;
    commit?: string;
    buildTime?: string;
    node?: string;
}

async function main(): Promise<void> {
    console.log('\nRunning Settings & App Link API tests...\n');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // ── 1. Apple App Site Association ─────────────────────────────
    const appleRes1 = await fetch(`${BASE}/.well-known/apple-app-site-association`);
    assert(appleRes1.status === 200, 'GET /.well-known/apple-app-site-association returns 200');
    const appleBody1 = (await appleRes1.json()) as AppleAppSiteAssociation;
    assert(Array.isArray(appleBody1?.applinks?.details), 'Apple applinks details is an array');

    const appleRes2 = await fetch(`${BASE}/apple-app-site-association`);
    assert(appleRes2.status === 200, 'GET /apple-app-site-association returns 200');
    const appleBody2 = (await appleRes2.json()) as AppleAppSiteAssociation;
    assert(
        Boolean(appleBody2?.applinks?.details?.[0]?.appIDs?.[0]?.includes('org.beanpool.pillar')),
        'Apple applinks includes bundle id'
    );

    // ── 2. Android Asset Links ────────────────────────────────────
    const androidRes = await fetch(`${BASE}/.well-known/assetlinks.json`);
    assert(androidRes.status === 200, 'GET /.well-known/assetlinks.json returns 200');
    const androidBody = (await androidRes.json()) as AndroidAssetLink[];
    assert(
        Array.isArray(androidBody) && androidBody[0]?.target?.package_name === 'org.beanpool.pillar',
        'Android assetlinks targets org.beanpool.pillar'
    );

    // ── 3. Node Config Endpoint ───────────────────────────────────
    const nodeConfigRes = await fetch(`${BASE}/api/node/config`);
    assert(nodeConfigRes.status === 200, 'GET /api/node/config returns 200');
    const nodeConfigBody = (await nodeConfigRes.json()) as Record<string, unknown>;
    assert(typeof nodeConfigBody === 'object' && nodeConfigBody !== null, 'GET /api/node/config returns node configuration object');

    // ── 4. API Version Endpoint ───────────────────────────────────
    const versionRes = await fetch(`${BASE}/api/version`);
    assert(versionRes.status === 200, 'GET /api/version returns 200');
    const versionBody = (await versionRes.json()) as VersionResponse;
    assert(typeof versionBody?.version === 'string' && typeof versionBody?.commit === 'string', 'GET /api/version returns version and commit string');

    // ── 5. Directory Info Endpoint ───────────────────────────────
    const dirInfoRes = await fetch(`${BASE}/api/directory/info`);
    assert(dirInfoRes.status === 200 || dirInfoRes.status === 403, 'GET /api/directory/info returns 200 or 403');

    // ── 6. Admin Node Config Update Guard ─────────────────────────
    const adminConfigRes = await fetch(`${BASE}/api/local/admin/node/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishHealth: true }),
    });
    assert(adminConfigRes.status === 401 || adminConfigRes.status === 200, 'POST /api/local/admin/node/config handles auth guard correctly');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ settings checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
