#!/usr/bin/env node
// Standalone auth-boundary verifier for the requireSignature middleware.
//
// Posts to every supposedly-protected route on a running BeanPool node
// and asserts the middleware rejects the request before it reaches the
// handler. If any boundary check fails, this script exits non-zero.
//
// Usage:
//   node scripts/verify-auth-boundary.mjs                       # https://localhost:8443
//   node scripts/verify-auth-boundary.mjs https://my-node:8443
//
// Run this against a fresh node after every change to the requireSignature
// middleware. It is the structural guarantee that the next forgotten route
// can't slip through silently.

import crypto from 'node:crypto';
import https from 'node:https';

const TARGET = process.argv[2] ?? 'https://localhost:8443';

// Accept self-signed certs (default in dev). For production verification
// against a Let's Encrypt node, remove this agent override.
const agent = new https.Agent({ rejectUnauthorized: false });

// Every route in this list MUST require a valid signature. If any returns
// anything other than 401 (no headers) or 403 (bad sig), the boundary is
// broken for that route.
const PROTECTED_ROUTES = [
    '/api/profile/update',
    '/api/ledger/transfer',
    '/api/marketplace/posts',
    '/api/marketplace/posts/remove',
    '/api/marketplace/posts/update',
    '/api/marketplace/posts/accept',
    '/api/marketplace/posts/request',
    '/api/marketplace/posts/pause',
    '/api/marketplace/posts/resume',
    '/api/marketplace/transactions/approve',
    '/api/marketplace/transactions/reject',
    '/api/marketplace/transactions/cancel-request',
    '/api/marketplace/transactions/complete',
    '/api/marketplace/transactions/cancel',
    '/api/messages/conversation',
    '/api/messages/send',
    '/api/messages/mark-read',
    '/api/commons/projects',
    '/api/commons/projects/update',
    '/api/commons/projects/delete',
    '/api/commons/vote',
    '/api/crowdfund/projects',
    '/api/crowdfund/projects/update',
    '/api/crowdfund/projects/delete',
    '/api/crowdfund/projects/test-id/pledge',
    '/api/invite/generate',
    '/api/community/register',
    '/api/ratings',
    '/api/reports',
    '/api/friends/add',
    '/api/friends/remove',
    '/api/friends/guardian',
    '/api/recovery/request',
    '/api/recovery/approve',
    '/api/recovery/reject',
    '/api/recovery/cancel',
    '/api/push-tokens',
    '/api/members/preferences',
];

// Routes that are deliberately public (no signature required). The script
// does NOT POST to these — listed here for documentation only.
const PUBLIC_POST_ROUTES = [
    '/api/invite/redeem',
    '/api/invite/redeem-offline',
    // /api/local/* and /api/admin/* are password-gated separately.
];

function post(url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            agent,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function rawPubHex(publicKey) {
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

async function testUnsigned(route) {
    const res = await post(`${TARGET}${route}`, {}, JSON.stringify({}));
    return { route, test: 'unsigned', status: res.status, pass: res.status === 401 };
}

async function testWrongKeySig(route) {
    // Sign with key B but present key A's pubkey in the header. Signature
    // verification must fail at the middleware level → 403.
    const { publicKey: pubA } = crypto.generateKeyPairSync('ed25519');
    const { privateKey: privB } = crypto.generateKeyPairSync('ed25519');
    const body = JSON.stringify({});
    const sig = crypto.sign(null, Buffer.from(body), privB).toString('base64');
    const res = await post(`${TARGET}${route}`, {
        'X-Public-Key': rawPubHex(pubA),
        'X-Signature': sig,
    }, body);
    return { route, test: 'wrong-key', status: res.status, pass: res.status === 403 };
}

async function testSpoofedBody(route) {
    // Valid signature, but the body claims a different publicKey than the
    // signing key. The middleware's spoof-check must catch this → 403.
    const { publicKey: pubA, privateKey: privA } = crypto.generateKeyPairSync('ed25519');
    const { publicKey: pubB } = crypto.generateKeyPairSync('ed25519');
    const body = JSON.stringify({ publicKey: rawPubHex(pubB) });
    const sig = crypto.sign(null, Buffer.from(body), privA).toString('base64');
    const res = await post(`${TARGET}${route}`, {
        'X-Public-Key': rawPubHex(pubA),
        'X-Signature': sig,
    }, body);
    return { route, test: 'spoofed-body', status: res.status, pass: res.status === 403 };
}

async function main() {
    console.log(`Verifying auth boundary against ${TARGET}`);
    console.log(`${PROTECTED_ROUTES.length} routes, 3 tests each = ${PROTECTED_ROUTES.length * 3} total checks\n`);

    let pass = 0;
    let fail = 0;
    const failures = [];

    for (const route of PROTECTED_ROUTES) {
        const results = await Promise.all([
            testUnsigned(route),
            testWrongKeySig(route),
            testSpoofedBody(route),
        ]);
        for (const r of results) {
            const mark = r.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
            const expected = r.test === 'unsigned' ? '401' : '403';
            console.log(`${mark} ${r.route.padEnd(50)} [${r.test.padEnd(13)}] → ${r.status} (expected ${expected})`);
            if (r.pass) pass++;
            else { fail++; failures.push(r); }
        }
    }

    console.log(`\n${pass} passed, ${fail} failed.`);
    if (fail > 0) {
        console.log('\nFailures indicate a route is not actually protected by the requireSignature middleware:');
        for (const f of failures) {
            console.log(`  - ${f.route} [${f.test}] returned ${f.status}`);
        }
        process.exit(1);
    }
    console.log('\nBoundary holds. All protected routes correctly reject unsigned/forged/spoofed requests.');
}

main().catch((e) => {
    console.error('\nScript crashed (is the server running on', TARGET, '?):');
    console.error(e.message);
    process.exit(2);
});
