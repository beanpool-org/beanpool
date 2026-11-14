/**
 * Lounge L1 (review of #2573) and front doors S2: the web app's signed knock, status and cancel calls to a community,
 * through the real middleware.
 *
 * An applicant's web app runs on its own node (the global one), so every call to the community it asked is cross-origin,
 * and the signed headers (X-Public-Key, X-Signature, ...) make a browser preflight each. Before this, the preflight got a bare
 * 204 with no Access-Control-Allow-Origin for any origin the operator had not listed, so the browser refused the call and
 * the web app said "Couldn't reach this community" every time. These three routes carry no cookie and no credential (the
 * signature is in the headers, and the node answers only for the signer), so any origin may make them, and nothing else is
 * opened:
 *
 *   1. The preflight of POST /api/join/knock (S2: the web app's own Ask to join), GET /api/join/knock/status and POST
 *      /api/join/knock/cancel from an unlisted origin allows that origin (`*`, never credentials), the method of that
 *      route alone, and exactly the headers the web app signs with.
 *   2. The real calls, signed as the web app signs them (bound to the host), come back readable: status `none`, and a
 *      cancel of a request that was never made `not_found`, each with the origin allowed; then a knock (201, pending),
 *      a second one's refusal in the node's words, and its status (`pending`).
 *   3. Nothing else is opened: the members' list, an answer, the rest of /api/join, the Market, and the node's status give
 *      an unlisted origin no allowance. (Until S2 the knock itself was on this list: the web app had no Ask to join, and
 *      the phone, which sent it, is no browser.)
 *   4. An origin the operator lists keeps its own rule on the same two routes: its origin back, with credentials.
 *   5. Told from another origin (DESIGN-global-yes-join-fable.md §2.4, slice Y2): the asker's web app on another community
 *      ("Tell me" on Home's waiting row) reads this node's web push key and gives it the browser's subscription, signed by
 *      the asking key, so POST and DELETE /api/web-push and GET /api/web-push/key are open the same way (`*`, never
 *      credentials, the signature's headers alone). A key with no open request here is still refused, 403, and the refusal
 *      is readable; the key that asked is kept, 201, and lets go with DELETE. Nothing else under /api/web-push is opened.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-knock-cors.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { buildBoundRequestHeaders } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { updateGatewayConfig } from './config/local-config.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let BASE = '';
const WEB = 'https://global.example';
const LISTED = 'https://listed.example';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

/** What the web app sends with a signed call (apps/pwa lib/knock.ts): the bound headers, and a JSON content type on a write. */
const SIGNED_HEADERS = ['content-type', 'x-public-key', 'x-signature', 'x-timestamp', 'x-nonce', 'x-signed-for'];

async function preflight(path: string, method: string, origin: string, headers: string[] = SIGNED_HEADERS): Promise<Response> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${path}`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers.join(',') },
    });
    await res.text();
    return res;
}

/** A call signed the way the web app signs it, from `origin`. */
async function signedCall(id: Id, method: 'GET' | 'POST' | 'DELETE', path: string, origin: string, sent: unknown = {}): Promise<{ res: Response; body: any }> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const url = `${BASE}${path}`;
    const text = method === 'GET' ? '' : JSON.stringify(sent);
    const bound = await buildBoundRequestHeaders({
        method, url, body: text, publicKeyHex: id.pk, sign: bytes => crypto.sign(null, Buffer.from(bytes), id.priv),
    });
    const res = await fetch(url, {
        method,
        headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...bound, Origin: origin },
        body: method === 'GET' ? undefined : text,
    });
    const raw = await res.text();
    let body: any;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    return { res, body };
}

const header = (r: Response, name: string): string | null => r.headers.get(name);
const lower = (s: string | null): string[] => (s ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

async function main(): Promise<void> {
    console.log('\n=== Lounge L1: the web app can reach the signed status and cancel routes of a community ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    seedGenesisMember(newId().pk, 'Olive');
    updateGatewayConfig({ corsAllowedOrigins: [] });

    const { startHttpsServer } = await import('./https-server.js');
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── 1. the preflights ──
    console.log('── 1. the preflight of the two signed routes ──');
    const statusPre = await preflight('/api/join/knock/status', 'GET', WEB);
    assert(statusPre.status === 204, `OPTIONS /api/join/knock/status: 204 (${statusPre.status})`);
    assert(header(statusPre, 'access-control-allow-origin') === '*', `status: any origin allowed (ACAO ${header(statusPre, 'access-control-allow-origin')})`);
    assert(header(statusPre, 'access-control-allow-credentials') === null, `status: never with credentials (ACAC ${header(statusPre, 'access-control-allow-credentials')})`);
    assert(lower(header(statusPre, 'access-control-allow-methods')).includes('get') && !lower(header(statusPre, 'access-control-allow-methods')).includes('post'),
        `status: GET alone (ACAM ${header(statusPre, 'access-control-allow-methods')})`);
    const statusHeaders = lower(header(statusPre, 'access-control-allow-headers'));
    assert(SIGNED_HEADERS.every(h => statusHeaders.includes(h)), `status: every header the web app signs with is allowed (ACAH ${header(statusPre, 'access-control-allow-headers')})`);
    assert(!statusHeaders.includes('x-admin-password') && !statusHeaders.includes('authorization') && !statusHeaders.includes('x-csrf-token'),
        'status: no admin or session header is allowed from any origin');

    const knockPre = await preflight('/api/join/knock', 'POST', WEB);
    assert(knockPre.status === 204, `OPTIONS /api/join/knock: 204 (${knockPre.status})`);
    assert(header(knockPre, 'access-control-allow-origin') === '*', `knock: any origin allowed (ACAO ${header(knockPre, 'access-control-allow-origin')})`);
    assert(header(knockPre, 'access-control-allow-credentials') === null, `knock: never with credentials (ACAC ${header(knockPre, 'access-control-allow-credentials')})`);
    assert(lower(header(knockPre, 'access-control-allow-methods')).includes('post') && !lower(header(knockPre, 'access-control-allow-methods')).includes('get'),
        `knock: POST alone (ACAM ${header(knockPre, 'access-control-allow-methods')})`);
    const knockHeaders = lower(header(knockPre, 'access-control-allow-headers'));
    assert(SIGNED_HEADERS.every(h => knockHeaders.includes(h)), `knock: every header the web app signs with is allowed (ACAH ${header(knockPre, 'access-control-allow-headers')})`);
    assert(!knockHeaders.includes('x-admin-password') && !knockHeaders.includes('authorization') && !knockHeaders.includes('x-csrf-token'),
        'knock: no admin or credential header is allowed');

    const cancelPre = await preflight('/api/join/knock/cancel', 'POST', WEB);
    assert(cancelPre.status === 204, `OPTIONS /api/join/knock/cancel: 204 (${cancelPre.status})`);
    assert(header(cancelPre, 'access-control-allow-origin') === '*', `cancel: any origin allowed (ACAO ${header(cancelPre, 'access-control-allow-origin')})`);
    assert(header(cancelPre, 'access-control-allow-credentials') === null, `cancel: never with credentials (ACAC ${header(cancelPre, 'access-control-allow-credentials')})`);
    assert(lower(header(cancelPre, 'access-control-allow-methods')).includes('post') && !lower(header(cancelPre, 'access-control-allow-methods')).includes('get'),
        `cancel: POST alone (ACAM ${header(cancelPre, 'access-control-allow-methods')})`);
    assert(SIGNED_HEADERS.every(h => lower(header(cancelPre, 'access-control-allow-headers')).includes(h)),
        `cancel: every header the web app signs with is allowed (ACAH ${header(cancelPre, 'access-control-allow-headers')})`);

    // ── 2. the real calls ──
    console.log('\n── 2. the signed calls, as the web app signs them ──');
    const applicant = newId();
    const status = await signedCall(applicant, 'GET', '/api/join/knock/status', WEB);
    assert(status.res.status === 200 && status.body?.status === 'none', `a signed status read from the web app: none (${status.res.status} ${JSON.stringify(status.body)})`);
    assert(header(status.res, 'access-control-allow-origin') === '*', `the status answer is readable from the web app (ACAO ${header(status.res, 'access-control-allow-origin')})`);
    const cancel = await signedCall(applicant, 'POST', '/api/join/knock/cancel', WEB);
    assert(cancel.res.status === 404 && cancel.body?.code === 'not_found', `a signed cancel of a request never made: not_found, no false success (${cancel.res.status} ${JSON.stringify(cancel.body)})`);
    assert(header(cancel.res, 'access-control-allow-origin') === '*', `the refusal is readable from the web app (ACAO ${header(cancel.res, 'access-control-allow-origin')})`);
    const knock = await signedCall(applicant, 'POST', '/api/join/knock', WEB, {
        message: 'I live by the river and grow tomatoes.', callsign: 'River', fromNode: 'global.example', toNode: new URL(BASE).host,
    });
    assert(knock.res.status === 201 && knock.body?.knock?.status === 'pending', `a signed knock from the web app: 201 pending (${knock.res.status} ${JSON.stringify(knock.body)})`);
    assert(header(knock.res, 'access-control-allow-origin') === '*' && header(knock.res, 'access-control-allow-credentials') === null,
        `the knock's answer is readable from the web app, with no credentials (ACAO ${header(knock.res, 'access-control-allow-origin')})`);
    const again = await signedCall(applicant, 'POST', '/api/join/knock', WEB, { message: 'Again', callsign: 'River' });
    assert(again.res.status === 409 && again.body?.code === 'knock_open' && header(again.res, 'access-control-allow-origin') === '*',
        `a second knock from the web app: its refusal readable, in the node's words (${again.res.status} ${JSON.stringify(again.body)})`);
    const pending = await signedCall(applicant, 'GET', '/api/join/knock/status', WEB);
    assert(pending.res.status === 200 && pending.body?.status === 'pending', `its status from the web app: pending (${pending.res.status} ${JSON.stringify(pending.body)})`);

    // ── 3. nothing else is opened ──
    console.log('\n── 3. nothing else is opened ──');
    const closed: Array<[string, string]> = [
        ['/api/join/knocks', 'GET'],
        ['/api/join/knocks/1/approve', 'POST'],
        ['/api/join/knocks/1/decline', 'POST'],
        ['/api/join', 'POST'],
        ['/api/market/posts', 'GET'],
        ['/api/local/status', 'GET'],
        ['/api/join/knock/status/extra', 'GET'],
        ['/api/join/knock/cancelled', 'POST'],
    ];
    for (const [p, method] of closed) {
        const r = await preflight(p, method, WEB);
        assert(header(r, 'access-control-allow-origin') === null && header(r, 'access-control-allow-headers') === null,
            `OPTIONS ${p}: an unlisted origin gets no allowance (ACAO ${header(r, 'access-control-allow-origin')})`);
    }
    const wrongMethod = await preflight('/api/join/knock/status', 'POST', WEB);
    assert(!lower(header(wrongMethod, 'access-control-allow-methods')).includes('post'), 'status never allows a write from another origin');
    const knockGet = await preflight('/api/join/knock', 'GET', WEB);
    assert(!lower(header(knockGet, 'access-control-allow-methods')).includes('get'), 'the knock allows only its POST from another origin');

    // ── 4. a listed origin keeps its rule ──
    console.log('\n── 4. an origin the operator lists keeps its own rule ──');
    updateGatewayConfig({ corsAllowedOrigins: [LISTED] });
    const listedPre = await preflight('/api/join/knock/status', 'GET', LISTED);
    assert(header(listedPre, 'access-control-allow-origin') === LISTED && header(listedPre, 'access-control-allow-credentials') === 'true',
        `a listed origin on status: its own origin with credentials (ACAO ${header(listedPre, 'access-control-allow-origin')}, ACAC ${header(listedPre, 'access-control-allow-credentials')})`);
    const stillOpen = await preflight('/api/join/knock/cancel', 'POST', WEB);
    assert(header(stillOpen, 'access-control-allow-origin') === '*' && header(stillOpen, 'access-control-allow-credentials') === null,
        `an unlisted origin on cancel while others are listed: still the open, credential-free answer (ACAO ${header(stillOpen, 'access-control-allow-origin')})`);
    const stillClosed = await preflight('/api/join/knocks', 'GET', WEB);
    assert(header(stillClosed, 'access-control-allow-origin') === null, 'an unlisted origin on the members\' list: nothing');

    // ── 5. told from another origin (Y2) ──
    console.log('\n── 5. told from another origin: the web push routes (global yes Y2) ──');
    updateGatewayConfig({ corsAllowedOrigins: [] });
    const pushPre = await preflight('/api/web-push', 'POST', WEB);
    assert(pushPre.status === 204 && header(pushPre, 'access-control-allow-origin') === '*' && header(pushPre, 'access-control-allow-credentials') === null,
        `OPTIONS /api/web-push (POST): any origin, never credentials (${pushPre.status}, ACAO ${header(pushPre, 'access-control-allow-origin')}, ACAC ${header(pushPre, 'access-control-allow-credentials')})`);
    const pushMethods = lower(header(pushPre, 'access-control-allow-methods'));
    assert(pushMethods.includes('post') && pushMethods.includes('delete') && !pushMethods.includes('get') && !pushMethods.includes('put'),
        `web push: POST and DELETE alone (ACAM ${header(pushPre, 'access-control-allow-methods')})`);
    const pushHeaders = lower(header(pushPre, 'access-control-allow-headers'));
    assert(SIGNED_HEADERS.every(h => pushHeaders.includes(h)) && !pushHeaders.includes('authorization') && !pushHeaders.includes('x-csrf-token'),
        `web push: the signature's headers and no session header (ACAH ${header(pushPre, 'access-control-allow-headers')})`);
    const keyPre = await preflight('/api/web-push/key', 'GET', WEB, []);
    assert(header(keyPre, 'access-control-allow-origin') === '*' && lower(header(keyPre, 'access-control-allow-methods')).includes('get')
        && !lower(header(keyPre, 'access-control-allow-methods')).includes('post'), `OPTIONS /api/web-push/key: any origin, GET alone (ACAM ${header(keyPre, 'access-control-allow-methods')})`);
    resetGatewayRateLimit();
    const keyRead = await fetch(`${BASE}/api/web-push/key`, { headers: { Origin: WEB } });
    const keyBody = await keyRead.json().catch(() => null) as { vapidKey?: unknown } | null;
    assert(keyRead.status === 200 && typeof keyBody?.vapidKey === 'string' && header(keyRead, 'access-control-allow-origin') === '*',
        `the node's web push key is readable from another origin (${keyRead.status}, ACAO ${header(keyRead, 'access-control-allow-origin')})`);

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const browser = {
        subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } },
        lang: 'en',
    };
    const stranger = newId();
    const refused = await signedCall(stranger, 'POST', '/api/web-push', WEB, browser);
    assert(refused.res.status === 403 && refused.body?.code === 'no_open_request' && header(refused.res, 'access-control-allow-origin') === '*',
        `a key with no open request here, from another origin: 403 no_open_request, readable (${refused.res.status} ${JSON.stringify(refused.body)})`);
    const kept = await signedCall(applicant, 'POST', '/api/web-push', WEB, browser);
    assert(kept.res.status === 201 && kept.body?.success === true && typeof kept.body?.subId === 'string' && 'pushKey' in (kept.body ?? {})
        && header(kept.res, 'access-control-allow-origin') === '*' && header(kept.res, 'access-control-allow-credentials') === null,
        `the key that asked, from another origin: 201 with its id and the notice key to pin (none here: no P2P signer in this suite), readable, no credentials (${kept.res.status})`);
    const letGo = await signedCall(applicant, 'DELETE', '/api/web-push', WEB, { subId: kept.body?.subId });
    assert(letGo.res.status === 200 && letGo.body?.success === true && header(letGo.res, 'access-control-allow-origin') === '*',
        `its DELETE from another origin: done, readable (${letGo.res.status} ${JSON.stringify(letGo.body)})`);
    for (const [p, method] of [['/api/web-push/key', 'POST'], ['/api/web-push/other', 'POST'], ['/api/web-pushes', 'POST'], ['/api/notices/push/1', 'GET']] as const) {
        const r = await preflight(p, method, WEB);
        assert(header(r, 'access-control-allow-origin') === null || !lower(header(r, 'access-control-allow-methods')).includes(method.toLowerCase()),
            `OPTIONS ${p} (${method}): not opened by the web push allowance (ACAO ${header(r, 'access-control-allow-origin')}, ACAM ${header(r, 'access-control-allow-methods')})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The web app can ask a community, read and cancel its request; no other route is opened.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
