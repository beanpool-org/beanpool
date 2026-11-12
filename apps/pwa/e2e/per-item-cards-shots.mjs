/* eslint-disable no-undef */
// Per-item prices, slice P2: node apps/pwa/e2e/per-item-cards-shots.mjs [--out <dir>] [--only list,grid,compact,page,page-held,page-one-gone]
// The Market's list, grid and compact cards and a listing's page, for an Offer priced for each one, at 320 px with 130% text, light and
// dark. Rob's panels: 300 Beans each, 20 of them, or all 20 for 5,500; the same with one taken singly (19 left, no price for all), all
// held (none left), and a free one, beside a plain fixed price. The node's answers are routed here: nothing leaves the machine.
// Checks (it exits 1 when one fails): nothing scrolls sideways, no price or phrase is pushed past the screen's edge, and the card
// words are on screen.
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

const LIMIT_S = Number(process.env.PER_ITEM_SHOTS_LIMIT_S || 300);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/per-item-cards-harness.html`;
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const AT = new Date().toISOString();
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#9cb98a"/><rect x="120" y="180" width="260" height="200" fill="#2c4a6b"/><rect x="420" y="180" width="260" height="200" fill="#2c4a6b"/></svg>');
const post = (over) => ({
    id: 'p', type: 'offer', category: 'tools', title: 'Listing', description: 'Second-hand, working, collect from the farm gate.', price_c: 4000,
    priceType: 'fixed', status: 'active', active: true, repeatable: false, authorPublicKey: 'rob-key', authorCallsign: 'Rob', createdAt: AT,
    photos: [PHOTO], audienceScope: 'public', ...over,
});
const EACH = { priceType: 'each', price_c: 30000, unitsLeft: 20, lot: { units: 20, price_c: 550000 } };
const POSTS = [
    post({ id: 'p-panels', title: 'Solar panels', ...EACH }),
    post({ id: 'p-one-gone', title: 'Solar panels, one gone', ...EACH, unitsLeft: 19 }),
    post({ id: 'p-held', title: 'Solar panels, all held', ...EACH, unitsLeft: 0 }),
    post({ id: 'p-free', title: 'Offcuts of timber', ...EACH, price_c: 0, lot: null }),
    post({ id: 'p-plain', title: 'Firewood, a trailer load' }),
];

const VIEWS = [
    { id: 'list', mode: 'list' },
    { id: 'grid', mode: 'grid' },
    { id: 'compact', mode: 'compact' },
    { id: 'page', open: 'p-panels' },
    { id: 'page-held', open: 'p-held' },
    { id: 'page-one-gone', open: 'p-one-gone' },
];
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? new Set(process.argv[onlyAt + 1].split(',')) : null;
const failures = [];
const lines = [];

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        for (const v of VIEWS) {
            if (only && !only.has(v.id)) continue;
            const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, deviceScaleFactor: 1 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript((mode) => {
                try { if (mode) localStorage.setItem('marketplace_view_mode', mode); } catch { /* none */ }
                document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '130%'; });
            }, v.mode ?? null);
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url());
                if (!url.hostname.includes('localhost')) return route.abort();
                if (!url.pathname.startsWith('/api/')) return route.continue();
                const p = url.pathname;
                if (p.startsWith('/api/community/info')) return json(route, { memberCount: 12, profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true } });
                if (p === '/api/marketplace/posts') {
                    const id = url.searchParams.get('id');
                    return json(route, id ? POSTS.filter((x) => x.id === id) : (url.searchParams.get('author') ? [] : POSTS));
                }
                if (p.startsWith('/api/ledger/balance')) return json(route, { balance_c: 10000, floor_c: -50000, isBlockedFromTrading: false, keeperOf: [] });
                if (p === '/api/marketplace/transactions') return json(route, []);
                if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 4.6, count: 5 });
                if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                if (p.startsWith('/api/groups')) return json(route, []);
                if (p.startsWith('/api/members')) return json(route, []);
                return json(route, {});
            });
            await page.goto(`${base}?${v.open ? `open=${v.open}` : 'view=feed'}${theme === 'dark' ? '&dark=1' : ''}`);
            const wait = v.open ? '[data-testid="listing-price"]' : '[data-testid="listing-list-card"], [data-testid="listing-grid-tile"], [data-testid="listing-compact-row"]';
            await page.waitForSelector(wait, { timeout: 20000 }).catch(() => failures.push(`${v.id} ${theme}: ${wait} not found`));
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(700);
            // The Market's floating "Add post" button is the page's own and sits over the first card in a full-page shot: out of the way.
            await page.evaluate(() => {
                for (const el of Array.from(document.querySelectorAll('button, a'))) {
                    if (/^\s*\+?\s*add post\s*$/i.test(el.textContent || '') && getComputedStyle(el).position === 'fixed') el.style.display = 'none';
                }
            });
            const m = await page.evaluate(() => {
                const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
                const text = document.body.innerText.replace(/\s+/g, ' ');
                // Every box that holds card words must sit inside the screen: nothing is pushed past the right edge.
                const past = [];
                for (const el of Array.from(document.querySelectorAll('[data-testid="listing-list-price"], [data-testid="grid-each-price"], [data-testid="compact-each-price"], [data-testid="listing-list-each-line"], [data-testid="card-stock-chip"], [data-testid="card-stock"], [data-testid="listing-each-stock"], [data-testid="listing-each-lot"]'))) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.right > window.innerWidth + 0.5) past.push(`${el.getAttribute('data-testid')} ends at ${Math.round(r.right)}`);
                }
                // The grid's pill is two lines tall when the price for all shows: it must not run over the type chip at the photo's top.
                const covered = [];
                for (const tile of Array.from(document.querySelectorAll('[data-testid="listing-grid-tile"]'))) {
                    const pill = tile.querySelector('[data-testid="grid-each-price"]');
                    const chip = tile.querySelector('span[class*="rounded"]');
                    if (!pill || !chip) continue;
                    const a = pill.parentElement.getBoundingClientRect();
                    const b = chip.getBoundingClientRect();
                    if (a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left) covered.push(`${tile.querySelector('h3')?.textContent}: the pill (top ${Math.round(a.top)}) is over the type chip (bottom ${Math.round(b.bottom)})`);
                }
                return { sideways, past, covered, text };
            });
            const shot = path.join(OUT_DIR, `per-item-${v.id}-320-x1.3-${theme}.png`);
            await page.screenshot({ path: shot, fullPage: true });
            if (m.sideways > 0) failures.push(`${v.id} ${theme}: the page scrolls sideways by ${m.sideways} px`);
            for (const p of m.past) failures.push(`${v.id} ${theme}: ${p}`);
            for (const p of m.covered) failures.push(`${v.id} ${theme}: ${p}`);
            if (errors.length) failures.push(`${v.id} ${theme}: page errors ${JSON.stringify(errors)}`);
            const needs = v.open
                ? (v.id === 'page' ? ['300', 'each', '20 left', 'or all 20 for 5,500 Beans'] : v.id === 'page-held' ? ['All taken for now'] : ['19 left'])
                : v.id === 'list' ? ['20 left', 'or all for 5,500', '19 left', 'All taken for now']
                : v.id === 'grid' ? ['20 LEFT', 'all 5,500', '19 LEFT', 'ALL TAKEN FOR NOW']
                : ['20 left', 'all 5,500', '19 left'];
            for (const w of needs) if (!m.text.includes(w)) failures.push(`${v.id} ${theme}: "${w}" is not on the page`);
            lines.push(`${v.id.padEnd(14)} ${theme.padEnd(5)} sideways ${m.sideways}px -> ${shot}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
for (const l of lines) console.log(l);
if (failures.length) {
    console.log(`\nFAILED (${failures.length}):\n${failures.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`\nOK — the cards and the page at 320 x 1.3, light and dark: the card words are all on screen and nothing scrolls sideways or past the edge, in all ${lines.length} shots.`);
}
