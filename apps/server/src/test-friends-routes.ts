/**
 * Integration test coverage for friend routes:
 *   GET  /api/friends/:publicKey
 *   POST /api/friends/add
 *   POST /api/friends/remove
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8593;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

async function send(method: string, path: string, body?: unknown, signer?: Identity): Promise<{ status: number; body: any }> {
    const bodyString = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (bodyString !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString || ''}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let resBody: any = null;
    try { resBody = await res.json(); } catch { /* ignore non-json */ }
    return { status: res.status, body: resBody };
}

async function main() {
    console.log('Running friends routes integration tests...');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const alice = keypair();
    const bob = keypair();
    const stranger = keypair();

    seedGenesisMember(alice.pub, 'alice');
    seedGenesisMember(bob.pub, 'bob');

    // 1. GET /api/friends/:publicKey without signature -> 401 when ENFORCE_READ_AUTH is active
    const unauthGet = await send('GET', `/api/friends/${alice.pub}`);
    assert(unauthGet.status === 401, 'GET /api/friends/:publicKey without signature returns 401');

    // 2. GET /api/friends/:publicKey signed by member -> 200 with empty array
    const initialFriends = await send('GET', `/api/friends/${alice.pub}`, undefined, alice);
    assert(initialFriends.status === 200, 'GET /api/friends/:publicKey signed by member returns 200');
    assert(Array.isArray(initialFriends.body) && initialFriends.body.length === 0, 'GET /api/friends/:publicKey initially empty');

    // 3. POST /api/friends/add without signature -> 401
    const unauthAdd = await send('POST', '/api/friends/add', { ownerPubkey: alice.pub, friendPubkey: bob.pub });
    assert(unauthAdd.status === 401, 'POST /api/friends/add without signature returns 401');

    // 4. POST /api/friends/add with missing friendPubkey -> 400
    const missingFriendAdd = await send('POST', '/api/friends/add', {}, alice);
    assert(missingFriendAdd.status === 400, 'POST /api/friends/add missing friendPubkey returns 400');

    // 5. POST /api/friends/add for non-existent member -> 400
    const nonExistentAdd = await send('POST', '/api/friends/add', { friendPubkey: stranger.pub }, alice);
    assert(nonExistentAdd.status === 400, 'POST /api/friends/add for non-existent member returns 400');

    // 6. POST /api/friends/add signed by alice adding bob -> 200 success
    const validAdd = await send('POST', '/api/friends/add', { friendPubkey: bob.pub }, alice);
    assert(validAdd.status === 200 && validAdd.body.success === true, 'POST /api/friends/add valid request succeeds');
    assert(validAdd.body.friend && validAdd.body.friend.publicKey === bob.pub, 'POST /api/friends/add returns added friend entry with publicKey');

    // 7. GET /api/friends/:publicKey returns added friend
    const friendsAfterAdd = await send('GET', `/api/friends/${alice.pub}`, undefined, alice);
    assert(friendsAfterAdd.status === 200, 'GET /api/friends/:publicKey returns 200 after add');
    assert(Array.isArray(friendsAfterAdd.body) && friendsAfterAdd.body.length === 1, 'GET /api/friends/:publicKey contains 1 friend');
    assert(friendsAfterAdd.body[0].publicKey === bob.pub, 'Friend entry matches added friend public key');

    // 8. POST /api/friends/remove without signature -> 401
    const unauthRemove = await send('POST', '/api/friends/remove', { ownerPubkey: alice.pub, friendPubkey: bob.pub });
    assert(unauthRemove.status === 401, 'POST /api/friends/remove without signature returns 401');

    // 9. POST /api/friends/remove for non-existent friend relationship -> 400
    const nonExistentRemove = await send('POST', '/api/friends/remove', { friendPubkey: stranger.pub }, alice);
    assert(nonExistentRemove.status === 400, 'POST /api/friends/remove for non-existent friend relationship returns 400');

    // 10. POST /api/friends/remove signed by alice removing bob -> 200 success
    const validRemove = await send('POST', '/api/friends/remove', { friendPubkey: bob.pub }, alice);
    assert(validRemove.status === 200 && validRemove.body.success === true, 'POST /api/friends/remove valid request succeeds');

    // 11. GET /api/friends/:publicKey returns empty array after removal
    const friendsAfterRemove = await send('GET', `/api/friends/${alice.pub}`, undefined, alice);
    assert(friendsAfterRemove.status === 200, 'GET /api/friends/:publicKey returns 200 after remove');
    assert(Array.isArray(friendsAfterRemove.body) && friendsAfterRemove.body.length === 0, 'GET /api/friends/:publicKey empty after remove');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Friends routes integration checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
