/**
 * Integration test coverage for friend routes:
 *   GET  /api/friends/:publicKey
 *   POST /api/friends/add
 *   POST /api/friends/remove
 *
 * A member's friends list is theirs alone (12–14), whatever ENFORCE_READ_AUTH says: read signed by the member whose
 * key is in the path, it is served; read by anyone else (another member, an admin, the owner, a visitor, a key with no
 * row) it is refused with one answer whatever key is named, so a refusal tells nothing about whether that key is a
 * member or has friends; unsigned, 401. Nobody adds to or removes from someone else's list.
 *
 * Run (read auth on, the default; the opt-out is a second registered run):
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-friends-routes.ts
 *   ENFORCE_READ_AUTH=false BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-friends-routes.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';

const READ_AUTH = process.env.ENFORCE_READ_AUTH !== 'false';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

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

function signedHeaders(method: string, path: string, signer: Identity, bodyString = ''): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
    return {
        'X-Public-Key': signer.pub,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function send(method: string, path: string, body?: unknown, signer?: Identity): Promise<{ status: number; body: any }> {
    const bodyString = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (bodyString !== undefined) {
        headers['Content-Type'] = 'application/json';
    }
    if (signer) Object.assign(headers, signedHeaders(method, path, signer, bodyString || ''));
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    let resBody: any = null;
    try { resBody = await res.json(); } catch { /* ignore non-json */ }
    return { status: res.status, body: resBody };
}

async function main() {
    console.log('Running friends routes integration tests...');

    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    const alice = keypair();
    const bob = keypair();
    const stranger = keypair();

    seedGenesisMember(alice.pub, 'alice');
    seedGenesisMember(bob.pub, 'bob');

    console.log(`(read auth ${READ_AUTH ? 'on' : 'opted out'})`);

    // 1. GET /api/friends/:publicKey without signature -> 401, under read auth and under the opt-out
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

    // 12. Own list only. Alice (an owner, from genesis) has Bob on her list again; Carol is a plain member, Amy an admin,
    // Bob the other owner, Dora a member with no friends, Vic a visitor, and the stranger has no row at all.
    const carol = keypair(), amy = keypair(), dora = keypair(), vic = keypair();
    const row = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                            VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis', ?)`);
    row.run(carol.pub, 'carol', 0);
    row.run(amy.pub, 'amy', 0);
    row.run(dora.pub, 'dora', 0);
    row.run(vic.pub, 'vic', 1);
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', ?)`).run(amy.pub, alice.pub);
    const readded = await send('POST', '/api/friends/add', { friendPubkey: bob.pub }, alice);
    assert(readded.status === 200, `Alice adds Bob again (${readded.status})`);
    const listOf = (owner: string) => (db.prepare('SELECT friend_pubkey FROM friends WHERE owner_pubkey = ? ORDER BY friend_pubkey').all(owner) as { friend_pubkey: string }[]).map(r => r.friend_pubkey).join(',');
    const show = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)}`;

    const own = await send('GET', `/api/friends/${alice.pub}`, undefined, alice);
    assert(own.status === 200 && Array.isArray(own.body) && own.body.length === 1 && own.body[0].publicKey === bob.pub,
        `12a. Alice reads her own list: Bob (${show(own)})`);

    // The answer to a key nobody here holds is the measure: every other key is answered exactly the same.
    const unknownKey = crypto.randomBytes(32).toString('hex');
    const unknown = await send('GET', `/api/friends/${unknownKey}`, undefined, carol);
    assert(unknown.status === 403 && !Array.isArray(unknown.body),
        `12b. Carol asking for a key nobody holds is refused 403 (${show(unknown)})`);
    const readers: Array<[string, Identity]> = [['Carol, a member', carol], ['Amy, an admin', amy], ['Bob, an owner and on the list', bob]];
    const targets: Array<[string, string]> = [
        ['Alice (has a friend)', alice.pub],
        ['Dora (a member with no friends)', dora.pub],
        ['a key nobody holds', unknownKey],
        ['Alice\'s key in capitals', alice.pub.toUpperCase()],
    ];
    for (const [who, reader] of readers) {
        for (const [whose, key] of targets) {
            const r = await send('GET', `/api/friends/${key}`, undefined, reader);
            assert(r.status === unknown.status && JSON.stringify(r.body) === JSON.stringify(unknown.body),
                `12c. ${who} reading ${whose}'s list gets the unknown key's answer (${show(r)})`);
        }
    }
    // A HEAD is answered by the GET handler: refused the same, its length no different from an unknown key's.
    const headAlice = await fetch(`${BASE}/api/friends/${alice.pub}`, { method: 'HEAD', headers: signedHeaders('HEAD', `/api/friends/${alice.pub}`, carol) });
    const headUnknown = await fetch(`${BASE}/api/friends/${unknownKey}`, { method: 'HEAD', headers: signedHeaders('HEAD', `/api/friends/${unknownKey}`, carol) });
    assert(headAlice.status === 403 && headAlice.status === headUnknown.status
        && headAlice.headers.get('content-length') === headUnknown.headers.get('content-length'),
        `12d. a HEAD of Alice's list by Carol answers as for an unknown key (${headAlice.status}/${headAlice.headers.get('content-length')} vs ${headUnknown.status}/${headUnknown.headers.get('content-length')})`);

    // A visitor and a key with no row: refused (by the read gate under read auth, by the route under the opt-out), and
    // the same answer for Alice's key as for one nobody holds.
    for (const [who, reader] of [['Vic, a visitor', vic], ['a key with no row', stranger]] as Array<[string, Identity]>) {
        const a = await send('GET', `/api/friends/${alice.pub}`, undefined, reader);
        const u = await send('GET', `/api/friends/${unknownKey}`, undefined, reader);
        assert(a.status >= 400 && !Array.isArray(a.body) && a.status === u.status && JSON.stringify(a.body) === JSON.stringify(u.body),
            `12e. ${who} is refused Alice's list, as for a key nobody holds (${show(a)} / ${show(u)})`);
    }
    // Unsigned, the same for every key.
    const unsignedUnknown = await send('GET', `/api/friends/${unknownKey}`);
    const unsignedAlice = await send('GET', `/api/friends/${alice.pub}`);
    assert(unsignedAlice.status === 401 && unsignedAlice.status === unsignedUnknown.status
        && JSON.stringify(unsignedAlice.body) === JSON.stringify(unsignedUnknown.body),
        `12f. unsigned, Alice's list and a key nobody holds get one answer (${show(unsignedAlice)})`);

    // 13. Nobody adds to or removes from someone else's list: a body naming Alice as the owner is refused, and a body
    // naming no owner acts on the signer's own list.
    const before = listOf(alice.pub);
    const addToAlice = await send('POST', '/api/friends/add', { ownerPubkey: alice.pub, friendPubkey: carol.pub }, carol);
    assert(addToAlice.status === 403 && listOf(alice.pub) === before && listOf(carol.pub) === '',
        `13a. Carol adding herself to Alice's list is refused, nothing written (${show(addToAlice)})`);
    const adminAdd = await send('POST', '/api/friends/add', { ownerPubkey: alice.pub, friendPubkey: amy.pub }, amy);
    assert(adminAdd.status === 403 && listOf(alice.pub) === before && listOf(amy.pub) === '',
        `13b. Amy (an admin) adding herself to Alice's list is refused, nothing written (${show(adminAdd)})`);
    const removeFromAlice = await send('POST', '/api/friends/remove', { ownerPubkey: alice.pub, friendPubkey: bob.pub }, carol);
    assert(removeFromAlice.status === 403 && listOf(alice.pub) === before,
        `13c. Carol removing Bob from Alice's list is refused, Bob stays (${show(removeFromAlice)})`);
    const removeOwnMissing = await send('POST', '/api/friends/remove', { friendPubkey: bob.pub }, carol);
    assert(removeOwnMissing.status === 400 && listOf(alice.pub) === before,
        `13d. Carol removing Bob with no owner named acts on her own list (not there, 400); Alice's keeps Bob (${show(removeOwnMissing)})`);
    assert(listOf(alice.pub) === bob.pub, `13e. Alice's list is still just Bob (${listOf(alice.pub)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Friends routes integration checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
