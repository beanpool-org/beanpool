/**
 * Test coverage for invite trampoline route and render utility.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-invite-trampoline.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { renderInviteTrampoline } from './routes/invite-trampoline.js';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8553;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running invite trampoline tests...\n');

    // 1. Pure function tests
    const htmlWebJoinTrue = renderInviteTrampoline({ webJoin: true });
    assert(htmlWebJoinTrue.includes('WEB_JOIN = true;'), 'renderInviteTrampoline sets WEB_JOIN to true');
    assert(htmlWebJoinTrue.includes("You're invited to BeanPool"), 'renderInviteTrampoline contains page title');

    const htmlWebJoinFalse = renderInviteTrampoline({ webJoin: false });
    assert(htmlWebJoinFalse.includes('WEB_JOIN = false;'), 'renderInviteTrampoline sets WEB_JOIN to false');

    // 2. Integration / Route tests via HTTPS server
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // GET /?invite=BP-TEST-CODE
    const inviteRes = await fetch(`${BASE}/?invite=BP-TEST-CODE`, { redirect: 'manual' });
    assert(inviteRes.status === 200, `GET /?invite=... returns 200 (got ${inviteRes.status})`);
    assert((inviteRes.headers.get('content-type') || '').includes('text/html'), 'Response content-type is HTML');
    assert(inviteRes.headers.get('cache-control') === 'no-cache, no-store, must-revalidate', 'Cache-control header is set correctly');

    const bodyText = await inviteRes.text();
    assert(bodyText.includes("You're invited to BeanPool"), 'Response body includes trampoline title');
    assert(bodyText.includes('Your invite code'), 'Response body includes invite code label');

    // GET / without invite query param -> redirects to /app
    const rootRes = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(rootRes.status === 302, `GET / without invite query param redirects (got ${rootRes.status})`);
    assert(rootRes.headers.get('location') === '/app', 'Redirect location is /app');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invite-trampoline checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
