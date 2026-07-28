import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { attestOne, attestSweep } from '../src/index.js';
import * as db from '../src/db.js';
import { verifyEd25519, verifySignedRequest } from '../src/sign.js';

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
                        const [name, node_pubkey, hostname, mode, status, origin, public_ip, contact, requested_at] = boundArgs;
                        if (allocations.has(name) && allocations.get(name).status !== 'revoked') {
                            throw new Error('UNIQUE constraint failed: name_allocations.name');
                        }
                        allocations.set(name, {
                            name, node_pubkey, hostname, mode, status, origin, public_ip, contact,
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

async function makeSignedRequest(url, method, keyPair, pubHex, bodyObj = null, timestampOverride = null) {
    const ts = timestampOverride !== null ? String(timestampOverride) : String(Math.floor(Date.now() / 1000));
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

// ==========================================
// 1. INVITE RESOLUTION (/i/:code) EDGE CASES
// ==========================================

test('Adversarial /i/:code - Valid invites & node name lookup', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);
    const { pubHex } = await generateKeypair();

    await db.insertAllocation(env, {
        name: 'byron',
        node_pubkey: pubHex,
        hostname: 'byron.beanpool.org',
        mode: 'tunnel',
        status: 'live',
        requested_at: Math.floor(Date.now() / 1000)
    });
    await db.insertInvite(env, 'INV-BYRON-2026', 'byron');

    // Case 1: Invite lookup in DB
    const resInv = await worker.fetch(new Request('https://beanpool.org/i/INV-BYRON-2026', { method: 'GET' }), env);
    assert.equal(resInv.status, 200);
    assert.equal(resInv.headers.get('content-type'), 'text/html; charset=utf-8');
    const htmlInv = await resInv.text();
    assert.ok(htmlInv.includes('beanpool://join?node=byron.beanpool.org&code=INV-BYRON-2026'));

    // Case 2: Node name lookup in DB (uppercase in path)
    const resNode = await worker.fetch(new Request('https://beanpool.org/i/BYRON', { method: 'GET' }), env);
    assert.equal(resNode.status, 200);
    const htmlNode = await resNode.text();
    assert.ok(htmlNode.includes('beanpool://join?node=byron.beanpool.org&code=BYRON'));
});

test('Adversarial /i/:code - Query parameter ?n= override and edge cases', async () => {
    const env = mockEnv();

    // Query n with hostname
    const res1 = await worker.fetch(new Request('https://beanpool.org/i/anycode?n=sub.example.com', { method: 'GET' }), env);
    assert.equal(res1.status, 200);
    const html1 = await res1.text();
    assert.ok(html1.includes('beanpool://join?node=sub.example.com&code=anycode'));
    assert.ok(html1.includes('Community node: sub.example.com'));

    // Query n without dot (appends base domain)
    const res2 = await worker.fetch(new Request('https://beanpool.org/i/anycode?n=perth', { method: 'GET' }), env);
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.ok(html2.includes('beanpool://join?node=perth.beanpool.org&code=anycode'));

    // Query n with path/scheme (sanitized by regex replace /[^a-z0-9.\-]/gi)
    const res3 = await worker.fetch(new Request('https://beanpool.org/i/testcode?n=https://evil.com', { method: 'GET' }), env);
    assert.equal(res3.status, 200);
    const html3 = await res3.text();
    assert.ok(html3.includes('beanpool://join?node=httpsevil.com&code=testcode'));

});

test('Adversarial /i/:code - Unmapped code and revoked allocation lookup', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);
    const { pubHex } = await generateKeypair();

    // Insert revoked allocation
    await db.insertAllocation(env, {
        name: 'deadnode',
        node_pubkey: pubHex,
        hostname: 'deadnode.beanpool.org',
        mode: 'tunnel',
        status: 'revoked',
        requested_at: Math.floor(Date.now() / 1000)
    });

    // Lookup unmapped code
    const resUnmapped = await worker.fetch(new Request('https://beanpool.org/i/unknown-999', { method: 'GET' }), env);
    assert.equal(resUnmapped.status, 404);
    assert.equal(resUnmapped.headers.get('content-type'), 'text/html; charset=utf-8');
    const htmlUnmapped = await resUnmapped.text();
    assert.ok(htmlUnmapped.includes('Invite code not found'));

    // Direct lookup of revoked node name -> 404
    const resRevoked = await worker.fetch(new Request('https://beanpool.org/i/deadnode', { method: 'GET' }), env);
    assert.equal(resRevoked.status, 404);

    // Invite pointing to revoked node name -> 404 (allocation status is revoked)
    await db.insertInvite(env, 'INV-DEAD', 'deadnode');
    const resRevokedInvite = await worker.fetch(new Request('https://beanpool.org/i/INV-DEAD', { method: 'GET' }), env);
    assert.equal(resRevokedInvite.status, 404);
    const htmlRevokedInvite = await resRevokedInvite.text();
    assert.ok(htmlRevokedInvite.includes('Invite code not found'));
});

test('Adversarial /i/:code - Malformed code, URL encoding, and HTML escaping', async () => {
    const env = mockEnv();

    // URL encoded spaces and quotes
    const resEnc = await worker.fetch(new Request('https://beanpool.org/i/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E?n=safe.node.org', { method: 'GET' }), env);
    assert.equal(resEnc.status, 200);
    const htmlEnc = await resEnc.text();
    // Verify script tags are encoded and inside href attribute safely
    assert.ok(htmlEnc.includes('code=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'));
    assert.ok(!htmlEnc.includes('<script>alert(1)</script>'));
});

// ==========================================
// 2. ATTESTATION SWEEP & CLASSIFICATION
// ==========================================

test('Attestation Sweep - Solar node protection (unverified)', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);
    const { pubHex } = await generateKeypair();

    await db.insertAllocation(env, {
        name: 'solarnode',
        node_pubkey: pubHex,
        hostname: 'solarnode.beanpool.org',
        mode: 'tunnel',
        status: 'live',
        requested_at: Math.floor(Date.now() / 1000)
    });

    const alloc = await db.getAllocation(env, 'solarnode');
    const originalFetch = globalThis.fetch;

    try {
        // Scenario 1: Network connection error / DNS fail (fetch throws)
        globalThis.fetch = async () => { throw new Error('Fetch failed / Connection reset'); };
        const res1 = await attestOne(env, alloc);
        assert.equal(res1, 'unverified');

        // Scenario 2: HTTP 500, 502, 503, 504, 521, 522
        const errorStatuses = [500, 502, 503, 504, 404, 521, 522];
        for (const status of errorStatuses) {
            globalThis.fetch = async () => new Response(`Error ${status}`, { status });
            const resStatus = await attestOne(env, alloc);
            assert.equal(resStatus, 'unverified', `HTTP status ${status} should yield unverified`);
        }

        // Run sweep while unverified for multiple rounds
        for (let i = 0; i < 5; i++) {
            await attestSweep(env);
            const check = await db.getAllocation(env, 'solarnode');
            assert.equal(check.status, 'live');
            assert.equal(check.attest_fails, 0);
        }
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Attestation Sweep - Mismatch classification (abuse detection)', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);
    const { keyPair, pubHex } = await generateKeypair();

    await db.insertAllocation(env, {
        name: 'abusenode',
        node_pubkey: pubHex,
        hostname: 'abusenode.beanpool.org',
        mode: 'tunnel',
        status: 'live',
        requested_at: Math.floor(Date.now() / 1000)
    });

    const alloc = await db.getAllocation(env, 'abusenode');
    const originalFetch = globalThis.fetch;

    try {
        // Scenario 1: 200 OK with non-JSON HTML
        globalThis.fetch = async () => new Response('<html><body>Swapped Content</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
        });
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 2: 200 OK with JSON but wrong pubkey
        const { pubHex: wrongPubHex } = await generateKeypair();
        globalThis.fetch = async (url) => {
            const parsed = new URL(url);
            const nonce = parsed.searchParams.get('nonce');
            const ts = String(Math.floor(Date.now() / 1000));
            return new Response(JSON.stringify({
                pubkey: wrongPubHex,
                nonce,
                timestamp: ts,
                signature: '00'.repeat(64)
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 3: 200 OK with JSON but wrong nonce
        globalThis.fetch = async (url) => {
            const ts = String(Math.floor(Date.now() / 1000));
            return new Response(JSON.stringify({
                pubkey: pubHex,
                nonce: 'wrong-nonce-123',
                timestamp: ts,
                signature: '00'.repeat(64)
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 4: Expired timestamp (> 120s)
        globalThis.fetch = async (url) => {
            const parsed = new URL(url);
            const nonce = parsed.searchParams.get('nonce');
            const expiredTs = String(Math.floor(Date.now() / 1000) - 300);
            return new Response(JSON.stringify({
                pubkey: pubHex,
                nonce,
                timestamp: expiredTs,
                signature: '00'.repeat(64)
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 5: Future timestamp (> 120s)
        globalThis.fetch = async (url) => {
            const parsed = new URL(url);
            const nonce = parsed.searchParams.get('nonce');
            const futureTs = String(Math.floor(Date.now() / 1000) + 300);
            return new Response(JSON.stringify({
                pubkey: pubHex,
                nonce,
                timestamp: futureTs,
                signature: '00'.repeat(64)
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 6: Invalid Ed25519 signature
        globalThis.fetch = async (url) => {
            const parsed = new URL(url);
            const nonce = parsed.searchParams.get('nonce');
            const ts = String(Math.floor(Date.now() / 1000));
            return new Response(JSON.stringify({
                pubkey: pubHex,
                nonce,
                timestamp: ts,
                signature: 'ff'.repeat(64)
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'mismatch');

        // Scenario 7: Valid Ed25519 signature!
        globalThis.fetch = async (url) => {
            const parsed = new URL(url);
            const nonce = parsed.searchParams.get('nonce');
            const ts = String(Math.floor(Date.now() / 1000));
            const msg = `${nonce}\n${ts}`;
            const sigBuf = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(msg)));
            const sigHex = Array.from(sigBuf).map(b => b.toString(16).padStart(2, '0')).join('');
            return new Response(JSON.stringify({
                pubkey: pubHex,
                nonce,
                timestamp: ts,
                signature: sigHex
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        assert.equal(await attestOne(env, alloc), 'ok');

    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Attestation Sweep - Concurrency and batch processing', async () => {
    const d1 = createMockD1();
    const env = mockEnv(d1);
    const originalFetch = globalThis.fetch;

    // Create 25 live nodes
    for (let i = 1; i <= 25; i++) {
        const { pubHex } = await generateKeypair();
        await db.insertAllocation(env, {
            name: `node${i}`,
            node_pubkey: pubHex,
            hostname: `node${i}.beanpool.org`,
            mode: 'tunnel',
            status: 'live',
            requested_at: Math.floor(Date.now() / 1000)
        });
    }

    try {
        globalThis.fetch = async () => { throw new Error('offline'); };
        await attestSweep(env);

        const liveList = await db.listByStatus(env, 'live');
        assert.equal(liveList.length, 25);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// ==========================================
// 3. ED25519 SIGNATURE CHECKS & REQ AUTH
// ==========================================

test('Ed25519 - Invalid signatures and header formatting', async () => {
    const env = mockEnv();
    const { keyPair, pubHex } = await generateKeypair();

    // All zeros signature
    const reqZeroSig = new Request('https://beanpool.org/api/registrar/status', {
        method: 'GET',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-bp-signature': '00'.repeat(64)
        }
    });
    assert.equal((await worker.fetch(reqZeroSig, env)).status, 401);

    // Corrupted single hex byte
    const validReq = await makeSignedRequest('https://beanpool.org/api/registrar/status', 'GET', keyPair, pubHex);
    const validSig = validReq.headers.get('x-bp-signature');
    const badSig = validSig.substring(0, 10) + (validSig[10] === '0' ? '1' : '0') + validSig.substring(11);
    const reqCorrupt = new Request('https://beanpool.org/api/registrar/status', {
        method: 'GET',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': validReq.headers.get('x-bp-timestamp'),
            'x-bp-signature': badSig
        }
    });
    assert.equal((await worker.fetch(reqCorrupt, env)).status, 401);

    // Non-hex signature characters
    const reqNonHex = new Request('https://beanpool.org/api/registrar/status', {
        method: 'GET',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-bp-signature': 'z'.repeat(128)
        }
    });
    assert.equal((await worker.fetch(reqNonHex, env)).status, 401);
});

test('Ed25519 - Expired and future timestamps (Clock skew)', async () => {
    const env = mockEnv();
    const { keyPair, pubHex } = await generateKeypair();
    const now = Math.floor(Date.now() / 1000);

    // Past expired (> 300s)
    const reqExpired = await makeSignedRequest('https://beanpool.org/api/registrar/status', 'GET', keyPair, pubHex, null, now - 301);
    assert.equal((await worker.fetch(reqExpired, env)).status, 401);

    // Future expired (> 300s)
    const reqFuture = await makeSignedRequest('https://beanpool.org/api/registrar/status', 'GET', keyPair, pubHex, null, now + 301);
    assert.equal((await worker.fetch(reqFuture, env)).status, 401);

    // Valid edge (299s past)
    const reqValidPast = await makeSignedRequest('https://beanpool.org/api/registrar/status', 'GET', keyPair, pubHex, null, now - 299);
    assert.equal((await worker.fetch(reqValidPast, env)).status, 200);

    // Malformed non-numeric timestamp
    const reqMalformedTs = new Request('https://beanpool.org/api/registrar/status', {
        method: 'GET',
        headers: {
            'x-bp-pubkey': pubHex,
            'x-bp-timestamp': 'not-a-number',
            'x-bp-signature': '00'.repeat(64)
        }
    });
    assert.equal((await worker.fetch(reqMalformedTs, env)).status, 401);
});

test('Ed25519 - Body tampering and request mismatch', async () => {
    const env = mockEnv();
    const { keyPair, pubHex } = await generateKeypair();

    // Sign with body A, send body B
    const bodyA = { name: 'sydney', mode: 'tunnel' };
    const bodyB = { name: 'melbourne', mode: 'tunnel' };
    const reqBodyA = await makeSignedRequest('https://beanpool.org/api/registrar/claim', 'POST', keyPair, pubHex, bodyA);

    const tamperedReq = new Request('https://beanpool.org/api/registrar/claim', {
        method: 'POST',
        headers: reqBodyA.headers,
        body: JSON.stringify(bodyB)
    });
    assert.equal((await worker.fetch(tamperedReq, env)).status, 401);
});

test('Ed25519 - Mismatched pubkey in header vs signing key', async () => {
    const env = mockEnv();
    const { keyPair: keyPair1 } = await generateKeypair();
    const { pubHex: pubHex2 } = await generateKeypair();

    // Signed by KeyPair1, but header pubkey is PubHex2
    const req = await makeSignedRequest('https://beanpool.org/api/registrar/status', 'GET', keyPair1, pubHex2);
    assert.equal((await worker.fetch(req, env)).status, 401);
});
