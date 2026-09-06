/**
 * Test coverage for the node-side app-store version lookup and the health payload
 * fields the app reads from it (appVersions + minAppVersion).
 *
 * No network: the store fetchers are exercised through their parsers, which is where
 * every bug that has actually shipped lived — Apple's "V1.2.31" defeating a numeric
 * parse, and a Play page whose markup no longer matches.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine, getCommunityHealth } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import {
    normaliseVersion,
    parseItunesLookup,
    parsePlayStoreHtml,
    applyCheckResult,
    getAppStoreVersions,
    getMinAppVersion,
    __resetAppStoreVersionsForTest,
} from './app-store-versions.js';

const PORT = 8593;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running app-store version tests...');

    // ── Version normalisation ────────────────────────────────────────────────────
    assert(normaliseVersion('V1.2.31') === '1.2.31', "Apple's capital-V version normalises");
    assert(normaliseVersion('1.2.31') === '1.2.31', 'a plain version passes through');
    assert(normaliseVersion('  1.2.31 ') === '1.2.31', 'surrounding whitespace is stripped');
    assert(normaliseVersion('1..31') === null, 'a half-parsed version is rejected, not repaired');
    assert(normaliseVersion('1.2.3-1') === null, 'a hyphenated build tag is rejected, not scrubbed into 1.2.31');
    assert(normaliseVersion('1.2.31-beta') === null, 'a prerelease tag is rejected');
    assert(normaliseVersion('varies by device') === null, 'a marketing string is rejected');
    assert(normaliseVersion(undefined) === null, 'a missing version is rejected');

    // ── Store response parsing ───────────────────────────────────────────────────
    // The exact shape itunes.apple.com/lookup returns for org.beanpool.pillar.
    assert(
        parseItunesLookup({ resultCount: 1, results: [{ version: 'V1.2.31', trackName: 'Bean Pool' }] }) === '1.2.31',
        'iTunes lookup yields the App Store version'
    );
    assert(parseItunesLookup({ resultCount: 0, results: [] }) === null, 'an empty iTunes lookup yields null');
    assert(parseItunesLookup(null) === null, 'a malformed iTunes body yields null');

    assert(
        parsePlayStoreHtml('junk before [[["1.2.31"]] junk after') === '1.2.31',
        'the Play listing version block is read'
    );
    assert(
        parsePlayStoreHtml('<html>Google changed the markup</html>') === null,
        'a Play page that no longer matches yields null instead of a wrong version'
    );

    // ── Cache behaviour ──────────────────────────────────────────────────────────
    __resetAppStoreVersionsForTest();
    const empty = getAppStoreVersions();
    assert(empty.android === null && empty.ios === null && empty.checkedAt === null, 'the cache starts empty');

    const first = applyCheckResult({ android: '1.2.31', ios: '1.2.31' }, new Date('2026-09-06T01:00:00.000Z'));
    assert(first.android === '1.2.31' && first.ios === '1.2.31', 'a good check populates both stores');
    assert(first.checkedAt === '2026-09-06T01:00:00.000Z', 'checkedAt records when we last knew this');

    // A store that failed keeps its last answer. Blanking it would tell a phone that had
    // already been told about a newer build that there is nothing to update to.
    const second = applyCheckResult({ android: null, ios: '1.2.32' }, new Date('2026-09-06T07:00:00.000Z'));
    assert(second.android === '1.2.31', 'a failed store check keeps the previous version');
    assert(second.ios === '1.2.32', 'the store that answered is updated');
    assert(second.checkedAt === '2026-09-06T07:00:00.000Z', 'checkedAt moves when something answered');

    const third = applyCheckResult({ android: null, ios: null }, new Date('2026-09-06T13:00:00.000Z'));
    assert(third.checkedAt === '2026-09-06T07:00:00.000Z', 'checkedAt does NOT move when both stores miss');
    assert(third.android === '1.2.31' && third.ios === '1.2.32', 'both versions survive a fully failed check');

    // ── The floor ────────────────────────────────────────────────────────────────
    delete process.env.MIN_APP_VERSION;
    assert(getMinAppVersion() === '1.0.75', 'the default floor is unchanged and below anything in the field');
    process.env.MIN_APP_VERSION = 'v1.1.0';
    assert(getMinAppVersion() === '1.1.0', 'an operator can raise the floor, leading v and all');
    process.env.MIN_APP_VERSION = 'nonsense';
    assert(getMinAppVersion() === '1.0.75', 'an unparseable floor falls back to the default, not to a banner');
    delete process.env.MIN_APP_VERSION;

    // ── The health payload the app actually reads ────────────────────────────────
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const res = await fetch(`${BASE}/api/community/health`);
    assert(res.status === 200, 'GET /api/community/health returns 200');
    const body = await res.json() as any;
    assert(body.minAppVersion === '1.0.75', 'health serves the node floor');
    assert(!!body.appVersions, 'health serves appVersions');
    assert(body.appVersions.android === '1.2.31', 'health serves the cached Play version');
    assert(body.appVersions.ios === '1.2.32', 'health serves the cached App Store version');
    assert(body.appVersions.checkedAt === '2026-09-06T07:00:00.000Z', 'health serves checkedAt');

    // ── The public payload carries no moderation analysis ────────────────────────
    // /api/community/health is in PUBLIC_READ_EXACT, so anything in it is readable by
    // anyone who can reach the node — and it is re-sent to every phone every 30 seconds.
    assert(body.flags === undefined, 'the public health payload does NOT carry fraud/moderation flags');
    assert(getCommunityHealth().flags !== undefined, 'getCommunityHealth() still returns flags for the authenticated admin route');
    assert(!!body.nodeName && !!body.currency && !!body.tree && !!body.activity,
        'the fields clients actually read are still served');
    assert(
        JSON.stringify(body).length < 800,
        `the public payload stays small (was 2048 bytes with flags, now ${JSON.stringify(body).length})`
    );

    // A node that has not looked yet must say so rather than omit the field: the app
    // treats a null as "keep what you already know", and a missing object identically.
    __resetAppStoreVersionsForTest();
    const health = getCommunityHealth();
    assert(
        health.appVersions.android === null && health.appVersions.ios === null && health.appVersions.checkedAt === null,
        'a node that has not checked yet reports nulls, not a stale or absent field'
    );

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ app-store version checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
