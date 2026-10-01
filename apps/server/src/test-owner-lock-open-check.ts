/**
 * Integration test for POST /api/node/owner/lock-open-check (routes/owner-unlock.ts).
 *
 * Covers:
 *   1. Unsigned request -> 401 (Missing cryptographic signature headers)
 *   2. Signed request from non-owner member -> 403
 *   3. Invalid body keys/types or malformed envelopeId -> 400
 *   4. Stale/invalid timestamp -> 401
 *   5. Valid owner request -> 200, success: true, checkedAt, owner_lock_opens DB record written
 *   6. Repeat owner request -> 200, updates existing record (ON CONFLICT DO UPDATE)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-owner-lock-open-check.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { OWNER_LOCK_OPEN_CHECK_PATH } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

let PORT = 0;
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

interface Identity {
    pub: string;
    priv: crypto.KeyObject;
}

function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        priv: privateKey,
    };
}

function signText(who: Identity, text: string): string {
    return crypto.sign(null, Buffer.from(text), who.priv).toString('base64');
}

function seedMember(pk: string, callsign: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

async function makeRequest(method: 'POST', path: string, signer?: Identity, body?: unknown, ts = Date.now()) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (signer) {
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = signText(signer, `${method}\n${path}\n${ts}\n${nonce}\n${raw}`);
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : raw });
    let json: any = null;
    try {
        json = await res.json();
    } catch {
        /* ignore non-json */
    }
    return { status: res.status, body: json, headers: res.headers };
}

async function main() {
    console.log('Running test-owner-lock-open-check...\n');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const owner = keypair();
    const nonOwner = keypair();

    seedMember(owner.pub, 'OwnerUser');
    seedMember(nonOwner.pub, 'NonOwnerUser');

    grantNodeRole(owner.pub, 'owner');

    const validEnvelopeId = '0123456789abcdef0123456789abcdef';

    // 1. Unsigned request -> 401
    const resUnsigned = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, undefined, {
        envelopeId: validEnvelopeId,
        opened: true,
    });
    assert(resUnsigned.status === 401, 'Unsigned request returns 401');
    assert(
        resUnsigned.body?.error === 'Missing cryptographic signature headers',
        '401 has expected error message for missing signature',
    );

    // 2. Non-owner request -> 403
    const resNonOwner = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, nonOwner, {
        envelopeId: validEnvelopeId,
        opened: true,
    });
    assert(resNonOwner.status === 403, 'Non-owner request returns 403');
    assert(resNonOwner.body?.error === "Only this community's owners report on its lock.", '403 has expected error message');

    // 3. Invalid body schema / field formats -> 400
    const resExtraKey = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: validEnvelopeId,
        opened: true,
        extra: 'field',
    });
    assert(resExtraKey.status === 400, 'Body with extra keys returns 400');
    assert(resExtraKey.body?.error === 'Send only { "envelopeId": <32 hex>, "opened": true | false }.', '400 has schema error message');

    const resBadHex = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: 'not-32-hex-characters',
        opened: true,
    });
    assert(resBadHex.status === 400, 'Body with non-32-hex envelopeId returns 400');

    const resBadOpenedType = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: validEnvelopeId,
        opened: 'true',
    });
    assert(resBadOpenedType.status === 400, 'Body with non-boolean opened value returns 400');

    // 4. Stale/zero timestamp -> 401
    const resBadTs = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: validEnvelopeId,
        opened: true,
    }, 0);
    assert(resBadTs.status === 401, 'Request with zero timestamp returns 401 from signature freshness check');
    assert(
        resBadTs.body?.error === 'Request timestamp is stale or invalid',
        '401 has expected timestamp freshness error message',
    );

    // 5. Valid owner request -> 200, success: true, checkedAt, DB record written
    const now = Date.now();
    const resValid = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: validEnvelopeId,
        opened: true,
    }, now);

    assert(resValid.status === 200, 'Valid owner request returns 200');
    assert(resValid.body?.success === true, 'Response body contains success: true');
    assert(resValid.body?.checkedAt === now, 'Response body contains checkedAt matching payload timestamp');
    assert(resValid.headers.get('cache-control') === 'no-store', 'Cache-Control header is no-store');

    const row = db.prepare('SELECT member_pubkey, envelope_id, opened, checked_at FROM owner_lock_opens WHERE member_pubkey = ?').get(owner.pub) as any;
    assert(row != null, 'Database record created in owner_lock_opens');
    assert(row.member_pubkey === owner.pub, 'Record member_pubkey matches owner');
    assert(row.envelope_id === validEnvelopeId, 'Record envelope_id matches requested envelopeId');
    assert(row.opened === 1, 'Record opened is 1 (boolean true stored as integer)');
    assert(row.checked_at === now, 'Record checked_at matches requested timestamp');

    // 6. Repeat owner request -> updates existing DB record
    const newEnvelopeId = 'fedcba9876543210fedcba9876543210';
    const nextTs = now + 1000;
    const resUpdate = await makeRequest('POST', OWNER_LOCK_OPEN_CHECK_PATH, owner, {
        envelopeId: newEnvelopeId,
        opened: false,
    }, nextTs);

    assert(resUpdate.status === 200, 'Subsequent update request returns 200');
    assert(resUpdate.body?.checkedAt === nextTs, 'Response body contains updated checkedAt');

    const updatedRow = db.prepare('SELECT member_pubkey, envelope_id, opened, checked_at FROM owner_lock_opens WHERE member_pubkey = ?').get(owner.pub) as any;
    assert(updatedRow.envelope_id === newEnvelopeId, 'Database record updated envelope_id');
    assert(updatedRow.opened === 0, 'Database record updated opened to 0');
    assert(updatedRow.checked_at === nextTs, 'Database record updated checked_at');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM owner_lock_opens WHERE member_pubkey = ?').get(owner.pub) as any;
    assert(count.cnt === 1, 'Exactly 1 row exists for owner in owner_lock_opens');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ test-owner-lock-open-check PASSED.');
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
