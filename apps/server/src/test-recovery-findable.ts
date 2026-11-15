/**
 * Whether a restore can find a member's account from each of their sign-ins (scratch design DESIGN-recovery-no-callsign-
 * fable.md §8, slice S4; Marty's decision 2 of 9 Nov 2026, his yes of 15 Nov): POST /api/recovery/shares/status says, per
 * connected sign-in, whether its copy holds its find hash (`findableSso`), and Refresh, which is the ordinary Connect
 * (POST /api/recovery/sso-nonce, then POST /api/recovery/shares/sso), writes it. Over real HTTPS through the real
 * signature middleware, with a stand-in Google key in the JWKS cache. No provider, registrar or BeanPool node is contacted.
 *
 *   1. the class, closed in one table: a copy made before S0 / after S0 / healed by the scan / refreshed, each through the
 *      real route and then through core's signInsToRefresh, the one rule both apps draw Refresh by
 *   2. a member with no copy: two empty lists, nothing to refresh
 *   3. another member's sign-in: never in a member's answer; unsigned is 401; a body naming another key changes nothing
 *   4. Refresh makes no second copy and no second account, and the find then names that one account, from the index
 *   5. a failed Connect changes nothing: the copy, its missing find hash and the answer stay as they were
 *   6. the answer gives nothing a stranger could use: provider names only, never a hash; every field an older app reads
 *      is still there
 *   7. a standby answers the same
 *
 * The bounded scan is untouched by S4: it goes when live servers log 0 (engine/recovery-find.ts).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-findable.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate
delete process.env.CF_RECORD_NAME; // LAN mode: a self-signed certificate, no registrar
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.APPLE_SERVICES_ID;

import crypto from 'node:crypto';
import { sealSeedToSso, signInsToRefresh } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const brief = (v: unknown) => JSON.stringify(v)?.slice(0, 260);

// ── the stand-in Google ─────────────────────────────────────────────────────────────────────────
const AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const KID = 'test-recovery-findable-google';
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function primeJwks(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [{ ...KEY.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any], expiresAt: Date.now() + 3600_000 });
}
const realFetch = globalThis.fetch;
const outsideCalls: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.startsWith('https://localhost:')) return realFetch(input, init);
    outsideCalls.push(url);
    return new Response('stubbed: test-recovery-findable contacts no provider', { status: 503 });
}) as typeof fetch;
function mint(sub: string, nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${header}.${payload}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), KEY.privateKey).toString('base64url')}`;
}

// ── keys and requests ───────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seed: Buffer }
function newId(): Id {
    const seed = crypto.randomBytes(32);
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed };
}
/** A POST signed by `signer`, naming `as` in X-Public-Key (the signer's own unless a test says otherwise). */
async function call(signer: Id | null, p: string, body: unknown, as?: Id): Promise<{ status: number; body: any; raw: string }> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = (as ?? signer).pk;
        headers['X-Signature'] = signRequest(signer.priv, { method: 'POST', path: p, timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await localFetch(`${BASE}${p}`, { method: 'POST', headers, body: raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, raw: text };
}
const status = (id: Id) => call(id, '/api/recovery/shares/status', {});

function addMember(id: Id, callsign: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'recovery-findable-test', 'TEST')`).run(id.pk, callsign);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
}
/**
 * Settings' Connect, and so Refresh: the member's own app seals the seed to the sign-in, asks for a nonce, and deposits.
 * `token` replaces the minted one (a failed sign-in).
 */
async function connect(id: Id, sub: string, token?: string): Promise<{ status: number; body: any }> {
    const sealed = await sealSeedToSso(new Uint8Array(id.seed), 'google', sub);
    const n = (await call(id, '/api/recovery/sso-nonce', {})).body?.nonce;
    return call(id, '/api/recovery/shares/sso', {
        provider: 'google', idToken: token ?? mint(sub, n), nonce: n, shares: [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }],
    });
}
/** A copy as code from before S0 deposited it: no find hash. */
function asMadeBeforeS0(id: Id): void {
    db.prepare(`UPDATE recovery_shares SET sso_find_hash = NULL WHERE owner_pubkey = ? AND holder_type = 'sso'`).run(id.pk);
}
/** A restore on a new device: find-nonce, then find with the sign-in. The accounts named, as `name:key`. */
async function find(sub: string): Promise<{ status: number; names: string[] }> {
    const eph = newId();
    const n = (await call(eph, '/api/recovery/find-nonce', {})).body?.nonce ?? 'no-nonce';
    const found = await call(eph, '/api/recovery/find', { provider: 'google', idToken: mint(sub, n), nonce: n });
    return { status: found.status, names: (Array.isArray(found.body?.accounts) ? found.body.accounts : []).map((a: any) => `${a.callsign}:${a.publicKey}`).sort() };
}
const rowsOf = (pk: string) => db.prepare(`SELECT id, holder_ref, sso_find_hash, generation FROM recovery_shares WHERE owner_pubkey = ?
    AND generation = (SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = ?) ORDER BY id`).all(pk, pk) as { id: number; holder_ref: string; sso_find_hash: string | null; generation: number }[];
const memberCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n;
type FindEngine = { findScanStats(): { scans: number; scrypts: number; healed: number; scanning: boolean } };

async function main(): Promise<void> {
    console.log('\n=== Recovery S4: findable per sign-in, and Refresh ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    primeJwks();
    _clearNoncesForTests();
    const engine = (await import('./engine/recovery-find.js')) as unknown as FindEngine;

    // ── 1. the class, in one table ──────────────────────────────────────────────────────────────────
    console.log('\n── 1. every kind of copy: what status says, and whether Refresh is offered ──');
    type Kind = 'made before S0' | 'made after S0' | 'healed by the scan' | 'refreshed';
    const TABLE: { kind: Kind; findable: boolean; refresh: string[] }[] = [
        { kind: 'made before S0', findable: false, refresh: ['google'] },
        { kind: 'made after S0', findable: true, refresh: [] },
        { kind: 'healed by the scan', findable: true, refresh: [] },
        { kind: 'refreshed', findable: true, refresh: [] },
    ];
    let k = 0;
    for (const row of TABLE) {
        k++;
        const who = newId();
        const sub = `10${String(k).padStart(19, '7')}`;
        addMember(who, `Table${k}`);
        const made = await connect(who, sub);
        if (row.kind !== 'made after S0') asMadeBeforeS0(who);
        let step = { status: made.status, body: made.body as any };
        if (row.kind === 'healed by the scan') {
            const found = await find(sub);
            step = { status: found.status, body: found.names };
        }
        if (row.kind === 'refreshed') step = await connect(who, sub);
        const s = await status(who);
        const findable = Array.isArray(s.body?.findableSso) && s.body.findableSso.includes('google');
        const refresh = signInsToRefresh(s.body);
        check(made.status === 200 && step.status === 200 && s.status === 200 && brief(s.body?.enrolledSso) === brief(['google'])
            && findable === row.findable && brief(refresh) === brief(row.refresh),
            `a copy ${row.kind}: status says ${row.findable ? 'findable' : 'not findable'} and Refresh is ${row.refresh.length ? 'offered' : 'not offered'} `
            + `(${made.status}/${step.status}/${s.status} enrolled ${brief(s.body?.enrolledSso)} findable ${brief(s.body?.findableSso)} refresh ${brief(refresh)})`);
    }

    // ── 2. no copy ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. a member with no copy ──');
    const none = newId();
    addMember(none, 'Nocopy');
    const noneStatus = await status(none);
    check(noneStatus.status === 200 && brief(noneStatus.body?.enrolledSso) === '[]' && brief(noneStatus.body?.findableSso) === '[]'
        && signInsToRefresh(noneStatus.body).length === 0,
        `no copy: two empty lists, nothing to refresh (${noneStatus.status} ${brief({ e: noneStatus.body?.enrolledSso, f: noneStatus.body?.findableSso })})`);

    // ── 3. another member's sign-in ─────────────────────────────────────────────────────────────────
    console.log("\n── 3. only the member's own ──");
    const ada = newId(), bo = newId();
    addMember(ada, 'Ada');
    addMember(bo, 'Bo');
    const ADA_SUB = '105555555555555555551';
    check((await connect(ada, ADA_SUB)).status === 200, 'Ada connects Google');
    asMadeBeforeS0(ada);
    const boStatus = await status(bo);
    check(boStatus.status === 200 && brief(boStatus.body?.enrolledSso) === '[]' && brief(boStatus.body?.findableSso) === '[]',
        `Bo's answer names none of Ada's sign-ins (${brief({ e: boStatus.body?.enrolledSso, f: boStatus.body?.findableSso })})`);
    const unsigned = await call(null, '/api/recovery/shares/status', {});
    check(unsigned.status === 401 && unsigned.body?.findableSso === undefined, `unsigned: 401, and no list (${unsigned.status})`);
    const boAsAda = await call(bo, '/api/recovery/shares/status', {}, ada);
    check((boAsAda.status === 401 || boAsAda.status === 403) && boAsAda.body?.findableSso === undefined,
        `Bo's signature over Ada's key: refused by the signature middleware, and no list (${boAsAda.status} ${brief(boAsAda.body)})`);
    const boNamingAda = await call(bo, '/api/recovery/shares/status', { owner: ada.pk, publicKey: ada.pk, actor: ada.pk });
    check(boNamingAda.body?.findableSso === undefined || brief(boNamingAda.body?.enrolledSso) === '[]',
        `a body naming Ada's key never answers for Ada (${boNamingAda.status} ${brief({ e: boNamingAda.body?.enrolledSso, f: boNamingAda.body?.findableSso })})`);

    // ── 4. Refresh: one copy, one account, found from the index ────────────────────────────────────
    console.log('\n── 4. Refresh makes no second copy and no second account ──');
    const cy = newId();
    addMember(cy, 'Cy');
    const CY_SUB = '106666666666666666661';
    check((await connect(cy, CY_SUB)).status === 200, 'Cy connects Google');
    asMadeBeforeS0(cy);
    const before = { rows: rowsOf(cy.pk), members: memberCount(), status: await status(cy) };
    check(brief(signInsToRefresh(before.status.body)) === brief(['google']), `setup: Cy is offered Refresh for Google (${brief(before.status.body?.findableSso)})`);
    const refreshed = await connect(cy, CY_SUB);
    const after = { rows: rowsOf(cy.pk), members: memberCount(), status: await status(cy) };
    check(refreshed.status === 200 && Array.isArray(refreshed.body?.findableSso) && refreshed.body.findableSso.includes('google'),
        `the Connect's own answer already says Google is findable, so the app shows it at once (${refreshed.status} ${brief(refreshed.body?.findableSso)})`);
    check(after.rows.length === 1 && after.rows[0].holder_ref === 'google' && !!after.rows[0].sso_find_hash && after.members === before.members,
        `one copy for Google, now with its find hash, and no new member (${brief(after.rows.map((r) => ({ ref: r.holder_ref, gen: r.generation, find: !!r.sso_find_hash })))} members ${before.members}→${after.members})`);
    check(signInsToRefresh(after.status.body).length === 0, `Refresh is no longer offered (${brief(after.status.body?.findableSso)})`);
    // Ada's copy (section 3) is still one made before S0, so the scan runs at every Google find: the heal count says Cy came
    // from the index (a copy the scan found would be healed, and counted).
    const healedBefore = engine.findScanStats().healed;
    const cyFound = await find(CY_SUB);
    check(cyFound.status === 200 && brief(cyFound.names) === brief([`Cy:${cy.pk}`]) && engine.findScanStats().healed === healedBefore,
        `a restore with Cy's Google names Cy alone, from the index: the scan healed nothing (${cyFound.status} ${brief(cyFound.names)} healed ${healedBefore}→${engine.findScanStats().healed})`);

    // ── 5. a failed Connect ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a failed Connect changes nothing ──');
    const di = newId();
    addMember(di, 'Di');
    const DI_SUB = '107777777777777777771';
    check((await connect(di, DI_SUB)).status === 200, 'Di connects Google');
    asMadeBeforeS0(di);
    const diBefore = rowsOf(di.pk);
    const bad = await connect(di, DI_SUB, 'not.a.token');
    const diAfter = rowsOf(di.pk);
    const diStatus = await status(di);
    check(bad.status >= 400 && typeof bad.body?.error === 'string' && bad.body?.findableSso === undefined,
        `a sign-in that doesn't check out is refused in words, with no list (${bad.status} ${brief(bad.body)})`);
    check(brief(diAfter) === brief(diBefore) && diAfter[0]?.sso_find_hash === null && brief(signInsToRefresh(diStatus.body)) === brief(['google']),
        `the copy is exactly as it was, still not findable, and Refresh is still offered (${brief(diAfter)})`);

    // ── 6. nothing a stranger could use; nothing an older app misses ───────────────────────────────
    console.log('\n── 6. what the answer gives away, and what an older app still reads ──');
    const cyStatus = await status(cy);
    const cyHash = rowsOf(cy.pk)[0]?.sso_find_hash ?? 'none';
    check(cyStatus.status === 200 && cyStatus.body.findableSso.every((p: unknown) => p === 'google') && !cyStatus.raw.includes(cyHash) && !cyStatus.raw.includes(CY_SUB),
        `provider names only: never the find hash, never the sign-in's id (${brief(cyStatus.body?.findableSso)})`);
    const OLD_FIELDS = ['generation', 'keepers', 'enrolledSso', 'communityCopy', 'nodeKey', 'total', 'threshold', 'canAffordToLose', 'canRemoveKeeper', 'recoverable', 'unattendedPieces', 'humanKeepers', 'dependsOnPeople'];
    const missing = OLD_FIELDS.filter((f) => !(f in (cyStatus.body ?? {})));
    check(missing.length === 0 && cyStatus.body.threshold === 1 && cyStatus.body.recoverable === true,
        `every field an app from before S4 reads is still there, with the same values (missing ${brief(missing)})`);

    // ── 7. a standby ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. a standby answers the same ──');
    const mainAnswers = { ada: await status(ada), cy: await status(cy) };
    setNodeRole('backup');
    let standbyAnswers: typeof mainAnswers;
    try {
        standbyAnswers = { ada: await status(ada), cy: await status(cy) };
    } finally {
        setNodeRole('primary');
    }
    check(standbyAnswers.ada.status === 200 && standbyAnswers.cy.status === 200
        && brief(standbyAnswers.ada.body?.findableSso) === brief(mainAnswers.ada.body?.findableSso)
        && brief(standbyAnswers.cy.body?.findableSso) === brief(mainAnswers.cy.body?.findableSso)
        && brief(signInsToRefresh(standbyAnswers.ada.body)) === brief(['google']) && signInsToRefresh(standbyAnswers.cy.body).length === 0,
        `a standby gives the same lists from the same rows (${brief({ ada: standbyAnswers.ada.body?.findableSso, cy: standbyAnswers.cy.body?.findableSso })})`);

    const providerCalls = outsideCalls.filter((u) => /google|apple|facebook/i.test(u));
    check(providerCalls.length === 0, `no provider was contacted (${brief(providerCalls)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery S4 (findable per sign-in, Refresh) checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
