/**
 * A key registers and removes only its own push rows — over a REAL HTTPS round trip, through the signature middleware.
 *
 * `push_tokens` is keyed by (public_key, token). The recovery alerts ("Someone is recovering an account…", "Your
 * account was just restored…") reach the owner through `getPushTokens(owner)`, so a request that removed the owner's
 * row would silence them before a sign-in recovery. A device token is not a secret the node can lean on: every
 * community the phone registered with holds it. So registering a token adds the signer's row and touches nobody
 * else's, whoever the signer is (a key minted a second ago, or a member), and only the owner's own signed DELETE removes
 * the owner's row (#1184 review 4110460184). The phone unregisters the old key itself as an account leaves it
 * (apps/native utils/account-leaves-phone.ts).
 *
 * It also pins that the key is the signer's: naming another key in the body neither registers nor deletes for it,
 * and an unsigned request changes nothing.
 *
 * Local only: it talks to the server it starts on localhost and nothing else. No push service is contacted.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-token-own-rows.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { getPushTokens, initStateEngine, isNodeMember } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8779;
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

interface Identity { name: string; pub: string; priv: crypto.KeyObject }
function keyPair(name: string): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { name, pub, priv: privateKey };
}
function member(name: string): Identity {
    const id = keyPair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pub, `${name}-${id.pub.slice(0, 6)}`);
    return id;
}

async function send(method: 'POST' | 'DELETE', path: string, body: unknown, signer: Identity | null): Promise<number> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    await res.text();
    return res.status;
}

/** Who holds a row for this token on the node, sorted. */
function holders(token: string): string[] {
    return (db.prepare('SELECT public_key FROM push_tokens WHERE token = ? ORDER BY public_key').all(token) as { public_key: string }[])
        .map((r) => r.public_key);
}
const keys = (...ids: Identity[]) => ids.map((i) => i.pub).sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The tokens the recovery, chat and escrow alerts for this key go to (recovery-collect.ts, via getPushTokens). */
function alertTokensOf(id: Identity): string[] {
    return getPushTokens(id.pub).map((r) => r.token).sort();
}

async function main(): Promise<void> {
    console.log('\nRunning push token: each key touches only its own rows...\n');

    await initTls();
    initStateEngine();
    const ava = member('ava');
    const ben = member('ben');
    // A key minted a second ago, with no member row on this node: an operator of another community that holds Ava's token.
    const stranger = keyPair('stranger');
    await startHttpsServer(PORT);

    // Ava's phone and her tablet.
    const PHONE = 'ExponentPushToken[ava-phone]';
    const AVA_TABLET = 'ExponentPushToken[ava-tablet]';
    const AVA_BOTH = [AVA_TABLET, PHONE].sort();

    // ── 1. Ava registers her phone and her tablet ─────────────────────────────────────────────
    assert(await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: PHONE, platform: 'android' }, ava) === 200,
        'Ava registers her phone');
    assert(await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: AVA_TABLET, platform: 'ios' }, ava) === 200,
        'Ava registers her tablet');
    assert(same(alertTokensOf(ava), AVA_BOTH), 'Ava\'s alerts go to both');

    // ── 2. A stranger registers Ava's phone token: Ava keeps her row ──────────────────────────
    assert(!isNodeMember(stranger.pub), 'the stranger is not a member of this node');
    const strangerPost = await send('POST', '/api/push-tokens', { publicKey: stranger.pub, token: PHONE, platform: 'android' }, stranger);
    assert(strangerPost === 200, `the stranger's registration of Ava's phone token is answered as main answered it (got ${strangerPost})`);
    assert(same(alertTokensOf(ava), AVA_BOTH), '...and Ava\'s recovery alerts still go to her phone and her tablet');
    assert(same(holders(PHONE), keys(ava, stranger)), '...the stranger\'s row sits beside Ava\'s, it does not replace it');

    // ── 3. A member registers Ava's phone token: Ava keeps her row ────────────────────────────
    assert(await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: PHONE, platform: 'android' }, ben) === 200,
        'Ben, a member, registers Ava\'s phone token');
    assert(same(alertTokensOf(ava), AVA_BOTH), '...and Ava\'s recovery alerts still go to her phone and her tablet');
    assert(same(holders(PHONE), keys(ava, ben, stranger)), '...Ben\'s row sits beside Ava\'s and the stranger\'s');

    // Registering again is idempotent for the same key, and still touches nobody else.
    assert(await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: PHONE, platform: 'android' }, ben) === 200,
        'Ben registers it again');
    assert(same(holders(PHONE), keys(ava, ben, stranger)), '...still one row per key');

    // ── 4. Nobody can delete Ava's rows by naming her ─────────────────────────────────────────
    const postAsAva = await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: 'ExponentPushToken[ben-says-ava]', platform: 'ios' }, ben);
    assert(postAsAva < 200 || postAsAva >= 300, `Ben naming Ava in a registration is refused (got ${postAsAva})`);
    assert(holders('ExponentPushToken[ben-says-ava]').length === 0, '...and registers nothing, for Ava or for Ben');

    const benDeletesAva = await send('DELETE', '/api/push-tokens', { publicKey: ava.pub, token: AVA_TABLET }, ben);
    assert(benDeletesAva < 200 || benDeletesAva >= 300, `Ben naming Ava to delete her tablet token is refused (got ${benDeletesAva})`);
    const strangerDeletesAva = await send('DELETE', '/api/push-tokens', { publicKey: ava.pub, token: PHONE }, stranger);
    assert(strangerDeletesAva < 200 || strangerDeletesAva >= 300, `the stranger naming Ava to delete her phone token is refused (got ${strangerDeletesAva})`);
    const strangerDeletesAll = await send('DELETE', '/api/push-tokens', { publicKey: ava.pub }, stranger);
    assert(strangerDeletesAll < 200 || strangerDeletesAll >= 300, `the stranger naming Ava to delete all her tokens is refused (got ${strangerDeletesAll})`);
    assert(same(alertTokensOf(ava), AVA_BOTH), '...and Ava keeps both rows');

    const benDeletesOwnCopy = await send('DELETE', '/api/push-tokens', { publicKey: ben.pub, token: AVA_TABLET }, ben);
    assert(benDeletesOwnCopy === 200, 'Ben deleting "his" copy of the tablet token is answered (he has none)');
    assert(same(alertTokensOf(ava), AVA_BOTH), '...and it deletes nothing of Ava\'s');

    const unsignedPost = await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: AVA_TABLET, platform: 'ios' }, null);
    assert(unsignedPost === 401, `an unsigned registration of Ava's tablet token is refused with 401 (got ${unsignedPost})`);
    const unsignedDelete = await send('DELETE', '/api/push-tokens', { publicKey: ava.pub, token: PHONE }, null);
    assert(unsignedDelete === 401, `an unsigned delete naming Ava is refused with 401 (got ${unsignedDelete})`);
    assert(same(holders(AVA_TABLET), keys(ava)) && same(holders(PHONE), keys(ava, ben, stranger)), '...and no row changes');

    const notAString = await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: { $ne: null }, platform: 'ios' }, ben);
    assert(notAString === 400, `a token that is not a string is refused with 400 (got ${notAString})`);
    assert(same(holders(AVA_TABLET), keys(ava)) && same(holders(PHONE), keys(ava, ben, stranger)), '...and no row changes');

    // A signer's DELETE with no token removes all of the signer's rows and nobody else's.
    assert(await send('DELETE', '/api/push-tokens', { publicKey: stranger.pub }, stranger) === 200,
        'the stranger removes all of its own rows');
    assert(same(holders(PHONE), keys(ava, ben)), '...its row for the phone token goes');
    assert(same(alertTokensOf(ava), AVA_BOTH), '...and Ava keeps both of hers');

    // ── 5. Ava's own delete, signed by her key, removes only hers ─────────────────────────────
    assert(await send('DELETE', '/api/push-tokens', { publicKey: ava.pub, token: PHONE }, ava) === 200,
        'Ava unregisters her phone, signed by her key');
    assert(same(alertTokensOf(ava), [AVA_TABLET]), '...her phone row goes and her tablet stays');
    assert(same(holders(PHONE), keys(ben)), '...and Ben\'s row for the phone token stays: her delete removes only hers');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ push-token own-rows checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
