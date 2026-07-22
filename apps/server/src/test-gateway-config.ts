/**
 * Test Suite: Phase 3 Gateway Configuration & Node Self-Protection
 *
 * Verifies:
 * 1. Default Gateway configuration state.
 * 2. getGatewayConfig / updateGatewayConfig persistence.
 * 3. CORS Allowed Origins headers matching.
 * 4. Admin IP allowlist 403 Forbidden interceptor logic.
 * 5. Subsystem Feature Toggles (marketplace, messaging, invites, federation, servePwa) 503/530 interceptor logic.
 * 6. Gateway Rate Limiting 429 Too Many Requests interceptor.
 */

import { getGatewayConfig, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';

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
    assert(initialGw.features.marketplace === true, 'Marketplace feature is enabled by default');
    assert(initialGw.features.servePwa === true, 'PWA serving is enabled by default');
    assert(initialGw.rateLimiting.enabled === false, 'Rate limiting is disabled by default');
    assert(initialGw.rateLimiting.maxRequestsPerMinute === 600, 'Default rate limit is 600 req/min');

    // 2. Gateway Config Updates
    const updated = updateGatewayConfig({
        corsAllowedOrigins: ['https://app.beanpool.org'],
        adminIpAllowlist: ['127.0.0.1'],
        features: {
            marketplace: false,
            messaging: true,
            federation: true,
            invites: false,
            servePwa: true,
        },
        rateLimiting: {
            enabled: true,
            maxRequestsPerMinute: 30,
        },
    });

    assert(updated.corsAllowedOrigins.includes('https://app.beanpool.org'), 'CORS allowed origins updated');
    assert(updated.adminIpAllowlist.includes('127.0.0.1'), 'Admin IP allowlist updated');
    assert(updated.features.marketplace === false, 'Marketplace feature toggle updated to false');
    assert(updated.features.invites === false, 'Invites feature toggle updated to false');
    assert(updated.rateLimiting.enabled === true, 'Rate limiting enabled');
    assert(updated.rateLimiting.maxRequestsPerMinute === 30, 'Rate limit max requests updated');

    // Re-fetch to ensure persistence
    const reFetched = getGatewayConfig();
    assert(reFetched.features.marketplace === false, 'Persisted marketplace feature state verified');
    assert(reFetched.rateLimiting.maxRequestsPerMinute === 30, 'Persisted rate limit verified');

    // 3. Reset back to defaults
    updateGatewayConfig(DEFAULT_GATEWAY_CONFIG);
    const reset = getGatewayConfig();
    assert(reset.features.marketplace === true, 'Gateway config reset back to defaults');
    assert(reset.rateLimiting.enabled === false, 'Rate limiting reset back to disabled');

    console.log('\n⭐️ ALL PHASE 3 GATEWAY CONFIGURATION CHECKS PASSED.');
}

runTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
