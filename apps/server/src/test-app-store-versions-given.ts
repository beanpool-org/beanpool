/**
 * APP_STORE_VERSIONS (app-store-versions.ts storeVersionsSetting): what a store has, as the operator says, in place of
 * asking it. Marty, 11 Nov: "I want to use test node to test this response". A 1.4.0 node refuses an older app only once
 * that platform's store has a build at or above the floor; the stores still had 1.3.4, so the test node let 1.3.4 in and
 * there was no way to show the block before the stores had 1.4.0.
 *
 *   1. reading it: both, one, none, and what it can't read. A platform it names takes the version it gives; one it
 *      doesn't is the store's, as without it. An entry it can't read leaves every platform it could mean with no store
 *      version (nothing enforced), and the log says why once, not on every read
 *   2. it never lowers anything: a version below the floor holds the floor; MIN_APP_VERSION and MIN_APP_VERSION_FROM
 *      apply as without it
 *   3. no request to a store it names: every fetch this process makes goes through a recorder that refuses any host
 *      but this machine, so a store asked is a store counted
 *   4. the start: one line naming the versions it gives and that those stores are not asked
 *   5. over HTTPS: with android=1.4.0 a 1.3.4 Android app is refused a gated read and a write, 426 app_too_old, while its
 *      way out (the push token's DELETE) still answers; without it the same request is answered (today's behaviour);
 *      health's appVersions and appFloors show the versions given, blocking true or false accordingly
 *   6. it reaches a node and its operator: docker-compose.yml passes it, .env.example lists it empty, and the operator
 *      manual's app-floor page says it is for a test community
 *
 * On origin/main every check that sets APP_STORE_VERSIONS fails: the node read nothing of it, asked both stores, and
 * enforced no floor the stores didn't meet.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-app-store-versions-given.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.BEANPOOL_ADDRESSES;
for (const k of [
    'APP_STORE_VERSIONS', 'DISABLE_APP_STORE_CHECK', 'MIN_APP_VERSION', 'MIN_APP_VERSION_IOS', 'MIN_APP_VERSION_ANDROID',
    'MIN_APP_VERSION_FROM', 'MIN_APP_VERSION_FROM_IOS', 'MIN_APP_VERSION_FROM_ANDROID',
]) {
    delete process.env[k];
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { db } from './db/db.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { signedHeaders } from './signed-request-test-helper.js';
import { logger } from './logger.js';
import {
    applyCheckResult, checkAppStoreVersions, floorRefusing, getAppStoreVersions, getPlatformFloorDetail,
    initAppStoreVersionChecks, __resetAppStoreVersionsForTest,
} from './app-store-versions.js';
import { APP_VERSION_HEADER } from './app-version-counts.js';
import { pushTokenId } from './services/push-token-seal.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DAY_MS = 24 * 60 * 60 * 1000;

function setEnv(env: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

// Every fetch in this process: this machine's server answers; any other host is recorded and refused, as a name that
// does not resolve is.
const PLAY = 'play.google.com', APPLE = 'itunes.apple.com';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
    outside.push(url.hostname);
    throw new TypeError('fetch failed');
}) as typeof fetch;
const askedSince = (from: number) => outside.slice(from).sort().join(',');

// Every warning, captured (and still printed).
const warnings: string[] = [];
const realWarn = logger.warn.bind(logger);
(logger as any).warn = (cat: string, msg: string, ...rest: unknown[]) => {
    warnings.push(String(msg));
    return (realWarn as any)(cat, msg, ...rest);
};
const settingWarnings = () => warnings.filter(w => w.includes('APP_STORE_VERSIONS='));

/** The stores as they are today (11 Nov): both have 1.3.4. */
function storesHave134(): void {
    __resetAppStoreVersionsForTest();
    applyCheckResult({ android: '1.3.4', ios: '1.3.4' });
}

const detail = (p: 'android' | 'ios') => {
    const d = getPlatformFloorDetail(p);
    return `${p} floor=${d.floor} store=${d.store} enforced=${d.enforced} held=${d.held} blocking=${d.blocking}`;
};

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

interface Answer { status: number; body: any; text: string }
let BASE = '';

/** A request to this community, signed by `signer` (format 2) or unsigned, with `extra` headers and a JSON body. */
async function call(method: string, urlPath: string, signer: Identity | null, extra: Record<string, string> = {}, body?: unknown): Promise<Answer> {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra };
    if (signer) Object.assign(headers, signedHeaders({ publicKeyHex: signer.pub, key: signer.priv, method, path: urlPath.split('?')[0], body: bodyString }));
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body === undefined ? undefined : bodyString });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, text };
}

async function main(): Promise<void> {
    console.log('\n=== APP_STORE_VERSIONS: a test community says what the stores have ===\n');

    // ── 1. reading it ─────────────────────────────────────────────────────────────────────────────
    console.log('--- 1. reading it: both, one, none, and what it can\'t read ---');
    storesHave134();
    let v = getAppStoreVersions();
    assert(v.android === '1.3.4' && v.ios === '1.3.4', `none: the stores' own versions, as today (${JSON.stringify(v)})`);
    assert(getPlatformFloorDetail('android').blocking === false && getPlatformFloorDetail('android').held === true,
        `none: the floor 1.4.0 is held for Google Play's 1.3.4, stopping nobody (${detail('android')})`);
    assert(floorRefusing('android', '1.3.4') === null, 'none: a 1.3.4 Android app is refused nothing');

    setEnv({ APP_STORE_VERSIONS: '' });
    v = getAppStoreVersions();
    assert(v.android === '1.3.4' && v.ios === '1.3.4' && getPlatformFloorDetail('android').blocking === false,
        `set but empty: the same as unset (${JSON.stringify(v)})`);

    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0,ios=1.4.0' });
    v = getAppStoreVersions();
    assert(v.android === '1.4.0' && v.ios === '1.4.0', `both: the versions given, in place of the stores' (${JSON.stringify(v)})`);
    for (const p of ['android', 'ios'] as const) {
        const d = getPlatformFloorDetail(p);
        assert(d.store === '1.4.0' && d.enforced === '1.4.0' && d.held === false && d.blocking === true,
            `both: ${p}'s floor 1.4.0 is enforced and blocks (${detail(p)})`);
    }
    assert(floorRefusing('android', '1.3.4') === '1.4.0' && floorRefusing('ios', '1.3.4') === '1.4.0',
        'both: a 1.3.4 app on either is refused below 1.4.0');
    assert(floorRefusing('android', '1.4.0') === null, 'both: an app at the floor is refused nothing');
    assert(v.checkedAt === getAppStoreVersions().checkedAt && typeof v.checkedAt === 'string',
        `checkedAt stays the stores' own, when one last answered (${v.checkedAt})`);

    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0' });
    v = getAppStoreVersions();
    assert(v.android === '1.4.0' && v.ios === '1.3.4', `one (android): android's given, iOS the App Store's own (${JSON.stringify(v)})`);
    assert(getPlatformFloorDetail('android').blocking === true && getPlatformFloorDetail('ios').blocking === false
        && getPlatformFloorDetail('ios').held === true,
        `one: Android blocks, iOS is held for its store as today (${detail('android')}; ${detail('ios')})`);
    assert(floorRefusing('android', '1.3.4') === '1.4.0' && floorRefusing('ios', '1.3.4') === null,
        'one: a 1.3.4 Android app is refused, a 1.3.4 iPhone app is not');

    setEnv({ APP_STORE_VERSIONS: ' Android = v1.4.0 , ios=1.4 ,' });
    v = getAppStoreVersions();
    assert(v.android === '1.4.0' && v.ios === '1.4', `spaces, a capital, a leading v, a two-part version and a trailing comma read as a store's would (${JSON.stringify(v)})`);
    assert(getPlatformFloorDetail('ios').blocking === true, `ios=1.4 meets the floor 1.4.0 (${detail('ios')})`);

    // What it can't read stops nobody on the platforms it could mean, and asks no store for them (3).
    const unreadable: Array<{ value: string; android: string | null; ios: string | null; says: string; why: string }> = [
        { value: 'android=banana', android: null, ios: '1.3.4', says: '"android=banana" is not a version', why: 'a version that isn\'t one' },
        { value: 'android=', android: null, ios: '1.3.4', says: '"android=" is not a version', why: 'no version' },
        { value: 'android=1.4.0,android=1.4.1', android: null, ios: '1.3.4', says: 'android is named twice', why: 'a platform named twice' },
        { value: 'android=1.4.0,ios=nope', android: '1.4.0', ios: null, says: '"ios=nope" is not a version', why: 'one good, one not' },
        { value: '1.4.0', android: null, ios: null, says: '"1.4.0" names neither android nor ios', why: 'no platform' },
        { value: 'android:1.4.0', android: null, ios: null, says: '"android:1.4.0" names neither', why: 'the wrong separator' },
        { value: 'web=1.4.0,android=1.4.0', android: null, ios: null, says: '"web=1.4.0" names neither', why: 'a platform that isn\'t one, beside a good one' },
    ];
    for (const u of unreadable) {
        storesHave134();
        const before = settingWarnings().length;
        setEnv({ APP_STORE_VERSIONS: u.value });
        v = getAppStoreVersions();
        assert(v.android === u.android && v.ios === u.ios,
            `${u.why} (${u.value}): android ${u.android ?? 'unknown'}, ios ${u.ios ?? 'unknown'} (got ${JSON.stringify(v)})`);
        for (const p of ['android', 'ios'] as const) {
            if (u[p] !== null) continue;
            const d = getPlatformFloorDetail(p);
            assert(d.store === null && d.enforced === null && d.blocking === false && floorRefusing(p, '1.3.4') === null,
                `  ${p}: no store version, nothing enforced, a 1.3.4 app refused nothing (${detail(p)})`);
        }
        for (let i = 0; i < 5; i++) { getAppStoreVersions(); getPlatformFloorDetail('android'); floorRefusing('ios', '1.3.4'); }
        const said = settingWarnings().slice(before);
        assert(said.length === 1 && said[0].includes(u.says),
            `  the log says why, once over many reads (${said.length}: ${said.join(' | ') || 'nothing'})`);
    }
    storesHave134();
    setEnv({ APP_STORE_VERSIONS: 'android=banana' });
    getAppStoreVersions();
    const changedBefore = settingWarnings().length;
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0' });
    getAppStoreVersions();
    setEnv({ APP_STORE_VERSIONS: 'android=pear' });
    getAppStoreVersions();
    assert(settingWarnings().length === changedBefore + 1, 'a new value it can\'t read is logged again: once each time the value changes');

    // ── 2. it never lowers anything ───────────────────────────────────────────────────────────────
    console.log('\n--- 2. it never lowers anything ---');
    storesHave134();
    setEnv({ APP_STORE_VERSIONS: 'android=1.3.9' });
    let d = getPlatformFloorDetail('android');
    assert(d.floor === '1.4.0' && d.store === '1.3.9' && d.held === true && d.enforced === null && d.blocking === false,
        `a version below the floor holds the floor, as a store behind it does (${detail('android')})`);
    assert(warnings.some(w => w.includes('android floor 1.4.0 is held') && w.includes('has 1.3.9')), 'and the log says it is held');
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0', MIN_APP_VERSION: '1.5.0' });
    d = getPlatformFloorDetail('android');
    assert(d.floor === '1.5.0' && d.held === true && d.blocking === false && floorRefusing('android', '1.4.0') === null,
        `MIN_APP_VERSION=1.5.0 stands above the 1.4.0 given: held, never lowered to it (${detail('android')})`);
    setEnv({ MIN_APP_VERSION: '1.2.0' });
    d = getPlatformFloorDetail('android');
    assert(d.floor === '1.4.0', `a MIN_APP_VERSION below the built-in floor is ignored as without it (${d.floor})`);
    setEnv({ MIN_APP_VERSION: undefined, MIN_APP_VERSION_FROM: new Date(Date.now() + 7 * DAY_MS).toISOString().slice(0, 10) });
    d = getPlatformFloorDetail('android');
    assert(d.enforced === '1.4.0' && d.blocking === false && floorRefusing('android', '1.3.4') === null,
        `a grace date still ahead: enforced, not yet blocking, nothing refused (${detail('android')})`);
    setEnv({ MIN_APP_VERSION_FROM: 'soon' });
    d = getPlatformFloorDetail('android');
    assert(d.fromInvalid === true && d.blocking === false, 'a grace date that is not a date still turns the block off');
    setEnv({ MIN_APP_VERSION_FROM: undefined });

    // ── 3. no request to a store it names ─────────────────────────────────────────────────────────
    console.log('\n--- 3. no request to a store it names ---');
    const checks: Array<{ value: string | undefined; asked: string; why: string }> = [
        { value: undefined, asked: [APPLE, PLAY].sort().join(','), why: 'unset: both stores, as today' },
        { value: 'android=1.4.0', asked: APPLE, why: 'android named: the App Store only' },
        { value: 'ios=1.4.0', asked: PLAY, why: 'ios named: Google Play only' },
        { value: 'android=1.4.0,ios=1.4.0', asked: '', why: 'both named: neither' },
        { value: 'android=banana', asked: APPLE, why: 'android named but unreadable: Google Play still not asked' },
        { value: '1.4.0', asked: '', why: 'unreadable for both: neither' },
    ];
    for (const c of checks) {
        storesHave134();
        setEnv({ APP_STORE_VERSIONS: c.value });
        const at = outside.length;
        const result = await checkAppStoreVersions();
        assert(askedSince(at) === c.asked, `${c.why} (asked: ${askedSince(at) || 'none'})`);
        if (c.value === 'android=1.4.0') {
            assert(result.android === '1.4.0' && result.ios === '1.3.4',
                `  the check answers the version given, and keeps the App Store's last answer when it is refused (${JSON.stringify(result)})`);
        }
    }
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0', DISABLE_APP_STORE_CHECK: 'true' });
    storesHave134();
    const offAt = outside.length;
    await checkAppStoreVersions();
    assert(askedSince(offAt) === '' && getPlatformFloorDetail('android').blocking === true,
        `with DISABLE_APP_STORE_CHECK=true: no store asked, and the version given still applies (${detail('android')})`);
    setEnv({ DISABLE_APP_STORE_CHECK: undefined });

    // ── 4. the start ─────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. the start ---');
    __resetAppStoreVersionsForTest();
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0,ios=1.4.1' });
    const startAt = warnings.length;
    // The boot's own call, with its timers caught rather than armed, so no later check runs inside this suite.
    const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
    const armed: number[] = [];
    globalThis.setTimeout = ((_cb: unknown, ms?: number) => { armed.push(ms ?? 0); return { unref() { return this; } }; }) as any;
    globalThis.setInterval = ((_cb: unknown, ms?: number) => { armed.push(ms ?? 0); return { unref() { return this; } }; }) as any;
    try {
        initAppStoreVersionChecks();
    } finally {
        globalThis.setTimeout = realTimeout;
        globalThis.setInterval = realInterval;
    }
    const startLines = warnings.slice(startAt).filter(w => w.includes('APP_STORE_VERSIONS'));
    assert(startLines.length === 1, `the start says it in one line (${startLines.length}: ${startLines.join(' | ') || 'nothing'})`);
    const line = startLines[0] ?? '';
    assert(line.includes('android=1.4.0') && line.includes('ios=1.4.1'), 'naming each version given');
    assert(line.includes('does not ask') && line.includes('Google Play') && line.includes('the App Store'), 'and that those stores are not asked');
    assert(line.includes('test community only'), 'and that it is for a test community only');
    assert(armed.length === 2, `the check for a platform it doesn't name still arms its timers (${armed.join(', ')} ms)`);

    // ── 5. over HTTPS ─────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. over HTTPS ---');
    await initTls();
    initStateEngine();
    const owner = keyPair(), ann = keyPair();
    seedGenesisMember(owner.pub, 'Owner');
    addMember(ann, 'Ann');
    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const app = (version: string, platform: 'android' | 'ios') => ({ [APP_VERSION_HEADER]: `${version} ${platform}` });
    const balancePath = `/api/ledger/balance/${ann.pub}`;
    const registered = (token: string) => !!db.prepare('SELECT 1 FROM push_tokens WHERE public_key = ? AND token_id = ?').get(ann.pub, pushTokenId(token));
    const health = async () => (await call('GET', '/api/community/health', null)).body;

    // Without it: today's behaviour.
    setEnv({ APP_STORE_VERSIONS: undefined });
    storesHave134();
    let h = await health();
    assert(h.appVersions?.android === '1.3.4' && h.appVersions?.ios === '1.3.4', `without it, health serves the stores' 1.3.4 (${JSON.stringify(h.appVersions)})`);
    assert(JSON.stringify(h.appFloors) === '{"android":{"min":null,"blocking":false},"ios":{"min":null,"blocking":false}}',
        `and no floor enforced, blocking false (${JSON.stringify(h.appFloors)})`);
    const plain = await call('GET', balancePath, ann);
    assert(plain.status === 200, `Ann's balance with no app header: 200 (got ${plain.status})`);
    let r = await call('GET', balancePath, ann, app('1.3.4', 'android'));
    assert(r.status === 200 && r.text === plain.text, `without it, her 1.3.4 Android app's balance read is answered, as today (got ${r.status} ${r.text})`);

    // With android=1.4.0: the block, on Android only.
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0' });
    h = await health();
    assert(h.appVersions?.android === '1.4.0' && h.appVersions?.ios === '1.3.4',
        `android=1.4.0: health serves android 1.4.0, ios the App Store's 1.3.4 (${JSON.stringify(h.appVersions)})`);
    assert(JSON.stringify(h.appFloors?.android) === '{"min":"1.4.0","blocking":true}' && JSON.stringify(h.appFloors?.ios) === '{"min":null,"blocking":false}',
        `appFloors: Android enforced and blocking, iOS not (${JSON.stringify(h.appFloors)})`);
    r = await call('GET', balancePath, ann, app('1.3.4', 'android'));
    assert(r.status === 426 && r.body?.code === 'app_too_old' && r.body?.minAppVersion === '1.4.0' && !r.text.includes('balance'),
        `her 1.3.4 Android app's balance read: 426 app_too_old with the floor 1.4.0 (got ${r.status} ${r.text})`);
    r = await call('POST', '/api/ledger/transfer', null, app('1.3.4', 'android'), {});
    assert(r.status === 426 && r.body?.code === 'app_too_old', `and a write from it: 426 app_too_old (got ${r.status})`);
    r = await call('GET', balancePath, ann, app('1.4.0', 'android'));
    assert(r.status === 200 && r.text === plain.text, `an Android app at 1.4.0 is answered (got ${r.status})`);
    r = await call('GET', balancePath, ann, app('1.3.4', 'ios'));
    assert(r.status === 200 && r.text === plain.text, `a 1.3.4 iPhone app is answered: iOS is not named (got ${r.status})`);
    r = await call('GET', '/api/community/health', ann, app('1.3.4', 'android'));
    assert(r.status === 200 && r.body?.minAppVersion === '1.4.0', `her health ping, a public read, is answered with the floor (got ${r.status} ${r.body?.minAppVersion})`);
    // The way out: "Update required"'s Leave this community drops the phone's push token (floorLetsThrough).
    const TOKEN = 'ExponentPushToken[ann-given]';
    r = await call('POST', '/api/push-tokens', ann, app('1.4.0', 'android'), { publicKey: ann.pub, token: TOKEN, platform: 'android', registeredAt: 1000 });
    assert(r.status === 200 && registered(TOKEN), `her phone registers a push token from 1.4.0 (got ${r.status} ${r.text})`);
    r = await call('POST', '/api/push-tokens', ann, app('1.3.4', 'android'), { publicKey: ann.pub, token: 'ExponentPushToken[ann-new]', platform: 'android' });
    assert(r.status === 426, `a registration from 1.3.4 is no way out: 426 (got ${r.status})`);
    r = await call('DELETE', '/api/push-tokens', ann, app('1.3.4', 'android'), { publicKey: ann.pub, token: TOKEN });
    assert(r.status === 200 && r.body?.success === true && !registered(TOKEN),
        `the way out, the push token's DELETE from her 1.3.4 app, still passes and the token is gone (got ${r.status} ${r.text})`);

    // The manager's route reads the same detail.
    const managerView = await call('GET', '/api/local/admin/app-versions', null, ownerSessionHeaders());
    const ma = managerView.body?.platforms?.android;
    assert(managerView.status === 200 && ma?.store === '1.4.0' && ma?.enforced === '1.4.0' && ma?.blocking === true,
        `the manager's route shows Android's store as 1.4.0, enforced and blocking (got ${managerView.status} ${JSON.stringify(ma)})`);

    // Both.
    setEnv({ APP_STORE_VERSIONS: 'android=1.4.0,ios=1.4.0' });
    h = await health();
    assert(h.appVersions?.android === '1.4.0' && h.appVersions?.ios === '1.4.0'
        && JSON.stringify(h.appFloors) === '{"android":{"min":"1.4.0","blocking":true},"ios":{"min":"1.4.0","blocking":true}}',
        `both: health serves both 1.4.0, both blocking (${JSON.stringify(h.appVersions)} ${JSON.stringify(h.appFloors)})`);
    r = await call('GET', balancePath, ann, app('1.3.4', 'ios'));
    assert(r.status === 426 && r.body?.code === 'app_too_old', `both: a 1.3.4 iPhone app is refused too (got ${r.status})`);

    // What it can't read: nothing enforced on the platform it could mean.
    setEnv({ APP_STORE_VERSIONS: 'android=banana' });
    h = await health();
    assert(h.appVersions?.android === null && JSON.stringify(h.appFloors?.android) === '{"min":null,"blocking":false}',
        `android=banana: health serves no Android store version and no Android floor (${JSON.stringify(h.appVersions)} ${JSON.stringify(h.appFloors)})`);
    r = await call('GET', balancePath, ann, app('1.3.4', 'android'));
    assert(r.status === 200 && r.text === plain.text, `and her 1.3.4 Android app is answered (got ${r.status})`);

    // ── 6. it reaches a node and its operator ─────────────────────────────────────────────────────
    console.log('\n--- 6. compose, .env.example and the operator manual ---');
    assert(/^\s*- APP_STORE_VERSIONS=\$\{APP_STORE_VERSIONS:-\}\s*$/m.test(read('docker-compose.yml')),
        'docker-compose.yml passes APP_STORE_VERSIONS from .env to the server, empty by default');
    assert(/^APP_STORE_VERSIONS=\s*$/m.test(read('.env.example')), '.env.example lists it, empty');
    const manual = read('packages/beanpool-guide/operators/server/app-floor.md');
    assert(manual.includes('**APP_STORE_VERSIONS**') && manual.includes('for a test community only')
        && manual.includes('On a real community it would stop older apps before members can get the new version'),
        'the operator manual\'s app-floor page says it is for a test community, and what it would do on a real one');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ APP_STORE_VERSIONS lets a test community show "Update required" before the stores have the build.');
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
