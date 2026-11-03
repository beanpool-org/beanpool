/**
 * Integration & unit tests for invite trampoline landing page and invite check route.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import vm from 'node:vm';
import { renderInviteTrampoline } from './routes/invite-trampoline.js';

let PORT = 0; // the port startHttpsServer(0) bound
let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/**
 * Run the page's own script against a tiny fake page, as a browser at `search` on `origin` with the user agent `ua`: what it
 * links to (the store, the app, the web hatch) and what its buttons copy. Nothing is fetched: the preflight is a no-op.
 */
function runTrampoline(search: string, ua: string, origin = 'https://mullum.beanpool.org') {
    const html = renderInviteTrampoline({ webJoin: true });
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const els = new Map<string, any>();
    const el = (id: string) => {
        if (!els.has(id)) els.set(id, { id, style: {}, handlers: {} as Record<string, Array<(e: any) => void>>, classList: { add() {}, remove() {} }, href: '', textContent: '', className: '',
            addEventListener(ev: string, fn: (e: any) => void) { (this.handlers[ev] ||= []).push(fn); }, appendChild() {} });
        return els.get(id);
    };
    const copied: string[] = [];
    const loc = { search, origin, href: '' };
    const sandbox: any = {
        URLSearchParams, encodeURIComponent, decodeURIComponent, setTimeout: () => 0,
        location: loc,
        navigator: { userAgent: ua, clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } },
        document: { getElementById: el, createElement: () => ({ style: {}, appendChild() {}, className: '', textContent: '' }), body: { removeChild() {} }, ontouchend: null },
        window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
        fetch: () => Promise.resolve({ ok: false }),
    };
    sandbox.document.createRange = () => ({ selectNode() {} });
    vm.runInNewContext(script, sandbox);
    const click = (id: string) => { for (const fn of el(id).handlers.click ?? []) fn({ preventDefault() {} }); };
    return { el, click, copied, loc };
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

    // 1b. Invite and share: `&post=<id>` rides every way the invite goes on, and only as an id. It is never looked up or shown
    // here, and a link without one is exactly the link it always was.
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14) Chrome/120';
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1';
    const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
    const referrerOf = (href: string) => decodeURIComponent(new URL(href).searchParams.get('referrer') || '');
    {
        const withPost = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, ANDROID);
        assert(referrerOf(withPost.el('installBtn').href) === `invite=INV-AB12-CD34&server=https://mullum.beanpool.org&post=${POST}`, 'trampoline: the Play referrer carries the listing after the server');
        assert(withPost.el('openAppBtn').href === `beanpool://welcome?invite=INV-AB12-CD34&server=${encodeURIComponent('https://mullum.beanpool.org')}&post=${POST}`, 'trampoline: Open BeanPool carries the listing');
        withPost.click('copyBtn');
        assert(withPost.copied[0] === `https://mullum.beanpool.org/?invite=INV-AB12-CD34&post=${POST}`, 'trampoline: Copy code copies the invite link with the listing');
        withPost.click('proceedWeb');
        assert(withPost.loc.href === `/app?invite=INV-AB12-CD34&webjoin=1&post=${POST}`, 'trampoline: Continue in browser carries the listing');

        const ios = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, IPHONE);
        ios.click('installBtn');
        assert(ios.copied[0] === `https://mullum.beanpool.org/?invite=INV-AB12-CD34&post=${POST}`, 'trampoline: on iOS the copied link carries the listing');

        const desktop = runTrampoline(`?invite=INV-AB12-CD34&post=${POST}`, 'Mozilla/5.0 (X11; Linux x86_64)');
        assert(referrerOf(desktop.el('androidStore').href).endsWith(`&post=${POST}`), 'trampoline: the desktop page\'s Google Play link carries the listing');

        const plain = runTrampoline('?invite=INV-AB12-CD34', ANDROID);
        assert(referrerOf(plain.el('installBtn').href) === 'invite=INV-AB12-CD34&server=https://mullum.beanpool.org', 'trampoline: with no listing the Play referrer is as it always was');
        assert(plain.el('openAppBtn').href === `beanpool://welcome?invite=INV-AB12-CD34&server=${encodeURIComponent('https://mullum.beanpool.org')}`, 'trampoline: with no listing Open BeanPool is as it always was');
        plain.click('copyBtn');
        assert(plain.copied[0] === 'https://mullum.beanpool.org/?invite=INV-AB12-CD34', 'trampoline: with no listing the copied link is as it always was');
        plain.click('proceedWeb');
        assert(plain.loc.href === '/app?invite=INV-AB12-CD34&webjoin=1', 'trampoline: with no listing the browser link is as it always was');

        for (const bad of ['..%2F..%2Fetc', 'a%20b', '%3Cscript%3E', 'x%26invite=EVIL', 'https%3A%2F%2Fevil.example', 'a'.repeat(101), '']) {
            const r = runTrampoline(`?invite=INV-AB12-CD34&post=${bad}`, ANDROID);
            r.click('copyBtn');
            r.click('proceedWeb');
            assert(!referrerOf(r.el('installBtn').href).includes('post=') && !r.el('openAppBtn').href.includes('post=') && !r.copied[0].includes('post=') && !r.loc.href.includes('post='),
                `trampoline: a post that is not an id (${bad.slice(0, 20)}) is left out everywhere`);
        }
    }

    // 2. Integration HTTP tests with running HTTPS server
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    // GET /?invite=BP-TEST-INVITE-123
    const resInvite = await fetch(`${BASE}/?invite=BP-TEST-INVITE-123`, { redirect: 'manual' });
    assert(resInvite.status === 200, 'GET /?invite=... returns 200 OK');
    const contentType = resInvite.headers.get('content-type') || '';
    assert(contentType.includes('text/html'), 'GET /?invite=... returns HTML content-type');
    const cacheControl = resInvite.headers.get('cache-control') || '';
    assert(cacheControl.includes('no-cache'), 'GET /?invite=... sets no-cache header');
    const textInvite = await resInvite.text();
    assert(textInvite.includes('BeanPool'), 'GET /?invite=... contains BeanPool in HTML body');

    // GET / (without invite): a stranger at a local community's bare address gets the community's card (front doors S15,
    // test-community-card.ts); a browser that keeps an account here (the web app's hint cookie) goes to /app as before.
    const resNoInvite = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert(resNoInvite.status === 200 && (await resNoInvite.text()).includes('data-testid="community-card"'), 'GET / without invite, for a stranger, is the community card');
    const resMember = await fetch(`${BASE}/`, { redirect: 'manual', headers: { Cookie: 'bp_account_here=1' } });
    assert(resMember.status === 302, 'GET / without invite, for a browser with an account here, returns 302 redirect');
    const location = resMember.headers.get('location') || '';
    assert(location === '/app', 'GET / without invite, for a browser with an account here, redirects to /app');

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
