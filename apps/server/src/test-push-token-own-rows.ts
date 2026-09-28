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
 * And what a key with no row here can store (state-engine.ts STRANGER_PUSH_RULES, #1295 review 4126286269): so many new
 * tokens an address a day, and so many the node, over which it is answered 429 while a member, a visitor's row and the
 * same token again are not; the address kept only as a keyed hash, for a day; its tokens not registered again for a
 * month pruned as the next one registers, with no tombstone, and a member's and a visitor's kept.
 *
 * Local only: it talks to the server it starts on localhost and nothing else. No push service is contacted.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-push-token-own-rows.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { STRANGER_PUSH_RULES, getPushTokens, initStateEngine, isNodeMember, registerPushToken } from './state-engine.js';
import { forgetOldJoinAddresses } from './engine/open-join.js';
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
    return (await answer(method, path, body, signer)).status;
}

/** The node's answer to a request, signed by `signer` or not: its status and its `code`, if any. */
async function answer(method: 'POST' | 'DELETE', path: string, body: unknown, signer: Identity | null): Promise<{ status: number; code?: string }> {
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
    const text = await res.text();
    let code: string | undefined;
    try { code = JSON.parse(text)?.code; } catch { /* not JSON */ }
    return { status: res.status, code };
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

    // ── 6. What a key with no row here can store ──────────────────────────────────────────────
    console.log('\n── A key with no row here: its new tokens are capped, and pruned after a month');
    const { perAddressPerDay, perNodePerDay, keptDays } = STRANGER_PUSH_RULES;
    const addresses = () => db.prepare('SELECT ip_hash FROM push_token_addresses').all() as { ip_hash: string | null }[];
    const register = (id: Identity, token: string) => answer('POST', '/api/push-tokens', { publicKey: id.pub, token, platform: 'android' }, id);
    const tokenOf = (id: Identity) => `ExponentPushToken[${id.name}]`;
    const before = addresses();
    assert(before.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(before[0].ip_hash ?? '') && !/127\.0\.0\.1|::1/.test(before[0].ip_hash ?? ''),
        `the stranger's token above is this address's first today, kept as a keyed hash, never the address (${JSON.stringify(before)})`);
    const fresh = Array.from({ length: perAddressPerDay }, (_, i) => keyPair(`fresh-${i}`));
    const firstDay: number[] = [];
    for (const f of fresh.slice(1)) firstDay.push((await register(f, tokenOf(f))).status);
    assert(firstDay.every((st) => st === 200) && addresses().length === perAddressPerDay,
        `${perAddressPerDay - 1} more fresh keys register a token each from this address: ${perAddressPerDay} today (${firstDay.join(', ')})`);
    const overAddress = await register(fresh[0], tokenOf(fresh[0]));
    assert(overAddress.status === 429 && overAddress.code === 'rate_limited' && holders(tokenOf(fresh[0])).length === 0 && addresses().length === perAddressPerDay,
        `the next one is refused, 429 rate_limited, and stores nothing (${JSON.stringify(overAddress)})`);
    const again = await register(fresh[1], tokenOf(fresh[1]));
    assert(again.status === 200 && addresses().length === perAddressPerDay, `a fresh key registering its own token again is taken: it adds no row (${JSON.stringify(again)})`);
    const benMore = await register(ben, 'ExponentPushToken[ben-tablet]');
    const vis = keyPair('visitor');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, is_visitor) VALUES (?, 'Visitor', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)`).run(vis.pub);
    const visitorPhone = await register(vis, tokenOf(vis));
    assert(benMore.status === 200 && visitorPhone.status === 200 && addresses().length === perAddressPerDay,
        `a member and a visitor's row register new tokens from the same address, uncounted (${benMore.status}, ${visitorPhone.status})`);
    // A day later the address's count starts again, and the day-old addresses are gone.
    db.prepare(`UPDATE push_token_addresses SET made_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`).run();
    const nextDay = await register(fresh[0], tokenOf(fresh[0]));
    assert(nextDay.status === 200 && addresses().length === 1, `a day later the address may register again, and only today's is kept (${JSON.stringify(nextDay)}, ${addresses().length})`);
    // The node's day, from every address together: an address costs nothing.
    for (let i = addresses().length; i < perNodePerDay; i++) {
        const r = registerPushToken(keyPair(`far-${i}`).pub, `ExponentPushToken[far-${i}]`, 'android', null, `address-${i}`);
        if (r !== 'registered') throw new Error(`the node's day filled early, at ${i}: ${r}`);
    }
    const late = keyPair('late');
    const overNode = await register(late, tokenOf(late));
    assert(overNode.status === 429 && overNode.code === 'busy' && holders(tokenOf(late)).length === 0,
        `past ${perNodePerDay} new tokens of keys with no row on this node today, from any address, one more is refused, 429 busy (${JSON.stringify(overNode)})`);
    assert(registerPushToken(late.pub, tokenOf(late), 'android', null, 'a-new-address') === 'busy', '...from a new address too');
    const benAtCap = await register(ben, 'ExponentPushToken[ben-watch]');
    assert(benAtCap.status === 200, `and a member still registers (${JSON.stringify(benAtCap)})`);
    assert(forgetOldJoinAddresses(Date.now() + 25 * 3600_000) === perNodePerDay && addresses().length === 0,
        'the addresses are forgotten once a day old (the minute sweep, engine/open-join.ts)');
    // A month on, a key with no row's tokens it hasn't registered again go as the next one registers; no tombstone.
    const monthAgo = `-${keptDays + 1} days`;
    const age = (pub: string) => db.prepare(`UPDATE push_tokens SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE public_key = ?`).run(monthAgo, pub);
    for (const pub of [fresh[2].pub, fresh[3].pub, ben.pub, vis.pub]) age(pub);
    assert((await register(fresh[3], tokenOf(fresh[3]))).status === 200, 'a fresh key registers its token again (the app starting)');
    const tombstonesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'push_tokens'`).get() as { n: number }).n;
    const another = keyPair('another');
    assert((await register(another, tokenOf(another))).status === 200, 'a new key with no row registers a token');
    const tombstonesAfter = (db.prepare(`SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'push_tokens'`).get() as { n: number }).n;
    assert(holders(tokenOf(fresh[2])).length === 0 && holders(tokenOf(fresh[3])).length === 1,
        `a key with no row's token not registered again in ${keptDays} days is pruned; one registered again is kept`);
    assert(alertTokensOf(ben).length === 3 && holders(tokenOf(vis)).length === 1,
        `a member's (${alertTokensOf(ben).length}) and a visitor's row's tokens are kept however old`);
    assert(tombstonesAfter === tombstonesBefore, `the prune writes no tombstone: those tokens never travel (${tombstonesBefore} → ${tombstonesAfter})`);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN DELETE FROM push_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        AND public_key NOT IN (SELECT m.public_key FROM members m)`).all(monthAgo) as { detail: string }[]).map((r) => r.detail).join('; ');
    assert(/SEARCH push_tokens USING INDEX idx_push_tokens_created_at/.test(plan) && !/SCAN push_tokens/.test(plan),
        `the prune runs at each stranger's new token, so it searches idx_push_tokens_created_at, never scans the table (${plan})`);

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
