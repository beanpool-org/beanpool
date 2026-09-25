/**
 * The web door's two pieces outside /api (design G11 §3.6 changes 2 and 3), over REAL HTTPS through the real
 * middleware. Nothing here contacts a provider or a node: the Apple answers are forms this suite writes itself.
 *
 *   1. POST /app/auth/apple, Apple's `form_post` return:
 *      - 404 on a local node, where the door is shut, and again once the node is local again (read per request)
 *      - `state` + `id_token` → 303 to /app/auth/apple#state=…&id_token=…, `Cache-Control: no-store`,
 *        `Referrer-Policy: no-referrer`; `code` and `user` go nowhere, and nothing from the body is in the answer's
 *        body, the node's console or its log table
 *      - `error` → #state=…&error=…; a value outside its character set is never forwarded
 *      - a body over 16 KB → 413 (declared, and streamed without a length); JSON or no form → 415
 *      - the 303's target, GET /app/auth/apple, is the web app itself
 *   2. the app document's CSP: /app, /app/…, /index.html and / carry the strict policy (no 'unsafe-inline' or
 *      third-party host in script-src) and `Referrer-Policy: strict-origin-when-cross-origin`; /settings, /manager
 *      and the invite page at /?invite= keep today's header; /api/community/info has no CSP
 *
 * The node serves a stand-in web app from a temporary public/ folder (process.chdir before https-server loads), so
 * the documents answer 200 whether or not a PWA build is present.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-web-door.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';

const PORT = 8734;
const BASE = `https://localhost:${PORT}`;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** The header every document had before G11, which the Settings UI, the manager and the invite page keep. */
const TODAYS_DOCUMENT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://unpkg.com https://*.tile.openstreetmap.org https://api.qrserver.com; connect-src 'self' https://nominatim.openstreetmap.org wss: https:; frame-ancestors 'none'";

/** The app document's policy, as design G11 §3.6 change 3 states it, with the tile host the web app uses today. */
const APP_DOCUMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://*.tile.openstreetmap.org; connect-src 'self' https://nominatim.openstreetmap.org wss: https:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

/** One directive's sources, or null when the policy has no such directive. */
function directive(csp: string | null, name: string): string[] | null {
    for (const part of (csp ?? '').split(';')) {
        const [key, ...sources] = part.trim().split(/\s+/);
        if (key === name) return sources;
    }
    return null;
}

// A signed id_token's shape (three base64url segments); its content is never read by the route.
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IndlYi1kb29yIn0.eyJzdWIiOiIwMDEyMzQud2ViZG9vci4wMDAxIiwibm9uY2UiOiJub25jZSJ9.c2lnbmF0dXJlLW9mLWEtdGVzdC10b2tlbg';
const STATE = 'Tq8Qm1f7xYkS0n3VbE2wR9cJ5uH6gL4pA8dZ7oN1sK0';
const CODE = 'c0a1b2c3d4e5f6.0.nrzz.web-door-code';
const USER = JSON.stringify({ name: { firstName: 'Wanda', lastName: 'Webdoor' }, email: 'wanda.webdoor@privaterelay.appleid.com' });

function form(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
}

async function postApple(body: BodyInit, contentType: string | null = 'application/x-www-form-urlencoded', extra: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (contentType) headers['Content-Type'] = contentType;
    return fetch(`${BASE}/app/auth/apple`, { method: 'POST', headers, body, redirect: 'manual', ...extra });
}

/** The fragment of a 303's Location as fields, or null when the Location is not the return page. */
function fragmentOf(res: Response): URLSearchParams | null {
    const location = res.headers.get('location') ?? '';
    const prefix = '/app/auth/apple#';
    return location.startsWith(prefix) ? new URLSearchParams(location.slice(prefix.length)) : null;
}

async function main(): Promise<void> {
    console.log('\n=== The web door outside /api: the Apple return and the app document\'s headers ===\n');

    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-web-door-'));
    const publicDir = path.join(webRoot, 'public');
    fs.mkdirSync(path.join(publicDir, 'settings'), { recursive: true });
    fs.mkdirSync(path.join(publicDir, 'manager'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>BeanPool</title><div id="root">the web app</div>');
    fs.writeFileSync(path.join(publicDir, 'settings', 'index.html'), '<!doctype html><title>Settings</title>');
    fs.writeFileSync(path.join(publicDir, 'manager', 'index.html'), '<!doctype html><title>Manager</title>');
    // https-server.ts and routes/settings.ts take public/ from the working directory when it has one, as they load.
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const { startHttpsServer } = await import('./https-server.js');
    await startHttpsServer(PORT);

    // ── 1. the Apple return ──────────────────────────────────────────────────────────────────────
    console.log('── 1. POST /app/auth/apple ──');
    const shut = await postApple(form({ state: STATE, id_token: ID_TOKEN }));
    assert(shut.status === 404 && !shut.headers.get('location'), `local profile: the door is shut, so the Apple return is 404 (got ${shut.status})`);

    process.env.NODE_PROFILE = 'global';

    // Everything the node prints or logs while it handles the returns below, to prove none of it is the body.
    const printed: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map(m => console[m]);
    methods.forEach((m, i) => { console[m] = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); originals[i](...args); }; });
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: any, ...rest: any[]) => { printed.push(String(chunk)); return stdoutWrite(chunk, ...rest); }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: any, ...rest: any[]) => { printed.push(String(chunk)); return stderrWrite(chunk, ...rest); }) as typeof process.stderr.write;
    const lastLogId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM system_logs').get() as any).id as number;
    const bodies: string[] = [];

    let ok: Response, cancelled: Response, badState: Response, badToken: Response, badError: Response, empty: Response;
    try {
        ok = await postApple(form({ state: STATE, code: CODE, id_token: ID_TOKEN, user: USER }));
        bodies.push(await ok.text());
        cancelled = await postApple(form({ state: STATE, error: 'user_cancelled_authorize' }));
        bodies.push(await cancelled.text());
        badState = await postApple(form({ state: 'x"><script>alert(1)</script>', id_token: ID_TOKEN }));
        bodies.push(await badState.text());
        badToken = await postApple(form({ state: STATE, id_token: 'not a token <b>' }));
        bodies.push(await badToken.text());
        badError = await postApple(form({ state: STATE, error: '<img src=x onerror=alert(1)>', id_token: ID_TOKEN }));
        bodies.push(await badError.text());
        empty = await postApple(form({ state: STATE }));
        bodies.push(await empty.text());
    } finally {
        methods.forEach((m, i) => { console[m] = originals[i]; });
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
    }

    const okFragment = fragmentOf(ok);
    assert(ok.status === 303 && !!okFragment, `state + id_token → 303 to /app/auth/apple#… (got ${ok.status} ${ok.headers.get('location')?.slice(0, 40)})`);
    assert(okFragment?.get('state') === STATE && okFragment?.get('id_token') === ID_TOKEN && [...(okFragment?.keys() ?? [])].join(',') === 'state,id_token',
        `the fragment carries exactly the state and the id_token, as sent (got keys ${[...(okFragment?.keys() ?? [])].join(',')})`);
    assert(ok.headers.get('location') === `/app/auth/apple#state=${encodeURIComponent(STATE)}&id_token=${encodeURIComponent(ID_TOKEN)}`,
        'the Location is the return page with the URL-encoded fields in its fragment, never in the path or query');
    assert(ok.headers.get('cache-control') === 'no-store', `the 303 is Cache-Control: no-store (got ${ok.headers.get('cache-control')})`);
    assert(ok.headers.get('referrer-policy') === 'no-referrer', `the 303 is Referrer-Policy: no-referrer (got ${ok.headers.get('referrer-policy')})`);
    const okLocation = ok.headers.get('location') ?? '';
    assert(ok.status === 303 && !okLocation.includes(CODE) && !okLocation.includes('Wanda'),
        'Apple\'s code and user go nowhere: neither is in the Location');
    assert(ok.headers.get('set-cookie') === null, 'and the answer sets no cookie');

    const cancelledFragment = fragmentOf(cancelled);
    assert(cancelled.status === 303 && cancelledFragment?.get('state') === STATE && cancelledFragment?.get('error') === 'user_cancelled_authorize'
        && !cancelledFragment?.has('id_token'),
        `an error → 303 to #state=…&error=… (got ${cancelled.status} ${cancelled.headers.get('location')})`);
    assert(cancelled.headers.get('cache-control') === 'no-store' && cancelled.headers.get('referrer-policy') === 'no-referrer',
        'the error answer is no-store and no-referrer too');

    const badStateFragment = fragmentOf(badState);
    assert(badState.status === 303 && badStateFragment !== null && !badStateFragment.has('state') && badStateFragment.get('id_token') === ID_TOKEN,
        `a state outside the nonce's characters is not forwarded (the page then refuses the return for want of one) (got ${badState.headers.get('location')?.slice(0, 60)})`);
    const badTokenFragment = fragmentOf(badToken);
    assert(badToken.status === 303 && badTokenFragment?.get('error') === 'invalid_response' && !badTokenFragment?.has('id_token')
        && !(badToken.headers.get('location') ?? '').includes('<b>'),
        `an id_token that is not a token's shape → #…&error=invalid_response, never forwarded (got ${badToken.headers.get('location')})`);
    const badErrorFragment = fragmentOf(badError);
    assert(badError.status === 303 && badErrorFragment?.get('error') === 'invalid_response' && !badErrorFragment?.has('id_token')
        && !(badError.headers.get('location') ?? '').toLowerCase().includes('onerror'),
        `an error outside Apple's character set → error=invalid_response, and an error wins over a token sent with it (got ${badError.headers.get('location')})`);
    const emptyFragment = fragmentOf(empty);
    assert(empty.status === 303 && emptyFragment?.get('state') === STATE && emptyFragment?.get('error') === 'invalid_response',
        `neither a token nor an error → error=invalid_response (got ${empty.headers.get('location')})`);

    const secrets = [ID_TOKEN, STATE, CODE, 'Wanda', 'wanda.webdoor', 'onerror'];
    const answered = bodies.join('\n');
    assert(!secrets.some(s => answered.includes(s)), 'no answer\'s body repeats anything that was posted');
    const printedText = printed.join('\n');
    assert(!secrets.some(s => printedText.includes(s)), `nothing posted reaches the node's console (${printed.length} line(s) printed meanwhile)`);
    const logged = db.prepare('SELECT message, metadata FROM system_logs WHERE id > ?').all(lastLogId) as Array<{ message: string; metadata: string | null }>;
    const loggedText = logged.map(r => `${r.message} ${r.metadata ?? ''}`).join('\n');
    assert(!secrets.some(s => loggedText.includes(s)), `nor the node's log table (${logged.length} row(s) written meanwhile)`);

    const big = form({ state: STATE, id_token: ID_TOKEN, user: 'x'.repeat(17 * 1024) });
    const tooBig = await postApple(big);
    assert(tooBig.status === 413 && !tooBig.headers.get('location'), `a body over 16 KB → 413 (got ${tooBig.status})`);
    const streamed = await postApple(Readable.toWeb(Readable.from([Buffer.from(big)])) as any, 'application/x-www-form-urlencoded', { duplex: 'half' } as any);
    assert(streamed.status === 413 && !streamed.headers.get('location'), `...and streamed without a declared length → 413 (got ${streamed.status})`);
    const json = await postApple(JSON.stringify({ state: STATE, id_token: ID_TOKEN }), 'application/json');
    assert(json.status === 415 && !json.headers.get('location'), `a JSON body → 415, not a redirect (got ${json.status})`);
    const untyped = await postApple(form({ state: STATE, id_token: ID_TOKEN }), 'text/plain');
    assert(untyped.status === 415, `a body that is not a form → 415 (got ${untyped.status})`);

    const landing = await fetch(`${BASE}/app/auth/apple`);
    const landingHtml = await landing.text();
    assert(landing.status === 200 && landingHtml.includes('the web app'), `the 303's target, GET /app/auth/apple, is the web app (got ${landing.status})`);
    assert(landing.headers.get('content-security-policy') === APP_DOCUMENT_CSP, '...under the app document\'s policy');

    delete process.env.NODE_PROFILE;
    const shutAgain = await postApple(form({ state: STATE, id_token: ID_TOKEN }));
    assert(shutAgain.status === 404, `back to local: 404 again, read per request (got ${shutAgain.status})`);

    // ── 2. the app document's headers ────────────────────────────────────────────────────────────
    console.log('\n── 2. the app document\'s CSP ──');
    for (const docPath of ['/app', '/app/auth/google', '/index.html']) {
        const res = await fetch(`${BASE}${docPath}`);
        const body = await res.text();
        const csp = res.headers.get('content-security-policy');
        assert(res.status === 200 && body.includes('the web app'), `GET ${docPath} serves the web app (got ${res.status})`);
        assert(csp === APP_DOCUMENT_CSP, `GET ${docPath} carries the app document's policy (got ${csp})`);
        assert(JSON.stringify(directive(csp, 'script-src')) === JSON.stringify(["'self'"]),
            `GET ${docPath}: script-src is 'self' alone: no 'unsafe-inline', no third-party host (got ${JSON.stringify(directive(csp, 'script-src'))})`);
        assert(res.headers.get('referrer-policy') === 'strict-origin-when-cross-origin',
            `GET ${docPath}: Referrer-Policy strict-origin-when-cross-origin (got ${res.headers.get('referrer-policy')})`);
        assert(res.headers.get('x-frame-options') === 'DENY', `GET ${docPath}: still X-Frame-Options DENY`);
    }
    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(root.status === 302 && root.headers.get('location') === '/app' && root.headers.get('content-security-policy') === APP_DOCUMENT_CSP,
        `GET / (the way into the web app) carries it too (got ${root.status} ${root.headers.get('location')})`);

    const invite = await fetch(`${BASE}/?invite=BP-TEST-0001`);
    const inviteHtml = await invite.text();
    assert(invite.status === 200 && inviteHtml.includes('<script>') && invite.headers.get('content-security-policy') === TODAYS_DOCUMENT_CSP,
        `GET /?invite= (the install page, an inline script of its own) keeps today's header (got ${invite.status} ${invite.headers.get('content-security-policy')})`);
    for (const docPath of ['/settings', '/manager']) {
        const res = await fetch(`${BASE}${docPath}`);
        await res.text();
        assert(res.status === 200 && res.headers.get('content-security-policy') === TODAYS_DOCUMENT_CSP,
            `GET ${docPath} keeps today's header (got ${res.status} ${res.headers.get('content-security-policy')})`);
        assert(res.headers.get('referrer-policy') === null, `GET ${docPath} gains no Referrer-Policy`);
    }
    const api = await fetch(`${BASE}/api/community/info`);
    await api.text();
    assert(api.status === 200 && api.headers.get('content-security-policy') === null && api.headers.get('referrer-policy') === null,
        `GET /api/community/info carries no CSP (got ${api.status} ${api.headers.get('content-security-policy')})`);

    fs.rmSync(webRoot, { recursive: true, force: true });
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The web door: Apple\'s return reaches the page and nothing else, and the app document runs only its own scripts.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
