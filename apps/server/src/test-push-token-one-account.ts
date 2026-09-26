/**
 * A device token belongs to one account at a time on a node — over a REAL HTTPS round trip, through the signature
 * middleware.
 *
 * A phone holds one identity. When the next account on it registers the phone's push token (after Sign Out or
 * "Replace this phone's account"), the account that was there before loses its row for that token, so the phone
 * stops getting its chat, escrow and recovery alerts. Before this, `push_tokens` was keyed by (public_key, token)
 * and the old row stayed. The phone unregisters the old key itself when it can; this is the half that works when the
 * phone was offline as the account left it.
 *
 * It also pins that the key is the signer's: naming another key in the body neither registers nor deletes for it,
 * and an unsigned request changes nothing.
 *
 * Local only: it talks to the server it starts on localhost and nothing else. No push service is contacted.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-token-one-account.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
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
function member(name: string): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, `${name}-${pub.slice(0, 6)}`);
    return { name, pub, priv: privateKey };
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

/** Who holds a row for this token on the node. */
function holders(token: string): string[] {
    return (db.prepare('SELECT public_key FROM push_tokens WHERE token = ? ORDER BY public_key').all(token) as { public_key: string }[])
        .map((r) => r.public_key);
}

function tokensOf(id: Identity): string[] {
    return (db.prepare('SELECT token FROM push_tokens WHERE public_key = ? ORDER BY token').all(id.pub) as { token: string }[])
        .map((r) => r.token);
}

async function main(): Promise<void> {
    console.log('\nRunning push token: one account per device token...\n');

    await initTls();
    initStateEngine();
    const ava = member('ava');
    const ben = member('ben');
    await startHttpsServer(PORT);

    // The phone both accounts use, one after the other, and Ava's other device.
    const PHONE = 'ExponentPushToken[shared-phone]';
    const AVA_TABLET = 'ExponentPushToken[ava-tablet]';

    // ── 1. Ava registers the phone and her tablet ─────────────────────────────────────────────
    assert(await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: PHONE, platform: 'android' }, ava) === 200,
        'Ava registers the phone');
    assert(await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: AVA_TABLET, platform: 'ios' }, ava) === 200,
        'Ava registers her tablet');
    assert(JSON.stringify(tokensOf(ava)) === JSON.stringify([AVA_TABLET, PHONE].sort()), 'Ava holds both tokens');

    // ── 2. Ben takes the phone over: Ava's row for it goes, her tablet stays ───────────────────
    assert(await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: PHONE, platform: 'android' }, ben) === 200,
        'Ben registers the same phone token');
    assert(JSON.stringify(holders(PHONE)) === JSON.stringify([ben.pub]), 'only Ben holds the phone token now (Ava has no row for it)');
    assert(JSON.stringify(tokensOf(ava)) === JSON.stringify([AVA_TABLET]), 'Ava keeps her other token (the tablet)');

    // Registering again is idempotent for the same key.
    assert(await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: PHONE, platform: 'android' }, ben) === 200,
        'Ben registers the phone again');
    assert(JSON.stringify(holders(PHONE)) === JSON.stringify([ben.pub]), 'still one row for the phone token, Ben');

    // ── 3. The key is the signer's, whatever the body names ───────────────────────────────────
    const postAsAva = await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: 'ExponentPushToken[ben-says-ava]', platform: 'ios' }, ben);
    assert(postAsAva < 200 || postAsAva >= 300, `Ben naming Ava in a registration is refused (got ${postAsAva})`);
    assert(holders('ExponentPushToken[ben-says-ava]').length === 0, '...and registers nothing, for Ava or for Ben');

    const deleteAsAva = await send('DELETE', '/api/push-tokens', { publicKey: ava.pub, token: AVA_TABLET }, ben);
    assert(deleteAsAva < 200 || deleteAsAva >= 300, `Ben naming Ava to delete her tablet token is refused (got ${deleteAsAva})`);
    assert(JSON.stringify(tokensOf(ava)) === JSON.stringify([AVA_TABLET]), "...and Ava's tablet token stays");

    const deleteOwnNamingTablet = await send('DELETE', '/api/push-tokens', { publicKey: ben.pub, token: AVA_TABLET }, ben);
    assert(deleteOwnNamingTablet === 200, 'Ben deleting "his" copy of the tablet token is answered (he has none)');
    assert(JSON.stringify(tokensOf(ava)) === JSON.stringify([AVA_TABLET]), "...and it deletes nothing of Ava's");

    const unsigned = await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: AVA_TABLET, platform: 'ios' }, null);
    assert(unsigned === 401, `an unsigned registration of Ava's tablet token is refused with 401 (got ${unsigned})`);
    assert(JSON.stringify(holders(AVA_TABLET)) === JSON.stringify([ava.pub]), '...and the tablet token is still only Ava’s');

    const notAString = await send('POST', '/api/push-tokens', { publicKey: ben.pub, token: { $ne: null }, platform: 'ios' }, ben);
    assert(notAString === 400, `a token that is not a string is refused with 400 (got ${notAString})`);
    assert(JSON.stringify(holders(AVA_TABLET)) === JSON.stringify([ava.pub]) && JSON.stringify(holders(PHONE)) === JSON.stringify([ben.pub]),
        '...and no row changes');

    // ── 4. Ava gets the phone back: Ben's row goes ────────────────────────────────────────────
    assert(await send('POST', '/api/push-tokens', { publicKey: ava.pub, token: PHONE, platform: 'android' }, ava) === 200,
        'Ava registers the phone again');
    assert(JSON.stringify(holders(PHONE)) === JSON.stringify([ava.pub]), 'only Ava holds the phone token');
    assert(tokensOf(ben).length === 0, 'Ben has no token left on this node');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ push-token one-account checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
