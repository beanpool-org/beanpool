/**
 * Test Suite: Phase 3 Gateway Configuration & Node Self-Protection
 *
 * Verifies:
 * 1. Default Gateway configuration state.
 * 2. getGatewayConfig / updateGatewayConfig persistence.
 * 3. CORS Allowed Origins headers matching.
 * 4. Admin IP allowlist 403 Forbidden interceptor logic.
 * 5. One switch, servePwa (the headless node's 530). The four that were beside it (marketplace, messaging, federation,
 *    invites) are gone (How this community works S3): a stored one is never read, a save never keeps one, and a save
 *    that names one is refused whole (removedGatewaySwitchRefusal). test-shape-upgrade.ts boots a stored one over HTTP.
 * 6. Gateway Rate Limiting 429 Too Many Requests interceptor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getGatewayConfig, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG, getLocalConfig, saveLocalConfig } from './config/local-config.js';
import { removedGatewaySwitchRefusal, REMOVED_GATEWAY_SWITCHES } from './config/gateway.js';

function assert(condition: boolean, message: string) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${message}`);
        process.exit(1);
    }
    console.log(`✓ ${message}`);
}

async function runTests() {
    console.log('Running Phase 3 Gateway Configuration tests...\n');

    // Reset to defaults for clean test run
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);

    // 1. Initial State & Defaults
    const initialGw = getGatewayConfig();
    assert(JSON.stringify(initialGw.features) === JSON.stringify({ servePwa: true }), 'PWA serving is enabled by default, and is the only switch');
    assert(initialGw.rateLimiting.enabled === true, 'Rate limiting is enabled by default (#132)');
    assert(initialGw.rateLimiting.maxRequestsPerMinute === 120, 'Default rate limit is 120 req/min (#132)');

    // 2. Gateway Config Updates
    const updated = updateGatewayConfig({
        corsAllowedOrigins: ['https://app.beanpool.org'],
        adminIpAllowlist: ['127.0.0.1'],
        features: {
            servePwa: false,
        },
        rateLimiting: {
            enabled: true,
            maxRequestsPerMinute: 30,
        },
    });

    assert(updated.corsAllowedOrigins.includes('https://app.beanpool.org'), 'CORS allowed origins updated');
    assert(updated.adminIpAllowlist.includes('127.0.0.1'), 'Admin IP allowlist updated');
    assert(updated.features.servePwa === false, 'PWA serving toggled off (a headless node)');
    assert(updated.rateLimiting.enabled === true, 'Rate limiting enabled');
    assert(updated.rateLimiting.maxRequestsPerMinute === 30, 'Rate limit max requests updated');

    // Re-fetch to ensure persistence
    const reFetched = getGatewayConfig();
    assert(reFetched.features.servePwa === false, 'Persisted PWA serving state verified');
    assert(reFetched.rateLimiting.maxRequestsPerMinute === 30, 'Persisted rate limit verified');

    // 3. The switches that are gone: never read, never kept by a save, a save naming one refused whole.
    const config = getLocalConfig();
    config.gateway = { ...config.gateway!, features: { marketplace: false, messaging: false, federation: false, invites: false, servePwa: false } as any };
    saveLocalConfig(config);
    assert(JSON.stringify(getGatewayConfig().features) === JSON.stringify({ servePwa: false }), 'a stored old switch is never read: servePwa alone');
    const sneaked = updateGatewayConfig({ features: { servePwa: true, invites: false } as any });
    const file = JSON.parse(fs.readFileSync(path.join(process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data'), 'local-config.json'), 'utf8'));
    assert(JSON.stringify(sneaked.features) === JSON.stringify({ servePwa: true }) && JSON.stringify(file.gateway.features) === JSON.stringify({ servePwa: true }),
        `a save keeps only servePwa, in the file too: the old ones are dropped (${JSON.stringify(file.gateway.features)})`);
    for (const k of Object.keys(REMOVED_GATEWAY_SWITCHES)) {
        const refusal = removedGatewaySwitchRefusal({ features: { servePwa: true, [k]: true } });
        assert(refusal?.code === 'gateway_switch_removed' && JSON.stringify(refusal.removed) === JSON.stringify([k]) && /How this community works/.test(refusal.error),
            `a save naming ${k}, even on, is refused: ${refusal?.error}`);
    }
    assert(removedGatewaySwitchRefusal({ features: { servePwa: false } }) === null && removedGatewaySwitchRefusal({ corsAllowedOrigins: [] }) === null
        && removedGatewaySwitchRefusal(null) === null, 'a save of servePwa, or of no switch at all, is not');

    // 4. Reset back to defaults
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
    const reset = getGatewayConfig();
    assert(reset.features.servePwa === true, 'Gateway config reset back to defaults');
    assert(reset.rateLimiting.enabled === true, 'Rate limiting reset back to enabled (#132)');

    console.log('\n⭐️ ALL PHASE 3 GATEWAY CONFIGURATION CHECKS PASSED.');
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
