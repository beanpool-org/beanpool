/**
 * Integration test coverage for push notification tokens and notification preferences HTTP routes:
 *   POST /api/push-tokens
 *   DELETE /api/push-tokens
 *   GET /api/members/preferences
 *   POST /api/members/preferences
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8563;
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

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
const CALLSIGN = `prefuser-${pubKeyHex.slice(0, 6)}`;

async function signedFetch(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const bodyString = method === 'GET' || method === 'HEAD' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const pathname = path.split('?')[0];
    const canonical = `${method}\n${pathname}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const fetchOptions: RequestInit = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = bodyString;
    }
    const res = await fetch(`${BASE}${path}`, fetchOptions);
    let parsed: any;
    try {
        parsed = await res.json();
    } catch {
        parsed = undefined;
    }
    return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
    console.log('\nRunning Push Tokens & Member Preferences API tests...\n');

    await initTls();
    initStateEngine();

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubKeyHex, CALLSIGN);

    await startHttpsServer(PORT);

    // ── 0. Unsigned Request Guard Verification ──────────────────────────────────
    const unsignedRes = await fetch(`${BASE}/api/push-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: pubKeyHex, token: 'someToken' }),
    });
    assert(unsignedRes.status === 401, 'Unsigned POST /api/push-tokens is rejected with 401');

    // ── 1. Push Tokens Registration & Deletion Validation ─────────────────────────
    const invalidPushReg = await signedFetch('POST', '/api/push-tokens', { publicKey: pubKeyHex });
    assert(invalidPushReg.status === 400, 'POST /api/push-tokens rejects missing token with 400');

    const validPushReg = await signedFetch('POST', '/api/push-tokens', {
        publicKey: pubKeyHex,
        token: 'ExponentPushToken[xyz123]',
        platform: 'ios',
    });
    assert(validPushReg.status === 200 && validPushReg.body?.success === true, 'POST /api/push-tokens registers push token successfully');

    const invalidPushDel = await signedFetch('DELETE', '/api/push-tokens', {});
    assert(invalidPushDel.status === 400, 'DELETE /api/push-tokens rejects missing publicKey with 400');

    const validPushDel = await signedFetch('DELETE', '/api/push-tokens', {
        publicKey: pubKeyHex,
        token: 'ExponentPushToken[xyz123]',
    });
    assert(validPushDel.status === 200 && validPushDel.body?.success === true, 'DELETE /api/push-tokens removes push token successfully');

    // ── 2. Member Preferences GET & POST Validation ─────────────────────────────
    const missingGetPref = await signedFetch('GET', '/api/members/preferences');
    assert(missingGetPref.status === 400, 'GET /api/members/preferences rejects missing publicKey query param with 400');

    const validGetPref = await signedFetch('GET', `/api/members/preferences?publicKey=${pubKeyHex}`);
    const defaultPrefBody = validGetPref.body;
    assert(validGetPref.status === 200 && typeof defaultPrefBody === 'object', 'GET /api/members/preferences fetches default member preferences');

    const invalidPostPref = await signedFetch('POST', '/api/members/preferences', { publicKey: pubKeyHex });
    assert(invalidPostPref.status === 400, 'POST /api/members/preferences rejects missing preferences body with 400');

    const newPreferences = {
        notify_chat: false,
        notify_marketplace: true,
        notify_escrow: false,
    };
    const validPostPref = await signedFetch('POST', '/api/members/preferences', {
        publicKey: pubKeyHex,
        preferences: newPreferences,
    });
    assert(validPostPref.status === 200 && validPostPref.body?.success === true, 'POST /api/members/preferences updates member preferences successfully');

    const verifyUpdatedPref = await signedFetch('GET', `/api/members/preferences?publicKey=${pubKeyHex}`);
    const updatedPrefBody = verifyUpdatedPref.body;
    assert(verifyUpdatedPref.status === 200 && updatedPrefBody?.notify_chat === 'false' && updatedPrefBody?.notify_escrow === 'false', 'GET /api/members/preferences confirms updated preferences saved');

    // ── 3. Read Auth Member Isolation Tests ─────────────────────────────────────
    const victimKeyPair = crypto.generateKeyPairSync('ed25519');
    const victimPubHex = (victimKeyPair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'victim', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(victimPubHex);

    // Test that when ENFORCE_READ_AUTH is active via signedFetch, querying another member's preferences or invites returns 403.
    const otherMemberPref = await signedFetch('GET', `/api/members/preferences?publicKey=${victimPubHex}`);
    const otherMemberInvites = await signedFetch('GET', `/api/invite/mine/${victimPubHex}`);
    if (process.env.ENFORCE_READ_AUTH === 'true') {
        assert(otherMemberPref.status === 403, 'GET /api/members/preferences for another user returns 403 under ENFORCE_READ_AUTH');
        assert(otherMemberInvites.status === 403, 'GET /api/invite/mine/:publicKey for another user returns 403 under ENFORCE_READ_AUTH');
    }

    // Test signed fetch for own preferences / invites:
    const ownPref = await signedFetch('GET', `/api/members/preferences?publicKey=${pubKeyHex}`);
    assert(ownPref.status === 200, 'GET /api/members/preferences for own publicKey succeeds');

    const ownInvites = await signedFetch('GET', `/api/invite/mine/${pubKeyHex}`);
    assert(ownInvites.status === 200, 'GET /api/invite/mine/:publicKey for own publicKey succeeds');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ push-preferences checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
