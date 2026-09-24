/**
 * The open door, hardened (config/node-profile.ts, routes/open-join.ts), over REAL HTTPS through the real signature
 * middleware. No provider is contacted: the Google JWKS is a test key primed into sso.ts's cache, as in
 * test-open-join.
 *
 *   1. A global node whose ledger has never moved: the boot log says the door is open, /api/community/info says
 *      openJoin true, and a signed join nonce is issued.
 *   1b. One key, one spelling. The middleware verifies X-Public-Key by decoding its hex, so a keypair signs as its
 *      upper-case spelling too. The upper-case spelling of an existing member's key is refused as that member (409
 *      already_member) on the nonce and the join; a new key's lower-case join works once, and its upper-case
 *      spelling afterwards is that member, even with another sign-in account; a key that joins in upper case is
 *      stored in lower case; a spelling with extra characters the decoder skips is refused (400 bad_key).
 *   2. A local node whose operator opened the door (`nodeProfile.openJoin=true`), Beans on: open while nothing has
 *      moved, and SHUT, with no restart, the moment the first Bean moves (a Commons grant). Every door route (the
 *      nonce, the join, and the GitHub start and poll) answers 404 invite_only, /api/community/info says openJoin false.
 *   3. That live community switched to the global profile (the finding): money stays on (G1), and the door stays
 *      shut. At runtime first, then at boot, where a loud line says why; every door route is 404, openJoin false.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-open-door-hardening.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Whatever the shell running the suite has set, the suite starts from a node with no profile configured.
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.GOOGLE_CLIENT_IDS;

import crypto from 'node:crypto';

const PORT = 8751;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** Runs fn and returns what it wrote to console.log / console.warn, still printing it. */
async function capture(fn: () => unknown): Promise<{ logs: string[]; warns: string[]; error: unknown }> {
    const logs: string[] = [], warns: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); log(...a); };
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); warn(...a); };
    let error: unknown = null;
    try { await fn(); } catch (e) { error = e; } finally { console.log = log; console.warn = warn; }
    return { logs, warns, error };
}

// ── the sign-in provider (a test key, never contacted) ───────────────────────────────────────────
const GOOGLE_KID = 'test-open-door-hardening-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function mintGoogle(sub: string, nonce: string): string {
    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const payload = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url');
    return `${header}.${payload}.${sig}`;
}

// ── keys, signed requests ───────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/**
 * A request signed by `id` through the real middleware. `as` is the spelling of the key sent in X-Public-Key: the
 * signature covers method, path, time, nonce and body, not the key, so any spelling the middleware can decode signs.
 */
async function call(method: 'GET' | 'POST', id: Id | null, path: string, body?: unknown, as?: string): Promise<{ status: number; body: any }> {
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = as ?? id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

const info = async () => (await call('GET', null, '/api/community/info')).body;

/** Every door route, signed by a key nobody has seen: each must answer 404 invite_only while the door is shut. */
async function doorRoutesShut(label: string): Promise<void> {
    const stranger = newId();
    const nonce = await call('POST', stranger, '/api/join/sso-nonce', {});
    const joined = await call('POST', stranger, '/api/join', { callsign: 'Stranger', provider: 'google', idToken: mintGoogle('door-shut-sub', 'x'), nonce: 'x' });
    const ghStart = await call('POST', stranger, '/api/join/github/start', {});
    const ghPoll = await call('POST', stranger, '/api/join/github/poll', { sessionId: 'nothing' });
    const all = [nonce, joined, ghStart, ghPoll];
    assert(all.every(r => r.status === 404 && r.body?.code === 'invite_only'),
        `${label}: the nonce, the join, and the GitHub start and poll all answer 404 invite_only (got ${all.map(r => `${r.status} ${r.body?.code}`).join(', ')})`);
    const { db } = await import('./db/db.js');
    assert(!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(stranger.pk), `${label}: nobody joined`);
}

async function main(): Promise<void> {
    console.log('\n=== The open door, hardened ===\n');
    const { db, initSchema } = await import('./db/db.js');
    const profile = await import('./config/node-profile.js');
    const { mirrorNodeProfileAtBoot, getProfileSwitches, getNodeFeatures, ledgerHistory, NODE_PROFILE_KEY } = profile;
    const sso = await import('./sso.js');
    const setOverride = (name: string, value: string) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`${NODE_PROFILE_KEY}.${name}`, value);
    const clearOverrides = () => db.prepare('DELETE FROM node_config WHERE substr(key, 1, 12) = ?').run(`${NODE_PROFILE_KEY}.`);

    initSchema();
    const se = await import('./state-engine.js');
    se.initStateEngine();
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    await startHttpsServer(PORT);
    sso._resetJwksCacheForTests();
    sso._resetJwksCacheForTests('google', {
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any],
        expiresAt: Date.now() + 3600_000,
    });
    sso._clearNoncesForTests();

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`)
            .run(id.pk, callsign);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };

    // ── 1. A global node whose ledger has never moved: the door is open ──
    console.log('── 1. a global node whose ledger has never moved ──');
    process.env.NODE_PROFILE = 'global';
    const boot1 = await capture(() => mirrorNodeProfileAtBoot());
    assert(!boot1.error && ledgerHistory() === null, `the global node boots on a ledger that has never moved (${String(boot1.error ?? 'ok')})`);
    assert(boot1.logs.some(l => l.includes('open door is open')), 'the boot log says the door is open');
    assert(!boot1.warns.some(w => w.includes('open door stays SHUT')), 'and says nothing about it being shut');
    assert((await info()).features?.openJoin === true, '/api/community/info says openJoin true');
    const opener = newId();
    const opened = await call('POST', opener, '/api/join/sso-nonce', {});
    assert(opened.status === 200 && typeof opened.body?.nonce === 'string', `a signed join nonce is issued (${opened.status})`);

    // ── 1b. One key, one spelling ──
    console.log('\n── 1b. one key, one spelling ──');
    const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    const membersOf = (pk: string) => count('SELECT COUNT(*) AS n FROM members WHERE lower(public_key) = ?', pk.toLowerCase());
    const joinsOf = (pk: string) => count('SELECT COUNT(*) AS n FROM open_joins WHERE lower(member_pubkey) = ?', pk.toLowerCase());
    /** A join through the door as `as` (a spelling of id's key): the nonce, then the join, both signed that way. */
    const joinAs = async (id: Id, as: string, sub: string) => {
        const n = await call('POST', id, '/api/join/sso-nonce', {}, as);
        if (n.status !== 200) return n;
        return call('POST', id, '/api/join', { callsign: 'Joiner', provider: 'google', idToken: mintGoogle(sub, n.body.nonce), nonce: n.body.nonce }, as);
    };

    const mira = member('Mira');
    const MIRA = mira.pk.toUpperCase();
    const miraNonce = await call('POST', mira, '/api/join/sso-nonce', {}, MIRA);
    assert(miraNonce.status === 409 && miraNonce.body?.code === 'already_member',
        `a join nonce signed as the UPPER-CASE spelling of member Mira's key: refused as Mira, 409 already_member (got ${miraNonce.status} ${miraNonce.body?.code})`);
    const miraToken = sso.issueNonce(`open-join:${mira.pk}`);
    const miraJoin = await call('POST', mira, '/api/join', { callsign: 'Mira again', provider: 'google', idToken: mintGoogle('mira-second-account', miraToken), nonce: miraToken }, MIRA);
    assert(miraJoin.status === 409 && miraJoin.body?.code === 'already_member',
        `a join signed as that spelling, with another sign-in account: 409 already_member (got ${miraJoin.status} ${miraJoin.body?.code})`);
    assert(membersOf(mira.pk) === 1 && joinsOf(mira.pk) === 0, 'Mira is still one member, and no sign-in account was recorded against that key');

    const nia = newId();
    const niaFirst = await joinAs(nia, nia.pk, 'nia-google-sub');
    assert(niaFirst.status === 200 && niaFirst.body?.member?.publicKey === nia.pk, `Nia joins with their key in lower case (${niaFirst.status} ${niaFirst.body?.code ?? ''})`);
    const niaUpper = await joinAs(nia, nia.pk.toUpperCase(), 'nia-other-google-sub');
    assert(niaUpper.status === 409 && niaUpper.body?.code === 'already_member',
        `their UPPER-CASE spelling with another sign-in account: 409 already_member, not a second member (got ${niaUpper.status} ${niaUpper.body?.code})`);
    const niaAgain = await joinAs(nia, nia.pk, 'nia-third-google-sub');
    assert(niaAgain.status === 409 && niaAgain.body?.code === 'already_member', `their lower-case spelling again: 409 already_member (got ${niaAgain.status})`);
    assert(membersOf(nia.pk) === 1 && joinsOf(nia.pk) === 1, `one keypair, one member, one sign-in account (members ${membersOf(nia.pk)}, joins ${joinsOf(nia.pk)})`);

    const uma = newId();
    const umaJoin = await joinAs(uma, uma.pk.toUpperCase(), 'uma-google-sub');
    assert(umaJoin.status === 200 && umaJoin.body?.member?.publicKey === uma.pk,
        `Uma joins signing as their UPPER-CASE spelling: stored under the lower-case key (${umaJoin.status} ${umaJoin.body?.member?.publicKey?.slice(0, 12)})`);
    assert(!!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(uma.pk) && !db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(uma.pk.toUpperCase())
        && !!db.prepare('SELECT 1 FROM open_joins WHERE member_pubkey = ?').get(uma.pk),
        'the member row and the open_joins row are under the lower-case key, and nothing under the upper-case one');
    const umaLower = await joinAs(uma, uma.pk, 'uma-other-google-sub');
    assert(umaLower.status === 409 && umaLower.body?.code === 'already_member', `their lower-case spelling afterwards: 409 already_member (got ${umaLower.status})`);

    const odd = newId();
    const oddNonce = await call('POST', odd, '/api/join/sso-nonce', {}, `${odd.pk}zz`);
    const oddJoin = await call('POST', odd, '/api/join', { callsign: 'Odd', provider: 'google', idToken: mintGoogle('odd-sub', 'x'), nonce: 'x' }, `${odd.pk}zz`);
    assert(oddNonce.status === 400 && oddNonce.body?.code === 'bad_key' && oddJoin.status === 400 && oddJoin.body?.code === 'bad_key',
        `a spelling with characters the hex decoder skips (…zz) signs, but the door refuses it, 400 bad_key (got ${oddNonce.status} ${oddNonce.body?.code}, ${oddJoin.status} ${oddJoin.body?.code})`);
    assert(membersOf(odd.pk) === 0, 'and nobody joined');

    // ── 2. A local node whose operator opened the door: it shuts when the first Bean moves ──
    console.log('\n── 2. a local node with nodeProfile.openJoin=true: the first Bean shuts the door ──');
    process.env.NODE_PROFILE_ALLOW_CHANGE_FROM = 'global';
    delete process.env.NODE_PROFILE;
    await capture(() => mirrorNodeProfileAtBoot());
    delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
    setOverride('openJoin', 'true');
    const localOpen = getProfileSwitches();
    assert(localOpen.beans && localOpen.openJoin, `local, Beans on, door opened by the operator, nothing moved: the door is open (${JSON.stringify({ beans: localOpen.beans, openJoin: localOpen.openJoin })})`);
    assert((await call('POST', newId(), '/api/join/sso-nonce', {})).status === 200, 'and a signed join nonce is issued');

    const alice = member('Alice');
    assert(ledgerHistory() === null, 'nothing has moved yet');
    se.payFromCommons(alice.pk, 20, 'Test: Beans for Alice', { allowDeficit: true });
    assert(ledgerHistory() !== null, `the Commons pays Alice 20 Beans: the ledger has moved (${ledgerHistory()})`);
    const shutNow = getProfileSwitches();
    assert(!shutNow.openJoin && shutNow.beans, `with no restart, the door is shut and Beans are on (${JSON.stringify({ beans: shutNow.beans, openJoin: shutNow.openJoin })})`);
    assert(getNodeFeatures().openJoin === false && (await info()).features?.openJoin === false, '/api/community/info says openJoin false');
    await doorRoutesShut('local, door opened by the operator, ledger moved');
    clearOverrides();

    // ── 3. The live community switched to the global profile: money stays on, the door stays shut ──
    console.log('\n── 3. that live community switched to NODE_PROFILE=global ──');
    process.env.NODE_PROFILE = 'global';
    const runtime3 = getProfileSwitches();
    assert(runtime3.beans && !runtime3.openJoin, `at runtime, before any restart: Beans stay on (G1) and the door stays shut (${JSON.stringify({ beans: runtime3.beans, openJoin: runtime3.openJoin })})`);
    const boot3 = await capture(() => mirrorNodeProfileAtBoot());
    assert(!boot3.error, `the node boots as global (${String(boot3.error ?? 'ok')})`);
    const shutLine = boot3.warns.find(w => w.includes('open door stays SHUT')) ?? '';
    assert(/ledger has moved \(it has recorded transactions\)/.test(shutLine) && /live credit system/.test(shutLine) && /openJoin false/.test(shutLine),
        `the boot log says, loudly, that the door stays shut and why (${shutLine})`);
    assert(!boot3.logs.some(l => l.includes('open door is open')), 'and never that it is open');
    assert(boot3.warns.some(w => w.includes('stay ON') && w.includes('ledger has moved')), 'the money lock says so too (G1, unchanged)');
    const f3 = getNodeFeatures();
    assert(f3.beans && !f3.openJoin, `features: Beans on, open join off (${JSON.stringify(f3)})`);
    const info3 = await info();
    assert(info3.profile === 'global' && info3.features?.openJoin === false && info3.features?.beans === true,
        `/api/community/info: profile global, openJoin false, beans true (${JSON.stringify({ profile: info3.profile, features: info3.features })})`);
    await doorRoutesShut('global, ledger moved');
    setOverride('openJoin', 'true');
    assert(getProfileSwitches().openJoin === false && (await info()).features?.openJoin === false,
        'an operator override nodeProfile.openJoin=true opens nothing on this ledger');
    await doorRoutesShut('global, ledger moved, openJoin override');
    clearOverrides();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The open door opens only on a ledger that has never moved, and one key is one member.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
