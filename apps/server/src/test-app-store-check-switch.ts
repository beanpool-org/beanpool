/**
 * DISABLE_APP_STORE_CHECK (app-store-versions.ts appStoreCheckDisabled): the app-store version lookup's switch, as
 * DISABLE_UPDATE_CHECK is the GitHub check's. The no-mothership suite (#2143) found the lookup is the one call to a third
 * party every node makes with no way to turn it off.
 *
 *   1. On ('true'): initAppStoreVersionChecks arms no timer, and checkAppStoreVersions asks neither store. Every fetch
 *      this process makes goes through a recorder that refuses any host but this machine, so a store asked is a store
 *      counted.
 *   2. Off is unknown, never "up to date": /api/community/health serves null versions and no enforced floor (an app below
 *      MIN_APP_VERSION gets its banner only), and the manager's route says the check is off (`storeCheckOff`).
 *   3. The control: unset, or any value but 'true', the same call asks both stores (the recorder sees itunes.apple.com
 *      and play.google.com, refuses them, and the versions stay null: a refused store invents nothing).
 *   4. The switch reaches a node and its operator: docker-compose.yml passes it from .env, .env.example lists it empty,
 *      and the operator manual says how to turn the check off.
 *
 * On origin/main 1, 2's `storeCheckOff` and 4 fail: the lookup armed its two timers and asked both stores whatever the
 * environment said, and nothing passed or documented a switch.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-app-store-check-switch.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.DISABLE_APP_STORE_CHECK = 'true';
process.env.MIN_APP_VERSION = '1.2.60';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import {
    checkAppStoreVersions,
    getAppStoreVersions,
    initAppStoreVersionChecks,
    __resetAppStoreVersionsForTest,
} from './app-store-versions.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const STORES = ['itunes.apple.com', 'play.google.com'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Every fetch in this process: this machine's server answers; any other host is recorded and refused, as a name that
// does not resolve is.
const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
    outside.push(url.hostname);
    throw new TypeError('fetch failed');
}) as typeof fetch;

const storesAsked = (from: number) => outside.slice(from).filter(h => STORES.includes(h));

/** The timers `fn` arms, by delay. */
function timersArmedBy(fn: () => void): number[] {
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    const delays: number[] = [];
    globalThis.setTimeout = ((cb: any, ms?: number, ...a: any[]) => { delays.push(ms ?? 0); return realTimeout(cb, ms, ...a); }) as typeof setTimeout;
    globalThis.setInterval = ((cb: any, ms?: number, ...a: any[]) => { delays.push(ms ?? 0); return realInterval(cb, ms, ...a); }) as typeof setInterval;
    try {
        fn();
    } finally {
        globalThis.setTimeout = realTimeout;
        globalThis.setInterval = realInterval;
    }
    return delays;
}

async function main() {
    // ── 1. On: no timer, no request ─────────────────────────────────────────────────────────────────────
    console.log('\n— 1. DISABLE_APP_STORE_CHECK=true: no timer, no request —');
    __resetAppStoreVersionsForTest();
    const before = outside.length;
    const armed = timersArmedBy(() => initAppStoreVersionChecks());
    assert(armed.length === 0, `the boot's lookup arms no timer (${armed.length ? `armed ${armed.join(', ')} ms` : 'none'})`);
    const checked = await checkAppStoreVersions();
    assert(storesAsked(before).length === 0, `a check asks neither store (${storesAsked(before).join(', ') || 'none asked'})`);
    assert(outside.length === before, `and nothing else outside this machine (${outside.slice(before).join(', ') || 'nothing'})`);
    assert(checked.android === null && checked.ios === null && checked.checkedAt === null,
        `the versions stay unknown (${JSON.stringify(checked)})`);

    // ── 2. Off is unknown, never "up to date" ───────────────────────────────────────────────────────────
    console.log('\n— 2. what the phones and the manager are told —');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;
    const health = await (await fetch(`${base}/api/community/health`)).json() as any;
    assert(health.appVersions?.android === null && health.appVersions?.ios === null && health.appVersions?.checkedAt === null,
        `health tells the phones no store version: null, not a version (${JSON.stringify(health.appVersions)})`);
    assert(health.minAppVersion === '1.2.60', `the floor is still served, for the banner (${health.minAppVersion})`);
    assert(health.appFloors?.android?.min === null && health.appFloors?.android?.blocking === false
        && health.appFloors?.ios?.min === null && health.appFloors?.ios?.blocking === false,
        `no floor is enforced on an unknown store, so no app is stopped (${JSON.stringify(health.appFloors)})`);

    const owner = ownerSessionHeaders();
    const adminView = async () => {
        const r = await fetch(`${base}/api/local/admin/app-versions`, { headers: owner });
        return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    const off = await adminView();
    assert(off.status === 200 && off.body?.storeCheckOff === true,
        `the manager's route says the check is off (${off.status} storeCheckOff=${off.body?.storeCheckOff})`);
    assert(off.body?.platforms?.android?.store === null && off.body?.platforms?.android?.enforced === null
        && off.body?.platforms?.ios?.store === null && off.body?.platforms?.ios?.enforced === null,
        'and each platform\'s store build is unknown, its floor not enforced');

    // ── 3. The control: the same call asks both stores when the switch is not 'true' ────────────────────
    console.log('\n— 3. the control: unset, or not \'true\', the check asks both stores —');
    for (const value of [undefined, '1', 'false']) {
        if (value === undefined) delete process.env.DISABLE_APP_STORE_CHECK; else process.env.DISABLE_APP_STORE_CHECK = value;
        __resetAppStoreVersionsForTest();
        const at = outside.length;
        const result = await checkAppStoreVersions();
        const asked = storesAsked(at).sort();
        assert(asked.join(',') === [...STORES].sort().join(','),
            `DISABLE_APP_STORE_CHECK=${value ?? '(unset)'}: the check asks ${STORES.join(' and ')} (${asked.join(', ') || 'neither'})`);
        assert(result.android === null && result.ios === null && result.checkedAt === null,
            `  and, refused, the versions stay unknown (${JSON.stringify(result)})`);
    }
    const on = await adminView();
    assert(on.status === 200 && on.body?.storeCheckOff === false, `the manager's route then says the check is on (storeCheckOff=${on.body?.storeCheckOff})`);
    assert(getAppStoreVersions().checkedAt === null, 'a check no store answered records no time');

    // ── 4. The switch reaches a node and its operator ───────────────────────────────────────────────────
    console.log('\n— 4. compose, .env.example and the operator manual —');
    assert(/^\s*- DISABLE_APP_STORE_CHECK=\$\{DISABLE_APP_STORE_CHECK:-\}\s*$/m.test(read('docker-compose.yml')),
        'docker-compose.yml passes DISABLE_APP_STORE_CHECK from .env to the server, empty (the check on) by default');
    assert(/^DISABLE_APP_STORE_CHECK=\s*$/m.test(read('.env.example')), '.env.example lists it, empty');
    const manual = [
        'packages/beanpool-guide/operators/server/updates-and-health.md',
        'packages/beanpool-guide/operators/privacy/what-the-server-sees.md',
        'packages/beanpool-guide/operators/server/app-floor.md',
    ];
    const missing = manual.filter(p => !read(p).includes('DISABLE_APP_STORE_CHECK=true'));
    assert(missing.length === 0, `the operator manual's updates, privacy and app-floor pages say how to turn it off (${missing.length ? `missing in ${missing.join(', ')}` : 'all three'})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ DISABLE_APP_STORE_CHECK stops the app-store lookup, and off reads as unknown.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
