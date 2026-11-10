/**
 * Force updates, the node's half (app-store-versions.ts floors, app-version-counts.ts): what the app is told and what the
 * operator sees. The app's half is apps/native/utils/__tests__/force-update.test.ts.
 *
 *   1. the env: MIN_APP_VERSION_IOS / _ANDROID fall back to MIN_APP_VERSION and the default; a floor set below the
 *      default (1.4.0) is ignored, the default applies, and one start-up line names each one ignored; MIN_APP_VERSION_FROM
 *      (and its per-platform forms) read a date or a date and time, and anything else is `invalid`, never a date
 *   2. the held floor: a floor is enforced only once that platform's store has a build that meets it. An unknown store
 *      enforces nothing; a store behind the floor holds it, and the log says so once, not on every read
 *   3. the grace date: before it a floor stops nobody (blocking false), from it it does; a date that isn't one never does
 *   4. per platform: iOS held for its store while Android is enforced, each with its own grace date
 *   5. the counts: the header parsed strictly; only a signer `counts` accepts is counted; an update moves the member; a
 *      member not seen for 30 days drops out; the counts carry no key
 *   6. over HTTPS: health serves `appFloors` and `minAppVersionFrom` and stays small; a member's signed request with the
 *      header is counted, an unsigned one, a stranger's key and a garbled header are not; the manager's route is the
 *      owner's and admins' only and answers the floors and the counts
 *   7. below the floor (1.4.0): an app below its platform's blocking floor is refused its writes and members-only reads,
 *      426 app_too_old with the floor; public reads, an app at the floor, one below a held floor or before its grace
 *      date, and a request with no header (the web app) are answered; so are the ways out of "Update required", from
 *      the app below the floor: the push token's DELETE (Leave this community's, and Sign Out's with the leave's stamp)
 *      and a leave statement, while a push token registration stays refused
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
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { logger } from './logger.js';
import {
    applyCheckResult, getPlatformFloor, getFloorFrom, getMinAppVersionFrom, getPlatformFloorDetail, getAppFloors,
    getUnnamedAppFloor, getMinAppVersion, floorsBelowBuiltIn, noteFloorsBelowBuiltIn, __resetAppStoreVersionsForTest,
} from './app-store-versions.js';
import { pushTokenId } from './services/push-token-seal.js';
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
    db.prepare('INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pub);
}

const bound = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.from(text, 'utf8')]);

interface Answer { status: number; body: any; text: string; headers: Record<string, string> }

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
    return { status: res.status, body, text, headers: Object.fromEntries(res.headers.entries()) };
}

/** A write to this community with a JSON body, signed by `signer` for it (request binding, body and all) or unsigned. */
async function send(method: 'POST' | 'DELETE', path: string, body: unknown, signer: Identity | null, extra: Record<string, string> = {}): Promise<Answer> {
    const bodyString = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (signer) {
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const text = `beanpool-request/2\n${HOST}\n${method}\n${path}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = crypto.sign(null, bound(text), signer.priv).toString('base64');
        headers['X-Timestamp'] = ts;
        headers['X-Nonce'] = nonce;
        headers['X-Signed-For'] = HOST;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyString });
    const text = await res.text();
    let parsed: Answer['body'];
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, text, headers: Object.fromEntries(res.headers.entries()) };
}

const counted = (platform: 'android' | 'ios') => Object.fromEntries(getAppVersionCounts().platforms[platform].map(v => [v.version, v.members]));

async function main(): Promise<void> {
    console.log('\n=== Force updates: the floors a node serves, and the versions it counts ===\n');

    // ── 1. the env ──────────────────────────────────────────────────────────────────────────────
    console.log('--- 1. the env ---');
    __resetAppStoreVersionsForTest();
    assert(getPlatformFloor('ios') === '1.4.0' && getPlatformFloor('android') === '1.4.0', 'no floor set: both platforms have the default, 1.4.0 (the cutover)');
    setEnv({ MIN_APP_VERSION: '1.5.0' });
    assert(getPlatformFloor('ios') === '1.5.0' && getPlatformFloor('android') === '1.5.0', 'MIN_APP_VERSION alone: both platforms have it');
    setEnv({ MIN_APP_VERSION_IOS: 'v1.5.2' });
    assert(getPlatformFloor('ios') === '1.5.2', "MIN_APP_VERSION_IOS is iOS's floor, leading v and all");
    assert(getPlatformFloor('android') === '1.5.0', 'and Android keeps MIN_APP_VERSION');
    setEnv({ MIN_APP_VERSION_ANDROID: 'soon' });
    assert(getPlatformFloor('android') === '1.5.0', 'a platform floor that is not a version is ignored: the generic one stands');
    setEnv({ MIN_APP_VERSION: undefined, MIN_APP_VERSION_IOS: undefined, MIN_APP_VERSION_ANDROID: undefined });

    // A floor in .env raises the built-in one and never lowers it (#3047's deciding review, finding 2): one set before
    // the cutover, as G7's was (after 1.2.55), is ignored, and the start says so in one line (initAppStoreVersionChecks).
    const startLines = () => warnings.filter(w => w.includes("below this server's own floor")).length;
    assert(floorsBelowBuiltIn().length === 0 && noteFloorsBelowBuiltIn() === null && startLines() === 0,
        'no floor set: nothing is ignored, and the start says nothing');
    setEnv({ MIN_APP_VERSION: 'v1.2.60' });
    assert(getMinAppVersion() === '1.4.0' && getPlatformFloor('ios') === '1.4.0' && getPlatformFloor('android') === '1.4.0',
        `MIN_APP_VERSION=1.2.60, below the built-in floor: both platforms keep 1.4.0 (got ${getPlatformFloor('ios')} / ${getPlatformFloor('android')})`);
    assert(getUnnamedAppFloor() === '1.4.0', 'and so does an app that names no platform');
    let startLine = noteFloorsBelowBuiltIn();
    assert(startLines() === 1 && !!startLine && startLine === warnings[warnings.length - 1]
        && startLine.includes('MIN_APP_VERSION=1.2.60 in .env is below') && startLine.includes('so it is ignored and 1.4.0 applies'),
        `one line in the log names it and what applies instead (${startLine})`);
    setEnv({ MIN_APP_VERSION: '1.5.0', MIN_APP_VERSION_IOS: '1.3.9', MIN_APP_VERSION_ANDROID: 'v1.2.8' });
    assert(getPlatformFloor('ios') === '1.4.0' && getPlatformFloor('android') === '1.4.0' && getMinAppVersion() === '1.5.0',
        'MIN_APP_VERSION raises it to 1.5.0, while each platform held back below 1.4.0 stops at 1.4.0, never under it');
    startLine = noteFloorsBelowBuiltIn();
    assert(startLines() === 2 && JSON.stringify(floorsBelowBuiltIn()) === '["MIN_APP_VERSION_ANDROID=1.2.8","MIN_APP_VERSION_IOS=1.3.9"]'
        && !!startLine?.startsWith('[AppVersions] MIN_APP_VERSION_ANDROID=1.2.8, MIN_APP_VERSION_IOS=1.3.9 in .env are below'),
        `the two ignored ones, in one line; MIN_APP_VERSION=1.5.0 is no part of it (${startLine})`);
    setEnv({ MIN_APP_VERSION: '1.4.0', MIN_APP_VERSION_IOS: undefined, MIN_APP_VERSION_ANDROID: undefined });
    assert(getPlatformFloor('android') === '1.4.0' && noteFloorsBelowBuiltIn() === null && startLines() === 2,
        'MIN_APP_VERSION=1.4.0, the built-in floor itself: applied, and nothing to say');
    setEnv({ MIN_APP_VERSION: undefined });

    // An app that can't say which kind of phone it is on (every build before the full-screen update): the lower of the
    // two platforms' floors, never one above its own platform's (#1415's deciding review: with only per-platform floors
    // set, those apps got no banner at all).
    assert(getUnnamedAppFloor() === '1.4.0', 'no floor set: an app that names no platform has the default');
    setEnv({ MIN_APP_VERSION: '1.4.5' });
    assert(getUnnamedAppFloor() === '1.4.5', 'MIN_APP_VERSION alone: it, as always');
    setEnv({ MIN_APP_VERSION: undefined, MIN_APP_VERSION_ANDROID: '1.4.2' });
    assert(getUnnamedAppFloor() === '1.4.0', 'Android raised alone: an app that names no platform may be an iPhone, so its floor stays');
    setEnv({ MIN_APP_VERSION_IOS: '1.4.1' });
    assert(getUnnamedAppFloor() === '1.4.1', 'both raised: the lower of the two, which every platform has reached');
    setEnv({ MIN_APP_VERSION_IOS: '1.4.3' });
    assert(getUnnamedAppFloor() === '1.4.2', 'whichever platform is the lower one');
    setEnv({ MIN_APP_VERSION: '1.5.0', MIN_APP_VERSION_ANDROID: undefined, MIN_APP_VERSION_IOS: '1.4.5' });
    assert(getUnnamedAppFloor() === '1.4.5', 'a platform held below MIN_APP_VERSION: the unnamed app is held to no more than it');
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
    setEnv({ MIN_APP_VERSION: '1.5.0' });
    let d = getPlatformFloorDetail('android');
    assert(d.store === null && d.enforced === null && !d.blocking && !d.held,
        'the store version is unknown: nothing is enforced and nothing is said to be held');
    applyCheckResult({ android: '1.4.6', ios: null });
    const before = heldWarnings('android');
    d = getPlatformFloorDetail('android');
    assert(d.store === '1.4.6' && d.enforced === null && d.held && !d.blocking,
        'the store has 1.4.6, the floor is 1.5.0: held, enforced null, blocking nobody');
    assert(heldWarnings('android') === before + 1, 'the hold is logged');
    for (let i = 0; i < 5; i++) getAppFloors();
    assert(heldWarnings('android') === before + 1, 'once: reading the floors again does not log it again');
    assert(warnings.some(w => w.includes('android floor 1.5.0 is held') && w.includes('the store has 1.4.6')),
        'the line names the floor and the store version');
    applyCheckResult({ android: '1.5.0', ios: null });
    d = getPlatformFloorDetail('android');
    assert(d.enforced === '1.5.0' && !d.held && d.blocking, 'the store reaches 1.5.0: the floor is enforced, and with no grace date it blocks');
    applyCheckResult({ android: '1.5.2', ios: null });
    d = getPlatformFloorDetail('android');
    assert(d.enforced === '1.5.0', 'a store ahead of the floor: the floor itself is enforced, never the store version');

    // ── 3. the grace date ───────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. the grace date ---');
    const now = new Date('2026-10-10T12:00:00Z');
    setEnv({ MIN_APP_VERSION_FROM: '2026-10-15' });
    d = getPlatformFloorDetail('android', now);
    assert(d.enforced === '1.5.0' && d.from === '2026-10-15T00:00:00.000Z' && !d.blocking, 'before the grace date: enforced, but blocking nobody yet');
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
    setEnv({ MIN_APP_VERSION: '1.4.5', MIN_APP_VERSION_IOS: '1.5.0', MIN_APP_VERSION_ANDROID: '1.5.0', MIN_APP_VERSION_FROM_ANDROID: '2026-10-01' });
    applyCheckResult({ android: '1.5.0', ios: '1.4.61' }); // Apple still reviewing 1.5.0
    const floors = getAppFloors(new Date('2026-10-05T00:00:00Z'));
    assert(floors.android.min === '1.5.0' && floors.android.blocking,
        'Android: its store has 1.5.0, its grace date has passed: enforced and blocking');
    assert(getAppFloors(new Date('2026-09-30T00:00:00Z')).android.blocking === false, 'and not before its own grace date');
    assert(floors.ios.min === null && !floors.ios.blocking,
        'iOS: its store is still on 1.4.61, so its 1.5.0 floor stops nobody (iOS review lag)');
    assert(heldWarnings('ios') >= 1, "iOS's hold is logged");
    applyCheckResult({ android: null, ios: '1.5.0' });
    const later = getAppFloors(new Date('2026-10-06T00:00:00Z'));
    assert(later.ios.min === '1.5.0' && later.ios.blocking, 'once Apple publishes 1.5.0, iOS is enforced too');
    assert(later.android.min === '1.5.0', 'a store check that missed Android keeps its last answer, and its floor');
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
    applyCheckResult({ android: '1.4.2', ios: '1.4.1' });
    setEnv({ MIN_APP_VERSION_ANDROID: '1.4.2', MIN_APP_VERSION_IOS: '1.4.2', MIN_APP_VERSION_FROM: '2026-01-01' });

    let r = await get('/api/community/health', null);
    assert(r.status === 200, `health answers (got ${r.status})`);
    assert(r.body.minAppVersion === '1.4.2', `minAppVersion, for builds before this one: both platforms raised to 1.4.2, so 1.4.2 (got ${r.body.minAppVersion})`);
    assert(r.body.minAppVersionFrom === '2026-01-01T00:00:00.000Z', 'minAppVersionFrom is served');
    assert(JSON.stringify(r.body.appFloors?.android) === '{"min":"1.4.2","blocking":true}',
        `Android: enforced and blocking (got ${JSON.stringify(r.body.appFloors?.android)})`);
    assert(JSON.stringify(r.body.appFloors?.ios) === '{"min":null,"blocking":false}',
        `iOS: held for its store, blocking nobody (got ${JSON.stringify(r.body.appFloors?.ios)})`);
    assert(r.text.length < 800, `the public payload stays small (${r.text.length} bytes)`);
    // The banner's number: an app naming its platform gets that platform's floor; anything else the generic one.
    setEnv({ MIN_APP_VERSION_IOS: '1.4.1' });
    r = await get('/api/community/health', null, { [APP_VERSION_HEADER]: '1.2.57 android' });
    assert(r.body.minAppVersion === '1.4.2', `an Android app's minAppVersion is the Android floor (got ${r.body.minAppVersion})`);
    r = await get('/api/community/health', null, { [APP_VERSION_HEADER]: '1.2.57 ios' });
    assert(r.body.minAppVersion === '1.4.1', `an iPhone app's is the iOS floor (got ${r.body.minAppVersion})`);
    assert(String(r.headers?.vary ?? '').toLowerCase().includes('x-beanpool-app'), `the answer varies by the header (Vary: ${r.headers?.vary})`);
    r = await get('/api/community/health', null, { [APP_VERSION_HEADER]: 'nonsense' });
    assert(r.body.minAppVersion === '1.4.1', `a garbled header gets the lower of the two floors (got ${r.body.minAppVersion})`);
    r = await get('/api/community/health', null);
    assert(r.body.minAppVersion === '1.4.1', `and so does a request without one (an older app, the web app) (got ${r.body.minAppVersion})`);
    setEnv({ MIN_APP_VERSION_IOS: undefined });
    r = await get('/api/community/health', null);
    assert(r.body.minAppVersion === '1.4.0', `Android alone raised: an app that names no platform keeps MIN_APP_VERSION (got ${r.body.minAppVersion})`);
    r = await get('/api/community/health', null, { [APP_VERSION_HEADER]: '1.2.57 android' });
    assert(r.body.minAppVersion === '1.4.2', `while an Android app that names itself gets Android's (got ${r.body.minAppVersion})`);
    setEnv({ MIN_APP_VERSION_IOS: '1.4.2' });
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
    // Step 7c: with the node's 2FA off, the owner's password alone is refused; the manager sends an owner's automation token.
    r = await get(route, null, { 'X-Admin-Password': PW });
    assert(r.status === 403 && r.body?.code === 'password_needs_2fa' && !r.text.includes('"platforms"'),
        `the owner's password alone, 2FA off: 403 password_needs_2fa, no counts (got ${r.status})`);
    resetAdminAuthTarpit();
    const managerToken = ownerTokenHeaders('admin');
    r = await get(route, null, managerToken);
    assert(r.status === 200, `the owner's automation token: 200 (got ${r.status})`);
    const a = r.body?.platforms?.android, i = r.body?.platforms?.ios;
    assert(a?.floor === '1.4.2' && a?.store === '1.4.2' && a?.enforced === '1.4.2' && a?.held === false && a?.blocking === true,
        `Android's floor as set, its store and its enforcement (got ${JSON.stringify(a)})`);
    assert(i?.floor === '1.4.2' && i?.store === '1.4.1' && i?.enforced === null && i?.held === true && i?.blocking === false,
        `iOS held for its store (got ${JSON.stringify(i)})`);
    assert(JSON.stringify(a?.versions) === '[{"version":"1.2.57","members":1}]' && JSON.stringify(i?.versions) === '[{"version":"1.2.61","members":1}]',
        `the counts per version (got ${JSON.stringify(a?.versions)} / ${JSON.stringify(i?.versions)})`);
    assert(typeof r.body.since === 'string' && r.body.windowDays === 30 && r.body.minAppVersionFrom === '2026-01-01T00:00:00.000Z',
        'since, the window and the grace date');
    assert(!r.text.includes(ann.pub) && !r.text.includes(ben.pub), 'the answer names no member');
    const post = await fetch(`${BASE}${route}`, { method: 'POST', headers: managerToken });
    assert(post.status === 404 || post.status === 405, `read-only: no POST (got ${post.status})`);

    // ── 7. below the floor: refused (cutover 1.4.0) ─────────────────────────────────────────────
    // Once a platform's floor blocks (its store has the build, its grace date has passed), an app below it is refused
    // every write and members-only read, 426 app_too_old with the floor, so it puts up "Update required" at once. Public
    // reads still answer, health with the floor. Below a floor that is held, or before its grace date, nothing is refused.
    console.log('\n--- 7. below the floor ---');
    const balancePath = `/api/ledger/balance/${ann.pub}`;
    const plain = await get(balancePath, ann);
    assert(plain.status === 200, `Ann's own balance, from a request with no header (the web app): 200 (got ${plain.status})`);
    const below = await get(balancePath, ann, { [APP_VERSION_HEADER]: '1.4.1 android' });
    assert(below.status === 426 && below.body?.code === 'app_too_old' && below.body?.minAppVersion === '1.4.2'
        && typeof below.body?.error === 'string' && below.headers['cache-control'] === 'no-store' && !below.text.includes('balance'),
        `Ann's balance from an Android app below its blocking floor: 426 app_too_old with the floor, no balance (got ${below.status} ${below.text})`);
    const far = await get(balancePath, ann, { [APP_VERSION_HEADER]: '0.0.1 android' });
    assert(far.status === 426 && far.body?.minAppVersion === '1.4.2', `and from one far below it (got ${far.status})`);
    const atFloor = await get(balancePath, ann, { [APP_VERSION_HEADER]: '1.4.2 android' });
    assert(atFloor.status === 200 && atFloor.text === plain.text, `at the floor: answered exactly as without the header (got ${atFloor.status})`);
    const heldBelow = await get(balancePath, ann, { [APP_VERSION_HEADER]: '1.2.57 ios' });
    assert(heldBelow.status === 200 && heldBelow.text === plain.text,
        `an iPhone app below iOS's floor, which is held for its store: answered, never refused (got ${heldBelow.status})`);
    const garbled = await get(balancePath, ann, { [APP_VERSION_HEADER]: 'nonsense' });
    assert(garbled.status === 200, `a header that isn't one refuses nothing (got ${garbled.status})`);
    const healthBelow = await get('/api/community/health', ann, { [APP_VERSION_HEADER]: '0.0.1 android' });
    assert(healthBelow.status === 200 && healthBelow.body?.minAppVersion === '1.4.2',
        `her health ping, a public read: answered, with the floor her app shows (got ${healthBelow.status} ${healthBelow.body?.minAppVersion})`);
    // A write is refused before its signature is looked at: unsigned, the same POST is 401 without the header.
    const writeOf = (extra: Record<string, string>) => fetch(`${BASE}/api/ledger/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: '{}',
    });
    const writeBelow = await writeOf({ [APP_VERSION_HEADER]: '1.4.1 android' });
    const writeBelowBody = await writeBelow.json().catch(() => null) as any;
    assert(writeBelow.status === 426 && writeBelowBody?.code === 'app_too_old', `a write from an app below the floor: 426 (got ${writeBelow.status})`);
    const writePlain = await writeOf({});
    assert(writePlain.status === 401, `the same write with no header: 401, no signature (got ${writePlain.status})`);

    // The ways out (#3047's deciding review, finding 1), each as the phone sends it while it is still set to this
    // community, its version and all. "Update required"'s Leave this community asks the community to drop the phone's
    // push token (the DELETE without a stamp: native account-leaves-phone.ts stopPushAlertsAt); leaving the last community
    // is Sign Out, which asks it with the leave's stamp (unregisterPushToken); a phone that couldn't reach it then
    // presents the leave statement, unsigned (push-leave.ts). Refused, the node would go on pushing her alerts to a phone
    // that left. A registration is no way out.
    const belowFloor = { [APP_VERSION_HEADER]: '1.4.1 android' };
    const registered = (token: string) => !!db.prepare('SELECT 1 FROM push_tokens WHERE public_key = ? AND token_id = ?').get(ann.pub, pushTokenId(token));
    const LEAVE = 'ExponentPushToken[ann-leave]', SIGN_OUT = 'ExponentPushToken[ann-sign-out]';
    const LATER = 'ExponentPushToken[ann-statement]', SLASH = 'ExponentPushToken[ann-slash]', NEW = 'ExponentPushToken[ann-new]';
    for (const token of [LEAVE, SIGN_OUT, LATER, SLASH]) {
        const reg = await send('POST', '/api/push-tokens', { publicKey: ann.pub, token, platform: 'android', registeredAt: 1000 }, ann,
            { [APP_VERSION_HEADER]: '1.4.2 android' });
        assert(reg.status === 200 && registered(token), `Ann's phone registers ${token} from an app at the floor (got ${reg.status} ${reg.text})`);
    }
    const regBelow = await send('POST', '/api/push-tokens', { publicKey: ann.pub, token: NEW, platform: 'android' }, ann, belowFloor);
    assert(regBelow.status === 426 && regBelow.body?.code === 'app_too_old' && !registered(NEW),
        `a registration from the app below the floor is no way out: 426, nothing registered (got ${regBelow.status})`);
    const leave = await send('DELETE', '/api/push-tokens', { publicKey: ann.pub, token: LEAVE }, ann, belowFloor);
    assert(leave.status === 200 && leave.body?.success === true && !registered(LEAVE),
        `Leave this community's push stop, from the app below the floor: answered by its route, and the token is gone (got ${leave.status} ${leave.text})`);
    const signOut = await send('DELETE', '/api/push-tokens', { publicKey: ann.pub, token: SIGN_OUT, leftAt: 2000 }, ann, belowFloor);
    assert(signOut.status === 200 && signOut.body?.success === true && !registered(SIGN_OUT),
        `Sign Out's, with the leave's stamp: answered, and the token is gone (got ${signOut.status} ${signOut.text})`);
    const statementText = `beanpool-push-leave/2\n${HOST}\n${ann.pub}\n${LATER}\n2000`;
    const statement = { token: LATER, leftAt: 2000, signature: crypto.sign(null, bound(statementText), ann.priv).toString('base64'), signedFor: HOST };
    const presented = await send('POST', `/api/push-tokens/leave/${ann.pub}`, statement, null, belowFloor);
    assert(presented.status === 200 && presented.body?.left === true && !registered(LATER),
        `her leave statement, presented later and unsigned by the app below the floor: taken, and the token is gone (got ${presented.status} ${presented.text})`);
    const slash = await send('DELETE', '/api/push-tokens/', { publicKey: ann.pub, token: SLASH }, ann, belowFloor);
    assert(slash.status === 200 && slash.body?.success === true && !registered(SLASH),
        `the DELETE with one trailing slash, which the router answers as the same route: let through too (got ${slash.status} ${slash.text})`);
    const stillRefused = await get(balancePath, ann, belowFloor);
    assert(stillRefused.status === 426 && stillRefused.body?.code === 'app_too_old',
        `and everything else from that app is still refused (got ${stillRefused.status})`);
    // Before Android's own grace date the block doesn't apply yet, so nothing is refused.
    setEnv({ MIN_APP_VERSION_FROM_ANDROID: new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10) });
    const graced = await get(balancePath, ann, { [APP_VERSION_HEADER]: '1.4.1 android' });
    assert(graced.status === 200 && graced.text === plain.text, `before the grace date: answered (got ${graced.status})`);
    setEnv({ MIN_APP_VERSION_FROM_ANDROID: undefined });

    assert(JSON.stringify(counted('android')) === '{"1.4.1":1}', 'Ann counts on the version her last answered request sent (a refused one is never counted)');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ app floor checks PASSED.');
}
main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
