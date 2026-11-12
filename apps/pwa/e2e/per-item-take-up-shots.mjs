/* eslint-disable no-undef */
// Per-item prices, slice P3: node apps/pwa/e2e/per-item-take-up-shots.mjs [--out <dir>]
// The buyer's "How many would you like?" box on a listing's page, at 320 px with 130% text, light and dark: a number (3 of them),
// all of them (all 20 for 5,500), and a refusal (the node answers 409 units_gone: only 2 left now). Rob's panels: 300 Beans each,
// 20 of them, or all 20 for 5,500. The real page (P2's harness, e2e/per-item-cards-harness.html); the node's answers are routed
// here and nothing leaves the machine. Checks (it exits 1 when one fails): nothing scrolls sideways, nothing in the box ends past
// the screen's edge, the stepper's buttons and Confirm are at least 48 px tall, and the box's words are on screen.
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
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#9cb98a"/><rect x="120" y="180" width="260" height="200" fill="#2c4a6b"/><rect x="420" y="180" width="260" height="200" fill="#2c4a6b"/></svg>');
const panels = (unitsLeft) => ({
    id: 'p-panels', type: 'offer', category: 'tools', title: 'Solar panels', description: 'Second-hand, working, collect from the farm gate.',
    price_c: 30000, priceType: 'each', unitsLeft, lot: { units: 20, price_c: 550000 }, status: 'active', active: true, repeatable: false,
    authorPublicKey: 'rob-key', authorCallsign: 'Rob', createdAt: new Date().toISOString(), photos: [PHOTO], audienceScope: 'public',
});

const STATES = [
    { id: 'number', needs: ['How many would you like?', 'Choose how many', '300 Beans each · 20 left', 'All 20 for 5,500 Beans', '500 less than one by one', '3 × 300 = 900 Beans', 'Rob receives 886.50'] },
    { id: 'all', needs: ['All 20 for 5,500 Beans', '5,500 Beans go into trust now. Rob receives 5,417.50'] },
    { id: 'refusal', needs: ['Only 2 left now. Choose 2 or fewer.', '300 Beans each · 2 left'] },
];
const failures = [];
const lines = [];

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        for (const s of STATES) {
            const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, deviceScaleFactor: 1 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '130%'; });
            });
            // The listing as the node holds it: in the refusal, someone else took 18 while the box was open.
            let left = 20;
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url());
                if (!url.hostname.includes('localhost')) return route.abort();
                if (!url.pathname.startsWith('/api/')) return route.continue();
                const p = url.pathname;
                if (p.startsWith('/api/community/info')) return json(route, { memberCount: 12, profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true } });
                if (p === '/api/marketplace/posts') return json(route, url.searchParams.get('author') ? [] : [panels(left)]);
                if (p === '/api/marketplace/posts/accept') {
                    left = 2;
                    return json(route, { error: 'Only 2 left now. Choose 2 or fewer.', code: 'units_gone', unitsLeft: 2 }, 409);
                }
                // A same-origin photo: the avatar rules refuse an SVG, and the profile gate would open in place of the box.
                if (p.startsWith('/api/profile/')) return json(route, { avatar: '/assets/bean.png', callsign: 'Ana' });
                if (p.startsWith('/api/ledger/balance')) return json(route, { balance_c: 1000000, floor_c: -50000, isBlockedFromTrading: false, keeperOf: [] });
                if (p === '/api/marketplace/transactions') return json(route, []);
                if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 4.6, count: 5 });
                if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                if (p.startsWith('/api/groups')) return json(route, []);
                if (p.startsWith('/api/members')) return json(route, []);
                return json(route, {});
            });
            await page.goto(`${base}?open=p-panels${theme === 'dark' ? '&dark=1' : ''}`);
            await page.waitForSelector('[data-testid="listing-price"]', { timeout: 20000 }).catch(() => failures.push(`${s.id} ${theme}: the page did not open`));
            await page.evaluate(() => document.fonts.ready);
            await page.getByRole('button', { name: '🤝 Accept Offer' }).click();
            const opened = await page.waitForSelector('[data-testid="each-confirm"]', { timeout: 10000 }).then(() => true, () => false);
            if (!opened) {
                // What the page showed instead, for whoever reads the failure.
                const seen = path.join(OUT_DIR, `per-item-box-${s.id}-${theme}-NOT-OPENED.png`);
                await page.screenshot({ path: seen, fullPage: true });
                failures.push(`${s.id} ${theme}: the box did not open (see ${seen}): ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400)}`);
                await context.close();
                continue;
            }
            if (s.id === 'number' || s.id === 'refusal') {
                await page.getByTestId('each-more').click();
                await page.getByTestId('each-more').click();
            }
            if (s.id === 'all') await page.getByTestId('each-all').click();
            if (s.id === 'refusal') {
                await page.getByTestId('each-confirm-btn').click();
                await page.waitForSelector('[data-testid="each-refusal"]', { timeout: 10000 }).catch(() => failures.push(`${s.id} ${theme}: no refusal shown`));
                await page.waitForFunction(() => document.querySelector('[data-testid="each-line"]')?.textContent?.includes('2 left'), null, { timeout: 10000 })
                    .catch(() => failures.push(`${s.id} ${theme}: the listing was not read again`));
            }
            await page.waitForTimeout(400);
            await page.getByTestId('each-confirm').scrollIntoViewIfNeeded();
            const m = await page.evaluate(() => {
                const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
                const boxEl = document.querySelector('[data-testid="each-confirm"]');
                const text = (boxEl?.innerText || '').replace(/\s+/g, ' ');
                const past = [];
                for (const el of Array.from(boxEl?.querySelectorAll('*') || [])) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.right > window.innerWidth + 0.5) past.push(`${el.getAttribute('data-testid') || el.tagName.toLowerCase()} ends at ${Math.round(r.right)}`);
                }
                const short = [];
                for (const id of ['each-less', 'each-more', 'each-confirm-btn', 'each-count']) {
                    const h = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().height ?? 0;
                    if (h < 48) short.push(`${id} is ${Math.round(h)} px tall`);
                }
                return { sideways, past, short, text };
            });
            const box = await page.getByTestId('each-confirm').boundingBox();
            const shot = path.join(OUT_DIR, `per-item-box-${s.id}-320-x1.3-${theme}.png`);
            await page.screenshot({ path: shot, clip: box ? { x: 0, y: Math.max(0, box.y - 8), width: 320, height: Math.min(900, box.height + 16) } : undefined });
            if (m.sideways > 0) failures.push(`${s.id} ${theme}: the page scrolls sideways by ${m.sideways} px`);
            for (const p of m.past) failures.push(`${s.id} ${theme}: ${p}`);
            for (const p of m.short) failures.push(`${s.id} ${theme}: ${p}`);
            if (errors.length) failures.push(`${s.id} ${theme}: page errors ${JSON.stringify(errors)}`);
            for (const w of s.needs) if (!m.text.includes(w)) failures.push(`${s.id} ${theme}: "${w}" is not in the box (${m.text})`);
            lines.push(`${s.id.padEnd(8)} ${theme.padEnd(5)} sideways ${m.sideways}px -> ${shot}`);
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
    console.log(`\nOK — the box at 320 x 1.3, light and dark: its words are on screen, nothing scrolls sideways or past the edge, and its buttons are 48 px, in all ${lines.length} shots.`);
}
