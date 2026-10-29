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

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
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
