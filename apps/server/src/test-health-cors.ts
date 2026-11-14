/**
 * Cutover W (1.4.0): another community's web app can read this server's health, and nothing else is opened by it, through the
 * real middleware.
 *
 * The web app asks a community's server for its version (GET /api/community/health) before it calls it, and calls nothing on a
 * server it can't read (apps/pwa/src/lib/node-version-gate.ts). That read is cross-origin on every community but the web app's
 * own, and before this no server answered it with an Access-Control-Allow-Origin for an origin the operator had not listed, so
 * in a browser it always failed. The answer is public (it names nobody) and the web app reads it with a plain GET that carries
 * no credential and no header of its own, so:
 *
 *   1. GET and HEAD /api/community/health from an unlisted origin come back readable: `*`, never credentials; the GET carries
 *      the server's version.
 *   2. Its preflight, if one is ever sent, allows GET and HEAD alone, `*`, no credentials and no request header.
 *   3. A write to it from another origin gets no allowance.
 *   4. Nothing else is opened: every route the node serves, preflighted from an unlisted origin with its own method, gets an
 *      allowance only where it is listed by route and method below: the three signed knock routes, the web push key and
 *      subscription an applicant's web app reads and gives (global yes Y2), and the health read; and real unsigned GETs of
 *      the health read's neighbours (info, card, version, config, known rule, Home, the node's status) carry none.
 *   5. An origin the operator lists keeps its own rule on the health read: its origin back, with credentials.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-health-cors.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { updateGatewayConfig } from './config/local-config.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let BASE = '';
const WEB = 'https://mullum.example';
const LISTED = 'https://listed.example';
const HEALTH = '/api/community/health';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

function newKey(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

async function call(method: string, path: string, headers: Record<string, string>): Promise<Response> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${path}`, { method, headers });
    await res.text().catch(() => '');
    return res;
}

const preflight = (path: string, method: string, origin: string, requestHeaders?: string): Promise<Response> => call('OPTIONS', path, {
    Origin: origin, 'Access-Control-Request-Method': method, ...(requestHeaders ? { 'Access-Control-Request-Headers': requestHeaders } : {}),
});

const header = (r: Response, name: string): string | null => r.headers.get(name);
const lower = (s: string | null): string[] => (s ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

async function main(): Promise<void> {
    console.log('\n=== Cutover W: the health read is readable from another community\'s web app, and nothing else is opened ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    seedGenesisMember(newKey(), 'Olive');
    updateGatewayConfig({ corsAllowedOrigins: [] });

    const https = await import('./https-server.js');
    BASE = `https://localhost:${await https.startHttpsServer(0)}`;

    // ── 1. the read itself, as the web app makes it ──
    console.log('── 1. GET and HEAD from an unlisted origin ──');
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const get = await fetch(`${BASE}${HEALTH}`, { headers: { Origin: WEB } });
    const body = await get.json().catch(() => null) as { version?: unknown } | null;
    assert(get.status === 200, `GET ${HEALTH} from another origin: 200 (${get.status})`);
    assert(header(get, 'access-control-allow-origin') === '*', `the answer is readable from any origin (ACAO ${header(get, 'access-control-allow-origin')})`);
    assert(header(get, 'access-control-allow-credentials') === null, `never with credentials (ACAC ${header(get, 'access-control-allow-credentials')})`);
    assert(typeof body?.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version), `it names the server's version (${JSON.stringify(body?.version)})`);
    const head = await call('HEAD', HEALTH, { Origin: WEB });
    assert(head.status === 200 && header(head, 'access-control-allow-origin') === '*', `HEAD from another origin: 200, readable (${head.status}, ACAO ${header(head, 'access-control-allow-origin')})`);
    const sameSite = await call('GET', HEALTH, {});
    assert(sameSite.status === 200, `GET with no Origin (a phone, a monitor) still answers 200 (${sameSite.status})`);

    // ── 2. its preflight ──
    console.log('\n── 2. the preflight ──');
    const pre = await preflight(HEALTH, 'GET', WEB);
    assert(pre.status === 204, `OPTIONS ${HEALTH}: 204 (${pre.status})`);
    assert(header(pre, 'access-control-allow-origin') === '*', `any origin allowed (ACAO ${header(pre, 'access-control-allow-origin')})`);
    assert(header(pre, 'access-control-allow-credentials') === null, `never with credentials (ACAC ${header(pre, 'access-control-allow-credentials')})`);
    const methods = lower(header(pre, 'access-control-allow-methods'));
    assert(methods.includes('get') && methods.includes('head') && !methods.some(m => ['post', 'put', 'patch', 'delete'].includes(m)),
        `GET and HEAD alone (ACAM ${header(pre, 'access-control-allow-methods')})`);
    const withHeaders = await preflight(HEALTH, 'GET', WEB, 'x-signature, x-public-key, x-admin-password, authorization');
    assert(header(withHeaders, 'access-control-allow-headers') === null, `no request header is allowed, not a signature's nor an admin's (ACAH ${header(withHeaders, 'access-control-allow-headers')})`);

    // ── 3. a write gets nothing ──
    console.log('\n── 3. a write from another origin ──');
    const post = await call('POST', HEALTH, { Origin: WEB, 'Content-Type': 'text/plain' });
    assert(header(post, 'access-control-allow-origin') === null, `POST ${HEALTH} from another origin: no allowance (${post.status}, ACAO ${header(post, 'access-control-allow-origin')})`);
    const prePost = await preflight(HEALTH, 'POST', WEB);
    assert(!lower(header(prePost, 'access-control-allow-methods')).includes('post'), `its preflight never allows a POST (ACAM ${header(prePost, 'access-control-allow-methods')})`);

    // ── 4. nothing else is opened ──
    console.log('\n── 4. nothing else is opened ──');
    const app = https.getKoaApp();
    if (!app) throw new Error('no Koa app');
    const served = [...new Set<string>(app.middleware.filter((m: any) => m.router).flatMap((m: any) => m.router.stack)
        .flatMap((l: any) => (l.methods as string[]).filter(m => m !== 'HEAD').map(m => `${m} ${l.path}`)))].sort();
    const materialise = (routePath: string): string => routePath
        .replace(/\(\.\*\)/g, 'sentinel')
        .replace(/:([A-Za-z_]+)(\([^)]*\))?\??/g, 'sentinel');
    // Every opening, by route and method, and nothing more: a route opened by mistake (or a method added to an open one)
    // is named here, not hidden in a count.
    const OPEN: readonly string[] = [
        `GET ${HEALTH}`,
        // The three signed knock routes (front doors S2, Lounge L1).
        'POST /api/join/knock', 'GET /api/join/knock/status', 'POST /api/join/knock/cancel',
        // An applicant's web app is told of the answer (DESIGN-global-yes-join-fable.md §2.4, slice Y2): the community's web
        // push key, read, and the browser's subscription, given and taken back, signed by the asking key.
        'GET /api/web-push/key', 'POST /api/web-push', 'DELETE /api/web-push',
    ];
    const opened: string[] = [];
    const unexpected: string[] = [];
    for (const route of served) {
        const space = route.indexOf(' ');
        const method = route.slice(0, space);
        const path = materialise(route.slice(space + 1));
        if (!path.startsWith('/')) continue;
        const r = await preflight(path, method, WEB);
        if (header(r, 'access-control-allow-origin') === null) continue;
        opened.push(route);
        if (!OPEN.includes(`${method} ${path}`)) unexpected.push(`${route} (ACAO ${header(r, 'access-control-allow-origin')})`);
    }
    assert(served.length > 400, `the sweep reaches every route the node serves (${served.length})`);
    assert(opened.includes(`GET ${HEALTH}`), `the health read is the one new opening (${opened.join(', ')})`);
    assert(unexpected.length === 0, `no other route answers an unlisted origin's preflight with an allowance${unexpected.length ? `: ${unexpected.join(', ')}` : ''}`);
    assert(JSON.stringify([...opened].sort()) === JSON.stringify([...OPEN].sort()),
        `exactly the seven openings, by route and method: the health read, the three signed knock routes, the web push key and subscription (${opened.join(', ')})`);

    const neighbours = ['/api/community/info', '/api/community/card', '/api/community/known-rule', '/api/version', '/api/node/config', '/api/home', '/api/local/status', '/api/community/health/extra', '/api/community/healthz'];
    for (const p of neighbours) {
        const r = await call('GET', p, { Origin: WEB });
        assert(header(r, 'access-control-allow-origin') === null, `GET ${p} from another origin: no allowance (${r.status}, ACAO ${header(r, 'access-control-allow-origin')})`);
    }

    // ── 5. a listed origin keeps its rule ──
    console.log('\n── 5. an origin the operator lists keeps its own rule ──');
    updateGatewayConfig({ corsAllowedOrigins: [LISTED] });
    const listed = await call('GET', HEALTH, { Origin: LISTED });
    assert(header(listed, 'access-control-allow-origin') === LISTED && header(listed, 'access-control-allow-credentials') === 'true',
        `a listed origin on the health read: its own origin with credentials (ACAO ${header(listed, 'access-control-allow-origin')}, ACAC ${header(listed, 'access-control-allow-credentials')})`);
    const stillOpen = await call('GET', HEALTH, { Origin: WEB });
    assert(header(stillOpen, 'access-control-allow-origin') === '*' && header(stillOpen, 'access-control-allow-credentials') === null,
        `an unlisted origin while others are listed: still the open, credential-free answer (ACAO ${header(stillOpen, 'access-control-allow-origin')})`);
    const stillClosed = await call('GET', '/api/community/info', { Origin: WEB });
    assert(header(stillClosed, 'access-control-allow-origin') === null, 'an unlisted origin on the community info: nothing');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Another community\'s web app can read this server\'s version; no other route is opened.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
