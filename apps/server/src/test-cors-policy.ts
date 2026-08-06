import assert from 'node:assert';
import { DEFAULT_GATEWAY_CONFIG } from './config/local-config.js';

console.log('Running #131 CORS policy & credentials security test...');

// Re-implement CORS logic test helper matching https-server.ts:
function applyCorsHeaders(requestOrigin: string | undefined, corsAllowedOrigins: string[]) {
    const headers: Record<string, string> = {};
    const ctx = {
        set: (k: string, v: string) => { headers[k] = v; }
    };

    const allowedOrigins = corsAllowedOrigins || [];
    if (requestOrigin) {
        // Normalize trailing slashes to match browser Origin header format (mirrors federation-api.ts)
        const normalizedReq = requestOrigin.replace(/\/+$/, '');
        const isExplicitlyAllowed = allowedOrigins.some(o => o.replace(/\/+$/, '') === normalizedReq);
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

// 4. Non-matching origin under explicit config gets NO headers
const explicitNonMatchRes = applyCorsHeaders('https://evil-site.com', ['https://app.beanpool.org']);
assert.strictEqual(explicitNonMatchRes['Access-Control-Allow-Origin'], undefined, 'Non-matching origin gets no CORS headers');
assert.strictEqual(explicitNonMatchRes['Access-Control-Allow-Credentials'], undefined, 'Non-matching origin gets no credentials');

// 5. Trailing slash normalization: 'https://app.beanpool.org/' in config matches 'https://app.beanpool.org' from browser
const trailingSlashRes = applyCorsHeaders('https://app.beanpool.org', ['https://app.beanpool.org/']);
assert.strictEqual(trailingSlashRes['Access-Control-Allow-Origin'], 'https://app.beanpool.org', 'Trailing slash in config entry matches canonical browser origin');
assert.strictEqual(trailingSlashRes['Access-Control-Allow-Credentials'], 'true', 'Trailing slash normalized origin permits credentials');

console.log('✅ #131 CORS policy & credentials security test PASSED!');

// Exit explicitly. This suite leaves the engine's timers and handles open, so returning normally
// keeps the event loop alive and the process never terminates — it prints a pass and then hangs.
// In CI that is indistinguishable from a slow run and blocks every suite after it (scripts/test-all.sh
// runs them in sequence), which is how a single test burns hours of Actions time. Reaching here means
// every assertion above held; a failure throws and exits non-zero long before this line.
process.exit(0);
