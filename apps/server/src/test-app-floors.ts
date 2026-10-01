/**
 * Force updates, the node's half (app-store-versions.ts floors, app-version-counts.ts): what the app is told and what the
 * operator sees. The app's half is apps/native/utils/__tests__/force-update.test.ts.
 *
 *   1. the env: MIN_APP_VERSION_IOS / _ANDROID fall back to MIN_APP_VERSION and the default; MIN_APP_VERSION_FROM (and
 *      its per-platform forms) read a date or a date and time, and anything else is `invalid`, never a date
 *   2. the held floor: a floor is enforced only once that platform's store has a build that meets it. An unknown store
 *      enforces nothing; a store behind the floor holds it, and the log says so once, not on every read
 *   3. the grace date: before it a floor stops nobody (blocking false), from it it does; a date that isn't one never does
 *   4. per platform: iOS held for its store while Android is enforced, each with its own grace date
 *   5. the counts: the header parsed strictly; only a signer `counts` accepts is counted; an update moves the member; a
 *      member not seen for 30 days drops out; the counts carry no key
 *   6. over HTTPS: health serves `appFloors` and `minAppVersionFrom` and stays small; a member's signed request with the
 *      header is counted, an unsigned one, a stranger's key and a garbled header are not; a version far below the floor
 *      is never refused; the manager's route is the owner's and admins' only and answers the floors and the counts
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-app-floors.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.BEANPOOL_ADDRESSES = 'floors.test';
for (const k of ['MIN_APP_VERSION', 'MIN_APP_VERSION_IOS', 'MIN_APP_VERSION_ANDROID', 'MIN_APP_VERSION_FROM', 'MIN_APP_VERSION_FROM_IOS', 'MIN_APP_VERSION_FROM_ANDROID']) {
    delete process.env[k];
}

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig, hashPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { logger } from './logger.js';
import {
    applyCheckResult, getPlatformFloor, getFloorFrom, getMinAppVersionFrom, getPlatformFloorDetail, getAppFloors,
    __resetAppStoreVersionsForTest,
} from './app-store-versions.js';
import {
    parseAppVersionHeader, noteAppVersion, getAppVersionCounts, __resetAppVersionCountsForTest, APP_VERSION_HEADER,
} from './app-version-counts.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const HOST = 'floors.test';
const DAY_MS = 24 * 60 * 60 * 1000;
let BASE = '';

// Every warning the floors log, captured (and still printed).
const warnings: string[] = [];
const realWarn = logger.warn.bind(logger);
(logger as any).warn = (cat: string, msg: string, ...rest: unknown[]) => {
    warnings.push(String(msg));
    return (realWarn as any)(cat, msg, ...rest);
};
const heldWarnings = (platform: string) => warnings.filter(w => w.includes(`${platform} floor`) && w.includes('is held')).length;

function setEnv(env: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

interface Identity { pub: string; priv: crypto.KeyObject }
function keyPair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}
function addMember(id: Identity, callsign: string): void {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(id.pub, callsign);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pub);
}

const bound = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);

interface Answer { status: number; body: any; text: string }

/** A GET to this community, signed by `signer` for it (request binding) or unsigned, with `extra` headers. */
async function get(path: string, signer: Identity | null, extra: Record<string, string> = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...extra };
    if (signer) {
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = `beanpool-request/2\n${HOST}\nGET\n${path.split('?')[0]}\n${ts}\n${nonce}\n`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, bound(text), signer.priv).toString('base64');
        headers['X-Timestamp'] = ts;
        headers['X-Nonce'] = nonce;
        headers['X-Signed-For'] = HOST;
    }
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, text };
}

const counted = (platform: 'android' | 'ios') => Object.fromEntries(getAppVersionCounts().platforms[platform].map(v => [v.version, v.members]));

async function main(): Promise<void> {
    console.log('\n=== Force updates: the floors a node serves, and the versions it counts ===\n');

    // ── 1. the env ──────────────────────────────────────────────────────────────────────────────
    console.log('--- 1. the env ---');
    __resetAppStoreVersionsForTest();
    assert(getPlatformFloor('ios') === '1.0.75' && getPlatformFloor('android') === '1.0.75', 'no floor set: both platforms have the default');
    setEnv({ MIN_APP_VERSION: '1.2.40' });
    assert(getPlatformFloor('ios') === '1.2.40' && getPlatformFloor('android') === '1.2.40', 'MIN_APP_VERSION alone: both platforms have it');
    setEnv({ MIN_APP_VERSION_IOS: 'v1.2.50' });
    assert(getPlatformFloor('ios') === '1.2.50', "MIN_APP_VERSION_IOS is iOS's floor, leading v and all");
    assert(getPlatformFloor('android') === '1.2.40', 'and Android keeps MIN_APP_VERSION');
    setEnv({ MIN_APP_VERSION_ANDROID: 'soon' });
    assert(getPlatformFloor('android') === '1.2.40', 'a platform floor that is not a version is ignored: the generic one stands');
    setEnv({ MIN_APP_VERSION: undefined, MIN_APP_VERSION_IOS: undefined, MIN_APP_VERSION_ANDROID: undefined });

    assert(getFloorFrom().iso === null && !getFloorFrom().invalid && getMinAppVersionFrom() === null, 'no grace date: null, and not invalid');
    setEnv({ MIN_APP_VERSION_FROM: '2026-10-15' });
    assert(getFloorFrom('ios').iso === '2026-10-15T00:00:00.000Z', 'a bare date is midnight UTC, and every platform falls back to it');
    assert(getMinAppVersionFrom() === '2026-10-15T00:00:00.000Z', 'minAppVersionFrom is the generic date');
    setEnv({ MIN_APP_VERSION_FROM_IOS: '2026-10-20T09:00:00+10:00' });
    assert(getFloorFrom('ios').iso === '2026-10-19T23:00:00.000Z', "MIN_APP_VERSION_FROM_IOS is iOS's own, offset and all");
    assert(getFloorFrom('android').iso === '2026-10-15T00:00:00.000Z', 'and Android keeps the generic date');
    for (const bad of ['next tuesday', '15/10/2026', '2026', '2026-13-45', '1']) {
        setEnv({ MIN_APP_VERSION_FROM: bad, MIN_APP_VERSION_FROM_IOS: undefined });
        const f = getFloorFrom('android');
        assert(f.iso === null && f.invalid, `"${bad}" is not a date: invalid, never read as one`);
    }
    setEnv({ MIN_APP_VERSION_FROM: undefined });

    // ── 2. the held floor ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. the floor is enforced only once the store has it ---');
    setEnv({ MIN_APP_VERSION: '1.3.0' });
    let d = getPlatformFloorDetail('android');
    assert(d.store === null && d.enforced === null && !d.blocking && !d.held,
        'the store version is unknown: nothing is enforced and nothing is said to be held');
    applyCheckResult({ android: '1.2.60', ios: null });
    const before = heldWarnings('android');
    d = getPlatformFloorDetail('android');
    assert(d.store === '1.2.60' && d.enforced === null && d.held && !d.blocking,
        'the store has 1.2.60, the floor is 1.3.0: held, enforced null, blocking nobody');
    assert(heldWarnings('android') === before + 1, 'the hold is logged');
    for (let i = 0; i < 5; i++) getAppFloors();
    assert(heldWarnings('android') === before + 1, 'once: reading the floors again does not log it again');
    assert(warnings.some(w => w.includes('android floor 1.3.0 is held') && w.includes('the store has 1.2.60')),
        'the line names the floor and the store version');
    applyCheckResult({ android: '1.3.0', ios: null });
    d = getPlatformFloorDetail('android');
    assert(d.enforced === '1.3.0' && !d.held && d.blocking, 'the store reaches 1.3.0: the floor is enforced, and with no grace date it blocks');
    applyCheckResult({ android: '1.3.2', ios: null });
    d = getPlatformFloorDetail('android');
    assert(d.enforced === '1.3.0', 'a store ahead of the floor: the floor itself is enforced, never the store version');

    // ── 3. the grace date ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. the grace date ---');
    const now = new Date('2026-10-10T12:00:00Z');
    setEnv({ MIN_APP_VERSION_FROM: '2026-10-15' });
    d = getPlatformFloorDetail('android', now);
    assert(d.enforced === '1.3.0' && d.from === '2026-10-15T00:00:00.000Z' && !d.blocking, 'before the grace date: enforced, but blocking nobody yet');
    d = getPlatformFloorDetail('android', new Date('2026-10-15T00:00:00Z'));
    assert(d.blocking, 'from the grace date: blocking');
    setEnv({ MIN_APP_VERSION_FROM: 'the 15th' });
    d = getPlatformFloorDetail('android', new Date('2027-01-01T00:00:00Z'));
    assert(d.fromInvalid && !d.blocking, 'a grace date that is not a date: the block never applies, however late it is');
    assert(warnings.some(w => w.includes('is not a date') && w.includes('android')), 'and the log says so');
    setEnv({ MIN_APP_VERSION_FROM: undefined });

    // ── 4. per platform ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. each platform answers for itself ---');
    __resetAppStoreVersionsForTest();
    setEnv({ MIN_APP_VERSION: '1.2.40', MIN_APP_VERSION_IOS: '1.3.0', MIN_APP_VERSION_ANDROID: '1.3.0', MIN_APP_VERSION_FROM_ANDROID: '2026-10-01' });
    applyCheckResult({ android: '1.3.0', ios: '1.2.61' }); // Apple still reviewing 1.3.0
    const floors = getAppFloors(new Date('2026-10-05T00:00:00Z'));
    assert(floors.android.min === '1.3.0' && floors.android.blocking,
        'Android: its store has 1.3.0, its grace date has passed: enforced and blocking');
    assert(getAppFloors(new Date('2026-09-30T00:00:00Z')).android.blocking === false, 'and not before its own grace date');
    assert(floors.ios.min === null && !floors.ios.blocking,
        'iOS: its store is still on 1.2.61, so its 1.3.0 floor stops nobody (iOS review lag)');
    assert(heldWarnings('ios') >= 1, "iOS's hold is logged");
    applyCheckResult({ android: null, ios: '1.3.0' });
    const later = getAppFloors(new Date('2026-10-06T00:00:00Z'));
    assert(later.ios.min === '1.3.0' && later.ios.blocking, 'once Apple publishes 1.3.0, iOS is enforced too');
    assert(later.android.min === '1.3.0', 'a store check that missed Android keeps its last answer, and its floor');
    setEnv({ MIN_APP_VERSION: undefined, MIN_APP_VERSION_IOS: undefined, MIN_APP_VERSION_ANDROID: undefined, MIN_APP_VERSION_FROM_ANDROID: undefined });

    // ── 5. the counts ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. the counts ---');
    assert(JSON.stringify(parseAppVersionHeader('1.2.57 android')) === '{"version":"1.2.57","platform":"android"}', 'the header: "<version> <platform>"');
    assert(parseAppVersionHeader(' 1.2.57   ios ')?.platform === 'ios', 'spacing is forgiven');
    assert(parseAppVersionHeader('1.2.57 Android')?.platform === 'android', 'and the platform\'s case');
    for (const bad of ['', '1.2.57', '1.2.57 web', '1.2.57 android extra', 'v1.2.57-beta android', 'android 1.2.57', `1.2.57 ${'x'.repeat(80)}`]) {
        assert(parseAppVersionHeader(bad) === null, `"${bad.slice(0, 30)}" is not the header: nothing counted`);
    }
    assert(parseAppVersionHeader(undefined) === null && parseAppVersionHeader(42) === null, 'nor is a missing or non-string one');

    __resetAppVersionCountsForTest();
    const yes = () => true, no = () => false;
    const t0 = Date.now();
    noteAppVersion('a'.repeat(64), '1.2.57 android', yes, t0);
    noteAppVersion('b'.repeat(64), '1.2.57 android', yes, t0);
    noteAppVersion('c'.repeat(64), '1.2.56 android', yes, t0);
    noteAppVersion('d'.repeat(64), '1.2.57 ios', yes, t0);
    noteAppVersion('e'.repeat(64), '1.2.57 android', no, t0);
    assert(JSON.stringify(counted('android')) === '{"1.2.57":2,"1.2.56":1}', 'Android: two on 1.2.57, one on 1.2.56; the one the predicate refused is not counted');
    assert(JSON.stringify(counted('ios')) === '{"1.2.57":1}', 'iOS counted apart');
    noteAppVersion('a'.repeat(64), '1.2.57 android', yes, t0 + 1000);
    assert(counted('android')['1.2.57'] === 2, 'the same member again is still one');
    noteAppVersion('c'.repeat(64), '1.2.58 android', yes, t0 + 2000);
    assert(JSON.stringify(counted('android')) === '{"1.2.58":1,"1.2.57":2}', 'a member who updates moves to the new version; newest first');
    const listed = getAppVersionCounts(t0 + 3000);
    assert(!JSON.stringify(listed).includes('a'.repeat(16)) && !JSON.stringify(listed).includes('cccc'), 'the counts name nobody');
    const outside = getAppVersionCounts(t0 + 31 * DAY_MS);
    assert(outside.platforms.android.length === 0 && outside.platforms.ios.length === 0, 'a member not seen for 30 days is no longer counted');
    __resetAppVersionCountsForTest(t0);
    const fresh = getAppVersionCounts(t0 + DAY_MS);
    assert(fresh.since === new Date(t0).toISOString() && fresh.windowDays === 30, 'counted since the server started, when that is within 30 days');
    assert(getAppVersionCounts(t0 + 40 * DAY_MS).since === new Date(t0 + 10 * DAY_MS).toISOString(), 'and 30 days back when it is not');
    let threw = false;
    try { noteAppVersion('f'.repeat(64), '1.2.57 android', () => { throw new Error('db gone'); }); } catch { threw = true; }
    assert(!threw, 'a failing standing check never throws into the request');

    // ── 6. over HTTPS ───────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. over HTTPS ---');
    await initTls();
    initStateEngine();
    const PW = 'Floors-Owner-7!';
    const { hash, salt } = hashPassword(PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false });
    const owner = keyPair(), ann = keyPair(), ben = keyPair(), stranger = keyPair();
    seedGenesisMember(owner.pub, 'Owner');
    addMember(ann, 'Ann');
    addMember(ben, 'Ben');
    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    __resetAppStoreVersionsForTest();
    __resetAppVersionCountsForTest();
    applyCheckResult({ android: '1.2.60', ios: '1.2.58' });
    setEnv({ MIN_APP_VERSION_ANDROID: '1.2.60', MIN_APP_VERSION_IOS: '1.2.60', MIN_APP_VERSION_FROM: '2026-01-01' });

    let r = await get('/api/community/health', null);
    assert(r.status === 200, `health answers (got ${r.status})`);
    assert(r.body.minAppVersion === '1.0.75', 'minAppVersion, for builds before this one, is unchanged');
    assert(r.body.minAppVersionFrom === '2026-01-01T00:00:00.000Z', 'minAppVersionFrom is served');
    assert(JSON.stringify(r.body.appFloors?.android) === '{"min":"1.2.60","blocking":true}',
        `Android: enforced and blocking (got ${JSON.stringify(r.body.appFloors?.android)})`);
    assert(JSON.stringify(r.body.appFloors?.ios) === '{"min":null,"blocking":false}',
        `iOS: held for its store, blocking nobody (got ${JSON.stringify(r.body.appFloors?.ios)})`);
    assert(r.text.length < 800, `the public payload stays small (${r.text.length} bytes)`);
    assert(r.body.flags === undefined, 'and still carries no flags');

    // Counting, from the verified signer only.
    r = await get('/api/community/health', ann, { [APP_VERSION_HEADER]: '1.2.57 android' });
    assert(r.status === 200, `a member's signed health ping with the header: 200 (got ${r.status})`);
    r = await get('/api/community/health', ben, { [APP_VERSION_HEADER]: '1.2.61 ios' });
    r = await get('/api/community/health', null, { [APP_VERSION_HEADER]: '1.2.10 android' });
    assert(r.status === 200, 'an unsigned request with the header is answered');
    r = await get('/api/community/health', stranger, { [APP_VERSION_HEADER]: '1.2.11 android' });
    assert(r.status === 200, "a stranger's signed request with the header is answered");
    r = await get('/api/community/health', owner, { [APP_VERSION_HEADER]: 'nonsense' });
    assert(JSON.stringify(counted('android')) === '{"1.2.57":1}', `Android counts only Ann's verified 1.2.57 (got ${JSON.stringify(counted('android'))})`);
    assert(JSON.stringify(counted('ios')) === '{"1.2.61":1}', `iOS counts Ben's 1.2.61 (got ${JSON.stringify(counted('ios'))})`);

    // The manager's route.
    const route = '/api/local/admin/app-versions';
    resetAdminAuthTarpit();
    r = await get(route, null);
    assert(r.status === 401 && !r.text.includes('"platforms"'), `unsigned: 401, no counts (got ${r.status})`);
    r = await get(route, null, { 'X-Admin-Password': 'not-the-password' });
    assert(r.status === 401, `a wrong password: 401 (got ${r.status})`);
    resetAdminAuthTarpit();
    r = await get(route, ann);
    assert(r.status === 401 && !r.text.includes('"platforms"'), `a member's signature: 401, no counts (got ${r.status})`);
    resetAdminAuthTarpit();
    r = await get(route, null, { 'X-Admin-Password': PW });
    assert(r.status === 200, `the owner's password: 200 (got ${r.status})`);
    const a = r.body?.platforms?.android, i = r.body?.platforms?.ios;
    assert(a?.floor === '1.2.60' && a?.store === '1.2.60' && a?.enforced === '1.2.60' && a?.held === false && a?.blocking === true,
        `Android's floor as set, its store and its enforcement (got ${JSON.stringify(a)})`);
    assert(i?.floor === '1.2.60' && i?.store === '1.2.58' && i?.enforced === null && i?.held === true && i?.blocking === false,
        `iOS held for its store (got ${JSON.stringify(i)})`);
    assert(JSON.stringify(a?.versions) === '[{"version":"1.2.57","members":1}]' && JSON.stringify(i?.versions) === '[{"version":"1.2.61","members":1}]',
        `the counts per version (got ${JSON.stringify(a?.versions)} / ${JSON.stringify(i?.versions)})`);
    assert(typeof r.body.since === 'string' && r.body.windowDays === 30 && r.body.minAppVersionFrom === '2026-01-01T00:00:00.000Z',
        'since, the window and the grace date');
    assert(!r.text.includes(ann.pub) && !r.text.includes(ben.pub), 'the answer names no member');
    const post = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'X-Admin-Password': PW } });
    assert(post.status === 404 || post.status === 405, `read-only: no POST (got ${post.status})`);

    // Below the floor, and never refused for it: a members-only read and a public one answer as they would without it.
    const balancePath = `/api/ledger/balance/${ann.pub}`;
    const plain = await get(balancePath, ann);
    const below = await get(balancePath, ann, { [APP_VERSION_HEADER]: '0.0.1 android' });
    assert(plain.status === 200 && below.status === 200 && below.text === plain.text,
        `Ann's own balance, from an app far below the floor: answered exactly as without the header (${below.status} vs ${plain.status})`);
    const healthBelow = await get('/api/community/health', ann, { [APP_VERSION_HEADER]: '0.0.1 android' });
    assert(healthBelow.status === 200, `and her health ping (got ${healthBelow.status})`);

    assert(JSON.stringify(counted('android')) === '{"0.0.1":1}', 'and Ann now counts on the version she last sent');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ app floor checks PASSED.');
}
main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
