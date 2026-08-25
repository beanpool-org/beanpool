/**
 * Integration & unit tests for invite trampoline landing page and invite check route.
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
    console.log('Running invite-trampoline tests...');

    // 1. Pure unit tests for renderInviteTrampoline
    const htmlWebJoinTrue = renderInviteTrampoline({ webJoin: true });
    assert(htmlWebJoinTrue.includes('WEB_JOIN = true;'), 'renderInviteTrampoline with webJoin: true sets WEB_JOIN to true');
    assert(htmlWebJoinTrue.includes('org.beanpool.pillar'), 'renderInviteTrampoline includes app bundle id');
    assert(htmlWebJoinTrue.includes('Continue in your browser'), 'renderInviteTrampoline with webJoin: true includes web join link');

    const htmlWebJoinFalse = renderInviteTrampoline({ webJoin: false });
    assert(htmlWebJoinFalse.includes('WEB_JOIN = false;'), 'renderInviteTrampoline with webJoin: false sets WEB_JOIN to false');

    // 2. Integration HTTP tests with running HTTPS server
    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    // GET /?invite=BP-TEST-INVITE-123
    const resInvite = await fetch(`${BASE}/?invite=BP-TEST-INVITE-123`, { redirect: 'manual' });
    assert(resInvite.status === 200, 'GET /?invite=... returns 200 OK');
    const contentType = resInvite.headers.get('content-type') || '';
    assert(contentType.includes('text/html'), 'GET /?invite=... returns HTML content-type');
    const cacheControl = resInvite.headers.get('cache-control') || '';
    assert(cacheControl.includes('no-cache'), 'GET /?invite=... sets no-cache header');
    const textInvite = await resInvite.text();
    assert(textInvite.includes('BeanPool'), 'GET /?invite=... contains BeanPool in HTML body');

    // GET / (without invite) -> should redirect to /app
    const resNoInvite = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(resNoInvite.status === 302, 'GET / without invite returns 302 redirect');
    const location = resNoInvite.headers.get('location') || '';
    assert(location === '/app', 'GET / without invite redirects to /app');

    // GET /api/invite/check?code=BP-INVALID-CODE
    const resCheck = await fetch(`${BASE}/api/invite/check?code=BP-INVALID-CODE`);
    assert(resCheck.status === 200, 'GET /api/invite/check returns 200');
    const dataCheck = await resCheck.json() as any;
    assert(dataCheck.valid === false, 'GET /api/invite/check for invalid code returns valid: false');
    assert(typeof dataCheck.reason === 'string', 'GET /api/invite/check returns failure reason');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ invite-trampoline checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
