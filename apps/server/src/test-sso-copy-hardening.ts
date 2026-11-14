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
 *   5. Since S3 a session opens only for the account a verified sign-in found (the find's hold): a stranger naming a
 *      member's key opens nothing and sends them no push, and the member's own restore goes through after them, telling
 *      them once. Sessions a collect by name opened before S3 and never released, still on a node when it updated, evict
 *      neither a session that has released its copy nor a new restore, and stay capped.
 *   6. (PR #1456 deciding review) Strangers with many addresses pile nothing against a member now, and the limiter still
 *      holds each address to its 15. A pile left from before S3 costs the member little: their app is sent the count and
 *      the newest few, one Stop takes every session in one request (and says so truthfully), and a pile is gone from
 *      their app half an hour after it stops growing.
 *   7. (PR #1456 re-review) And a pile against a member who never opens the app is retired anyway: a node-wide sweep,
 *      in statements of SWEEP_BATCH rows (tens of milliseconds each here) with the event loop free between them, leaves
 *      each owner's idle cap, deletes the expired and the long-stopped, and keeps every session that released something
 *      and every one in its sign-in window.
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
// The suite's own server, in this process: a call after a long synchronous stretch (rows written by the hundred
// thousand) must not reuse a socket the server is about to close (keepalive-test-fetch.ts; CI run 36964891493).
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

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
    // The node's own update check (a timer, which §7's longer run reaches): answered here, so it reaches nothing either.
    if (url.hostname === 'api.github.com') return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
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
    const res = await localFetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': key.pk,
            'X-Signature': signRequest(key.priv, { method: 'POST', path, timestamp: ts, nonce, body: bodyString }),
            [SIGNED_FOR_HEADER]: signedForHost(),
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
    const res = await localFetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': addr,
            'X-Public-Key': key.pk,
            'X-Signature': signRequest(key.priv, { method: 'POST', path, timestamp: ts, nonce, body: bodyString }),
            [SIGNED_FOR_HEADER]: signedForHost(),
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

/**
 * `n` strangers' /64s (2001:db8:<block>:<i>::/64), each sending `per` collects that name `pk` with no find of theirs
 * behind them, 32 at a time: what a stranger can still try against a member since S3.
 */
async function flood(pk: string, block: number, n: number, per: number): Promise<number[]> {
    const addrs: string[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < per; j++) addrs.push(`2001:db8:${block.toString(16)}:${i.toString(16)}::1`);
    const statuses: number[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < addrs.length) {
            const addr = addrs[next++];
            statuses.push((await callFrom(addr, throwaway(), '/api/recovery/collect', { candidatePublicKey: pk })).status);
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
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(key.pk);
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
/** A restoring device's find with the sign-in (`kid` names Google's key), from `from`'s address when given: its answer. */
async function find(device: Key, kid = GOOGLE_KID, from?: string): Promise<{ status: number; body: any }> {
    const ask = (path: string, body: unknown) => (from ? callFrom(from, device, path, body) : call(device, path, body));
    const n = (await ask('/api/recovery/find-nonce', {})).body?.nonce;
    return ask('/api/recovery/find', { provider: 'google', idToken: googleToken(SUB, n, kid), nonce: n });
}
/**
 * A restore as both apps run it since S2: a find with the sign-in, then the collect of `owner` by the find's hold, which
 * opens the session and releases the copy in one request.
 */
async function restore(owner: Owner, opts: { device?: Key; from?: string } = {}): Promise<Restore & { status: number; body: any }> {
    const device = opts.device ?? throwaway();
    await find(device, GOOGLE_KID, opts.from);
    const body = { candidatePublicKey: owner.key.pk };
    const collected = opts.from ? await callFrom(opts.from, device, '/api/recovery/collect', body) : await call(device, '/api/recovery/collect', body);
    return { device, collectionId: collected.body?.collectionId, status: collected.status, body: collected.body };
}
/**
 * Sessions as a collect by name opened them before S3 (anybody could, against any member's name) and never released,
 * still on a node when it updated: `n` of them against `owner`, put straight in. The id of the last one.
 */
function pileUp(owner: Owner, n: number, createdAt = new Date(), expiresAt = new Date(Date.now() + 72 * 3600_000)): string {
    db.prepare(`
        WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
        INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
        SELECT lower(hex(randomblob(32))), ?, (SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = ?), lower(hex(randomblob(32))),
               'open', ?, ? FROM k
    `).run(n, owner.key.pk, owner.key.pk, createdAt.toISOString(), expiresAt.toISOString());
    return (db.prepare('SELECT id FROM recovery_collections WHERE rowid = last_insert_rowid()').get() as { id: string }).id;
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
    const r = await restore(ann);
    assert(r.status === 200 && r.body?.progress?.collected === 1, 'a device with the sign-in finds the account, and its collect releases the copy into its session');

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
    const bobsPhone = throwaway();
    jwksFetches.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await find(bobsPhone, `made-up-kid-${i}`)).status);
    assert(statuses.every(s => s === 400), `twenty tokens naming keys Google never published are refused (${[...new Set(statuses)].join(',')})`);
    assert(jwksFetches.length <= 1, `...and Google's key set is fetched at most once for all of them, not per request (${jwksFetches.length})`);
    const rb = await restore(bob, { device: bobsPhone });
    assert(rb.status === 200, "Bob's real sign-in goes straight through after the flood");
    assert(await seedFrom((await fragments(rb, { seal: SEAL })).body?.fragments?.[0], rb.device, rb.collectionId).catch(() => null) === bob.seedHex,
        '...to his own seed');

    // ── 4. Only a live session hands a copy over ─────────────────────────────────────────────────────────────────
    console.log('\n── 4. only while the session is live ───────────────────');
    const cat = addOwner();
    await deposit(cat);
    const stopped = await restore(cat);
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

    const expired = await restore(cat);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.collectionId);
    assert((await fragments(expired, { seal: SEAL })).status === 400, 'a session past its expiry hands nothing over');

    const resplit = await restore(cat);
    await deposit(cat); // Cat moves her copy: a new generation
    assert((await fragments(resplit, { seal: SEAL })).status === 400, 'a session the owner re-split out from under hands nothing over');

    // ── 5. Nobody can ping a member, or evict their restore ──────────────────────────────────────────────────────
    console.log('\n── 5. no pings, no evictions ────────────────────────────');
    const dee = addOwner();
    await deposit(dee);
    registerPushToken(dee.key.pk, `ExponentPushToken[dee-${dee.key.pk.slice(0, 8)}]`, 'android');
    const sessionsOf = (o: Owner): number =>
        (db.prepare('SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ?').get(o.key.pk) as { n: number }).n;
    const ownPhone = throwaway();
    assert((await find(ownPhone)).status === 200, 'Dee, on a new phone, finds her account with her sign-in and is about to collect it');
    const strangers: number[] = [];
    for (let i = 0; i < 12; i++) strangers.push((await call(throwaway(), '/api/recovery/collect', { candidatePublicKey: dee.key.pk })).status);
    assert(strangers.every(s => s === 400) && sessionsOf(dee) === 0,
        `a stranger naming Dee's key opens nothing: no find of theirs named her (${[...new Set(strangers)].join(',')}; ${sessionsOf(dee)} sessions)`);
    assert(pushesTo(dee).length === 0, `...and twelve of them send Dee no push (${JSON.stringify(pushesTo(dee))})`);
    const ownCollect = await call(ownPhone, '/api/recovery/collect', { candidatePublicKey: dee.key.pk });
    const own: Restore = { device: ownPhone, collectionId: ownCollect.body?.collectionId };
    assert(ownCollect.status === 200, `Dee's own restore goes through after them (${ownCollect.status} ${ownCollect.body?.error ?? ''})`);
    assert(await seedFrom((await fragments(own, { seal: SEAL })).body?.fragments?.[0], own.device, own.collectionId).catch(() => null) === dee.seedHex,
        '...to her seed');
    assert(JSON.stringify(pushesTo(dee)) === JSON.stringify(['account.restored']),
        `and the one push Dee gets is that her account was restored (${JSON.stringify(pushesTo(dee))})`);

    // A session that has released its copy is never the one pushed out, by sessions left from before S3 or a new restore.
    const fetchedLater = await restore(dee);
    pileUp(dee, 12);
    const again = await restore(dee);
    assert(again.status === 200 && (await fragments(fetchedLater, { seal: SEAL })).status === 200,
        'a session that released its copy survives twelve idle ones from before and a new restore, and still hands it over');

    // Storage stays bounded: a session past its sign-in window that released nothing is what a new restore pushes out.
    db.prepare(`UPDATE recovery_collections SET created_at = ? WHERE owner_pubkey = ? AND id NOT IN (SELECT collection_id FROM recovery_releases)`)
        .run(new Date(Date.now() - 2 * 3600_000).toISOString(), dee.key.pk);
    const fresh = await restore(dee);
    const idle = db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?
                              AND id NOT IN (SELECT collection_id FROM recovery_releases)`)
        .get(dee.key.pk, new Date().toISOString()) as { n: number };
    assert(idle.n <= 10, `idle sessions past their sign-in window are capped at 10 (${idle.n})`);
    const live = (await call(fresh.device, '/api/recovery/collect/status', { collectionId: fresh.collectionId })).body;
    assert(live?.live === true, 'and a pile never locks the member out: a new restore is always live');
    assert((await call(fetchedLater.device, '/api/recovery/collect/status', { collectionId: fetchedLater.collectionId })).body?.live === true,
        '...while the released sessions are still live');

    // ── 6. A pile against a member stays small to them, and one Stop takes it all ────────────────────────────────
    // PR #1456 deciding review: nothing evicts a session in its sign-in window (5, above), so strangers with many
    // addresses could pile thousands against one name. Since S3 none of theirs opens; a pile left from before S3 is what
    // the member's app still stays small for. Real signed HTTP, distinct /64s, and no limiter is ever reset here.
    console.log('\n── 6. a pile of sessions ────────────────────────────────');
    // The node-wide sweep (§7), looked up rather than imported, so this suite runs (and fails where it should) on a node
    // without it.
    const rr = await import('./engine/recovery-release.js') as Record<string, unknown>;
    const sweep = rr.sweepRecoveryCollections as undefined | ((onBatch?: (ms: number, rows: number) => void) => Promise<{ deleted: number; batches: number }>);
    const sweepNow = async (onBatch?: (ms: number, rows: number) => void) => { if (sweep) await sweep(onBatch); };
    const eve = addOwner();
    await deposit(eve);
    const EVE_ADDR = '198.51.100.7';      // Eve's own phone, the one with the banner
    const NEW_PHONE = '203.0.113.44';     // Eve on a new phone, restoring
    const evesRestore = { device: throwaway(), collectionId: '' };
    const evesFind = await find(evesRestore.device, GOOGLE_KID, NEW_PHONE);
    assert(evesFind.status === 200 && evesFind.body?.accounts?.some((a: any) => a.publicKey === eve.key.pk),
        'Eve, on a new phone, finds her account with her sign-in');

    // Then 100 strangers' /64s, 15 collects each naming Eve's key, the most the auth limiter lets each one have.
    const STRANGER_NETS = 100;
    const sessionsBefore = sessionsOf(eve);
    const t0 = performance.now();
    const tried = await flood(eve.key.pk, 1, STRANGER_NETS, 15);
    console.log(`  (${tried.length} collects in ${Math.round(performance.now() - t0)} ms)`);
    assert(tried.length === STRANGER_NETS * 15 && tried.every(s => s === 400) && sessionsOf(eve) === sessionsBefore,
        `${tried.length} strangers' collects from ${STRANGER_NETS} /64s naming Eve open nothing: no find of theirs named her (${[...new Set(tried)].join(',')})`);
    const sixteenth = await callFrom('2001:db8:1:0::99', throwaway(), '/api/recovery/collect', { candidatePublicKey: eve.key.pk });
    assert(sixteenth.status === 429, `...and the limiter is real: a 16th from one /64 is refused (${sixteenth.status})`);

    const evesSignIn = await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect', { candidatePublicKey: eve.key.pk });
    evesRestore.collectionId = evesSignIn.body?.collectionId;
    assert(evesSignIn.status === 200, `Eve's own restore goes through, neither evicted nor blocked by them (${evesSignIn.status} ${evesSignIn.body?.error ?? ''})`);
    const evesCopy = await callFrom(NEW_PHONE, evesRestore.device, '/api/recovery/collect/fragments', { collectionId: evesRestore.collectionId, seal: SEAL });
    assert(await seedFrom(evesCopy.body?.fragments?.[0], evesRestore.device, evesRestore.collectionId).catch(() => null) === eve.seedHex,
        '...and goes through to her seed');

    // A pile left from before S3, as strangers with many addresses made one then: 1,500 sessions in their sign-in window.
    pileUp(eve, 1500);
    const liveFor = (o: Owner): number => (db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections
        WHERE owner_pubkey = ? AND status = 'open' AND expires_at > ?`).get(o.key.pk, new Date().toISOString()) as { n: number }).n;
    const pile = liveFor(eve);
    const eveMine = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    console.log(`  (/collect/mine at ${pile} live sessions: ${eveMine.text.length} bytes, ${Math.round(eveMine.ms)} ms)`);
    assert(eveMine.status === 200 && eveMine.body?.count === pile, `Eve's app is told how many sessions are live: all ${pile} (${eveMine.body?.count})`);
    assert(eveMine.text.length < 4096, `...in a small answer, not every session: ${eveMine.text.length} bytes at ${pile} sessions`);
    assert(Array.isArray(eveMine.body?.collections) && eveMine.body.collections.length >= 1 && eveMine.body.collections.length <= 3
        && !!eveMine.body.collections[0].startedAt, `...with the newest few, which is what the banner shows (${eveMine.body?.collections?.length})`);

    // Bigger piles, as a stranger with more addresses made them: rows put straight in, in their sign-in window.
    pileUp(eve, 20_000);
    const big = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    console.log(`  (/collect/mine at ${big.body?.count} live sessions: ${big.text.length} bytes, ${Math.round(big.ms)} ms)`);
    assert(big.status === 200 && big.body?.count === liveFor(eve) && big.text.length < 4096,
        `at ${liveFor(eve)} sessions the answer is still ${big.text.length} bytes`);
    assert(big.ms < 500, `...and quick, so a poll does not hold the node (${Math.round(big.ms)} ms)`);
    const strangerTry = await callFrom('2001:db8:2:0::1', throwaway(), '/api/recovery/collect', { candidatePublicKey: eve.key.pk });
    console.log(`  (a stranger's collect against the pile: ${strangerTry.status} in ${Math.round(strangerTry.ms)} ms)`);

    // Stop It Now: ONE request from Eve's own address takes every live session, and says so truthfully.
    const before = liveFor(eve);
    const stop = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/cancel', {});
    assert(stop.status === 200 && stop.body?.live === 0 && stop.body?.stopped === before,
        `one Stop from Eve stops all ${before} live sessions (${stop.status}: stopped ${stop.body?.stopped}, live ${stop.body?.live} ${stop.body?.error ?? ''})`);
    assert(liveFor(eve) === 0, `...and the node agrees: ${liveFor(eve)} live`);
    assert(getRow(evesRestore.collectionId)?.status === 'cancelled', "...Eve's own restore, which released her copy, among them");
    const afterStop = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    assert(afterStop.body?.count === 0 && afterStop.body?.collections?.length === 0, 'her banner then reads nothing live');
    const aStranger = (db.prepare(`SELECT id, requester_ephemeral_pubkey AS k FROM recovery_collections WHERE owner_pubkey = ?
        AND id NOT IN (SELECT collection_id FROM recovery_releases) LIMIT 1`).get(eve.key.pk) as { id: string } | undefined)?.id;
    const emptyLeft = () => (db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ?
        AND id NOT IN (SELECT collection_id FROM recovery_releases)`).get(eve.key.pk) as { n: number }).n;
    assert(!!aStranger && getRow(aStranger)?.status === 'cancelled', "for a while a stopped session that released nothing is kept, so its device reads 'cancelled'");
    db.prepare(`UPDATE recovery_collections SET updated_at = ? WHERE owner_pubkey = ? AND status = 'cancelled'`)
        .run(new Date(Date.now() - 31 * 60_000).toISOString(), eve.key.pk);
    await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    await sweepNow();
    assert(emptyLeft() === 0, `half an hour on, Eve's next poll and the sweep delete every stopped session that released nothing (${emptyLeft()} left)`);
    assert(getRow(evesRestore.collectionId)?.status === 'cancelled', "...while her own restore, which released her copy, is kept as evidence");

    // An app from before names one session per Stop: its first request stops them all, so its "all cancelled" is true.
    pileUp(eve, 150);
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
    pileUp(eve, 300);
    const piled = liveFor(eve);
    db.prepare(`UPDATE recovery_collections SET created_at = ? WHERE owner_pubkey = ? AND status = 'open'`)
        .run(new Date(Date.now() - 31 * 60_000).toISOString(), eve.key.pk);
    const later = await callFrom(EVE_ADDR, eve.key, '/api/recovery/collect/mine', {});
    assert(later.body?.count <= 10 && liveFor(eve) <= 10,
        `${piled} sessions past their sign-in window are down to the idle cap at Eve's next poll (${later.body?.count}, ${liveFor(eve)} live)`);

    // ── 7. A pile against a member who never opens the app is retired anyway ──────────────────────────────────────
    // PR #1456 re-review: the per-owner prune ran only when the owner polled or somebody opened against them, so a pile
    // against a member whose app stays closed was never retired (750 rows at 400 days). A node-wide sweep, in batches.
    console.log('\n── 7. the node-wide sweep ───────────────────────────────');
    assert(typeof sweep === 'function', 'the node sweeps recovery sessions across every owner');
    const rowsFor = (o: Owner, where = '1'): number => (db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections
        WHERE owner_pubkey = ? AND ${where}`).get(o.key.pk) as { n: number }).n;
    const EMPTY = 'id NOT IN (SELECT collection_id FROM recovery_releases)';

    const fay = addOwner();     // never opens the app: no poll, ever
    await deposit(fay);
    // A restore of Fay's that released its copy: evidence, kept whatever happens.
    const faysEvidence = await restore(fay, { from: '203.0.113.70' });
    assert(faysEvidence.status === 200, 'a restore of Fay\'s releases her copy (evidence from here on)');
    // A pile left against her from before S3, past its sign-in window; and one opened then by a device still mid sign-in,
    // in its window when the sweep runs.
    pileUp(fay, 750, new Date(Date.now() - 31 * 60_000), new Date(Date.now() + 71 * 3600_000));
    const inWindow = pileUp(fay, 1);
    // Fay, on a new phone, has found her account and is about to collect it.
    const faysOwnDevice = throwaway();
    assert((await find(faysOwnDevice, GOOGLE_KID, '203.0.113.71')).status === 200, 'Fay finds her account on a new phone');
    const piled7 = rowsFor(fay, `${EMPTY} AND status = 'open' AND created_at <= '${new Date(Date.now() - 30 * 60_000).toISOString()}'`);
    console.log(`  (${piled7} idle sessions against Fay past their window, her app closed)`);

    await sweepNow();
    const idle7 = rowsFor(fay, `${EMPTY} AND id != '${inWindow}'`);
    assert(idle7 <= 10, `at 31 min, with no poll from Fay and no restore of hers since, the sweep leaves her idle cap (${piled7} -> ${idle7})`);
    assert(getRow(faysEvidence.collectionId)?.status === 'open', '...keeps the session that released her copy');
    assert(getRow(inWindow)?.status === 'open', '...and the one still in its sign-in window');
    const ownIn = await callFrom('203.0.113.71', faysOwnDevice, '/api/recovery/collect', { candidatePublicKey: fay.key.pk });
    assert(ownIn.status === 200, `...and Fay's own restore goes through after it (${ownIn.status} ${ownIn.body?.error ?? ''})`);
    const faysOwnId = ownIn.body?.collectionId as string;

    db.prepare(`UPDATE recovery_collections SET expires_at = ? WHERE owner_pubkey = ?`).run(new Date(Date.now() - 1000).toISOString(), fay.key.pk);
    await sweepNow();
    assert(rowsFor(fay, EMPTY) === 0, `past their expiry, every session against Fay that released nothing is gone (${rowsFor(fay, EMPTY)} left)`);
    assert(rowsFor(fay) === 2 && !!getRow(faysEvidence.collectionId) && !!getRow(faysOwnId),
        `...and the two that released her copy are kept as evidence (${rowsFor(fay)})`);

    // Stopped, past the half hour, with Fay's app closed after her Stop.
    pileUp(fay, 60);
    assert((await callFrom('198.51.100.70', fay.key, '/api/recovery/collect/cancel', {})).body?.live === 0, 'Fay stops a pile of 60, then closes the app');
    db.prepare(`UPDATE recovery_collections SET updated_at = ? WHERE owner_pubkey = ? AND status = 'cancelled'`).run(new Date(Date.now() - 31 * 60_000).toISOString(), fay.key.pk);
    await sweepNow();
    assert(rowsFor(fay, EMPTY) === 0, `half an hour on, the sweep deletes the stopped ones that released nothing (${rowsFor(fay, EMPTY)} left)`);

    // A poll on a big aged pile against one member prunes one batch, not the pile.
    const gus = addOwner(); await deposit(gus);
    const gen = (o: Owner) => (db.prepare('SELECT MAX(generation) AS g FROM recovery_shares WHERE owner_pubkey = ?').get(o.key.pk) as { g: number }).g;
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
        INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
        SELECT lower(hex(randomblob(32))), ?, ?, lower(hex(randomblob(32))), 'open', ?, ? FROM k`)
        .run(50_000, gus.key.pk, gen(gus), new Date(Date.now() - 40 * 60_000).toISOString(), new Date(Date.now() + 70 * 3600_000).toISOString());
    const gusPoll = await callFrom('198.51.100.71', gus.key, '/api/recovery/collect/mine', {});
    console.log(`  (Gus's first poll on 50,000 aged sessions: ${Math.round(gusPoll.ms)} ms)`);
    assert(gusPoll.status === 200 && gusPoll.ms < 500, `a poll on an aged pile of 50,000 prunes one batch, not the pile (${Math.round(gusPoll.ms)} ms)`);

    // 250,000 more, interleaved across 2,000 members (row by row, as strangers' opens against many names land): each
    // member's alternate rounds idle past their window or expired, so each has about 62 idle and 63 expired. The cold confirm of e326b1aa found the owner lookup held the
    // loop ~240 ms on such a layout, unbatched; it now walks the covering index.
    const OWNERS = 2_000;
    db.exec('CREATE TEMP TABLE pile_owners (rn INTEGER PRIMARY KEY, pk TEXT NOT NULL)');
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ? - 1)
        INSERT INTO pile_owners (rn, pk) SELECT i, lower(hex(randomblob(32))) FROM k`).run(OWNERS);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        SELECT pk, 'pile' || rn, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis' FROM pile_owners`).run();
    db.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ? - 1)
        INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
        SELECT lower(hex(randomblob(32))), (SELECT pk FROM pile_owners WHERE rn = i % ?), 1, lower(hex(randomblob(32))), 'open',
               CASE WHEN (i / ?) % 2 = 0 THEN ? ELSE ? END, CASE WHEN (i / ?) % 2 = 0 THEN ? ELSE ? END FROM k`)
        .run(250_000, OWNERS,
            OWNERS, new Date(Date.now() - 40 * 60_000).toISOString(), new Date(Date.now() - 73 * 3600_000).toISOString(),
            OWNERS, new Date(Date.now() + 70 * 3600_000).toISOString(), new Date(Date.now() - 3600_000).toISOString());
    const pileLeft = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM recovery_collections
        WHERE owner_pubkey IN (SELECT pk FROM pile_owners)`).get() as { n: number }).n;
    const pileMax = (): number => (db.prepare(`SELECT MAX(n) AS m FROM (SELECT COUNT(*) AS n FROM recovery_collections
        WHERE owner_pubkey IN (SELECT pk FROM pile_owners) GROUP BY owner_pubkey)`).get() as { m: number | null }).m ?? 0;

    // A yardstick timed in this run, on this machine: one statement that reads every row of the pile, as a sweep statement
    // that examined the pile rather than its batch would. Read from a copy of the pile, so the sweep's deletes don't shrink
    // it, the median of three before the sweep and of three after: a slow or busy runner slows it as it slows the sweep
    // (#1874: on CI the absolute bounds below were p95 289 and 348 ms, a bystander's p99 1124 ms).
    db.exec('CREATE TEMP TABLE yardstick AS SELECT * FROM recovery_collections');
    const yardRows = (db.prepare('SELECT COUNT(*) AS n FROM yardstick').get() as { n: number }).n;
    const readAll = db.prepare('SELECT SUM(length(id) + length(requester_ephemeral_pubkey)) AS n FROM yardstick WHERE status != ?');
    const yard = () => [0, 1, 2].map(() => { const t = performance.now(); readAll.get('none'); return performance.now() - t; }).sort((x, y) => x - y)[1];
    const yardBefore = yard();

    const times: number[] = [];
    let swept = 0;
    // A bystander asks the node something the whole time; how long it waits is how long the sweep holds the loop.
    let sweepDone = false;
    const waits: number[] = [];
    const bystander = (async () => {
        while (!sweepDone) {
            const t = performance.now();
            await localFetch(`${BASE}/api/version`).then(r => r.text()).catch(() => '');
            waits.push(performance.now() - t);
        }
    })();
    const t7 = performance.now();
    const batches: [number, number][] = [];
    await sweepNow((ms, rows) => { times.push(ms); swept += rows; batches.push([ms, rows]); });
    const sweepMs = performance.now() - t7;
    sweepDone = true;
    await bystander;
    const yardAfter = yard();
    const scanMs = Math.max(yardBefore, yardAfter);
    db.exec('DROP TABLE yardstick');
    const pct = (xs: number[], p: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
    const longest = Math.max(0, ...times);
    const longestWait = Math.max(0, ...waits);
    console.log(`  (swept ${swept} rows in ${times.length} statements, ${Math.round(sweepMs)} ms; statement median ${pct(times, 0.5).toFixed(1)} ms, `
        + `p95 ${pct(times, 0.95).toFixed(1)} ms, longest ${longest.toFixed(1)} ms; a bystander's wait median ${pct(waits, 0.5).toFixed(1)} ms, `
        + `longest ${longestWait.toFixed(1)} ms over ${waits.length} requests; one read of all ${yardRows} rows ${yardBefore.toFixed(1)} ms before, ${yardAfter.toFixed(1)} after)`);
    assert(rowsFor(gus, EMPTY) <= 10 && pileLeft() === OWNERS * 10 && pileMax() === 10,
        `the sweep retires the piles: Gus's to ${rowsFor(gus, EMPTY)}, 2,000 members' 250,000 to their caps (${pileLeft()} left, at most ${pileMax()} each)`);
    // Batched by construction, then by time, against the yardstick: each statement is to examine its batch, not the pile,
    // so a statement that reads every row costs it at least about one yardstick. The time bounds are statistical, and
    // relative, so a loaded CI machine slows both sides. Four copies of this suite at once here gave p95 55-105 ms, and a
    // few single statements of 0.5-3 s, 53-row ones among them: the disk's fsyncs under four writers, not the statement's
    // work, so no bound is put on the single longest. An unbatched sweep fails all three at once: one statement over these
    // piles takes seconds (an aged 125,000 took 963 ms in one at 8f4e8b64), so few statements, far more rows in one, and a
    // p95 of seconds; a batched one whose statements each scan the pile, a p95 of about a yardstick.
    // The bounds in reads of the pile: on this Mac (a read 75-80 ms) they are the 250, 100 and 1,000 ms they were before
    // #1887 raised the first to 500 ms to stop the flakes.
    const SHORT = 3, WAIT_MEDIAN = 1.25, WAIT_P99 = 12;
    const batch = rr.SWEEP_BATCH as number;
    assert(times.length >= 300 && batches.every(([, rows]) => rows <= batch),
        `...in hundreds of statements of at most ${batch} rows each (${times.length}; most rows in one: ${Math.max(0, ...batches.map(([, r]) => r))})`);
    assert(pct(times, 0.95) < SHORT * scanMs,
        `...that are short: p95 ${pct(times, 0.95).toFixed(1)} ms, under ${SHORT} of one read of the whole pile (${scanMs.toFixed(1)} ms) (median ${pct(times, 0.5).toFixed(1)}, longest ${longest.toFixed(1)})`);
    assert(waits.length >= 20 && pct(waits, 0.5) < WAIT_MEDIAN * scanMs && pct(waits, 0.99) < WAIT_P99 * scanMs,
        `...so requests made meanwhile are answered throughout (${waits.length}; median ${pct(waits, 0.5).toFixed(1)} ms, p99 ${pct(waits, 0.99).toFixed(1)} ms, longest ${longestWait.toFixed(1)} ms; under ${WAIT_MEDIAN} and ${WAIT_P99} reads of the pile)`);

    assert(blocked.length === 0, `nothing was reached off this machine (${blocked.join(', ') || 'none'})`);
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Sign-in copy hardening checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
