/**
 * Test coverage for invite trampoline and root redirect behaviour
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { renderInviteTrampoline } from './routes/invite-trampoline.js';

const PORT = 8553;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

async function main() {
    console.log('Running invite trampoline tests...');

    // Unit tests for renderInviteTrampoline helper
    const htmlWebJoinTrue = renderInviteTrampoline({ webJoin: true });
    assert(htmlWebJoinTrue.includes('var WEB_JOIN = true;'), 'renderInviteTrampoline includes WEB_JOIN = true when webJoin is true');
    assert(htmlWebJoinTrue.includes('Join in your browser?'), 'renderInviteTrampoline includes web join modal when webJoin is true');

    const htmlWebJoinFalse = renderInviteTrampoline({ webJoin: false });
    assert(htmlWebJoinFalse.includes('var WEB_JOIN = false;'), 'renderInviteTrampoline includes WEB_JOIN = false when webJoin is false');
    assert(htmlWebJoinFalse.includes('You\'re invited to BeanPool'), 'renderInviteTrampoline contains title');

    // Integration HTTP tests
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Test GET / without invite query param -> redirects to /app
    const resNoInvite = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(resNoInvite.status === 302, 'GET / redirects when no invite code provided');
    assert(resNoInvite.headers.get('location') === '/app', 'GET / location header points to /app');

    // Test GET / with query params but no invite -> redirects to /app?foo=bar
    const resQueryNoInvite = await fetch(`${BASE}/?foo=bar`, { redirect: 'manual' });
    assert(resQueryNoInvite.status === 302, 'GET /?foo=bar redirects');
    assert(resQueryNoInvite.headers.get('location') === '/app?foo=bar', 'GET /?foo=bar preserves query params');

    // Test GET / with ?invite=CODE -> renders HTML trampoline (status 200)
    const resWithInvite = await fetch(`${BASE}/?invite=TESTCODE123`);
    assert(resWithInvite.status === 200, 'GET /?invite=TESTCODE123 returns HTTP 200');
    assert((resWithInvite.headers.get('content-type') || '').includes('text/html'), 'GET /?invite=... returns html content-type');
    const htmlBody = await resWithInvite.text();
    assert(htmlBody.includes('You\'re invited to BeanPool'), 'GET /?invite=... body includes invite landing title');
    assert(htmlBody.includes('params.get(\'invite\')'), 'GET /?invite=... renders invite trampoline template containing client script');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invite-trampoline checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
