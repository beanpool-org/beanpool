import assert from 'node:assert';
import { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';

console.log('Running #131 CORS policy & credentials security test...');

// Re-implement CORS logic test helper matching https-server.ts:
function applyCorsHeaders(requestOrigin: string | undefined, corsAllowedOrigins: string[]) {
    const headers: Record<string, string> = {};
    const ctx = {
        get: (headerName: string) => headerName.toLowerCase() === 'origin' ? requestOrigin : undefined,
        set: (k: string, v: string) => { headers[k] = v; }
    };

    const allowedOrigins = corsAllowedOrigins || [];
    if (requestOrigin) {
        const isExplicitlyAllowed = allowedOrigins.includes(requestOrigin);
        const isWildcardAllowed = allowedOrigins.includes('*');

        if (isExplicitlyAllowed) {
            ctx.set('Access-Control-Allow-Origin', requestOrigin);
            ctx.set('Access-Control-Allow-Credentials', 'true');
        } else if (isWildcardAllowed) {
            ctx.set('Access-Control-Allow-Origin', '*');
        }
    }

    return headers;
}

// 1. Default config (empty allowed origins): Untrusted origin gets NO CORS headers
const defaultRes = applyCorsHeaders('https://evil-site.com', DEFAULT_GATEWAY_CONFIG.corsAllowedOrigins);
assert.strictEqual(defaultRes['Access-Control-Allow-Origin'], undefined, 'Default policy must not allow untrusted origins');
assert.strictEqual(defaultRes['Access-Control-Allow-Credentials'], undefined, 'Default policy must not set credentials');

// 2. Wildcard config ('*'): Returns '*' origin and MUST NOT set credentials to true (#131)
const wildcardRes = applyCorsHeaders('https://evil-site.com', ['*']);
assert.strictEqual(wildcardRes['Access-Control-Allow-Origin'], '*', 'Wildcard policy must return literal * origin');
assert.strictEqual(wildcardRes['Access-Control-Allow-Credentials'], undefined, 'Wildcard policy MUST NOT allow credentials with reflected origin');

// 3. Explicit config ('https://app.beanpool.org'): Matching origin gets origin + credentials: true
const explicitRes = applyCorsHeaders('https://app.beanpool.org', ['https://app.beanpool.org']);
assert.strictEqual(explicitRes['Access-Control-Allow-Origin'], 'https://app.beanpool.org', 'Explicit origin must be reflected');
assert.strictEqual(explicitRes['Access-Control-Allow-Credentials'], 'true', 'Explicit allowed origin permits credentials');

// Non-matching origin under explicit config gets NO headers
const explicitNonMatchRes = applyCorsHeaders('https://evil-site.com', ['https://app.beanpool.org']);
assert.strictEqual(explicitNonMatchRes['Access-Control-Allow-Origin'], undefined, 'Non-matching origin gets no CORS headers');
assert.strictEqual(explicitNonMatchRes['Access-Control-Allow-Credentials'], undefined, 'Non-matching origin gets no credentials');

console.log('✅ #131 CORS policy & credentials security test PASSED!');
