/**
 * Test coverage for profile feature gate middleware and helper functions (routes/profile-feature-gate.ts).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-profile-feature-gate.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.NODE_PROFILE = 'global';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { featureOffFor, respondProfileRefusal } from './routes/profile-feature-gate.js';
import { BeansOffError, FeatureOffError, PROFILE_NO_BEANS } from './config/node-profile.js';

const PORT = 8831;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('── 1. Unit tests for featureOffFor ──');
    const mockSwitchesOff = {
        openJoin: true,
        ssoRequiredForJoin: true,
        beans: false,
        escrow: false,
        enterprises: false,
        treasuries: false,
        crowdfund: false,
        knocks: false,
        probation: true,
        autoHideReports: true,
        autoMute: true,
        distanceSortDefault: true,
        directoryMirror: true,
        publishToDirectory: false,
        guestListingsOnly: true,
    };

    assert(featureOffFor('/api/marketplace/posts/request', mockSwitchesOff) === 'escrow',
        'escrow route identifies "escrow" as missing feature when escrow switch is false');
    assert(featureOffFor('/api/treasury/info', mockSwitchesOff) === 'enterprises' ||
        featureOffFor('/api/treasury/info', mockSwitchesOff) === 'treasuries',
        'treasury route identifies missing enterprise/treasury feature');
    assert(featureOffFor('/api/crowdfund/projects', mockSwitchesOff) === 'crowdfund',
        'crowdfund route identifies "crowdfund" as missing feature');
    assert(featureOffFor('/api/federation/purchase', mockSwitchesOff) === 'beans',
        'federation purchase route identifies "beans" as missing feature');
    assert(featureOffFor('/api/community/info', mockSwitchesOff) === null,
        'non-gated path /api/community/info returns null');

    const mockSwitchesOn = { ...mockSwitchesOff, beans: true, escrow: true, enterprises: true, treasuries: true, crowdfund: true };
    assert(featureOffFor('/api/treasury/info', mockSwitchesOn) === null,
        'gated path returns null when all required switches are true');

    console.log('\n── 2. Unit tests for respondProfileRefusal ──');
    const ctx1 = { status: 200, body: null as unknown };
    const handled1 = respondProfileRefusal(ctx1, new BeansOffError('Beans off'));
    assert(handled1 === true && ctx1.status === 403 && (ctx1.body as { code: string })?.code === PROFILE_NO_BEANS,
        'respondProfileRefusal handles BeansOffError with status 403 and profile_no_beans code');

    const ctx2 = { status: 200, body: null as unknown };
    const handled2 = respondProfileRefusal(ctx2, new FeatureOffError('escrow'));
    assert(handled2 === true && ctx2.status === 404 && (ctx2.body as { feature: string })?.feature === 'escrow',
        'respondProfileRefusal handles FeatureOffError with status 404 and feature name');

    const ctx3 = { status: 200, body: null as unknown };
    const handled3 = respondProfileRefusal(ctx3, new Error('generic error'));
    assert(handled3 === false && ctx3.status === 200,
        'respondProfileRefusal ignores non-profile errors');

    console.log('\n── 3. HTTPS Server Integration for profileFeatureGate ──');
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const resGated1 = await fetch(`${BASE}/api/treasury/info`);
    assert(resGated1.status === 404, 'gated route GET /api/treasury/info returns 404 when disabled');
    const bodyGated1 = await resGated1.json();
    assert(bodyGated1.code === 'feature_off', 'response body contains code: "feature_off"');

    const resGated2 = await fetch(`${BASE}/api/crowdfund/projects`);
    assert(resGated2.status === 404, 'gated route GET /api/crowdfund/projects returns 404 when disabled');
    const bodyGated2 = await resGated2.json();
    assert(bodyGated2.code === 'feature_off' && bodyGated2.feature === 'crowdfund', 'response body identifies "crowdfund" feature');

    const resUngated = await fetch(`${BASE}/api/community/info`);
    assert(resUngated.status === 200, 'ungated route GET /api/community/info passes through gate with 200');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ profile-feature-gate checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
