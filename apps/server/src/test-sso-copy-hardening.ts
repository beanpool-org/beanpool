/**
 * A sign-in copy on its way back to a member, hardened (defence review FABLE-sec-sso, 2026-10-01, findings 2 to 5),
 * over real HTTPS through the real signature middleware, with a stand-in Google (a local RSA key).
 *
 *   2. A released copy is sealed to the recovering device's throwaway key when the device asks: the bytes on the wire
 *      and in any log open nothing without that key, even with the member's Google id. An app from before the seal
 *      (it does not ask) still gets the copy as stored, so its restores keep working.
 *   3. A token naming a key Google never published does not make the node ask Google again on every request: an
 *      unknown kid refetches the key set at most once a minute.
 *   4. A released copy is handed over only while its session is live: after the owner stops it, after a re-split, or
 *      after it expires, `/collect/fragments` refuses.
 *   5. Opening a session against someone's name (anybody can) sends them no push, and a flood of opens evicts neither
 *      the member's own sign-in in progress nor a session that has released its copy. The member's own restore still
 *      tells them, once, when it goes through.
 *   6. (PR #1456 deciding review) So strangers with many addresses can pile thousands of sessions against one name.
 *      What that costs the member stays small: their app is sent the count and the newest few, one Stop takes every
 *      session in one request (and says so truthfully), and a pile is gone from their app half an hour after it stops
 *      growing. Their own restore, in progress through the flood, still goes through.
 *
 * Local only: the node is this process's own HTTPS server on localhost. Google's key set is answered here, Expo's push
 * endpoint is answered here, and anything else is refused and counted.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-sso-copy-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { openListedFragment, openSeedFromSso, sealSeedToSso } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, registerPushToken } from './state-engine.js';
import { db } from './db/db.js';
import { startHttpsServer } from './https-server.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';

/** The scheme a device asks for (core KEEPER_ALG_RELEASE), spelled out so this suite reads the same on a node without it. */
const SEAL = 'x25519-xc20p-release-v1';

const GOOGLE_KID = 'test-sso-copy-hardening-kid';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const SUB = '110169484474386276334';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const GOOGLE_JWK = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any;

// ── Nothing leaves this machine ───────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
const jwksFetches: string[] = [];
const blocked: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
    if (url.href === GOOGLE_JWKS) {
        jwksFetches.push(url.href);
        return new Response(JSON.stringify({ keys: [GOOGLE_JWK] }), {
            status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
        });
    }
    if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    blocked.push(url.hostname);
    throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function threw(fn: () => unknown): boolean {
    try { fn(); return false; } catch { return true; }
}
async function rejects(p: Promise<unknown>): Promise<boolean> {
    try { await p; return false; } catch { return true; }
}

interface Key { pk: string; seedHex: string; priv: crypto.KeyObject }
function keyFromSeed(seed: Buffer): Key {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, seedHex: seed.toString('hex'), priv };
}
const throwaway = (): Key => keyFromSeed(crypto.randomBytes(32));

function googleToken(sub: string, nonce: string, kid = GOOGLE_KID): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const payload = b64({
        iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email: 'copy-hardening@example.com', email_verified: true,
        iat: now, exp: now + 3600, nonce,
    });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`;
}

let BASE = '';
/** Signed as the real middleware requires (method, path, timestamp, nonce, body). Each from a clear limiter. */
async function call(key: Key, path: string, body: unknown): Promise<{ status: number; body: any; text: string }> {
    resetGatewayRateLimit();
    pruneAuthAttempts(Date.now() + 120_000);
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': key.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${bodyString}`), key.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}

/**
 * Signed like `call`, but from one client address (`X-Forwarded-For`, which a localhost caller may set: loopback is a
 * trusted proxy, client-ip.ts) and with NO limiter reset: what a stranger with many addresses, or the member on their
 * own one, really gets. An IPv6 address is counted by its /64.
 */
async function callFrom(addr: string, key: Key, path: string, body: unknown): Promise<{ status: number; body: any; text: string; ms: number }> {
    const bodyString = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': addr,
            'X-Public-Key': key.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${bodyString}`), key.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, ms };
}

/** `n` strangers' /64s (2001:db8:<block>:<i>::/64), each opening `per` sessions against `callsign`, 32 at a time. */
async function flood(callsign: string, block: number, n: number, per: number): Promise<number[]> {
    const addrs: string[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < per; j++) addrs.push(`2001:db8:${block.toString(16)}:${i.toString(16)}::1`);
    const statuses: number[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < addrs.length) {
            const addr = addrs[next++];
            statuses.push((await callFrom(addr, throwaway(), '/api/recovery/collect', { callsign })).status);
        }
    }));
    return statuses;
}

interface Owner { key: Key; seedHex: string; callsign: string }
interface Deposited { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string }

let seq = 0;
function addOwner(): Owner {
    const seed = crypto.randomBytes(32);
    const key = keyFromSeed(seed);
    const callsign = `hard${++seq}-${key.pk.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(key.pk, callsign);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key.pk);
    return { key, seedHex: seed.toString('hex'), callsign };
}

/** The owner connects Google: their copy, sealed on their phone, deposited over HTTPS. A second deposit is a re-split. */
async function deposit(owner: Owner): Promise<Deposited> {
    const sealed = await sealSeedToSso(new Uint8Array(Buffer.from(owner.seedHex, 'hex')), 'google', SUB) as Deposited;
    const n = (await call(owner.key, '/api/recovery/sso-nonce', {})).body?.nonce;
    const res = await call(owner.key, '/api/recovery/shares/sso', {
        provider: 'google', idToken: googleToken(SUB, n), nonce: n,
        shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }],
    });
    if (res.status !== 200) throw new Error(`the deposit was refused: ${res.status} ${res.text}`);
    return sealed;
}

interface Restore { device: Key; collectionId: string }
async function openRestore(callsign: string, device = throwaway()): Promise<Restore & { status: number }> {
    const opened = await call(device, '/api/recovery/collect', { callsign });
    return { device, collectionId: opened.body?.collectionId, status: opened.status };
}
async function release(r: Restore, kid = GOOGLE_KID): Promise<{ status: number; body: any }> {
    const n = (await call(r.device, '/api/recovery/collect/sso-nonce', { collectionId: r.collectionId })).body?.nonce;
    return call(r.device, '/api/recovery/collect/sso', {
        collectionId: r.collectionId, provider: 'google', idToken: googleToken(SUB, n, kid), nonce: n,
    });
}
const fragments = (r: Restore, extra: Record<string, unknown> = {}) =>
    call(r.device, '/api/recovery/collect/fragments', { collectionId: r.collectionId, ...extra });

/** What a phone or a browser does with the listing: open it to the copy (core, both apps), then with the sign-in. */
async function seedFrom(f: any, device: Key, collectionId: string): Promise<string> {
    const copy = openListedFragment(f, device.seedHex, collectionId);
    const opened = await openSeedFromSso({ encryptedShare: copy.payload, shareIv: copy.payloadIv, shareTag: copy.payloadTag, kdfParams: copy.kdfParams! }, 'google', SUB);
    return Buffer.from(opened.seed).toString('hex');
}

const getRow = (id: string) => db.prepare('SELECT status FROM recovery_collections WHERE id = ?').get(id) as { status: string } | undefined;

const pushesTo = (owner: Owner): string[] =>
    (db.prepare('SELECT kind FROM push_notices WHERE recipient = ? ORDER BY rowid').all(owner.key.pk) as { kind: string }[]).map(r => r.kind);

async function main(): Promise<void> {
    console.log('\nSign-in copies on the way back: sealed, throttled, live-only, and nobody pings or evicts\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [GOOGLE_JWK], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();

    // ── 2. The copy is sealed to the device that asked ──────────────────────────────────────────────────────────
    console.log('── 2. sealed to the recovering device ──────────────────');
    const ann = addOwner();
    const annCopy = await deposit(ann);
    const r = await openRestore(ann.callsign);
    assert(r.status === 200 && (await release(r)).status === 200, 'a device with the sign-in releases the copy into its session');

    const sealed = await fragments(r, { seal: SEAL });
    const f = sealed.body?.fragments?.find((x: any) => x.holderType === 'sso');
    let alg: unknown;
    try { alg = JSON.parse(f?.kdfParams).alg; } catch { alg = undefined; }
    assert(sealed.status === 200 && alg === SEAL, `asked to, the node lists the copy sealed to the device (${sealed.status}, ${String(alg)})`);
    assert(!!f && ![annCopy.encryptedShare, annCopy.shareIv, annCopy.shareTag, annCopy.kdfParams].some(v => sealed.text.includes(v)),
        '...and no byte of the copy as deposited is in the answer');
    assert(!!f && await rejects(openSeedFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: annCopy.kdfParams }, 'google', SUB)),
        "so the bytes on the wire, with the member's Google id and the copy's own parameters, open nothing");
    assert(!!f && await seedFrom(f, r.device, r.collectionId).catch(() => null) === ann.seedHex,
        "the device that asked opens it with its throwaway key, then the sign-in: the member's own seed");
    assert(!!f && threw(() => openListedFragment(f, throwaway().seedHex, r.collectionId)),
        'any other key opens nothing');

    const asStored = await fragments(r);
    const g = asStored.body?.fragments?.find((x: any) => x.holderType === 'sso');
    assert(asStored.status === 200 && g?.payload === annCopy.encryptedShare && g?.kdfParams === annCopy.kdfParams,
        'an app from before the seal (it does not ask) still gets the copy as stored...');
    assert(!!g && await seedFrom(g, r.device, r.collectionId).catch(() => null) === ann.seedHex, '...and its restore still works');

    const unknown = await fragments(r, { seal: 'rot13' });
    assert(unknown.status === 400 && !unknown.body?.fragments, `a scheme the node can't seal to is refused, with no copy (${unknown.status})`);
    const notMine = await call(throwaway(), '/api/recovery/collect/fragments', { collectionId: r.collectionId, seal: SEAL });
    assert(notMine.status === 404 && !notMine.body?.fragments, "and another key can't ask for it sealed to itself");

    // ── 3. A made-up kid does not make the node ask Google each time ─────────────────────────────────────────────
    console.log('\n── 3. unknown key ids ───────────────────────────────────');
    const bob = addOwner();
    await deposit(bob);
    const rb = await openRestore(bob.callsign);
    jwksFetches.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await release(rb, `made-up-kid-${i}`)).status);
    assert(statuses.every(s => s === 400), `twenty tokens naming keys Google never published are refused (${[...new Set(statuses)].join(',')})`);
    assert(jwksFetches.length <= 1, `...and Google's key set is fetched at most once for all of them, not per request (${jwksFetches.length})`);
    assert((await release(rb)).status === 200, "Bob's real sign-in goes straight through after the flood");
    assert(await seedFrom((await fragments(rb, { seal: SEAL })).body?.fragments?.[0], rb.device, rb.collectionId).catch(() => null) === bob.seedHex,
        '...to his own seed');

    // ── 4. Only a live session hands a copy over ─────────────────────────────────────────────────────────────────
    console.log('\n── 4. only while the session is live ───────────────────');
    const cat = addOwner();
    await deposit(cat);
    const stopped = await openRestore(cat.callsign);
    await release(stopped);
    assert((await fragments(stopped, { seal: SEAL })).status === 200, 'a released copy is fetchable while the session is live');
    const mine = await call(cat.key, '/api/recovery/collect/mine', {});
    assert(mine.body?.collections?.some((c: any) => c.collectionId === stopped.collectionId), 'Cat sees the restore under way...');
    const cancel = await call(cat.key, '/api/recovery/collect/cancel', { collectionId: stopped.collectionId });
    assert(cancel.status === 200 && cancel.body?.cancelled === true, '...and stops it');
    for (const extra of [{ seal: SEAL }, {}]) {
        const after = await fragments(stopped, extra);
        assert(after.status === 400 && !after.body?.fragments,
            `after the owner stops it, the copy is no longer handed over${extra.seal ? '' : ', sealed or not'} (${after.status})`);
    }
    const kept = db.prepare('SELECT COUNT(*) AS n FROM recovery_releases WHERE collection_id = ?').get(stopped.collectionId) as { n: number };
    assert(kept.n === 1, '...while the release stays on record as evidence');

    const expired = await openRestore(cat.callsign);
    await release(expired);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.collectionId);
    assert((await fragments(expired, { seal: SEAL })).status === 400, 'a session past its expiry hands nothing over');

    const resplit = await openRestore(cat.callsign);
    await release(resplit);
    await deposit(cat); // Cat moves her copy: a new generation
    assert((await fragments(resplit, { seal: SEAL })).status === 400, 'a session the owner re-split out from under hands nothing over');

    // ── 5. Nobody can ping a member, or evict their restore ──────────────────────────────────────────────────────
    console.log('\n── 5. no pings, no evictions ────────────────────────────');
    const dee = addOwner();
    await deposit(dee);
    registerPushToken(dee.key.pk, `ExponentPushToken[dee-${dee.key.pk.slice(0, 8)}]`, 'android');
    const own = await openRestore(dee.callsign); // Dee, on a new phone, about to sign in
    const strangers: number[] = [];
    for (let i = 0; i < 12; i++) strangers.push((await openRestore(dee.callsign)).status);
    assert(strangers.every(s => s === 200), 'anybody can still open a restore against a name (they must: the device has no account)');
    assert(!pushesTo(dee).includes('account.recovery-started'),
        `...but thirteen opens send Dee no push (${pushesTo(dee).filter(k => k === 'account.recovery-started').length} sent)`);
    const deeReleased = await release(own);
    assert(deeReleased.status === 200, `twelve strangers' opens did not evict Dee's own restore, mid sign-in (${deeReleased.status} ${deeReleased.body?.error ?? ''})`);
    assert(await seedFrom((await fragments(own, { seal: SEAL })).body?.fragments?.[0], own.device, own.collectionId).catch(() => null) === dee.seedHex,
        '...which goes through to her seed');
    assert(JSON.stringify(pushesTo(dee)) === JSON.stringify(['account.restored']),
        `and the one push Dee gets is that her account was restored (${JSON.stringify(pushesTo(dee))})`);

    // A session that has released its copy is never the one pushed out.
    const fetchedLater = await openRestore(dee.callsign);
    await release(fetchedLater);
    for (let i = 0; i < 12; i++) await openRestore(dee.callsign);
    assert((await fragments(fetchedLater, { seal: SEAL })).status === 200, 'a session that released its copy survives a flood, and still hands it over');

    // Storage stays bounded: a session past its sign-in window that released nothing is what a flood pushes out.
    db.prepare(`UPDATE recovery_collections SET created_at = ? WHERE owner_pubkey = ? AND id NOT IN (SELECT collection_id FROM recovery_releases)`)
        .run(new Date(Date.now() - 2 * 3600_000).toISOString(), dee.key.pk);
    const fresh = await openRestore(dee.callsign);
    const idle = db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?
                              AND id NOT IN (SELECT collection_id FROM recovery_releases) AND id != ?`)
        .get(dee.key.pk, new Date().toISOString(), fresh.collectionId) as { n: number };
    assert(idle.n <= 10, `idle sessions past their sign-in window are capped at 10 (${idle.n})`);
    const live = (await call(fresh.device, '/api/recovery/collect/status', { collectionId: fresh.collectionId })).body;
    assert(live?.live === true, 'and a flood never locks the member out: a new restore is always live');
    assert((await call(fetchedLater.device, '/api/recovery/collect/status', { collectionId: fetchedLater.collectionId })).body?.live === true,
        '...while the released sessions are still live');

    // ── 6. A pile of strangers' sessions stays small to the member, and one Stop takes it all ────────────────────
    // PR #1456 deciding review: nothing evicts a session in its sign-in window (5, above), so strangers with many
    // addresses can pile thousands against one name. Real signed HTTP, distinct /64s, and no limiter is ever reset here.
    console.log('\n── 6. a pile of strangers\' sessions ────────────────────');
    const eve = addOwner();
    await deposit(eve);
    const EVE_ADDR = '198.51.100.7';      // Eve's own phone, the one with the banner
    const NEW_PHONE = '203.0.113.44';     // Eve on a new phone, restoring
    const evesRestore = { device: throwaway(), collectionId: '' };
    const evesOpen = await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect', { callsign: eve.callsign });
    evesRestore.collectionId = evesOpen.body?.collectionId;
    const evesNonce = (await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect/sso-nonce', { collectionId: evesRestore.collectionId })).body?.nonce;
    assert(evesOpen.status === 200 && typeof evesNonce === 'string', "Eve opens a restore on a new phone and asks for a nonce, then goes to Google's sheet");

    // While she is on the sheet: 100 strangers' /64s, 15 opens each, the most the auth limiter lets each one have.
    const STRANGER_NETS = 100;
    const t0 = performance.now();
    const opened = await flood(eve.callsign, 1, STRANGER_NETS, 15);
    console.log(`  (${opened.length} opens in ${Math.round(performance.now() - t0)} ms)`);
    assert(opened.every(s => s === 200), `${opened.length} strangers' opens from ${STRANGER_NETS} /64s all go through (they must: a restoring device has no account)`);
    const sixteenth = await callFrom('2001:db8:1:0::99', throwaway(), '/api/recovery/collect', { callsign: eve.callsign });
    assert(sixteenth.status === 429, `...and the limiter is real: a 16th open from one /64 is refused (${sixteenth.status})`);

    const evesSignIn = await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect/sso', {
        collectionId: evesRestore.collectionId, provider: 'google', idToken: googleToken(SUB, evesNonce), nonce: evesNonce,
    });
    assert(evesSignIn.status === 200, `Eve's own restore, in progress through the flood, is neither evicted nor blocked (${evesSignIn.status} ${evesSignIn.body?.error ?? ''})`);
    const evesCopy = await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect/fragments', { collectionId: evesRestore.collectionId, seal: SEAL });
    assert(await seedFrom(evesCopy.body?.fragments?.[0], evesRestore.device, evesRestore.collectionId).catch(() => null) === eve.seedHex,
        '...and goes through to her seed');

    const liveFor = (o: Owner): number => (db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections
        WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?`).get(o.key.pk, new Date().toISOString()) as { n: number }).n;
    const pile = liveFor(eve);
    const eveMine = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    console.log(`  (/collect/mine at ${pile} live sessions: ${eveMine.text.length} bytes, ${Math.round(eveMine.ms)} ms)`);
    assert(eveMine.status === 200 && eveMine.body?.count === pile, `Eve's app is told how many sessions are live: all ${pile} (${eveMine.body?.count})`);
    assert(eveMine.text.length < 4096, `...in a small answer, not every session: ${eveMine.text.length} bytes at ${pile} sessions`);
    assert(Array.isArray(eveMine.body?.collections) && eveMine.body.collections.length >= 1 && eveMine.body.collections.length <= 3
        && !!eveMine.body.collections[0].startedAt, `...with the newest few, which is what the banner shows (${eveMine.body?.collections?.length})`);

    // Bigger piles, as a stranger with more addresses makes them: rows put straight in, in their sign-in window.
    const pileUp = (n: number) => db.prepare(`
        WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
        INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
        SELECT lower(hex(randomblob(32))), ?, (SELECT generation FROM recovery_collections WHERE id = ?), lower(hex(randomblob(32))),
               'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ? FROM k
    `).run(n, eve.key.pk, evesRestore.collectionId, new Date(Date.now() + 72 * 3600_000).toISOString());
    pileUp(20_000);
    const big = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    console.log(`  (/collect/mine at ${big.body?.count} live sessions: ${big.text.length} bytes, ${Math.round(big.ms)} ms)`);
    assert(big.status === 200 && big.body?.count === liveFor(eve) && big.text.length < 4096,
        `at ${liveFor(eve)} sessions the answer is still ${big.text.length} bytes`);
    assert(big.ms < 500, `...and quick, so a poll does not hold the node (${Math.round(big.ms)} ms)`);
    const strangerOpen = await callFrom('2001:db8:2:0::1', throwaway(), '/api/recovery/collect', { callsign: eve.callsign });
    console.log(`  (one more open against the pile: ${Math.round(strangerOpen.ms)} ms)`);

    // Stop It Now: ONE request from Eve's own address takes every live session, and says so truthfully.
    const before = liveFor(eve);
    const stop = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/cancel', {});
    assert(stop.status === 200 && stop.body?.live === 0 && stop.body?.stopped === before,
        `one Stop from Eve stops all ${before} live sessions (${stop.status}: stopped ${stop.body?.stopped}, live ${stop.body?.live} ${stop.body?.error ?? ''})`);
    assert(liveFor(eve) === 0, `...and the node agrees: ${liveFor(eve)} live`);
    const kept6 = db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ?
        AND id NOT IN (SELECT collection_id FROM recovery_releases)`).get(eve.key.pk) as { n: number };
    assert(kept6.n === 0, `...the ones that released nothing are gone (${kept6.n} left)...`);
    assert(getRow(evesRestore.collectionId)?.status === 'cancelled', "...and Eve's own restore, which released her copy, is kept as evidence, stopped");
    const afterStop = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    assert(afterStop.body?.count === 0 && afterStop.body?.collections?.length === 0, 'her banner then reads nothing live');

    // An app from before names one session per Stop: its first request stops them all, so its "all cancelled" is true.
    await flood(eve.callsign, 3, 10, 15);
    const listed = (await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {})).body?.collections ?? [];
    const oldStop = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/cancel', { collectionId: listed[0]?.collectionId });
    assert(oldStop.status === 200 && oldStop.body?.cancelled === true && liveFor(eve) === 0,
        `an older app's Stop, naming one session, stops all 150 (${oldStop.status}, ${liveFor(eve)} live)`);
    const someoneElses = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/cancel', { collectionId: r.collectionId });
    assert(someoneElses.status === 400, `naming a session against somebody else's account is still refused (${someoneElses.status})`);
    const stranger = await callFrom('2001:db8:4:0::1', throwaway(), '/api/recovery/collect/cancel', {});
    assert(stranger.status === 401, `and a stranger's key stops nothing (${stranger.status})`);

    // A pile that nobody stops is gone half an hour after it stops growing, on Eve's next poll, not 72 hours later
    // when somebody next opens one.
    await flood(eve.callsign, 5, 20, 15);
    const piled = liveFor(eve);
    db.prepare(`UPDATE recovery_collections SET created_at = ? WHERE owner_pubkey = ? AND status = 'open'`)
        .run(new Date(Date.now() - 31 * 60_000).toISOString(), eve.key.pk);
    const later = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    assert(later.body?.count <= 10 && liveFor(eve) <= 10,
        `${piled} strangers' sessions past their sign-in window are down to the idle cap at Eve's next poll (${later.body?.count}, ${liveFor(eve)} live)`);

    assert(blocked.length === 0, `nothing was reached off this machine (${blocked.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Sign-in copy hardening checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
