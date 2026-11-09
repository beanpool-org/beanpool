#!/usr/bin/env node
/**
 * The account handoff (DESIGN-global-yes-join-fable.md §2.1, slice Y1) in headless Chromium between TWO real origins, each
 * served from its own local port by its own Vite server: "global" (https://global.example.org, the holding page,
 * e2e/global-yes-y1-harness.tsx with the real components/YesJoin.tsx) and "Byron" (https://byron.example.org, the real web
 * app, App.tsx's /app?door=handoff). Chromium decides what each origin may read and where each postMessage is delivered;
 * Playwright only maps the two names to the two ports, answers /api with stubs, and serves a third origin's spy pages.
 *
 *   1. Join → Byron's page → "Join Byron Shire BeanPool as CJ Asked?" (the name the request sent, editable; the photo
 *      from global a tickbox, off) → Join → member, through the invite path with the same key; global's tab says
 *      "You joined Byron Shire BeanPool." The photo goes only when ticked.
 *   2. The key never appears in any address or request either page made (every request, its URL, headers and body).
 *   3. The receiver refuses: a key nobody there said yes to; a browser that already has an account there; a message not
 *      from its opener; a wrong nonce; a message from an origin other than the one its address names (a spy opener).
 *   4. The holder posts only to the knock's origin: the handoff redirected to a spy at another origin, which says
 *      "ready" with the right nonce, gets nothing, and global's tab shows the fallback card.
 *   5. window.open gives nothing back (a pop-up blocker): the fallback card, and nothing is sent anywhere.
 *   6. The screens at 320 px with 1.3x text, light and dark (--shots <dir>): fails on sideways scroll, or a primary
 *      control under 48 px tall.
 * The no-opener-policy pin on the node's /app is apps/server/src/test-api-headers-and-feed-etag.ts.
 *
 * Run: node apps/pwa/e2e/global-yes-y1-check.mjs [--shots <dir>]
 */
/* global document, window, indexedDB, localStorage, console, process, URL, setTimeout, clearTimeout, MessageEvent */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : path.join(os.tmpdir(), 'bp-global-yes-y1-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const GLOBAL = 'https://global.example.org';
const BYRON = 'https://byron.example.org';
const SPY = 'https://spy.example.org';
const INVITE = 'INV-KN0C-K1NV';
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const NAME = 'Byron Shire BeanPool';

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}
const WATCHDOG_MS = Number(process.env.Y1_WATCHDOG_MS) || 420_000;
const servers = [];
let browser;
const watchdog = setTimeout(async () => {
    console.error(`Stopped after ${WATCHDOG_MS} ms. So far ${failures.length} failed.`);
    process.exit(2);
}, WATCHDOG_MS);

// Two origins, two ports: one Vite server each, each with its own dependency cache.
async function serve(tag) {
    const server = await createServer({
        configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, logLevel: 'error',
        cacheDir: path.join(os.tmpdir(), `bp-y1-vite-${tag}`),
        server: { port: 0, host: '127.0.0.1', hmr: false, allowedHosts: true, proxy: {} },
    });
    await server.listen();
    servers.push(server);
    return `http://127.0.0.1:${server.httpServer.address().port}`;
}

// Every request either page made, for the check that the key is never in one.
const network = [];
// What the pages said went wrong, printed if the check stops.
const pageLog = [];
const openContexts = [];

/** One context: a browser with nothing kept, the three origins mapped, the stubs it answers with. */
async function scenario({ dark = false, redirectToSpy = false, readyThenSpy = false, byronStore = null } = {}) {
    const state = { yesKeys: new Set(), members: new Set(), redeems: [], statusReads: [], profileWrites: [], otherHosts: new Set() };
    const context = await browser.newContext({ viewport: { width: 320, height: 720 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', deviceScaleFactor: 2 });
    context.on('request', (req) => network.push({ url: req.url(), headers: req.headers(), body: req.postData() ?? '' }));
    context.on('page', (p) => {
        p.on('pageerror', (e) => pageLog.push(`[pageerror ${new URL(p.url()).host}] ${e.message}`));
        p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') pageLog.push(`[${m.type()} ${new URL(p.url() || 'about:blank').host}] ${m.text().slice(0, 300)}`); });
    });
    openContexts.push(context);
    await context.addInitScript(([mode]) => {
        // Vite's dev server leaves `process.env` reads in place (the build replaces them), as the harnesses' own pages shim.
        window.process = window.process || { env: {} };
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
        document.addEventListener('DOMContentLoaded', () => {
            const s = document.createElement('style');
            s.textContent = 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; animation: none !important; }';
            document.head.appendChild(s);
        });
    }, [dark ? 'dark' : 'light']);
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        if (u.origin === SPY) return route.fulfill({ contentType: 'text/html', body: spyPage(u) });
        const local = u.origin === GLOBAL ? ports.global : u.origin === BYRON ? ports.byron : null;
        if (!local) { state.otherHosts.add(u.host); return route.abort(); }
        if (u.pathname.startsWith('/api/')) {
            const signer = req.headers()['x-public-key'] ?? null;
            if (u.origin === GLOBAL) {
                // readyThenSpy: the photo read is slow, so the account goes well after Byron's page has gone.
                if (readyThenSpy && u.pathname.startsWith('/api/profile/')) await new Promise((r) => setTimeout(r, 1500));
                if (u.pathname.startsWith('/api/profile/')) return json(route, { publicKey: decodeURIComponent(u.pathname.split('/')[3]), callsign: 'CJ Global', avatar: PHOTO });
                return json(route, {});
            }
            if (u.pathname === '/api/community/info') return json(route, { profile: 'local', memberCount: 40, postCount: 0, transactionCount: 0, commonsBalance: 0, features: { openJoin: false, knocks: true } });
            if (u.pathname === '/api/community/card') return json(route, { name: NAME, host: 'byron.example.org', members: 40, joining: 'requests' });
            if (u.pathname === '/api/join/knock/status') {
                state.statusReads.push(signer);
                if (!signer || !state.yesKeys.has(signer)) return json(route, { status: 'none' });
                return json(route, { status: 'approved', invite: INVITE, expiresAt: null, ...(state.members.has(signer) ? { member: true } : {}) });
            }
            if (u.pathname.startsWith('/api/community/membership/')) return json(route, { isMember: state.members.has(decodeURIComponent(u.pathname.split('/').pop())), callsign: null });
            if (u.pathname === '/api/invite/check') return json(route, { valid: true });
            if (u.pathname === '/api/invite/redeem') {
                const body = JSON.parse(req.postData() ?? '{}');
                state.redeems.push({ ...body, signer });
                if (body.code !== INVITE || body.publicKey !== signer || !state.yesKeys.has(signer)) return json(route, { error: 'This invite is for someone else.' }, 400);
                state.members.add(body.publicKey);
                return json(route, { success: true, member: { publicKey: body.publicKey, callsign: body.callsign } });
            }
            if (/^\/api\/members\/[^/]+\/profile$/.test(u.pathname) || u.pathname === '/api/profile') state.profileWrites.push(req.postData() ?? '');
            return json(route, {});
        }
        if (readyThenSpy && u.origin === BYRON && u.pathname === '/app') {
            // Byron's page says ready, rightly (its origin, its nonce), then the window goes to another origin before the
            // account is sent: only the post's target origin keeps the key from the page that is there now.
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>
                const n = new URLSearchParams(location.search).get('n');
                window.opener.postMessage({ tag: 'beanpool-handoff', v: 1, type: 'ready', nonce: n }, '*');
                setTimeout(() => location.replace(${JSON.stringify(SPY)} + '/app' + location.search), 50);</script>` });
        }
        if (redirectToSpy && u.origin === BYRON && u.pathname === '/app') {
            // The window the holder opened leaves Byron for another origin (a hijacked or compromised redirect).
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>location.replace(${JSON.stringify(SPY)} + '/app' + location.search)</script>` });
        }
        const res = await route.fetch({ url: `${local}${u.pathname}${u.search}` });
        return route.fulfill({ response: res });
    });
    if (byronStore) {
        const seed = await context.newPage();
        await seed.goto(`${BYRON}/e2e/global-yes-y1-harness.html?mode=manual`, { waitUntil: 'load' });
        await seed.evaluate((id) => new Promise((resolve, reject) => {
            const open = indexedDB.open('beanpool-identity', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('keys');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const tx = open.result.transaction('keys', 'readwrite');
                tx.objectStore('keys').put(id, 'sovereign-identity');
                tx.oncomplete = () => { open.result.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
            };
        }), byronStore);
        await seed.close();
    }
    return { context, state };
}

function spyPage(u) {
    const keep = "window.__got = []; addEventListener('message', (e) => window.__got.push({ origin: e.origin, data: e.data }));";
    if (u.pathname === '/opener') {
        return `<!doctype html><html><body><p>spy opener</p><script>${keep}
            let win = null; window.__open = (url) => { win = window.open(url, '_blank'); return !!win; };
            window.__post = (data, origin) => { if (win) win.postMessage(data, origin); };</script></body></html>`;
    }
    // Where a redirect lands the handoff: it says "ready" to its opener with the nonce from its address, as the
    // community's page would, again and again, and keeps everything it is sent.
    return `<!doctype html><html><body><p>spy</p><script>${keep}
        const n = new URLSearchParams(location.search).get('n');
        const ready = () => { if (window.opener && n) window.opener.postMessage({ tag: 'beanpool-handoff', v: 1, type: 'ready', nonce: n }, '*'); };
        ready(); setInterval(ready, 300);</script></body></html>`;
}

async function storedKey(page) {
    return page.evaluate(async () => {
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        if (!dbs.some((d) => d.name === 'beanpool-identity')) return null;
        return new Promise((resolve) => {
            const r = indexedDB.open('beanpool-identity');
            r.onerror = () => resolve(null);
            r.onsuccess = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains('keys')) { db.close(); resolve(null); return; }
                const g = db.transaction('keys').objectStore('keys').get('sovereign-identity');
                g.onsuccess = () => { db.close(); resolve(g.result ? g.result.publicKey : null); };
                g.onerror = () => { db.close(); resolve(null); };
            };
        });
    });
}

const problems = [];
async function shot(page, name, theme) {
    await page.waitForTimeout(250);
    const width = await page.evaluate(() => document.scrollingElement.scrollWidth);
    if (width > 320) problems.push(`${name} ${theme}: scrolls sideways (${width}px)`);
    const out = path.join(SHOTS, `y1-${name}-320-x1.3-${theme}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`    shot ${name} ${theme} (width ${width}) → ${out}`);
}
async function tall(page, testId, name) {
    const h = await page.getByTestId(testId).first().evaluate((el) => el.getBoundingClientRect().height);
    if (h < 48) problems.push(`${name}: ${testId} is ${h}px tall`);
}

const JOIN = `y1-join-${BYRON}`;
let ports;
let identities = [];

try {
    ports = { global: await serve('global'), byron: await serve('byron') };
    console.log(`global → ${ports.global}, Byron → ${ports.byron}`);
    browser = await chromium.launch();

    // ── 1. The walk, light and dark: Join → Byron's page → Join → member; global's tab says so ──
    for (const theme of ['light', 'dark']) {
        console.log(`\n1. Join, the whole way (${theme})`);
        const { context, state } = await scenario({ dark: theme === 'dark' });
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        await tall(holder, JOIN, `holder ${theme}`);
        await shot(holder, 'global-yes', theme);
        const [popup] = await Promise.all([context.waitForEvent('page'), holder.getByTestId(JOIN).click()]);
        await holder.getByTestId(`y1-running-${BYRON}`).waitFor();
        check(true, 'global\'s tab says "Carry on in the new tab." while Byron\'s page has it');
        await shot(holder, 'global-running', theme);
        check(popup.url().startsWith(`${BYRON}/app?door=handoff&n=`) || popup.url().startsWith(`${BYRON}/app`), `the new tab is Byron's own page (${popup.url().slice(0, 60)}…)`);
        await popup.getByTestId('handoff-confirm').waitFor({ timeout: 90_000 });
        check(!new URL(popup.url()).searchParams.has('n'), 'Byron\'s page took the handoff out of its address once read');
        const title = await popup.locator('[data-testid="handoff-confirm"] h1').textContent();
        check(title === `Join ${NAME} as CJ Asked?`, `it asks "Join ${NAME} as CJ Asked?" with the name the request sent (${title})`);
        check((await popup.getByTestId('handoff-from').textContent()).includes('global.example.org'), 'it names the page the account came from');
        check(await popup.getByTestId('handoff-callsign').inputValue() === 'CJ Asked', 'the name field holds the request\'s name, editable');
        check(await popup.getByTestId('handoff-photo-box').isChecked() === false, 'global\'s photo is offered as a tickbox, off');
        check(await storedKey(popup) === null, 'nothing is kept at Byron before Join');
        await tall(popup, 'handoff-join', `confirm ${theme}`);
        await shot(popup, 'byron-confirm', theme);
        if (theme === 'dark') {
            // The photo, ticked, comes with the account; the name, edited, is the one the join sends.
            await popup.getByTestId('handoff-photo-box').check();
            await popup.getByTestId('handoff-callsign').fill('CJ Byron');
        }
        await popup.getByTestId('handoff-join').click();
        await holder.getByTestId(`y1-joined-${BYRON}`).waitFor({ timeout: 60_000 });
        check(true, 'global\'s tab says "You joined Byron Shire BeanPool."');
        await shot(holder, 'global-joined', theme);
        const want = theme === 'dark' ? 'CJ Byron' : 'CJ Asked';
        check(state.redeems.length === 1 && state.redeems[0].publicKey === id.publicKey && state.redeems[0].signer === id.publicKey && state.redeems[0].code === INVITE,
            'Byron took the yes with the same key, signed by it, through the invite path');
        check(state.redeems[0]?.callsign === want, `as the name the person left in the field (${state.redeems[0]?.callsign})`);
        check(await storedKey(popup) === id.publicKey, 'Byron\'s page keeps that same account now (no asking again)');
        await popup.getByText('📸 Choose your look').waitFor({ timeout: 30_000 });
        const preselected = await popup.locator(`img[src="${PHOTO}"]`).count();
        check(theme === 'dark' ? preselected > 0 : preselected === 0, theme === 'dark' ? 'the photo ticked is the photo step\'s first pick' : 'no photo is picked for them with the box off');
        check(await popup.getByTestId('backup-words').count() === 0, 'no 12 words shown as new');
        await shot(popup, 'byron-photo', theme);
        check([...state.otherHosts].length === 0, `nothing asked any other host (${[...state.otherHosts].join(', ')})`);
        await context.close();
    }

    // ── 3a. A key nobody at Byron said yes to ──
    console.log('\n3a. A key with no yes at Byron');
    {
        const { context, state } = await scenario();
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        identities.push(await holder.evaluate(() => window.__identity));
        const [popup] = await Promise.all([context.waitForEvent('page'), holder.getByTestId(JOIN).click()]);
        await popup.getByTestId('handoff-refused').waitFor({ timeout: 90_000 });
        check((await popup.getByTestId('handoff-refused').textContent()) === 'This account has no yes here.', 'Byron\'s page says "This account has no yes here."');
        check(await popup.getByTestId('handoff-confirm').count() === 0 && await storedKey(popup) === null, 'and asks nothing, and keeps nothing');
        await holder.getByTestId(`y1-fallback-${BYRON}`).waitFor({ timeout: 10_000 });
        check(true, 'global\'s tab shows the fallback card');
        check(state.redeems.length === 0, 'no join was sent');
        await shot(popup, 'byron-refused', 'light');
        await shot(holder, 'global-fallback', 'light');
        await context.close();
    }

    // ── 3b. A browser that already has an account at Byron ──
    console.log('\n3b. A browser with an account at Byron already');
    {
        const other = { publicKey: 'c'.repeat(64), privateKey: '11'.repeat(32), callsign: 'Someone', createdAt: new Date().toISOString() };
        const { context, state } = await scenario({ byronStore: other });
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        const [popup] = await Promise.all([context.waitForEvent('page'), holder.getByTestId(JOIN).click()]);
        await popup.getByTestId('handoff-held').waitFor({ timeout: 90_000 });
        check(true, 'Byron\'s page says "This browser already has an account here."');
        check(await storedKey(popup) === other.publicKey, 'the account there is untouched');
        await holder.getByTestId(`y1-fallback-${BYRON}`).waitFor({ timeout: 10_000 });
        check(state.redeems.length === 0, 'global\'s tab shows the fallback card, and no join was sent');
        await shot(popup, 'byron-held', 'light');
        await context.close();
    }

    // ── 3c, 3d. A message not from the opener; a wrong nonce (the holder driven by hand) ──
    console.log('\n3c-d. Not from the opener; a wrong nonce');
    {
        const { context, state } = await scenario();
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=manual`, { waitUntil: 'load' });
        await holder.getByTestId('manual').waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        const nonce = '7'.repeat(32);
        const [popup] = await Promise.all([
            context.waitForEvent('page'),
            holder.evaluate(([url]) => window.__open(url), [`${BYRON}/app?door=handoff&n=${nonce}&from=${encodeURIComponent(GLOBAL)}`]),
        ]);
        await popup.getByTestId('handoff-waiting').waitFor({ timeout: 90_000 });
        await holder.waitForFunction((n) => window.__got.some((m) => m.data?.type === 'ready' && m.data?.nonce === n), nonce, { timeout: 30_000 });
        check(true, 'Byron\'s page said ready to its opener');
        const account = { publicKey: id.publicKey, privateKey: id.privateKey, mnemonic: id.mnemonic, callsign: 'CJ' };
        // Not from the opener: the same message, put in the page with another source (only a script in Byron's own
        // page could do this; another window has no handle on this one, which is the point of `source`).
        await popup.evaluate(([data, from]) => {
            window.dispatchEvent(new MessageEvent('message', { data, origin: from, source: window }));
            window.dispatchEvent(new MessageEvent('message', { data, origin: from, source: null }));
        }, [await holder.evaluate(([n, a]) => window.__messages.accountMessage(n, a, null), [nonce, account]), GLOBAL]);
        // A wrong nonce, from the real opener at the right origin.
        await holder.evaluate(([n, a, origin]) => window.__post(window.__messages.accountMessage(n, a, null), origin), ['8'.repeat(32), account, BYRON]);
        await popup.waitForTimeout(1500);
        check(await popup.getByTestId('handoff-confirm').count() === 0 && await popup.getByTestId('handoff-waiting').count() === 1,
            'Byron\'s page took neither: still waiting, nothing asked');
        check(await storedKey(popup) === null && state.statusReads.length === 0, 'nothing kept, and the key never used');
        // The same account with the right nonce, from the opener: taken, which shows it was the nonce and the source.
        await holder.evaluate(([n, a, origin]) => window.__post(window.__messages.accountMessage(n, a, null), origin), [nonce, account, BYRON]);
        await popup.getByTestId('handoff-confirm').waitFor({ timeout: 30_000 });
        check(true, 'with its own nonce, from its opener, it asks');
        await context.close();
    }

    // ── 3e. A message from an origin other than the one Byron's address names ──
    console.log('\n3e. A spy opener that claims to be global');
    {
        const { context, state } = await scenario();
        const holderish = await context.newPage();
        await holderish.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=manual`, { waitUntil: 'load' });
        const id = await holderish.evaluate(async () => { while (!window.__identity) await new Promise((r) => setTimeout(r, 50)); return window.__identity; });
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        const spy = await context.newPage();
        await spy.goto(`${SPY}/opener`);
        const nonce = '9'.repeat(32);
        const [popup] = await Promise.all([
            context.waitForEvent('page'),
            spy.evaluate(([url]) => window.__open(url), [`${BYRON}/app?door=handoff&n=${nonce}&from=${encodeURIComponent(GLOBAL)}`]),
        ]);
        await popup.getByTestId('handoff-waiting').waitFor({ timeout: 90_000 });
        await popup.waitForTimeout(1000);
        check((await spy.evaluate(() => window.__got)).length === 0, 'its "ready" went to global\'s origin only, so the spy opener heard nothing');
        const msg = await holderish.evaluate(([n, a]) => window.__messages.accountMessage(n, a, null), [nonce, { publicKey: id.publicKey, privateKey: id.privateKey, mnemonic: id.mnemonic, callsign: 'CJ' }]);
        await spy.evaluate(([data, origin]) => window.__post(data, origin), [msg, BYRON]);
        await popup.waitForTimeout(1500);
        check(await popup.getByTestId('handoff-confirm').count() === 0 && await storedKey(popup) === null && state.statusReads.length === 0,
            'an account from the spy\'s origin is dropped: nothing asked, nothing kept, the key never used');
        await context.close();
    }

    // ── 4. The holder posts only to the knock's origin: a redirect to a spy gets nothing ──
    console.log('\n4. The handoff redirected to a spy at another origin');
    {
        const { context, state } = await scenario({ redirectToSpy: true });
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join&readyMs=4000`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        const [popup] = await Promise.all([context.waitForEvent('page'), holder.getByTestId(JOIN).click()]);
        await popup.waitForURL(`${SPY}/**`, { timeout: 30_000 });
        await holder.getByTestId(`y1-fallback-${BYRON}`).waitFor({ timeout: 15_000 });
        const got = await popup.evaluate(() => window.__got);
        const heard = await holder.evaluate((spy) => window.__got.filter((m) => m.origin === spy && m.data?.type === 'ready').length, SPY);
        check(heard > 0, `global's tab did hear the spy's "ready" (${heard} times), with the right nonce`);
        check(got.length === 0, `and the spy was sent nothing (${got.length} messages)`);
        check(true, 'global\'s tab showed the fallback card when Byron\'s page never answered');
        await context.close();
    }

    // ── 4b. Byron's page said ready, then the window went to a spy before the account went ──
    console.log('\n4b. Ready from Byron, then the window goes to a spy');
    {
        const { context, state } = await scenario({ readyThenSpy: true });
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join&readyMs=4000`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        identities.push(id);
        state.yesKeys.add(id.publicKey);
        const [popup] = await Promise.all([context.waitForEvent('page'), holder.getByTestId(JOIN).click()]);
        await popup.waitForURL(`${SPY}/**`, { timeout: 30_000 });
        // The account is sent about 1.5 s after the ready (the slow photo read); give it time to arrive anywhere.
        await popup.waitForTimeout(3000);
        const got = await popup.evaluate(() => window.__got.filter((m) => m.data?.type === 'account').length);
        check(got === 0, `the account was sent to Byron's origin only, so the spy now in that window got none (${got})`);
        await context.close();
    }

    // ── 5. window.open gives nothing back ──
    console.log('\n5. A pop-up blocker');
    {
        const { context } = await scenario();
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/global-yes-y1-harness.html?mode=join&nopopup=1`, { waitUntil: 'load' });
        await holder.getByTestId(JOIN).waitFor({ timeout: 90_000 });
        identities.push(await holder.evaluate(() => window.__identity));
        const before = network.length;
        await holder.getByTestId(JOIN).click();
        await holder.getByTestId(`y1-fallback-${BYRON}`).waitFor({ timeout: 5_000 });
        check(true, 'the fallback card at once');
        check(network.slice(before).every((r) => !r.url.startsWith(BYRON)), 'and nothing went to Byron');
        await tall(holder, `y1-open-${BYRON}`, 'fallback');
        await context.close();
    }

    // ── 2. The key in no address or request, from either page, in any scenario ──
    console.log(`\n2. ${network.length} requests, from every page in every scenario`);
    const secrets = identities.flatMap((id) => [id.privateKey, id.privateKey.slice(-64), id.mnemonic.join(' '), id.mnemonic.join(','), id.mnemonic.join('%20'), id.mnemonic.join('+')]);
    const leaks = network.filter((r) => {
        const text = `${r.url}\n${JSON.stringify(r.headers)}\n${r.body}`;
        return secrets.some((s) => s && text.includes(s));
    });
    check(identities.length >= 8 && leaks.length === 0, `no private key, seed or 12 words in any of them (${leaks.length} found: ${leaks.map((r) => r.url).join(', ').slice(0, 300)})`);
    check(network.some((r) => r.url.startsWith(`${BYRON}/api/join/knock/status`)), 'and the check saw the signed status reads it was looking through');

    for (const p of problems) check(false, p);
} catch (e) {
    failures.push(`crashed: ${e?.stack ?? e}`);
    console.error(e);
    console.error(pageLog.slice(-40).join('\n'));
    for (const c of openContexts) {
        for (const p of c.pages()) {
            const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '(closed)');
            console.error(`--- ${p.url().slice(0, 100)}\n${String(text).slice(0, 600)}`);
        }
    }
} finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed.');
process.exit(failures.length ? 1 : 0);
