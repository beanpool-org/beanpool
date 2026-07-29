import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestOne, attestSweep } from '../src/index.js';
import * as db from '../src/db.js';

function createMockD1() {
    const allocations = new Map();
    const policies = new Map([
        ['www', 'blocked'], ['api', 'blocked'], ['admin', 'blocked'],
        ['sydney', 'gated'], ['melbourne', 'gated'], ['cairns', 'gated']
    ]);
    const invites = new Map();

    return {
        prepare(sql) {
            let boundArgs = [];
            return {
                bind(...args) {
                    boundArgs = args;
                    return this;
                },
                async first() {
                    if (sql.includes('FROM name_allocations WHERE name=?')) {
                        return allocations.get(boundArgs[0]) || null;
                    }
                    if (sql.includes('FROM name_allocations WHERE node_pubkey=?')) {
                        const [pubkey] = boundArgs;
                        const list = Array.from(allocations.values()).filter(a => a.node_pubkey === pubkey && ['pending', 'live'].includes(a.status));
                        list.sort((a, b) => (b.requested_at || 0) - (a.requested_at || 0));
                        return list[0] || null;
                    }
                    if (sql.includes('FROM name_policy WHERE pattern=?')) {
                        const tier = policies.get(boundArgs[0]);
                        return tier ? { tier } : null;
                    }
                    if (sql.includes('FROM invites WHERE code=?')) {
                        return invites.get(boundArgs[0]) || null;
                    }
                    return null;
                },
                async all() {
                    if (sql.includes('FROM name_allocations WHERE status=?')) {
                        const [st] = boundArgs;
                        const results = Array.from(allocations.values()).filter(a => a.status === st);
                        return { results };
                    }
                    if (sql.includes('FROM name_allocations WHERE status IN')) {
                        const results = Array.from(allocations.values()).filter(a => ['pending', 'live'].includes(a.status));
                        results.sort((a, b) => (b.requested_at || 0) - (a.requested_at || 0));
                        return { results };
                    }
                    return { results: [] };
                },
                async run() {
                    if (sql.startsWith('INSERT INTO name_allocations')) {
                        const [name, node_pubkey, hostname, mode, status, community_name, origin, public_ip, contact, requested_at] = boundArgs;
                        if (allocations.has(name) && allocations.get(name).status !== 'revoked') {
                            throw new Error('UNIQUE constraint failed: name_allocations.name');
                        }
                        allocations.set(name, {
                            name, node_pubkey, hostname, mode, status, community_name, origin, public_ip, contact,
                            attest_fails: 0, requested_at, last_attest_at: null, decided_at: null, decided_by: null
                        });
                        return { success: true };
                    }
                    if (sql.startsWith('UPDATE name_allocations SET')) {
                        const name = boundArgs[boundArgs.length - 1];
                        const alloc = allocations.get(name);
                        if (!alloc) return { success: false };
                        const setMatch = sql.match(/SET (.*?) WHERE/);
                        if (setMatch) {
                            const setParts = setMatch[1].split(',').map(s => s.trim().split('=')[0].trim());
                            setParts.forEach((col, idx) => {
                                alloc[col] = boundArgs[idx];
                            });
                        }
                        return { success: true };
                    }
                    if (sql.startsWith('DELETE FROM name_allocations')) {
                        allocations.delete(boundArgs[0]);
                        return { success: true };
                    }
                    if (sql.startsWith('INSERT INTO invites')) {
                        const [code, node_name, created_at] = boundArgs;
                        invites.set(code, { code, node_name, created_at });
                        return { success: true };
                    }
                    return { success: true };
                }
            };
        }
    };
}

function mockEnv(dbInstance) {
    return {
        BASE_DOMAIN: 'beanpool.org',
        ATTEST_FAIL_LIMIT: '2',
        ADMIN_SECRET: 'test-admin-secret',
        DB: dbInstance || createMockD1()
    };
}

async function generateKeypair() {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const pubHex = Array.from(rawPub).map(b => b.toString(16).padStart(2, '0')).join('');
    return { keyPair, pubHex };
}

async function makeSignedRequest(url, method, keyPair, pubHex, bodyObj = null) {
    const ts = String(Math.floor(Date.now() / 1000));
    const bodyText = bodyObj ? JSON.stringify(bodyObj) : '';
    const parsedUrl = new URL(url);
    const message = `${method}\n${parsedUrl.pathname}\n${ts}\n${bodyText}`;
    const sigArray = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(message)));
    const sigHex = Array.from(sigArray).map(b => b.toString(16).padStart(2, '0')).join('');

    return new Request(url, {
        method,
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': ts,
            'x-bp-signature': sigHex,
            'content-type': 'application/json'
        },
        body: bodyText || undefined
    });
}

test('R1: GET /api/registrar/health returns status ok', async () => {
    const env = mockEnv();
    const req = new Request('https://beanpool.org/api/registrar/health', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ok' });
});

test('Ed25519 Signature Verification: claim and status endpoints', async () => {
    const env = mockEnv();
    const { keyPair, pubHex } = await generateKeypair();

    // 1. Valid signature on /claim
    const validClaimReq = await makeSignedRequest(
        'https://beanpool.org/api/registrar/claim',
        'POST', keyPair, pubHex, { name: 'sydney', mode: 'tunnel' }
    );
    const claimRes = await worker.fetch(validClaimReq, env);
    assert.equal(claimRes.status, 200);
    const claimBody = await claimRes.json();
    assert.equal(claimBody.status, 'pending');
    assert.equal(claimBody.hostname, 'sydney.beanpool.org');

    // 2. Invalid signature on /claim -> 401 bad signature
    const invalidClaimReq = new Request('https://beanpool.org/api/registrar/claim', {
        method: 'POST',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-bp-signature': '00'.repeat(64),
            'content-type': 'application/json'
        },
        body: JSON.stringify({ name: 'sydney', mode: 'tunnel' })
    });
    const badClaimRes = await worker.fetch(invalidClaimReq, env);
    assert.equal(badClaimRes.status, 401);
    const badClaimBody = await badClaimRes.json();
    assert.equal(badClaimBody.error, 'bad signature');

    // 3. Valid signature on /status
    const validStatusReq = await makeSignedRequest(
        'https://beanpool.org/api/registrar/status',
        'GET', keyPair, pubHex
    );
    const statusRes = await worker.fetch(validStatusReq, env);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.status, 'pending');
    assert.equal(statusBody.name, 'sydney');

    // 4. Invalid signature on /status -> 401 bad signature
    const invalidStatusReq = new Request('https://beanpool.org/api/registrar/status', {
        method: 'GET',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-bp-signature': 'ff'.repeat(64)
        }
    });
    const badStatusRes = await worker.fetch(invalidStatusReq, env);
    assert.equal(badStatusRes.status, 401);
});

test('R2: /i/:code Invite resolution and deep-linking response', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);

    // Seed an allocation and an invite
    const { pubHex } = await generateKeypair();
    await db.insertAllocation(env, {
        name: 'mullum',
        node_pubkey: pubHex,
        hostname: 'mullum.beanpool.org',
        mode: 'tunnel',
        status: 'live',
        requested_at: Math.floor(Date.now() / 1000)
    });
    await db.insertInvite(env, 'INV-1234-5678', 'mullum');

    // Case 1: Query param ?n= provided
    const reqWithN = new Request('https://beanpool.org/i/cairns?n=cairns', { method: 'GET' });
    const resN = await worker.fetch(reqWithN, env);
    assert.equal(resN.status, 200);
    const htmlN = await resN.text();
    assert.ok(htmlN.includes('beanpool://join?node=cairns.beanpool.org&code=cairns'));
    assert.ok(htmlN.includes('Community node: cairns.beanpool.org'));
    assert.ok(htmlN.includes('apps.apple.com/app/beanpool'));
    assert.ok(htmlN.includes('play.google.com/store/apps/details?id=org.beanpool'));

    // Case 2: D1 invite lookup match
    const reqInvite = new Request('https://beanpool.org/i/INV-1234-5678', { method: 'GET' });
    const resInvite = await worker.fetch(reqInvite, env);
    assert.equal(resInvite.status, 200);
    const htmlInvite = await resInvite.text();
    assert.ok(htmlInvite.includes('beanpool://join?node=mullum.beanpool.org&code=INV-1234-5678'));
    assert.ok(htmlInvite.includes('Community node: mullum.beanpool.org'));

    // Case 3: Allocation lookup directly by node name code
    const reqAlloc = new Request('https://beanpool.org/i/mullum', { method: 'GET' });
    const resAlloc = await worker.fetch(reqAlloc, env);
    assert.equal(resAlloc.status, 200);
    const htmlAlloc = await resAlloc.text();
    assert.ok(htmlAlloc.includes('beanpool://join?node=mullum.beanpool.org&code=mullum'));

    // Case 4: Invalid/unmapped code without ?n= -> 404 Error Page
    const reqBad = new Request('https://beanpool.org/i/unmapped-code-999', { method: 'GET' });
    const resBad = await worker.fetch(reqBad, env);
    assert.equal(resBad.status, 404);
    const htmlBad = await resBad.text();
    assert.ok(htmlBad.includes('Invite code not found'));
});

test('Attestation sweep logic: mismatch revokes vs unverified preserves', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);

    const { pubHex } = await generateKeypair();
    await db.insertAllocation(env, {
        name: 'testnode',
        node_pubkey: pubHex,
        hostname: 'testnode.beanpool.org',
        mode: 'tunnel',
        status: 'live',
        requested_at: Math.floor(Date.now() / 1000)
    });

    const alloc = await db.getAllocation(env, 'testnode');

    // 1. Mock fetch returns unverified (network error / 503)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('Service Unavailable', { status: 503 });

    try {
        const resultUnverified = await attestOne(env, alloc);
        assert.equal(resultUnverified, 'unverified');

        // Run sweep — should preserve status as 'live' and not increment attest_fails
        await attestSweep(env);
        const checkUnverified = await db.getAllocation(env, 'testnode');
        assert.equal(checkUnverified.status, 'live');
        assert.equal(checkUnverified.attest_fails, 0);

        // 2. Mock fetch returns mismatch (200 OK but wrong JSON/signature)
        globalThis.fetch = async () => new Response(JSON.stringify({ pubkey: 'wrong', nonce: 'bad' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });

        const resultMismatch = await attestOne(env, alloc);
        assert.equal(resultMismatch, 'mismatch');

        // First sweep: attest_fails becomes 1
        await attestSweep(env);
        const checkMismatch1 = await db.getAllocation(env, 'testnode');
        assert.equal(checkMismatch1.status, 'live');
        assert.equal(checkMismatch1.attest_fails, 1);

        // Second sweep: attest_fails reaches limit (2) -> auto-revoked
        await attestSweep(env);
        const checkMismatch2 = await db.getAllocation(env, 'testnode');
        assert.equal(checkMismatch2.status, 'revoked');
        assert.equal(checkMismatch2.attest_fails, 2);

    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Metadata: claim with community_name and update via signed POST /api/registrar/update', async () => {
    const env = mockEnv();
    const { keyPair, pubHex } = await generateKeypair();

    // 1. Claim with community_name & contact
    const claimReq = await makeSignedRequest(
        'https://beanpool.org/api/registrar/claim',
        'POST', keyPair, pubHex, {
            name: 'cairns',
            mode: 'tunnel',
            community_name: 'Cairns Solar Grid',
            contact: 'cairns@beanpool.org'
        }
    );
    const claimRes = await worker.fetch(claimReq, env);
    assert.equal(claimRes.status, 200);

    // Verify stored in D1
    const alloc1 = await db.getAllocation(env, 'cairns');
    assert.equal(alloc1.community_name, 'Cairns Solar Grid');
    assert.equal(alloc1.contact, 'cairns@beanpool.org');

    // 2. Signed metadata update via /api/registrar/update using camelCase communityName
    const updateReq = await makeSignedRequest(
        'https://beanpool.org/api/registrar/update',
        'POST', keyPair, pubHex, {
            communityName: 'Cairns Eco Village',
            contact: 'admin@cairnseca.org'
        }
    );
    const updateRes = await worker.fetch(updateReq, env);
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.status, 'ok');

    // Verify updated values in D1
    const alloc2 = await db.getAllocation(env, 'cairns');
    assert.equal(alloc2.community_name, 'Cairns Eco Village');
    assert.equal(alloc2.contact, 'admin@cairnseca.org');

    // 3. Clear contact by passing empty string
    const clearReq = await makeSignedRequest(
        'https://beanpool.org/api/registrar/update',
        'POST', keyPair, pubHex, {
            contact: ''
        }
    );
    const clearRes = await worker.fetch(clearReq, env);
    assert.equal(clearRes.status, 200);
    const alloc3 = await db.getAllocation(env, 'cairns');
    assert.equal(alloc3.community_name, 'Cairns Eco Village');
    assert.equal(alloc3.contact, null);
});
