/**
 * Getting an account back with a sign-in, with nothing typed (scratch design DESIGN-recovery-no-callsign-fable.md §3 and
 * §7, slice S0): the find hash a deposit writes, POST /api/recovery/find-nonce, POST /api/recovery/find, and POST
 * /api/recovery/collect by the find's hold, over real HTTPS through the real signature middleware, with stand-in Google
 * and Apple keys in the JWKS cache. No provider, registrar or BeanPool node is contacted.
 *
 * scripts/server-suites.mjs runs it twice: as a local community, and as the global community (NODE_PROFILE=global). Global
 * is case 1 (Damo, 9 Nov): a numbered name, joined through the open door with Google, which enrolled the sign-in in the
 * same request. On a local community case 1's member connects Google in Settings.
 *
 *   1. deposit with Google, find with the same Google: one name; collect by the hold; the fragments open to the same key
 *      (and the find hash is the keyed hash of the verified sub, never the client's; a disconnect carries it)
 *   2. a stranger's valid token: an empty list, no session row, no push
 *   3. two owners, one sub: both names; collect for one opens one session and one push
 *   4. a row without a find hash is found by the scan and healed; the second find runs no scan (counter); one scan at a
 *      time, a second caller gets the 503 sentence (worded so no app's match catches it); the boot count falls by one.
 *      One sign-in protecting a copy made before the find hash and one made after it: the scan runs even though the
 *      index found one, both are named, and the second find runs no scan (Marty's decision 3, 9 Nov); while another
 *      scan runs, that find gets the 503 too (both sets or none)
 *   5. keys a take-over replaced (the deciding review of 38f03fac): a copy deposited while the server ran on its own key,
 *      whose member doesn't restore before the next take-over, is still found there, by the scan: the start's relock
 *      clears the retired key's find hash, and so does a deposit or a disconnect that carries the copy; the boot count
 *      shows it until then. Before that relock, a find tries the retired key's hash too
 *   6. collect with no hold, or a key not in the matches, or another device's hold, opens nothing
 *   7. the hold dies at 5 minutes, and leaves memory then with no find or collect after it
 *   8. a token from another provider is refused by the verifier's own sentence, and holds nothing
 *   9. a standby refuses, and keeps the member's hold for its main server's answer
 *  10. no seal key: the 503 sentence, the nonce unspent and the hold kept
 *  11. a row whose find hash matches but whose lookup hash does not releases nothing: the index is never the proof
 *  12. the name routes are gone (S3): an app from before S2 asking the lookup by name, /collect/sso-nonce or /collect/sso
 *      gets 404 and one sentence in JSON, naming nobody; a collect by name opens nothing; and the find still restores
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-find.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate
delete process.env.CF_RECORD_NAME; // LAN mode: a self-signed certificate, no registrar
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;
const GLOBAL = process.env.NODE_PROFILE === 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KEEPER_ALG_RELEASE, openReleaseOnDevice, openSeedFromSso, sealSeedToSso } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, registerPushToken } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import {
    RECOVERY_SEAL_KEY_MISSING, installCarriedRecoverySealKey, recoverySealKeyPath, recoverySealSubkey, rewrapRowsFromRetiredKeys,
} from './services/recovery-seal-key.js';
import { getCurrentShares } from './engine/recovery-shares.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const brief = (v: unknown) => JSON.stringify(v)?.slice(0, 260);

// ── the stand-in providers ──────────────────────────────────────────────────────────────────────
type Provider = 'google' | 'apple';
const AUD: Record<Provider, string> = { google: '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com', apple: 'org.beanpool.pillar' };
const ISS: Record<Provider, string> = { google: 'https://accounts.google.com', apple: 'https://appleid.apple.com' };
const KID: Record<Provider, string> = { google: 'test-recovery-find-google', apple: 'test-recovery-find-apple' };
const KEYS: Record<Provider, crypto.KeyPairKeyObjectResult> = {
    google: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    apple: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
};
/**
 * Each provider's cached key set holds both stand-in keys, so a token one provider signed and the request names as the
 * other gets past its key id and signature to the claims, where the issuer refuses it: no key set is fetched for an
 * unknown key id (a fetch is answered as an outage, below), and the refusal is the same on every route.
 */
function primeJwks(): void {
    _resetJwksCacheForTests();
    const jwks = (['google', 'apple'] as Provider[]).map((p) => ({ ...KEYS[p].publicKey.export({ format: 'jwk' }), kid: KID[p], alg: 'RS256', use: 'sig' } as any));
    for (const p of ['google', 'apple'] as Provider[]) _resetJwksCacheForTests(p, { keys: jwks, expiresAt: Date.now() + 3600_000 });
}

// Requests to this process's own server go through; anything else is recorded and answered as an outage.
const realFetch = globalThis.fetch;
const outsideCalls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith('https://localhost:')) return realFetch(input, init);
    outsideCalls.push(url);
    return new Response('stubbed: test-recovery-find contacts no provider', { status: 503 });
}) as typeof fetch;
function mint(provider: Provider, sub: string, nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: KID[provider], typ: 'JWT' });
    const payload = b64({ iss: ISS[provider], aud: AUD[provider], sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), KEYS[provider].privateKey).toString('base64url')}`;
}

// ── keys: a member's, and a restoring device's throwaway one ────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Buffer }
function idFromSeed(seed: Buffer): Id {
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed };
}
const newId = (): Id => idFromSeed(crypto.randomBytes(32));

async function call(id: Id | null, p: string, body: unknown): Promise<{ status: number; body: any }> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method: 'POST', path: p, timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await localFetch(`${BASE}${p}`, { method: 'POST', headers, body: raw });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

// ── members and their copies ────────────────────────────────────────────────────────────────────
function addMember(id: Id, callsign: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'recovery-find-test', 'TEST')`).run(id.pk, callsign);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
}
/** Settings' Connect: the member's own app seals the seed to the sign-in and deposits it. */
async function connect(id: Id, provider: Provider, sub: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const sealed = await sealSeedToSso(new Uint8Array(id.seed), provider, sub);
    const n = (await call(id, '/api/recovery/sso-nonce', {})).body?.nonce;
    return call(id, '/api/recovery/shares/sso', {
        provider, idToken: mint(provider, sub, n), nonce: n, shares: [{ holderType: 'sso', holderRef: provider, shareIndex: 1, ...sealed, ...extra }],
    });
}
/** Settings' Disconnect: DELETE /api/recovery/shares/sso/:provider, signed by the member. The status. */
async function disconnect(id: Id, provider: Provider): Promise<number> {
    const ts = Date.now(); const n = crypto.randomBytes(16).toString('hex'); const p = `/api/recovery/shares/sso/${provider}`;
    const sig = signRequest(id.priv, { method: 'DELETE', path: p, timestamp: ts, nonce: n });
    pruneAuthAttempts(Date.now() + 120_000); resetGatewayRateLimit();
    const res = await localFetch(`${BASE}${p}`, { method: 'DELETE', headers: { 'X-Public-Key': id.pk, [SIGNED_FOR_HEADER]: signedForHost(), 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Nonce': n } });
    return res.status;
}
/** The global community's open door: one sign-in joins and enrols the same sign-in as the recovery copy. */
async function joinThroughDoor(id: Id, callsign: string, provider: Provider, sub: string): Promise<{ status: number; body: any }> {
    const n = (await call(id, '/api/join/sso-nonce', {})).body?.nonce;
    const sealed = await sealSeedToSso(new Uint8Array(id.seed), provider, sub);
    return call(id, '/api/join', {
        callsign, provider, idToken: mint(provider, sub, n), nonce: n,
        recovery: { shares: [{ holderType: 'sso', holderRef: provider, shareIndex: 1, ...sealed }] },
    });
}

// ── the restore, as a new device with only the sign-in ──────────────────────────────────────────
async function findBy(eph: Id, provider: Provider, sub: string, opts: { as?: string } = {}): Promise<{ nonce: { status: number; body: any }; found: { status: number; body: any } }> {
    const nonce = await call(eph, '/api/recovery/find-nonce', {});
    const n = typeof nonce.body?.nonce === 'string' ? nonce.body.nonce : 'no-nonce';
    const found = await call(eph, '/api/recovery/find', { provider: opts.as ?? provider, idToken: mint(provider, sub, n), nonce: n });
    return { nonce, found };
}
const names = (found: { body: any }): string[] => (Array.isArray(found.body?.accounts) ? found.body.accounts : []).map((a: any) => `${a.callsign}:${a.publicKey}`).sort();
const collect = (eph: Id, pk: string) => call(eph, '/api/recovery/collect', { candidatePublicKey: pk });

/** The released copy fetched sealed to the device's throwaway key, opened with it and then with the sign-in: whose key? */
async function openReleased(eph: Id, collectionId: string, provider: Provider, sub: string): Promise<{ status: number; pk: string | null; error: string | null }> {
    const fr = await call(eph, '/api/recovery/collect/fragments', { collectionId, seal: KEEPER_ALG_RELEASE });
    const f = fr.body?.fragments?.[0];
    if (!f) return { status: fr.status, pk: null, error: `no fragment: ${brief(fr.body)}` };
    try {
        const copy = openReleaseOnDevice({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, ephemeralPubkey: f.ephemeralPubkey, kdfParams: f.kdfParams },
            new Uint8Array(eph.seed), { collectionId, holderType: 'sso' });
        const opened = await openSeedFromSso({ ...copy, kdfParams: copy.kdfParams ?? '' }, provider, sub);
        return { status: fr.status, pk: idFromSeed(Buffer.from(opened.seed)).pk, error: null };
    } catch (e) {
        return { status: fr.status, pk: null, error: (e as Error)?.message || String(e) };
    }
}

// ── what the database says ──────────────────────────────────────────────────────────────────────
const sessionsFor = (pk: string): number => (db.prepare('SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ?').get(pk) as { n: number }).n;
const releasesFor = (pk: string): number => (db.prepare('SELECT COUNT(*) AS n FROM recovery_releases WHERE owner_pubkey = ?').get(pk) as { n: number }).n;
const allSessions = (): number => (db.prepare('SELECT COUNT(*) AS n FROM recovery_collections').get() as { n: number }).n;
const allPushes = (): number => (db.prepare('SELECT COUNT(*) AS n FROM push_notices').get() as { n: number }).n;
const pushesTo = (pk: string): string[] => (db.prepare('SELECT kind FROM push_notices WHERE recipient = ? ORDER BY rowid').all(pk) as { kind: string }[]).map((r) => r.kind);
/** A phone registered for the member, so a push to them is kept (push_notices) and one that should not come would show. */
const withPhone = (id: Id): void => { registerPushToken(id.pk, `ExponentPushToken[find-${id.pk.slice(0, 8)}]`, 'android'); };
/** The member's current sign-in row for `provider`: its find hash and stamp (undefined before the column exists). */
function rowOf(pk: string, provider: Provider): { id: number; findHash: string | null | undefined; lookupHash: string | null; updatedAt: string } | null {
    const r = db.prepare(`SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso' AND holder_ref = ?
                          AND generation = (SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = ?)`).get(pk, provider, pk) as any;
    return r ? { id: r.id, findHash: r.sso_find_hash, lookupHash: r.sso_lookup_hash, updatedAt: r.updated_at } : null;
}
/** The find hash this suite expects, worked out on its own: HMAC-SHA-256 of `provider|sub` under the seal file's find key. */
function expectedFindHash(provider: Provider, sub: string): string {
    const key = recoverySealSubkey('beanpool-recovery-find/v1', 32);
    if (!key) return 'no key';
    return crypto.createHmac('sha256', Buffer.from(key)).update(`${provider}|${sub}`, 'utf-8').digest('base64url');
}

// The engine's own clock and counters, which the routes cannot show: the hold's age and how many scans ran.
type FindEngine = {
    FIND_HOLD_TTL_MS: number;
    findScanStats(): { scans: number; scrypts: number; healed: number; scanning: boolean };
    countUnfindableSignInCopies(): number;
    _ageFindHoldForTests(throwawayKey: string, byMs: number): boolean;
    _holdsFindForTests(throwawayKey: string): boolean;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    console.log(`\n=== Recovery without a typed name (S0), as ${GLOBAL ? 'the global community' : 'a local community'} ===\n`);
    const bootLines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { bootLines.push(args.map(String).join(' ')); realLog(...args); };
    await initTls();
    try { initStateEngine(); } finally { console.log = realLog; }
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    primeJwks();
    _clearNoncesForTests();
    const engine = (await import('./engine/recovery-find.js').catch(() => null)) as FindEngine | null;
    check(!!engine, 'the find engine exists (engine/recovery-find.ts)');

    const info = await (await localFetch(`${BASE}/api/community/info`)).json() as any;
    check(info?.features?.openJoin === GLOBAL, `the node runs as ${GLOBAL ? 'the global community (its open door on)' : 'a local community (no open door)'} (openJoin ${info?.features?.openJoin})`);
    check(bootLines.some((l) => /\b0 sign-in copies not yet findable by sign-in\b/.test(l)),
        `a main server's boot log counts the copies not yet findable by sign-in: none on a new database (${brief(bootLines.filter((l) => /findable/.test(l)))})`);

    // ── 1. deposit, find, collect by the hold, open ─────────────────────────────────────────────────
    console.log('\n── 1. one sign-in finds its one account, and brings it back ──');
    const DAMO_SUB = '110169484474386276334';
    const damo = newId();
    const damoName = GLOBAL ? 'Damo276729' : 'Monnunit';
    if (GLOBAL) {
        const joined = await joinThroughDoor(damo, damoName, 'google', DAMO_SUB);
        check(joined.status === 200 && joined.body?.recovery?.enrolled === true,
            `global: ${damoName} joins through the open door with Google, which enrols the same sign-in (${joined.status} ${brief(joined.body?.recovery)})`);
    } else {
        addMember(damo, damoName);
        const smuggled = await connect(damo, 'google', DAMO_SUB, { ssoFindHash: 'chosen-by-the-client' });
        check(smuggled.status === 400 && rowOf(damo.pk, 'google') === null,
            `a deposit that carries its own find hash is refused, as one carrying a lookup hash is: the node derives it (${smuggled.status} ${brief(smuggled.body)})`);
        const connected = await connect(damo, 'google', DAMO_SUB);
        check(connected.status === 200, `local: ${damoName} connects Google in Settings (${connected.status} ${brief(connected.body)})`);
    }
    withPhone(damo);
    const damoRow = rowOf(damo.pk, 'google');
    check(!!damoRow?.findHash && damoRow.findHash === expectedFindHash('google', DAMO_SUB) && damoRow.findHash !== damoRow.lookupHash,
        `the deposit wrote the find hash: HMAC-SHA-256 of "google|sub" under the seal file's find key, beside the per-row lookup hash (${damoRow?.findHash ? 'set' : String(damoRow?.findHash)})`);
    check(!db.serialize().includes(Buffer.from(DAMO_SUB)), 'and the raw sub is nowhere in the database');

    const unsigned = await call(null, '/api/recovery/find-nonce', {});
    const unsignedFind = await call(null, '/api/recovery/find', { provider: 'google', idToken: 'x', nonce: 'x' });
    check(unsigned.status === 401 && unsignedFind.status === 401, `an unsigned find-nonce or find is refused by the middleware (${unsigned.status}, ${unsignedFind.status})`);

    const phone = newId();
    const pushesBefore = pushesTo(damo.pk).length;
    const first = await findBy(phone, 'google', DAMO_SUB);
    check(first.nonce.status === 200 && typeof first.nonce.body?.nonce === 'string' && first.nonce.body?.expiresInSeconds === 600
        && typeof first.nonce.body?.clientIds === 'object' && first.nonce.body?.clientIds?.google === AUD.google,
        `find-nonce answers as /collect/sso-nonce does, with no session: a nonce, 600 s, the web client ids (${first.nonce.status} ${brief(first.nonce.body)})`);
    check(first.found.status === 200 && brief(names(first.found)) === brief([`${damoName}:${damo.pk}`]),
        `find with the same Google names the one account, by name and key, with nothing typed (${first.found.status} ${brief(first.found.body)})`);
    check(sessionsFor(damo.pk) === 0 && pushesTo(damo.pk).length === pushesBefore, 'a find opens no session and sends no push');
    const restored = await collect(phone, damo.pk);
    check(restored.status === 200 && typeof restored.body?.collectionId === 'string' && restored.body?.progress?.collected === 1
        && restored.body?.threshold === 1 && restored.body?.progress?.enough === true,
        `collect {candidatePublicKey} by the hold opens the session and releases the copy in the same request (${restored.status} ${brief(restored.body)})`);
    const opened = await openReleased(phone, restored.body?.collectionId, 'google', DAMO_SUB);
    check(opened.status === 200 && opened.pk === damo.pk, `the fragments open, sealed to the throwaway key and then with the sign-in, to ${damoName}'s own key (${opened.pk === damo.pk ? 'equal' : opened.error})`);
    check(brief(pushesTo(damo.pk).slice(pushesBefore)) === brief(['account.restored']), `${damoName} is told once that the account was restored (${brief(pushesTo(damo.pk))})`);
    const again = await collect(phone, damo.pk);
    check(again.status === 400 && sessionsFor(damo.pk) === 1, `the hold is spent: the same collect again opens nothing (${again.status} ${brief(again.body)})`);

    // A second sign-in on the same account: each has its own find hash, and a disconnect of one carries the other's.
    const DAMO_APPLE = '001234.damodamodamodamodamodamodamodamo.0001';
    const withApple = await connect(damo, 'apple', DAMO_APPLE);
    check(withApple.status === 200 && rowOf(damo.pk, 'apple')?.findHash === expectedFindHash('apple', DAMO_APPLE)
        && rowOf(damo.pk, 'google')?.findHash === expectedFindHash('google', DAMO_SUB),
        `connecting Apple too writes Apple's find hash and carries Google's into the new generation (${withApple.status})`);
    const byApple = await findBy(newId(), 'apple', DAMO_APPLE);
    check(byApple.found.status === 200 && brief(names(byApple.found)) === brief([`${damoName}:${damo.pk}`]), `Apple finds the same account (${brief(byApple.found.body)})`);
    const dropApple = await disconnect(damo, 'apple');
    check(dropApple === 200 && rowOf(damo.pk, 'apple') === null && rowOf(damo.pk, 'google')?.findHash === expectedFindHash('google', DAMO_SUB),
        `disconnecting Apple keeps Google findable: the next generation carries its find hash (${dropApple})`);

    // ── 2. a stranger ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. a stranger\'s valid sign-in finds nothing ──');
    const stranger = newId();
    const [sessions2, pushes2] = [allSessions(), allPushes()];
    const nobody = await findBy(stranger, 'google', '999999999999999999999');
    check(nobody.found.status === 200 && Array.isArray(nobody.found.body?.accounts) && nobody.found.body.accounts.length === 0,
        `a valid Google sign-in with no account here: a plain 200 and an empty list (${nobody.found.status} ${brief(nobody.found.body)})`);
    const strangerCollect = await collect(stranger, damo.pk);
    check(strangerCollect.status === 400 && allSessions() === sessions2 && allPushes() === pushes2,
        `no session row and no push, and a collect after it naming someone's key opens nothing (${strangerCollect.status} ${brief(strangerCollect.body)})`);

    // ── 3. two owners, one sub ──────────────────────────────────────────────────────────────────────
    console.log('\n── 3. one sign-in that protects two accounts ──');
    const PARENT_SUB = '108765432109876543210';
    const pat = newId(), kit = newId();
    if (GLOBAL) {
        const joined = await joinThroughDoor(pat, 'Pat481516', 'google', PARENT_SUB);
        check(joined.status === 200, `global: Pat joins through the door with the parent's Google (${joined.status})`);
    } else {
        addMember(pat, 'Pat');
        check((await connect(pat, 'google', PARENT_SUB)).status === 200, 'local: Pat connects the parent\'s Google');
    }
    addMember(kit, GLOBAL ? 'Kit2342' : 'Kit');
    check((await connect(kit, 'google', PARENT_SUB)).status === 200, 'Kit connects the same Google in Settings (Connect checks no other owner)');
    const patName = GLOBAL ? 'Pat481516' : 'Pat', kitName = GLOBAL ? 'Kit2342' : 'Kit';
    withPhone(pat);
    withPhone(kit);
    const family = newId();
    const both = await findBy(family, 'google', PARENT_SUB);
    check(both.found.status === 200 && brief(names(both.found)) === brief([`${kitName}:${kit.pk}`, `${patName}:${pat.pk}`].sort()),
        `the find names both accounts, by name and key (${brief(both.found.body)})`);
    const kitBack = await collect(family, kit.pk);
    const kitOpened = await openReleased(family, kitBack.body?.collectionId, 'google', PARENT_SUB);
    check(kitBack.status === 200 && kitOpened.pk === kit.pk && sessionsFor(kit.pk) === 1 && sessionsFor(pat.pk) === 0,
        `collect for Kit opens one session, Kit's, and the copy opens to Kit's key; nothing opens for Pat (${kitBack.status} kit ${sessionsFor(kit.pk)} pat ${sessionsFor(pat.pk)})`);
    check(brief(pushesTo(kit.pk)) === brief(['account.restored']) && pushesTo(pat.pk).length === 0 && releasesFor(pat.pk) === 0,
        `one push, to Kit; none to Pat, and nothing released for Pat (${brief({ kit: pushesTo(kit.pk), pat: pushesTo(pat.pk) })})`);

    // ── 4. a copy made before this change ───────────────────────────────────────────────────────────
    console.log('\n── 4. a copy made before the find hash: the scan finds and heals it, once ──');
    const LEE_SUB = '104444444444444444444';
    const lee = newId();
    addMember(lee, GLOBAL ? 'Lee90210' : 'Lee');
    check((await connect(lee, 'google', LEE_SUB)).status === 200, 'Lee connects Google');
    // As a copy deposited by code from before S0 sits: no find hash, stamped long ago.
    const oldStamp = '2026-10-01T00:00:00.000Z';
    try { db.prepare(`UPDATE recovery_shares SET sso_find_hash = NULL, updated_at = ? WHERE owner_pubkey = ? AND holder_type = 'sso'`).run(oldStamp, lee.pk); } catch { /* no column yet */ }
    // And a GitHub copy the boot's removal left (it never throws; engine/github-sign-in-removal.ts): no sign-in can find it.
    const leftover = newId();
    addMember(leftover, `Leftover${leftover.pk.slice(0, 6)}`);
    db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
                sso_lookup_hash, sso_lookup_salt, kdf_params, generation) VALUES (?, 'sso', 'github', 1, 'x', 'x', 'x', ?, ?, '{}', 1)`)
        .run(leftover.pk, crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(16).toString('base64url'));
    const unfindableBefore = engine?.countUnfindableSignInCopies() ?? -1;
    check(unfindableBefore === 1, `the boot count's query counts Lee's copy as not yet findable, and not a copy of a provider no sign-in uses (${unfindableBefore})`);
    db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(leftover.pk);
    const statsBefore = engine?.findScanStats() ?? { scans: -1, scrypts: -1, healed: -1, scanning: false };
    const leeFound = await findBy(newId(), 'google', LEE_SUB);
    const statsAfterFirst = engine?.findScanStats() ?? statsBefore;
    const healedRow = rowOf(lee.pk, 'google');
    check(leeFound.found.status === 200 && brief(names(leeFound.found)) === brief([`${GLOBAL ? 'Lee90210' : 'Lee'}:${lee.pk}`]),
        `the index finds nothing, so the scan does: Lee's account (${leeFound.found.status} ${brief(leeFound.found.body)})`);
    check(statsAfterFirst.scans === statsBefore.scans + 1 && statsAfterFirst.healed === statsBefore.healed + 1,
        `one scan ran and healed one copy (${brief({ before: statsBefore, after: statsAfterFirst })})`);
    check(healedRow?.findHash === expectedFindHash('google', LEE_SUB) && !!healedRow && healedRow.updatedAt > oldStamp,
        `the copy now holds its find hash, and its stamp moved so a delta carries it to a standby (${healedRow?.updatedAt})`);
    check((engine?.countUnfindableSignInCopies() ?? -1) === unfindableBefore - 1, `the boot count falls by one (${engine?.countUnfindableSignInCopies()})`);
    const leeAgain = await findBy(newId(), 'google', LEE_SUB);
    const statsAfterSecond = engine?.findScanStats() ?? statsBefore;
    check(leeAgain.found.status === 200 && names(leeAgain.found).length === 1 && statsAfterSecond.scans === statsAfterFirst.scans && statsAfterSecond.scrypts === statsAfterFirst.scrypts,
        `the second find comes from the index and runs no scan (${brief({ scans: statsAfterSecond.scans, scrypts: statsAfterSecond.scrypts })})`);

    // One sign-in protecting a copy made before the find hash and one made after it (Marty's decision 3, 9 Nov: known limit
    // 1 of S0). The index finds the newer copy, and the scan still runs for the older one, so both are named, the older one
    // is made findable, and the next find needs no scan.
    const SAM_SUB = '103333333333333333333';
    const ola = newId(), pia = newId();
    const olaName = GLOBAL ? 'Ola5150' : 'Ola', piaName = GLOBAL ? 'Pia8675' : 'Pia';
    addMember(ola, olaName);
    addMember(pia, piaName);
    check((await connect(ola, 'google', SAM_SUB)).status === 200, `${olaName} connects Sam's Google`);
    // Ola's copy, as code from before S0 deposited it: no find hash, stamped long ago.
    try { db.prepare(`UPDATE recovery_shares SET sso_find_hash = NULL, updated_at = ? WHERE owner_pubkey = ? AND holder_type = 'sso'`).run(oldStamp, ola.pk); } catch { /* no column yet */ }
    const piaConnected = await connect(pia, 'google', SAM_SUB);
    check(piaConnected.status === 200 && rowOf(pia.pk, 'google')?.findHash === expectedFindHash('google', SAM_SUB),
        `${piaName} connects the same Google after the find hash came, and ${piaName}'s copy holds it (${piaConnected.status})`);
    const unfindableSam = engine?.countUnfindableSignInCopies() ?? -1;
    check(unfindableSam === 1, `setup: ${olaName}'s copy is the only one not yet findable (${unfindableSam})`);
    const samStats0 = engine?.findScanStats() ?? { scans: -1, scrypts: -1, healed: -1, scanning: false };
    const samPhone = newId();
    const samFirst = await findBy(samPhone, 'google', SAM_SUB);
    const samStats1 = engine?.findScanStats() ?? samStats0;
    const samBoth = brief([`${olaName}:${ola.pk}`, `${piaName}:${pia.pk}`].sort());
    check(samFirst.found.status === 200 && brief(names(samFirst.found)) === samBoth,
        `the index finds ${piaName}, and the scan still runs and finds ${olaName}: both are named (${samFirst.found.status} ${brief(samFirst.found.body)})`);
    check(samStats1.scans === samStats0.scans + 1 && samStats1.healed === samStats0.healed + 1
        && rowOf(ola.pk, 'google')?.findHash === expectedFindHash('google', SAM_SUB) && (engine?.countUnfindableSignInCopies() ?? -1) === 0,
        `one scan ran and made ${olaName}'s copy findable; the boot count is 0 again (${brief({ before: samStats0, after: samStats1 })})`);
    const olaBack = await collect(samPhone, ola.pk);
    const olaOpened = await openReleased(samPhone, olaBack.body?.collectionId, 'google', SAM_SUB);
    check(olaBack.status === 200 && olaOpened.pk === ola.pk,
        `the hold names the scan's account too: collect for ${olaName} opens, and the copy opens to ${olaName}'s key (${olaBack.status} ${olaOpened.pk === ola.pk ? 'equal' : olaOpened.error})`);
    const samSecond = await findBy(newId(), 'google', SAM_SUB);
    const samStats2 = engine?.findScanStats() ?? samStats1;
    check(samSecond.found.status === 200 && brief(names(samSecond.found)) === samBoth && samStats2.scans === samStats1.scans && samStats2.scrypts === samStats1.scrypts,
        `the second find names both from the index and runs no scan (${brief({ found: names(samSecond.found).length, scans: samStats2.scans, scrypts: samStats2.scrypts })})`);

    // One scan at a time: copies nobody's sign-in matches (a community's old copies), and two strangers at once.
    const fillers: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < 24; i++) {
            const f = newId();
            fillers.push(f.pk);
            addMember(f, `Old${i}x${f.pk.slice(0, 6)}`);
            db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
                        sso_lookup_hash, sso_lookup_salt, kdf_params, generation) VALUES (?, 'sso', 'google', 1, 'x', 'x', 'x', ?, ?, ?, 1)`)
                .run(f.pk, crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(16).toString('base64url'),
                    JSON.stringify({ alg: 'node-wrap-xc20p-v1', inner: 'scrypt-xc20p-single-v1' }));
        }
    })();
    const firstStranger = findBy(newId(), 'google', '777777777777777777777');
    let waited = 0;
    while (!(engine?.findScanStats().scanning) && waited < 10_000) { await sleep(5); waited += 5; }
    check(!!engine?.findScanStats().scanning, `a stranger's find is scanning the community's ${fillers.length} old copies (waited ${waited} ms)`);
    // Two at once, while that scan runs: a stranger, and Sam, whose copies the index finds but who needs the scan too,
    // since the community still holds copies with no find hash. A find names both sets or none: half a list could hide
    // the account the member came for.
    const [secondStranger, samWhileBusy] = await Promise.all([
        findBy(newId(), 'google', '888888888888888888888'),
        findBy(newId(), 'google', SAM_SUB),
    ]);
    // Worded so no app's match catches it (test-member-words: the web's join reads "try again in " as a sentence that
    // already says when); the apps read the code.
    check(secondStranger.found.status === 503 && secondStranger.found.body?.error === 'Busy finding another account. Wait a minute, then sign in again.'
        && secondStranger.found.body?.code === 'find_busy',
        `a second caller meanwhile gets 503 find_busy, "Busy finding another account. Wait a minute, then sign in again." (${secondStranger.found.status} ${brief(secondStranger.found.body)})`);
    check(samWhileBusy.found.status === 503 && samWhileBusy.found.body?.code === 'find_busy',
        `and so does a find whose index found accounts, while copies wait for a scan: both sets or none (${samWhileBusy.found.status} ${brief(samWhileBusy.found.body)})`);
    const firstDone = await firstStranger;
    check(firstDone.found.status === 200 && firstDone.found.body?.accounts?.length === 0 && !engine?.findScanStats().scanning,
        `the first finishes with its empty list, and the next scan may start (${firstDone.found.status})`);
    db.transaction(() => { for (const pk of fillers) db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(pk); })();

    // ── 5. keys a take-over replaced ────────────────────────────────────────────────────────────────
    console.log('\n── 5. a key a take-over replaced: every copy stays findable through the next take-over ──');
    const REN_SUB = '105555555555555555555', VIC_SUB = '105555555555555555557', WES_SUB = '105555555555555555558';
    const UMA_SUB = '105555555555555555556', UMA_APPLE = '001234.umaumaumaumaumaumaumaumaumaumaum.0005';
    const WES_APPLE = '001234.weswesweswesweswesweswesweswes.0006';
    const ren = newId(), vic = newId(), uma = newId(), wes = newId();
    const renName = GLOBAL ? 'Ren31337' : 'Ren', vicName = GLOBAL ? 'Vic4242' : 'Vic', umaName = GLOBAL ? 'Uma1999' : 'Uma', wesName = GLOBAL ? 'Wes7007' : 'Wes';
    for (const [id, name] of [[ren, renName], [vic, vicName], [uma, umaName], [wes, wesName]] as [Id, string][]) addMember(id, name);
    const connected5 = [await connect(ren, 'google', REN_SUB), await connect(vic, 'google', VIC_SUB), await connect(uma, 'google', UMA_SUB),
        await connect(uma, 'apple', UMA_APPLE), await connect(wes, 'google', WES_SUB), await connect(wes, 'apple', WES_APPLE)];
    check(connected5.every((c) => c.status === 200),
        `Ren, Vic, Uma and Wes (both with Google, then Apple) connect while this server runs on its own key (${connected5.map((c) => c.status).join(' ')})`);
    const umaAppleUnderOld = rowOf(uma.pk, 'apple')?.findHash;
    const wesGoogleUnderOld = rowOf(wes.pk, 'google')?.findHash;
    // A take-over or a sealed-backup restore brings the community's key (services/recovery-seal-key.ts): this server's own
    // is kept beside it, retired, and the next start locks every copy only that one opens again with the live key. A find
    // hash can't be worked out again without the member's sub.
    const carried = installCarriedRecoverySealKey(crypto.randomBytes(32).toString('base64'));
    check(carried.outcome === 'replaced' && !!umaAppleUnderOld && rowOf(ren.pk, 'google')?.findHash !== expectedFindHash('google', REN_SUB),
        `setup: the carried key is live and this server's own is retired; the find hashes are still the retired key's (${carried.outcome})`);

    // Until that start (one whose relock failed runs on as it is): the index tries the retired key's hash too.
    const scansBeforeVic = engine?.findScanStats().scans ?? -1;
    const vicFound = await findBy(newId(), 'google', VIC_SUB);
    check(vicFound.found.status === 200 && brief(names(vicFound.found)) === brief([`${vicName}:${vic.pk}`]) && engine?.findScanStats().scans === scansBeforeVic
        && rowOf(vic.pk, 'google')?.findHash === expectedFindHash('google', VIC_SUB),
        `before the relock, a find tries the retired key's hash too: Vic is found with no scan, and Vic's find hash is written again under the live key (${brief(vicFound.found.body)})`);
    // And a deposit locks every copy it carries with the live key: Uma connects Google again, which carries Apple. Apple's
    // find hash is the retired key's, and once the copy opens under the live key no relock comes to it.
    const umaAgain = await connect(uma, 'google', UMA_SUB);
    const umaAppleCarried = rowOf(uma.pk, 'apple')?.findHash;
    check(umaAgain.status === 200 && umaAppleCarried === null,
        `a deposit carries a copy only the retired key opened without that key's find hash, which no take-over could find it by (${umaAgain.status}, ${umaAppleCarried === null ? 'none' : umaAppleCarried === umaAppleUnderOld ? 'the retired key\'s kept' : String(umaAppleCarried)})`);
    // So does a disconnect: Wes disconnects Apple, which carries Google.
    const wesDropped = await disconnect(wes, 'apple');
    const wesGoogleCarried = rowOf(wes.pk, 'google')?.findHash;
    check(wesDropped === 200 && rowOf(wes.pk, 'apple') === null && !!wesGoogleUnderOld && wesGoogleCarried === null,
        `and so does a disconnect: Wes's Google, carried when Apple goes, without the retired key's find hash (${wesDropped}, ${wesGoogleCarried === null ? 'none' : wesGoogleCarried === wesGoogleUnderOld ? 'the retired key\'s kept' : String(wesGoogleCarried)})`);

    // The start after the key change: every copy only the retired key opens is locked again with the live key.
    const renBefore = rowOf(ren.pk, 'google');
    const relocked = rewrapRowsFromRetiredKeys();
    const renAfter = rowOf(ren.pk, 'google');
    check(relocked.shares > 0 && renAfter?.findHash === null && !!renBefore && !!renAfter && renAfter.updatedAt > renBefore.updatedAt,
        `the relock locks Ren's copy again with the live key and clears its find hash, the retired key's, in the same stamped write (${relocked.shares} relocked, ${renAfter?.findHash === null ? 'cleared' : 'kept'})`);

    // The next server: a take-over carries the live key only (services/takeover-envelope.ts BUNDLED_FILES), never a retired
    // one, and a sealed backup is the same bundle.
    const dataDir = path.dirname(recoverySealKeyPath());
    const retiredFiles = fs.readdirSync(dataDir).filter((n) => /^recovery-seal-retired-[0-9a-f]{16}\.key$/.test(n));
    for (const n of retiredFiles) fs.renameSync(path.join(dataDir, n), path.join(dataDir, `${n}.next-server-holds-none`));
    let renOpens = false;
    try { renOpens = getCurrentShares(ren.pk).some((s) => s.holderType === 'sso' && s.holderRef === 'google'); } catch { /* does not open */ }
    check(retiredFiles.length === 1 && renOpens, `setup: the next server holds the live key only (${retiredFiles.length} retired key set aside), and Ren's copy opens under it`);
    const unfindable5 = engine?.countUnfindableSignInCopies() ?? -1;
    const scansBeforeRen = engine?.findScanStats().scans ?? -1;
    const renPhone = newId();
    const renFound = await findBy(renPhone, 'google', REN_SUB);
    check(renFound.found.status === 200 && brief(names(renFound.found)) === brief([`${renName}:${ren.pk}`]) && engine?.findScanStats().scans === scansBeforeRen + 1,
        `there, Ren's sign-in still finds Ren, by the scan (${renFound.found.status} ${brief(renFound.found.body)})`);
    const unfindableAfterRen = engine?.countUnfindableSignInCopies() ?? -1;
    check(unfindable5 >= 1 && unfindableAfterRen === unfindable5 - 1 && rowOf(ren.pk, 'google')?.findHash === expectedFindHash('google', REN_SUB),
        `the boot count showed Ren's copy until then (${unfindable5}, then ${unfindableAfterRen}), and the scan wrote its find hash under the live key`);
    const umaByApple = await findBy(newId(), 'apple', UMA_APPLE);
    const wesByGoogle = await findBy(newId(), 'google', WES_SUB);
    const vicThere = await findBy(newId(), 'google', VIC_SUB);
    check(brief(names(umaByApple.found)) === brief([`${umaName}:${uma.pk}`]) && rowOf(uma.pk, 'apple')?.findHash === expectedFindHash('apple', UMA_APPLE)
        && brief(names(wesByGoogle.found)) === brief([`${wesName}:${wes.pk}`]) && rowOf(wes.pk, 'google')?.findHash === expectedFindHash('google', WES_SUB)
        && brief(names(vicThere.found)) === brief([`${vicName}:${vic.pk}`]),
        `and the copies the deposit and the disconnect carried (Uma's Apple, Wes's Google) and Vic's are found there too (${brief([umaByApple.found.body, wesByGoogle.found.body, vicThere.found.body])})`);
    const renBack = await collect(renPhone, ren.pk);
    const renOpened = await openReleased(renPhone, renBack.body?.collectionId, 'google', REN_SUB);
    check(renBack.status === 200 && renOpened.pk === ren.pk, `Ren's copy, locked again with the live key, comes back to Ren's own key (${renBack.status} ${renOpened.pk === ren.pk ? 'equal' : renOpened.error})`);

    // ── 6. no hold, or not one of its matches ───────────────────────────────────────────────────────
    console.log('\n── 6. collect needs the hold, and only for an account the find named ──');
    const sessions6 = allSessions();
    const noHold = await collect(newId(), damo.pk);
    check(noHold.status === 400 && noHold.body?.error === "Sign in with your account's sign-in first." && allSessions() === sessions6,
        `a device that never found anything: 400 "Sign in with your account's sign-in first.", nothing opened (${noHold.status} ${brief(noHold.body)})`);
    // With no hold, every key gets that same answer: a member's here, a key that is no member, a visitor's row. Otherwise a
    // stranger holding a key from another community could ask whether it belongs to a member here.
    const visitor = newId();
    addMember(visitor, `Visitor${visitor.pk.slice(0, 6)}`);
    db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(visitor.pk);
    const probes = [damo.pk, newId().pk, visitor.pk];
    const answers = await Promise.all(probes.map((pk) => collect(newId(), pk)));
    check(answers.every((a) => a.status === 400 && a.body?.error === "Sign in with your account's sign-in first.") && allSessions() === sessions6,
        `with no hold, a member's key, a key that is no member and a visitor's row all get the same 400: no oracle for who is a member (${brief(answers.map((a) => a.body?.error))})`);
    const patPhone = newId();
    const patFind = await findBy(patPhone, 'google', PARENT_SUB);
    check(names(patFind.found).length === 2, 'setup: the parent\'s Google names Pat and Kit');
    const notMatched = await collect(patPhone, damo.pk);
    check(notMatched.status === 400 && sessionsFor(damo.pk) === 1 && allSessions() === sessions6,
        `a key the find did not name opens nothing (${notMatched.status} ${brief(notMatched.body)})`);
    const otherDevice = await collect(newId(), pat.pk);
    check(otherDevice.status === 400 && sessionsFor(pat.pk) === 0, `another device cannot use this device's hold: it is keyed by the throwaway key that signed the find (${otherDevice.status})`);
    const patBack = await collect(patPhone, pat.pk);
    check(patBack.status === 200 && sessionsFor(pat.pk) === 1, `while the right device, naming a key the find named, still can (${patBack.status})`);

    // ── 7. the hold dies at 5 minutes ───────────────────────────────────────────────────────────────
    console.log('\n── 7. the hold lasts 5 minutes ──');
    check(engine?.FIND_HOLD_TTL_MS === 5 * 60 * 1000, `the hold is kept 5 minutes (${engine?.FIND_HOLD_TTL_MS} ms)`);
    const slow = newId();
    await findBy(slow, 'google', DAMO_SUB);
    const aged4 = engine?._ageFindHoldForTests(slow.pk, 4 * 60 * 1000) ?? false;
    const at4 = await collect(slow, damo.pk);
    check(aged4 && at4.status === 200, `4 minutes after the find, the collect still works (${at4.status})`);
    const slower = newId();
    await findBy(slower, 'google', DAMO_SUB);
    const sessions7 = sessionsFor(damo.pk);
    const aged5 = engine?._ageFindHoldForTests(slower.pk, 5 * 60 * 1000) ?? false;
    const at5 = await collect(slower, damo.pk);
    check(aged5 && at5.status === 400 && sessionsFor(damo.pk) === sessions7, `5 minutes after it, the hold is gone and nothing opens (${at5.status} ${brief(at5.body)})`);
    // Nothing has to come by for it to go: a hold keeps a verified sub, so it leaves memory when its time is up, on a quiet
    // server too, with no find or collect after it.
    const idle = newId();
    await findBy(idle, 'google', DAMO_SUB);
    const heldIdle = engine?._holdsFindForTests(idle.pk) ?? false;
    engine?._ageFindHoldForTests(idle.pk, 5 * 60 * 1000);
    await sleep(50);
    const stillHeld = engine?._holdsFindForTests(idle.pk) ?? true;
    check(heldIdle && !stillHeld,
        `with no find or collect after it, an expired hold and its verified sub are gone from memory at its 5 minutes (${heldIdle ? 'held' : 'never held'}, then ${stillHeld ? 'still held' : 'gone'})`);

    // ── 8. a token from another provider ────────────────────────────────────────────────────────────
    console.log('\n── 8. another provider\'s token is refused by the verifier ──');
    const crossed = newId();
    const viaFind = await findBy(crossed, 'google', DAMO_SUB, { as: 'apple' });
    check(viaFind.found.status === 400 && viaFind.found.body?.error === `Apple token has wrong issuer (${ISS.google})`,
        `a Google token sent as Apple: 400 with the verifier's own sentence, its issuer named (${viaFind.found.status} ${brief(viaFind.found.body)})`);
    const crossedCollect = await collect(crossed, damo.pk);
    check(crossedCollect.status === 400, `and it holds nothing to collect with (${crossedCollect.status})`);
    const notAProvider = await findBy(newId(), 'google', DAMO_SUB, { as: 'github' });
    check(notAProvider.found.status === 400 && notAProvider.found.body?.error === "'github' is not a sign-in provider this node can verify.",
        `a provider this node doesn't verify: refused by name (${brief(notAProvider.found.body)})`);

    // ── 9. a standby ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. a standby refuses ──');
    const atStandby = newId();
    await findBy(atStandby, 'google', DAMO_SUB); // a hold made on the main server
    const waitingNonce = (await call(atStandby, '/api/recovery/find-nonce', {})).body?.nonce;
    const sessions9 = allSessions();
    setNodeRole('backup');
    let standby: { nonce: any; find: any; collect: any };
    try {
        standby = {
            nonce: await call(newId(), '/api/recovery/find-nonce', {}),
            find: await call(atStandby, '/api/recovery/find', { provider: 'google', idToken: mint('google', DAMO_SUB, waitingNonce), nonce: waitingNonce }),
            collect: await collect(atStandby, damo.pk),
        };
    } finally {
        setNodeRole('primary');
    }
    check(standby.nonce.status === 409 && standby.nonce.body?.code === 'standby' && standby.find.status === 409 && standby.find.body?.code === 'standby',
        `a standby answers find-nonce and find with 409 standby, before any sign-in is checked (${standby.nonce.status} ${standby.find.status} ${brief(standby.find.body)})`);
    check(standby.collect.status === 409 && standby.collect.body?.code === 'standby' && allSessions() === sessions9,
        `and a collect by a hold with 409 standby, opening nothing (${standby.collect.status} ${brief(standby.collect.body)})`);
    const afterStandby = await collect(atStandby, damo.pk);
    check(afterStandby.status === 200, `the refusal kept the member's hold: the main server's collect works (${afterStandby.status})`);

    // ── 10. no seal key ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 10. a server without its recovery-seal key ──');
    const keyless = newId();
    const keylessNonce = (await call(keyless, '/api/recovery/find-nonce', {})).body?.nonce;
    const keyPath = recoverySealKeyPath();
    const aside = `${keyPath}.aside-for-test`;
    const heldPhone = newId();
    await findBy(heldPhone, 'google', DAMO_SUB);
    const sessions10 = allSessions();
    fs.renameSync(keyPath, aside);
    let noKey: { find: any; collect: any };
    try {
        noKey = {
            find: await call(keyless, '/api/recovery/find', { provider: 'google', idToken: mint('google', DAMO_SUB, keylessNonce), nonce: keylessNonce }),
            collect: await collect(heldPhone, damo.pk),
        };
    } finally {
        fs.renameSync(aside, keyPath);
    }
    check(noKey.find.status === 503 && noKey.find.body?.error === RECOVERY_SEAL_KEY_MISSING && noKey.find.body?.code === 'recovery_seal_key_missing',
        `find answers 503 with the sentence: "${RECOVERY_SEAL_KEY_MISSING}" (${noKey.find.status} ${brief(noKey.find.body)})`);
    check(noKey.collect.status === 503 && noKey.collect.body?.error === RECOVERY_SEAL_KEY_MISSING && allSessions() === sessions10,
        `so does a collect by a hold, opening nothing (${noKey.collect.status})`);
    const keyBack = await call(keyless, '/api/recovery/find', { provider: 'google', idToken: mint('google', DAMO_SUB, keylessNonce), nonce: keylessNonce });
    const heldBack = await collect(heldPhone, damo.pk);
    check(keyBack.status === 200 && names(keyBack).length === 1 && heldBack.status === 200,
        `with the key back, the same nonce still finds (it was not spent) and the hold still collects (${keyBack.status} ${heldBack.status})`);

    // ── 11. the index is never the proof ────────────────────────────────────────────────────────────
    console.log('\n── 11. a find hash that matches over a lookup hash that does not releases nothing ──');
    const IVY_SUB = '106666666666666666666', MALLORY_SUB = '107777777777777777777';
    const ivy = newId();
    addMember(ivy, GLOBAL ? 'Ivy8080' : 'Ivy');
    check((await connect(ivy, 'google', IVY_SUB)).status === 200, 'Ivy connects Google');
    withPhone(ivy);
    // Someone who can write the database files Mallory's find hash on Ivy's copy. The copy and its lookup hash stay Ivy's.
    try { db.prepare(`UPDATE recovery_shares SET sso_find_hash = ? WHERE owner_pubkey = ? AND holder_type = 'sso'`).run(expectedFindHash('google', MALLORY_SUB), ivy.pk); } catch { /* no column yet */ }
    const mallory = newId();
    const malloryFind = await findBy(mallory, 'google', MALLORY_SUB);
    check(malloryFind.found.status === 200 && names(malloryFind.found).includes(`${GLOBAL ? 'Ivy8080' : 'Ivy'}:${ivy.pk}`),
        `setup: Mallory's sign-in finds Ivy by the planted index entry (${brief(malloryFind.found.body)})`);
    const malloryCollect = await collect(mallory, ivy.pk);
    check(malloryCollect.status === 400 && releasesFor(ivy.pk) === 0 && pushesTo(ivy.pk).length === 0 && sessionsFor(ivy.pk) === 0,
        `the collect runs the per-row scrypt proof, which Mallory's sub fails: nothing released, no push, no session left (${malloryCollect.status} ${brief(malloryCollect.body)})`);

    // ── 12. the name routes are gone (S3) ───────────────────────────────────────────────────────────
    console.log('\n── 12. the name routes are gone, and say so ──');
    // Design §4: an app from before S2 (1.3.4) asks the lookup first and reads any answer but a list as "can't reach the
    // community"; the server's own answer is 404 and the one sentence, in JSON, never a page or a 401.
    const NO_NAME_ERROR = 'This community no longer finds an account by its name. Update the app to restore with your sign-in, or use your 12 words.';
    const isNoName = (r: { status: number; body: any }) => r.status === 404 && r.body?.error === NO_NAME_ERROR && r.body?.code === 'no_restore_by_name';
    const sessions12 = allSessions(), releases12 = releasesFor(damo.pk), pushes12 = allPushes();
    pruneAuthAttempts(Date.now() + 120_000); resetGatewayRateLimit();
    const lookupRes = await localFetch(`${BASE}/api/recovery/lookup/${encodeURIComponent(damoName)}`);
    const lookupText = await lookupRes.text();
    let lookupBody: any;
    try { lookupBody = JSON.parse(lookupText); } catch { lookupBody = undefined; }
    check(isNoName({ status: lookupRes.status, body: lookupBody }) && /application\/json/.test(lookupRes.headers.get('content-type') ?? '')
        && !lookupText.includes(damo.pk) && !lookupText.includes(damoName),
        `the lookup by name, unsigned as an old app asks it: 404 and the sentence, in JSON, naming nobody (${lookupRes.status} ${brief(lookupText)})`);
    const oldApp = newId();
    const oldNonce = await call(oldApp, '/api/recovery/collect/sso-nonce', { collectionId: restored.body?.collectionId });
    const oldRelease = await call(oldApp, '/api/recovery/collect/sso', {
        collectionId: restored.body?.collectionId, provider: 'google', idToken: mint('google', DAMO_SUB, 'any'), nonce: 'any',
    });
    check(isNoName(oldNonce) && isNoName(oldRelease),
        `/collect/sso-nonce and /collect/sso answer 404 and the same sentence (${oldNonce.status} ${brief(oldNonce.body)} | ${oldRelease.status} ${brief(oldRelease.body)})`);
    // The two shapes of a collect by name: 1.3.4 sends the key the lookup listed beside the name; older apps the name alone.
    const byName = await call(oldApp, '/api/recovery/collect', { callsign: damoName });
    const byNameAndKey = await call(oldApp, '/api/recovery/collect', { callsign: damoName, candidatePublicKey: damo.pk });
    check(byName.status === 400 && byNameAndKey.status === 400 && byNameAndKey.body?.error === "Sign in with your account's sign-in first.",
        `a collect by name is refused: it names no hold (${byName.status} ${brief(byName.body)} | ${byNameAndKey.status} ${brief(byNameAndKey.body)})`);
    check(allSessions() === sessions12 && releasesFor(damo.pk) === releases12 && allPushes() === pushes12,
        'none of them opened a session, released a copy or sent a push');
    const afterS3 = newId();
    const refound = await findBy(afterS3, 'google', DAMO_SUB);
    const recollected = await collect(afterS3, damo.pk);
    const reopened = await openReleased(afterS3, recollected.body?.collectionId, 'google', DAMO_SUB);
    check(refound.found.status === 200 && brief(names(refound.found)) === brief([`${damoName}:${damo.pk}`]) && recollected.status === 200 && reopened.pk === damo.pk,
        `and the find still restores ${damoName}, with nothing typed (${refound.found.status} ${recollected.status} ${reopened.pk === damo.pk ? 'equal' : reopened.error})`);
    // What the lookup's own tests pinned (test-callsign-predicates), now on the find that replaced it: a member who left
    // (pruned) or moved to a new key (migrated) is never offered, though the copy's row is still there.
    for (const [status, sub, name] of [['pruned', '108888888888888888881', 'Fern'], ['migrated', '108888888888888888882', 'Moss']] as const) {
        const gone = newId();
        addMember(gone, GLOBAL ? `${name}4242` : name);
        const deposited = await connect(gone, 'google', sub);
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, gone.pk);
        const lookedFor = await findBy(newId(), 'google', sub);
        check(deposited.status === 200 && rowOf(gone.pk, 'google') !== null && lookedFor.found.status === 200 && names(lookedFor.found).length === 0,
            `a ${status} member's sign-in finds nothing, though the copy's row is there (${deposited.status} ${brief(lookedFor.found.body)})`);
    }

    const providerCalls = outsideCalls.filter((u) => /google|apple|facebook/i.test(u));
    check(providerCalls.length === 0, `no provider was contacted (${brief(providerCalls)})`);

    console.log(`\n${passed}/${run} checks passed (${GLOBAL ? 'global' : 'local'} community).`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery without a typed name (S0) checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
