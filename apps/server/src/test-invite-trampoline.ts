/**
 * Test coverage for invite trampoline rendering and root redirect behavior.
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

    // 1. Direct unit tests for renderInviteTrampoline
    const htmlWebJoinTrue = renderInviteTrampoline({ webJoin: true });
    assert(htmlWebJoinTrue.includes('<!doctype html>'), 'Renders valid HTML document');
    assert(htmlWebJoinTrue.includes('var WEB_JOIN = true;'), 'Sets WEB_JOIN to true when webJoin is enabled');
    assert(htmlWebJoinTrue.includes('Join in your browser?'), 'Includes web join modal element');

    const htmlWebJoinFalse = renderInviteTrampoline({ webJoin: false });
    assert(htmlWebJoinFalse.includes('var WEB_JOIN = false;'), 'Sets WEB_JOIN to false when webJoin is disabled');

    // 2. Integration test via HTTPS server
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // Root route without invite query param -> should redirect (302) to /app
    const resNoInvite = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(resNoInvite.status === 302, 'GET / without invite query param returns 302 redirect');
    assert(resNoInvite.headers.get('location') === '/app', 'GET / redirects to /app');

    // Root route with invite query param -> should return 200 with invite trampoline HTML
    const resWithInvite = await fetch(`${BASE}/?invite=BP-TEST-1234`, { redirect: 'manual' });
    assert(resWithInvite.status === 200, 'GET /?invite=... returns 200 OK');
    const content = await resWithInvite.text();
    assert(content.includes('You\'re invited to BeanPool'), 'GET /?invite=... serves invite trampoline page HTML');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invite-trampoline checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
