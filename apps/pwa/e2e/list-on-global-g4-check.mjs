#!/usr/bin/env node
/**
 * Back to the listing after the join, the web's whole way (list on global G4, DESIGN-list-on-global-fable.md §6 steps 3-7),
 * in headless Chromium between TWO real origins, each served by its own Vite server: "global" (https://global.example.org,
 * e2e/list-on-global-g4-harness.tsx with the real components/EventCopyDoor.tsx and components/YesJoin.tsx) and "Riverside"
 * (https://riverside.example.org, the real web app, App.tsx). Playwright only maps the names to the ports and answers /api with
 * stubs; each origin's storage is its own, as the browser keeps it.
 *
 *   1. A copy of Riverside's listing on global: Ask to join keeps the listing at Riverside (global's own storage, the id and the time
 *      only) and goes to the Find card's address (`/?ask=riverside.example.org`).
 *   2. Riverside said yes: Join opens Riverside's page with the listing beside the handoff (`&listing=<id>`), and Riverside's page takes it
 *      out of its address; Join there → the photo step → the tour → the member lands on that listing on Riverside's Market.
 *      Global's tab forgets it once Riverside's page said joined.
 *   3. The listing has gone by then: the Market, with "The listing you came for is no longer up." (here in Spanish).
 *   4. The screens at 320 px with 1.3x text, light and dark, one in Spanish (--shots <dir>): fails on sideways scroll.
 *
 * Run: node apps/pwa/e2e/list-on-global-g4-check.mjs [--shots <dir>]
 */
/* global document, window, localStorage, console, process, URL, setTimeout, clearTimeout */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : path.join(os.tmpdir(), 'bp-g4-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const GLOBAL = 'https://global.example.org';
const RIVERSIDE = 'https://riverside.example.org';
const INVITE = 'INV-KN0C-K1NV';
const NAME = 'Riverside Shire BeanPool';
const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const TITLE = 'Spare seedlings, ready to plant';
const GONE = 'The listing you came for is no longer up.';

/** Riverside's words in Spanish, as the app's own catalogs give them (app first, then core), for the buttons the walk taps. */
const catalogs = {
    es: {
        ...JSON.parse(fs.readFileSync(path.join(PWA_DIR, 'words/es.json'), 'utf8')),
        ...JSON.parse(fs.readFileSync(path.join(PWA_DIR, '../../packages/beanpool-core/words/es.json'), 'utf8')),
    },
};
const say = (lang, key) => (lang === 'en' ? key : catalogs[lang][key] ?? key);

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}
const WATCHDOG_MS = Number(process.env.G4_WATCHDOG_MS) || 480_000;
const servers = [];
let browser;
const watchdog = setTimeout(() => {
    console.error(`Stopped after ${WATCHDOG_MS} ms. So far ${failures.length} failed.`);
    process.exit(2);
}, WATCHDOG_MS);

async function serve(tag) {
    const server = await createServer({
        configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, logLevel: 'error',
        cacheDir: path.join(os.tmpdir(), `bp-g4-vite-${tag}`),
        server: { port: 0, host: '127.0.0.1', hmr: false, allowedHosts: true, proxy: {} },
    });
    await server.listen();
    servers.push(server);
    return `http://127.0.0.1:${server.httpServer.address().port}`;
}

const pageLog = [];
const openContexts = [];
let ports;

const POST_ROW = {
    id: POST, type: 'offer', category: 'garden', title: TITLE, description: 'Tomato and basil seedlings.', credits: 20, price_c: 2000,
    priceType: 'fixed', status: 'active', active: 1, authorPublicKey: 'e'.repeat(64), authorCallsign: 'Robin', createdAt: new Date().toISOString(),
    lat: -28.65, lng: 153.6, photos: [],
};

/** One context: a browser with nothing kept, both origins mapped, Riverside's stubs; `gone`: Riverside no longer holds the listing. */
async function scenario({ dark = false, lang = 'en', gone = false } = {}) {
    const state = { yesKeys: new Set(), members: new Set(), redeems: [], byId: [], handoffs: [], otherHosts: new Set() };
    const context = await browser.newContext({ viewport: { width: 320, height: 720 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', deviceScaleFactor: 2 });
    context.on('page', (p) => {
        p.on('pageerror', (e) => pageLog.push(`[pageerror ${new URL(p.url()).host}] ${e.message}`));
        p.on('console', (m) => { if (m.type() === 'error') pageLog.push(`[error ${new URL(p.url() || 'about:blank').host}] ${m.text().slice(0, 300)}`); });
    });
    openContexts.push(context);
    await context.addInitScript(([mode, language]) => {
        window.process = window.process || { env: {} };
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
            if (language !== 'en') localStorage.setItem('beanpool-language', language);
        } catch { /* none */ }
        document.addEventListener('DOMContentLoaded', () => {
            const s = document.createElement('style');
            s.textContent = 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; animation: none !important; }';
            document.head.appendChild(s);
        });
    }, [dark ? 'dark' : 'light', lang]);
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const local = u.origin === GLOBAL ? ports.global : u.origin === RIVERSIDE ? ports.riverside : null;
        if (!local) { state.otherHosts.add(u.host); return route.abort(); }
        if (u.origin === RIVERSIDE && u.pathname === '/app' && u.searchParams.get('door') === 'handoff') state.handoffs.push(u.href);
        // The copy's door goes to global's Find card (`/?ask=`): here, the harness's yes card, as the same origin.
        if (u.origin === GLOBAL && u.pathname === '/' && u.searchParams.has('ask')) {
            const res = await route.fetch({ url: `${local}/e2e/list-on-global-g4-harness.html${u.search}` });
            const html = (await res.text()).replaceAll('./list-on-global-g4-harness.tsx', '/e2e/list-on-global-g4-harness.tsx');
            return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        }
        if (u.pathname.startsWith('/api/')) {
            const signer = req.headers()['x-public-key'] ?? null;
            if (u.origin === GLOBAL) return json(route, u.pathname.startsWith('/api/profile/') ? { callsign: 'CJ Global' } : {});
            if (u.pathname === '/api/community/info') return json(route, { profile: 'local', memberCount: 40, postCount: 1, transactionCount: 0, commonsBalance_c: 0, features: { openJoin: false, knocks: true } });
            if (u.pathname === '/api/community/card') return json(route, { name: NAME, host: 'riverside.example.org', members: 40, joining: 'requests' });
            if (u.pathname === '/api/join/knock/status') {
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
            if (u.pathname === '/api/marketplace/posts') {
                const id = u.searchParams.get('id');
                if (id) {
                    state.byId.push(id);
                    return json(route, !gone && id === POST ? [POST_ROW] : []);
                }
                return json(route, []);
            }
            if (u.pathname === '/api/ledger/transactions' || u.pathname === '/api/marketplace/transactions' || /^\/api\/(transactions|messages|conversations|notifications|groups|projects|events|pins|knocks)/.test(u.pathname)) return json(route, []);
            return json(route, {});
        }
        const res = await route.fetch({ url: `${local}${u.pathname}${u.search}` });
        return route.fulfill({ response: res });
    });
    return { context, state };
}

const problems = [];
async function shot(page, name, theme) {
    await page.waitForTimeout(300);
    const width = await page.evaluate(() => document.scrollingElement.scrollWidth);
    if (width > 320) problems.push(`${name} ${theme}: scrolls sideways (${width}px)`);
    const out = path.join(SHOTS, `g4-${name}-320-x1.3-${theme}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`    shot ${name} ${theme} (width ${width}) → ${out}`);
}

const keptAtGlobal = (page) => page.evaluate(() => localStorage.getItem('beanpool_listing_after_join'));

/** Riverside's page after the handoff's Join: the photo step, then the tour's last button, as a member taps them. */
async function throughTheSteps(popup, lang) {
    await popup.getByText(say(lang, '📸 Choose your look')).waitFor({ timeout: 60_000 });
    await popup.getByRole('button', { name: say(lang, 'Next →'), exact: true }).first().click();
    const begin = popup.getByRole('button', { name: say(lang, "Let's Begin! 🚀") });
    await begin.waitFor({ timeout: 30_000 });
    await begin.click();
}

try {
    ports = { global: await serve('global'), riverside: await serve('riverside') };
    console.log(`global → ${ports.global}, Riverside → ${ports.riverside}`);
    browser = await chromium.launch();

    const runs = [
        { theme: 'light', lang: 'en', gone: false },
        { theme: 'dark', lang: 'en', gone: false },
        { theme: 'dark', lang: 'es', gone: true },
    ];
    for (const run of runs) {
        const tag = `${run.theme}${run.lang === 'en' ? '' : `-${run.lang}`}${run.gone ? '-gone' : ''}`;
        console.log(`\n${run.gone ? 'The listing has gone' : 'Back to the listing'} (${tag})`);
        const { context, state } = await scenario({ dark: run.theme === 'dark', lang: run.lang, gone: run.gone });
        const holder = await context.newPage();
        await holder.goto(`${GLOBAL}/e2e/list-on-global-g4-harness.html?listing=${POST}&lang=${run.lang}${run.theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'load' });
        const door = holder.getByTestId('event-copy-ask');
        await door.waitFor({ timeout: 90_000 });
        check(await keptAtGlobal(holder) === null, 'nothing is kept before the tap');
        await shot(holder, 'global-copy', tag);
        await Promise.all([holder.waitForURL(/\?ask=riverside\.example\.org/), door.click()]);
        const kept = JSON.parse(await keptAtGlobal(holder) ?? 'null');
        check(kept && Object.keys(kept).length === 1 && kept['riverside.example.org']?.id === POST && Object.keys(kept['riverside.example.org']).sort().join() === 'at,id',
            `Ask to join kept the listing at Riverside in global's storage, the id and the time only (${JSON.stringify(kept)})`);
        const join = holder.getByTestId(`g4-join-${RIVERSIDE}`);
        await join.waitFor({ timeout: 90_000 });
        const id = await holder.evaluate(() => window.__identity);
        state.yesKeys.add(id.publicKey);
        await shot(holder, 'global-yes', tag);
        const [popup] = await Promise.all([context.waitForEvent('page'), join.click()]);
        await popup.getByTestId('handoff').waitFor({ timeout: 90_000 });
        const opened = new URL(state.handoffs[0] ?? popup.url());
        check(opened.origin === RIVERSIDE && opened.searchParams.get('listing') === POST, `Riverside's page opened with the listing beside the handoff (${opened.search.replace(/n=[0-9a-f]+/, 'n=…')})`);
        check(!opened.href.includes(id.privateKey) && !opened.href.includes(id.mnemonic.join(' ')), 'and no key or words in its address');
        await popup.getByTestId('handoff-confirm').waitFor({ timeout: 90_000 });
        check(!new URL(popup.url()).searchParams.has('listing'), 'Riverside\'s page took the listing out of its address with the rest of the handoff');
        check(await popup.evaluate(() => localStorage.getItem('beanpool_listing_after_join')) === null, 'nothing is kept at Riverside before its Join');
        await popup.getByTestId('handoff-join').click();
        await holder.getByTestId(`g4-joined-${RIVERSIDE}`).waitFor({ timeout: 60_000 });
        check(await keptAtGlobal(holder) === null, 'global forgot the listing once Riverside\'s page said joined');
        check(state.redeems.length === 1 && state.redeems[0].publicKey === id.publicKey, 'Riverside took the yes with the same key, through the invite path');
        await throughTheSteps(popup, run.lang);
        if (run.gone) {
            const line = popup.getByText(say(run.lang, GONE));
            await line.waitFor({ timeout: 60_000 });
            check(true, `the Market says "${say(run.lang, GONE)}"`);
            check(say(run.lang, GONE) !== GONE || run.lang === 'en', 'in the member\'s language');
            check(state.byId.includes(POST), 'after asking Riverside for that listing by its id');
            await shot(popup, 'riverside-gone', tag);
        } else {
            const detail = popup.getByTestId('listing-detail');
            await detail.waitFor({ timeout: 60_000 });
            check((await detail.textContent()).includes(TITLE), `the member landed on the listing on Riverside's Market ("${TITLE}")`);
            check(await popup.getByText(GONE).count() === 0, 'with no line about it being gone');
            await shot(popup, 'riverside-listing', tag);
        }
        check(await popup.evaluate(() => localStorage.getItem('beanpool_listing_after_join')) === null, 'Riverside used it once: nothing is left kept there');
        check([...state.otherHosts].length === 0, `nothing asked any other host (${[...state.otherHosts].join(', ')})`);
        await context.close();
    }
    for (const p of problems) check(false, p);
} catch (e) {
    failures.push(`crashed: ${e?.stack ?? e}`);
    console.error(e);
    console.error(pageLog.slice(-40).join('\n'));
    for (const c of openContexts) {
        for (const p of c.pages()) {
            const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '(closed)');
            console.error(`--- ${p.url().slice(0, 120)}\n${String(text).slice(0, 800)}`);
        }
    }
} finally {
    clearTimeout(watchdog);
    await browser?.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
}
console.log(failures.length ? `\n${failures.length} failed:\n- ${failures.join('\n- ')}` : '\nAll passed.');
process.exit(failures.length ? 1 : 0);
