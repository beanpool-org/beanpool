/**
 * Joining the global community from an account a member already has in another community (the phone's half is
 * apps/native/utils/global-join-existing.ts), over REAL HTTPS through the real signature middleware. No provider is
 * contacted: the Google JWKS is a test key primed into sso.ts's cache, as test-open-join.ts does.
 *
 * The door never asks another community whether a key is its member, and needs no change to take one: it knows other
 * communities' members only as federation tells it, as visitors' rows carrying their home community's address. So:
 *
 *   1. a key this community has never seen (a member elsewhere: nothing here can say so) joins through the door: a
 *      member here, by the open door, with no home community
 *   2. a key this community knows only as another community's member (federation's visitor row, with that community's
 *      address) joins through the door, and its row becomes a member's HERE: not a visitor's, and no longer that
 *      community's, so every federation check reads it as local (its spending is not a visitor's); it keeps its account
 *   3. one sign-in account, one member: another key, also a member elsewhere, with the same account → 409
 *      already_joined, nothing written; with a sign-in account of its own, that key joins
 *   4. the per-network limits count these joins as any other: with the hour's joins from one address used up, the next
 *      account's join → 429 rate_limited, nothing written
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-join-existing-account.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, registerVisitor, getMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { _resetJwksCacheForTests, _clearNoncesForTests } from './sso.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { OPEN_JOIN_LIMITS } from './engine/open-join.js';
import { isVisitor } from './federation-settlement.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── the provider ────────────────────────────────────────────────────────────────────────────────
const GOOGLE_KID = 'test-open-join-existing';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function primeJwks(): void {
    _resetJwksCacheForTests();
    const jwk = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any;
    _resetJwksCacheForTests('google', { keys: [jwk], expiresAt: Date.now() + 3600_000 });
}

function mint(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── keys ────────────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/** Fresh limiter windows, so the suite's own request count never decides a result it isn't testing. */
function freshLimiters(): void {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
}

/** A POST signed by `id` the way the phone signs one (the middleware's unbound form). */
async function call(id: Id, path: string, body: unknown): Promise<{ status: number; body: any }> {
    freshLimiters();
    const raw = JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`POST\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: raw });
    let parsed: any;
    try { parsed = await res.json(); } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
}

async function joinNonce(id: Id): Promise<string> {
    const r = await call(id, '/api/join/sso-nonce', {});
    if (r.status !== 200 || typeof r.body?.nonce !== 'string') throw new Error(`no join nonce: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.nonce;
}

/** The door, as the phone goes through it: the nonce, the sign-in bound to it, the join. */
async function joinWith(id: Id, sub: string, callsign: string): Promise<{ status: number; body: any; nonce: string }> {
    const nonce = await joinNonce(id);
    const r = await call(id, '/api/join', { callsign, provider: 'google', idToken: mint(sub, nonce), nonce });
    return { ...r, nonce };
}

const memberRow = (pk: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk) as any;
const accountRow = (pk: string) => db.prepare('SELECT * FROM accounts WHERE public_key = ?').get(pk) as any;
const joinRow = (pk: string) => db.prepare('SELECT * FROM open_joins WHERE member_pubkey = ?').get(pk) as any;
const countJoins = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins').get() as any).n as number;

async function main(): Promise<void> {
    console.log('\n=== The global community\'s door, for an account a member already has elsewhere ===\n');
    await initTls();
    initStateEngine();
    process.env.NODE_PROFILE = 'global';
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    primeJwks();
    _clearNoncesForTests();

    // ── 1. a key never seen here ─────────────────────────────────────────────────────────────────
    console.log('── 1. a member of another community this one has never heard of ──');
    const mel = newId();
    assert(!memberRow(mel.pk), 'nothing here knows the key');
    const melJoin = await joinWith(mel, 'mel-google-sub', 'Mel');
    assert(melJoin.status === 200 && melJoin.body?.success === true && melJoin.body?.member?.publicKey === mel.pk,
        `the door lets the key in, as the member it signed for (got ${melJoin.status} ${JSON.stringify(melJoin.body)})`);
    const melRow = memberRow(mel.pk);
    assert(!!melRow && melRow.is_visitor === 0 && melRow.invited_by === 'open:google' && melRow.invite_code === null,
        `a member here, joined by the open door (${JSON.stringify({ is_visitor: melRow?.is_visitor, invited_by: melRow?.invited_by })})`);
    assert(melRow?.home_node_url === null && !isVisitor(mel.pk), 'local here: no home community, and not a visitor to federation');
    assert(!!joinRow(mel.pk), 'the door recorded the sign-in account it joined with');

    // ── 2. a key known here only as another community's member ───────────────────────────────────
    console.log('\n── 2. a member of another community this one knows from federation ──');
    const HOME = 'https://mullum.example.org';
    const ned = newId();
    registerVisitor(ned.pk, 'Ned', HOME);
    const before = memberRow(ned.pk);
    assert(before?.is_visitor === 1 && before?.home_node_url === HOME && isVisitor(ned.pk),
        `before: a visitor's row, that community's member to every federation check (${JSON.stringify({ is_visitor: before?.is_visitor, home: before?.home_node_url })})`);
    const nedJoin = await joinWith(ned, 'ned-google-sub', 'Ned Global');
    assert(nedJoin.status === 200 && nedJoin.body?.success === true,
        `the door lets it in: a visitor's row has not joined (got ${nedJoin.status} ${JSON.stringify(nedJoin.body)})`);
    const nedRow = memberRow(ned.pk);
    assert(nedRow?.is_visitor === 0 && nedRow?.invited_by === 'open:google' && nedRow?.callsign === 'Ned Global',
        `its row is a member's now, under the name it joined with (${JSON.stringify({ is_visitor: nedRow?.is_visitor, invited_by: nedRow?.invited_by, callsign: nedRow?.callsign })})`);
    assert(nedRow?.home_node_url === null,
        `and this community's, no longer ${HOME}'s: its home address is gone, as a new member's row has none (home_node_url ${JSON.stringify(nedRow?.home_node_url)})`);
    assert(!getMember(ned.pk)?.homeNodeUrl && !isVisitor(ned.pk),
        'so federation reads it as a local member: its DMs are not relayed away, a peer can\'t speak for it, its spending is its own');
    assert(!!accountRow(ned.pk), 'it keeps the account its visitor\'s row had (what was sent to it stays)');
    assert(!!joinRow(ned.pk), 'and the door recorded its sign-in account');

    // ── 3. one sign-in account, one member ───────────────────────────────────────────────────────
    console.log('\n── 3. one sign-in account, one member ──');
    const joinsBefore = countJoins();
    const mel2 = newId();
    const again = await joinWith(mel2, 'mel-google-sub', 'Mel Two');
    assert(again.status === 409 && again.body?.code === 'already_joined',
        `another key with the sign-in account Mel joined with → 409 already_joined (got ${again.status} ${JSON.stringify(again.body)})`);
    assert(!memberRow(mel2.pk) && countJoins() === joinsBefore, '...and nothing was written');
    const otherAccount = await joinWith(mel2, 'mel-other-google-sub', 'Mel Two');
    assert(otherAccount.status === 200,
        `the rule is one member per sign-in account, not per key: with an account of its own that key joins (got ${otherAccount.status} ${JSON.stringify(otherAccount.body)})`);

    // ── 4. per-network limits ────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the limits from one address count these joins like any ──');
    const ipHash = joinRow(mel.pk)?.ip_hash as string | null;
    assert(typeof ipHash === 'string' && [ned, mel2].every(id => joinRow(id.pk)?.ip_hash === ipHash),
        'every join above came from one address, and each counts against it');
    const fromHere = () => (db.prepare('SELECT COUNT(*) AS n FROM open_joins WHERE ip_hash = ?').get(ipHash) as any).n as number;
    let n = 0;
    while (fromHere() < OPEN_JOIN_LIMITS.perHour) {
        const filler = newId();
        const r = await joinWith(filler, `filler-google-sub-${++n}`, `Filler ${n}`);
        if (r.status !== 200) throw new Error(`filler join refused: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert(fromHere() === OPEN_JOIN_LIMITS.perHour, `the hour's ${OPEN_JOIN_LIMITS.perHour} joins from this address are used, three of them by members of other communities`);
    const ola = newId();
    registerVisitor(ola.pk, 'Ola', HOME);
    const over = await joinWith(ola, 'ola-google-sub', 'Ola');
    assert(over.status === 429 && over.body?.code === 'rate_limited' && /last hour/.test(String(over.body?.error)),
        `one more, also a member elsewhere → 429 for the hour (got ${over.status} ${JSON.stringify(over.body)})`);
    const olaRow = memberRow(ola.pk);
    assert(olaRow?.is_visitor === 1 && olaRow?.home_node_url === HOME && !joinRow(ola.pk),
        '...and nothing was written: its row is still the other community\'s visitor\'s');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The door takes a member of another community as it is: one member per sign-in account, limited per address, and local here once in.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
