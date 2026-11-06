/* eslint-disable no-undef */
// Deals S4 shots at 320 px with 130% text, light and dark: node apps/pwa/e2e/deals-s4-shots.mjs [--out <dir>]
// A listing as its payer, its payee (a helper on a Need), its author with two deals under way, a keeper of the enterprise
// that wrote it, and the feed with each chip. The node's answers are routed here: nothing leaves the machine.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const outAt = process.argv.indexOf('--out');
const OUT_DIR = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve(PWA_DIR, '../..', 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });
// --page: the listing's PAGE (DW3 of DESIGN-detail-pages-fable.md, in DESIGN-detail-pages-frame-fable.md's order) instead of
// the deal views: see pageShots below.
const PAGE_ONLY = process.argv.includes('--page');

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/deals-s4-shots-harness.html`;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const ME = 'me-key';
const ENT = 'farm-co-key';
const AT = '2026-10-24T10:00:00.000Z';
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#7a9a6a"/></svg>');
const post = (over) => ({
    id: 'p', type: 'offer', category: 'education', title: 'Listing', description: 'Six weeks on the wheel, Saturday mornings.', credits: 45,
    priceType: 'fixed', status: 'active', active: true, repeatable: true, authorPublicKey: 'damo-key', authorCallsign: 'Damo', createdAt: AT,
    photos: [PHOTO], audienceScope: 'public', ...over,
});
const POSTS = [
    post({ id: 'p-course', title: 'Pottery course' }),
    post({ id: 'p-stall', type: 'need', category: 'labour', title: 'Help at the market stall', credits: 20, authorPublicKey: 'kofi-key', authorCallsign: 'Kofi' }),
    post({ id: 'p-mine', title: 'Sourdough lessons', authorPublicKey: ME, authorCallsign: 'Ana' }),
    post({ id: 'p-farm', type: 'need', category: 'labour', title: 'Mend the polytunnel', credits: 20, authorPublicKey: ENT, authorCallsign: 'Farm Co-op' }),
    post({ id: 'p-ladder', category: 'tools', title: 'Long ladder', repeatable: false, lendable: true, credits: 0, createdAt: '2026-10-25T10:00:00.000Z' }),
    post({ id: 'p-other', category: 'food', title: 'Duck eggs', credits: 6 }),
    post({ id: 'p-olives', type: 'need', category: 'food', title: 'Pick the olives', credits: 20, priceType: 'daily', authorPublicKey: ME, authorCallsign: 'Ana' }),
];
// A 4:3 photo (the frame's own shape), for the page's cases.
const PHOTO_43 = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#9cb98a"/><circle cx="300" cy="320" r="120" fill="#c0392b"/><circle cx="500" cy="300" r="110" fill="#d35400"/></svg>');
// Marty's apples (DESIGN-detail-pages-fable.md §2.9): a recurring Need, Beans off where it is read (the global community).
if (PAGE_ONLY) POSTS.push(post({ id: 'p-apples', type: 'need', category: 'food', title: 'Apples needed', description: 'Looking for fresh apples', credits: 0,
    authorPublicKey: 'marty-key', authorCallsign: 'Marty', photos: [PHOTO_43], createdAt: '2026-11-03T10:00:00.000Z' }));
if (PAGE_ONLY) for (const p of POSTS) if (p.id === 'p-course' || p.id === 'p-mine') p.photos = [PHOTO_43];
const FARM_DEALS = [{ id: 'tx-f', postId: 'p-farm', postTitle: 'Mend the polytunnel', credits: 20, status: 'pending', buyerPublicKey: ENT, buyerCallsign: 'Farm Co-op', sellerPublicKey: 'mo-key', sellerCallsign: 'Mo', createdAt: AT }];

const cases = [
    { id: 'payer', wait: 'text=held in trust' },
    { id: 'payee', wait: "text=You're helping with this" },
    { id: 'author', wait: '[data-testid="deals-under-way"]' },
    { id: 'keeper', wait: '[data-testid="deals-under-way"]' },
    { id: 'feed', wait: '[data-testid="card-deal-chip"]' },
    // A row's Release opened, 3 days changed to 5: the Beans that will go (review on #2588).
    {
        id: 'release', wait: '[data-testid="deal-row-tx-d"]', target: '[data-testid="release-line-tx-d"]',
        act: async (page) => {
            await page.locator('[data-testid="deal-row-tx-d"] button', { hasText: 'Release Credits' }).first().click();
            await page.locator('[data-testid="deal-row-tx-d"] input').fill('5');
        },
    },
    { id: 'over', wait: '[data-testid="pinned-deal-over"]' },
];
// --only release,over: just those views.
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(',')) : null;

/**
 * `--page` (DW3): the listing's page for DP3's four cases (`apples`: Marty's recurring Need where Beans are off, the global
 * community's "In return"; `offer`: an Offer with Beans; `own`: the author's own listing; `deal`: the payer's deal under
 * way), light and dark, at 320 x 569 with 130% text (the first screen, and the whole page), and at 1024 and 1280 beside a
 * 256 px stand-in for the app's sidebar (App.tsx's w-64), as market-order-shots.mjs draws it. At 320 it FAILS (not prints)
 * when the action's top is past 500 px or its bottom past 569 (DESIGN-detail-pages-frame-fable.md §2), or the page scrolls
 * sideways; it prints the photo-to-quiet-row gap (16 in rem, 20.8 px at 130%).
 */
const PAGE_CASES = ['apples', 'offer', 'own', 'deal'];
const PAGE_SIZES = [
    { name: '320-x1.3', width: 320, height: 569, scale: 1.3, sidebar: false },
    { name: '1024-sidebar', width: 1024, height: 900, scale: 1, sidebar: true },
    { name: '1280-sidebar', width: 1280, height: 900, scale: 1, sidebar: true },
];
const SIDEBAR = 256;
const MEASURE_PAGE = () => {
    const detail = document.querySelector('[data-testid="listing-detail"]');
    if (!detail) return null;
    const top = (el) => (el ? Math.round((el.getBoundingClientRect().top + window.scrollY) * 10) / 10 : null);
    const bottom = (el) => (el ? Math.round((el.getBoundingClientRect().bottom + window.scrollY) * 10) / 10 : null);
    const action = detail.querySelector('[data-testid="listing-action"]');
    const first = action ? Array.from(action.querySelectorAll('button, a')).find((b) => b.getBoundingClientRect().height > 0) : null;
    // The take-up (Accept Offer, I can do this, Ask to borrow, or the local community's action where deals live there): the
    // stop's own subject. With none (a deal under way, the author's own), the stop is the action block's top, as the event
    // harness takes the answer block's where there is no Going (event-card-shots.mjs).
    const takeUp = action ? (action.querySelector('[data-testid="local-community-action"]')
        || Array.from(action.querySelectorAll('button')).find((b) => /Accept Offer|I can do this|Ask to borrow/.test(b.textContent || ''))) : null;
    const actionRect = action ? action.getBoundingClientRect() : null;
    const picture = detail.querySelector('[data-testid="listing-photos"]') || detail.querySelector('[data-testid="listing-tile-banner"]');
    const body = detail.querySelector('[data-testid="listing-body"]');
    const photoFrame = detail.querySelector('[data-testid="listing-photo-open"]');
    const label = (el) => (el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) : '—');
    const at = (sel) => top(detail.querySelector(sel));
    return {
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        action: label(first), actionTop: top(first), actionBottom: bottom(first),
        takeUp: takeUp ? label(takeUp) : null, takeUpTop: top(takeUp), takeUpBottom: bottom(takeUp),
        blockTop: actionRect && actionRect.height > 0 ? Math.round((actionRect.top + window.scrollY) * 10) / 10 : null,
        photo: photoFrame ? `${Math.round(photoFrame.getBoundingClientRect().width)} x ${Math.round(photoFrame.getBoundingClientRect().height)}` : '—',
        photoLeft: photoFrame ? Math.round(photoFrame.getBoundingClientRect().left) : null,
        photoGap: picture && body ? Math.round((body.getBoundingClientRect().top - picture.getBoundingClientRect().bottom) * 10) / 10 : null,
        shareTop: at('[data-testid="share-button"]'), postedByTop: top(Array.from(detail.querySelectorAll('p')).find((p) => p.textContent === 'Posted by')),
        pageHeight: Math.round(document.documentElement.scrollHeight),
    };
};
async function pageShots(browser) {
    const failures = [];
    const lines = [];
    for (const theme of ['light', 'dark']) {
        for (const size of PAGE_SIZES) {
            for (const which of PAGE_CASES) {
                const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                await page.addInitScript((scale) => {
                    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
                }, size.scale);
                // Beans off for the apples: the global community (a showcase), where the page says what it asks in return.
                const features = which === 'apples' ? { showcase: true, beans: false, escrow: false } : { beans: true, escrow: true, enterprises: true, decisions: true };
                await page.route('**/*', async (route) => {
                    const url = new URL(route.request().url());
                    if (!url.hostname.includes('localhost')) return route.abort();
                    if (!url.pathname.startsWith('/api/')) return route.continue();
                    const p = url.pathname;
                    if (p.startsWith('/api/community/info')) return json(route, { memberCount: 12, profile: 'local', features });
                    if (p === '/api/marketplace/posts') {
                        const id = url.searchParams.get('id');
                        return json(route, id ? POSTS.filter(x => x.id === id) : (url.searchParams.get('author') ? [] : POSTS));
                    }
                    if (p.startsWith('/api/ledger/balance')) return json(route, { balance: 100, floor: -500, isBlockedFromTrading: false, keeperOf: [] });
                    if (p === '/api/marketplace/transactions') return json(route, []);
                    if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 4.6, count: 5 });
                    if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                    if (p.startsWith('/api/groups')) return json(route, []);
                    if (p.startsWith('/api/members')) return json(route, []);
                    return json(route, {});
                });
                await page.goto(`${base}?view=page-${which}${theme === 'dark' ? '&dark=1' : ''}`);
                await page.waitForSelector('[data-testid="listing-detail"]', { timeout: 20000 }).catch(() => failures.push(`${which} ${theme} ${size.name}: no listing page`));
                if (size.sidebar) {
                    await page.addStyleTag({ content: `body { padding-left: ${SIDEBAR}px; } body::before { content: ''; position: fixed; left: 0; top: 0; bottom: 0; width: ${SIDEBAR}px; background: var(--bg-secondary); border-right: 1px solid var(--border-primary); }` });
                }
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(700);
                const m = await page.evaluate(MEASURE_PAGE);
                const shot = `dw3-${which}-${size.name}-${theme}`;
                await page.screenshot({ path: path.join(OUT_DIR, `${shot}.png`), fullPage: true });
                if (size.width === 320) await page.screenshot({ path: path.join(OUT_DIR, `${shot}-first-screen.png`) });
                if (!m) { await context.close(); continue; }
                if (m.sideways) failures.push(`${shot}: the page scrolls sideways`);
                if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
                if (size.width === 320) {
                    if (m.takeUp) {
                        if (m.takeUpTop > 500) failures.push(`${shot}: the take-up starts at ${m.takeUpTop} px, past the 500 px stop`);
                        if (m.takeUpBottom > 569) failures.push(`${shot}: the take-up ends at ${m.takeUpBottom} px, past the 569 px screen`);
                    } else if (m.blockTop != null && m.blockTop > 500) {
                        failures.push(`${shot}: the action starts at ${m.blockTop} px, past the 500 px stop`);
                    }
                }
                const gap = size.width < 768 ? `; photo → quiet row ${m.photoGap} px` : '';
                lines.push(`${shot.padEnd(30)} take-up ${m.takeUp ? `"${m.takeUp}" ${m.takeUpTop}–${m.takeUpBottom}` : '—'}; action block at ${m.blockTop}, its first button "${m.action}" ${m.actionTop}–${m.actionBottom}; `
                    + `photo ${m.photo} at x ${m.photoLeft}${gap}; `
                    + `Share at ${m.shareTop}, Posted by at ${m.postedByTop}; page ${m.pageHeight} px`);
                await context.close();
            }
        }
    }
    for (const l of lines) console.log(l);
    if (failures.length) {
        console.log(`\nFAILED (${failures.length}):\n${failures.join('\n')}`);
        process.exitCode = 1;
    } else {
        console.log(`\nOK — the listing page at 320 x 1.3: every take-up on the first screen (top <= 500, bottom <= 569), every action block's top <= 500, nothing sideways, in all ${lines.length} shots.`);
    }
}

const browser = await chromium.launch();
try {
    if (PAGE_ONLY) await pageShots(browser);
    for (const theme of PAGE_ONLY ? [] : ['light', 'dark']) {
        for (const c of cases) {
            if (only && !only.has(c.id)) continue;
            const context = await browser.newContext({ viewport: { width: 320, height: 860 }, colorScheme: theme, deviceScaleFactor: 1 });
            const page = await context.newPage();
            await page.addInitScript(() => {
                try { localStorage.setItem('marketplace_view_mode', 'list'); } catch { /* none */ }
                document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '130%'; });
            });
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url());
                if (!url.hostname.includes('localhost')) return route.abort();
                if (!url.pathname.startsWith('/api/')) return route.continue();
                const p = url.pathname;
                if (p.startsWith('/api/community/info')) return json(route, { memberCount: 12, profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true } });
                if (p === '/api/marketplace/posts') {
                    const id = url.searchParams.get('id');
                    return json(route, id ? POSTS.filter(x => x.id === id) : (url.searchParams.get('author') ? [] : POSTS));
                }
                if (p.startsWith('/api/ledger/balance')) return json(route, { balance: 100, floor: -500, isBlockedFromTrading: false, keeperOf: c.id === 'keeper' ? [ENT] : [] });
                if (p === '/api/marketplace/transactions') return json(route, url.searchParams.get('publicKey') === ENT ? FARM_DEALS : []);
                if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 4.6, count: 5 });
                if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                if (p.startsWith('/api/groups')) return json(route, []);
                if (p.startsWith('/api/members')) return json(route, []);
                return json(route, {});
            });
            await page.goto(`${base}?view=${c.id}${theme === 'dark' ? '&dark=1' : ''}`);
            await page.waitForSelector(c.wait, { timeout: 20000 }).catch(() => console.log(`${c.id} ${theme}: ${c.wait} not found`));
            await page.waitForTimeout(600);
            if (c.act) { await c.act(page); await page.waitForTimeout(300); }
            // The deal's own panel in view: the rows for its people, the taker's panel, or the first chip.
            const target = c.target ?? (c.id === 'feed' ? '[data-testid="card-deal-chip"]' : (c.id === 'author' || c.id === 'keeper') ? '[data-testid="deals-under-way"]' : `${c.wait}`);
            await page.locator(target).first().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            const outPath = path.join(OUT_DIR, `deals-s4-${c.id}-320-x1.3-${theme}.png`);
            await page.screenshot({ path: outPath, fullPage: false });
            console.log(`${c.id} ${theme}: horizontal overflow ${overflow}px -> ${outPath}`);
            if (c.id === 'feed') {
                // The other chip, further down the feed: ✋ ASKED on the ladder the reader asked to borrow.
                await page.locator('[data-testid="card-deal-chip"]', { hasText: 'ASKED' }).first().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
                await page.waitForTimeout(300);
                await page.screenshot({ path: path.join(OUT_DIR, `deals-s4-feed-asked-320-x1.3-${theme}.png`), fullPage: false });
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
