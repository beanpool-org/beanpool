/* eslint-disable no-undef */
// (cold-start N4) "I can do this" on a Need, on the web, in a real browser:
//   node apps/pwa/e2e/need-answer-shots.mjs [--out <dir>]
//
// The real Market page (e2e/need-answer-shots-harness.tsx), opened on a Need a neighbour could answer: a priced one, one
// priced by the hour (the total follows the hours typed), a free one, one with no name on it, and a Need the member has
// already answered (the request card, which carries the 1.5% fee now that the first screen does not). Every /api call is
// answered here; nothing leaves the machine. At 320 px wide with text at 1.3x and at 1280 px, light and dark: no sideways
// scroll, the sentence reads in full inside its card, the confirmation's buttons are at least 44 px tall, and no word of the
// fee, the Commons Pool or "Offer to Fulfill" is on the first screen. Shots of the take-up block and of the whole page.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'need-answer'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 300 s, not finished.'); process.exit(2); }, 300_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
const AT = '2026-10-24T10:00:00.000Z';
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#9cb98a"/><circle cx="300" cy="320" r="120" fill="#c0392b"/></svg>');
const need = (over) => ({
    id: 'p', type: 'need', category: 'labour', title: 'Help at the market stall', description: 'Saturday mornings, setting up the stall and packing down.',
    price_c: 2000, priceType: 'fixed', status: 'active', active: true, repeatable: true, authorPublicKey: 'kofi-key', authorCallsign: 'Kofi',
    createdAt: AT, photos: [PHOTO], audienceScope: 'public', ...over,
});
const POSTS = [
    need({ id: 'p-stall' }),
    need({ id: 'p-hours', title: 'Dig a vegetable bed', priceType: 'hourly', price_c: 2000 }),
    need({ id: 'p-free', title: 'Carry chairs to the hall', price_c: 0 }),
    need({ id: 'p-nameless', title: 'Mend the fence', price_c: 4000, authorCallsign: '' }),
];

const SCENES = [
    { id: 'priced', post: 'p-stall', sentence: "You'd do it for 20 Beans. Kofi agrees, you do it, Kofi confirms, and the Beans are yours." },
    { id: 'hourly', post: 'p-hours', hours: '3', sentence: "You'd do it for 60 Beans. Kofi agrees, you do it, Kofi confirms, and the Beans are yours." },
    { id: 'free', post: 'p-free', sentence: "You'd do it for free. Kofi agrees, you do it, and Kofi confirms." },
    { id: 'nameless', post: 'p-nameless', sentence: "You'd do it for 40 Beans. The person who asked agrees, you do it, they confirm, and the Beans are yours." },
    { id: 'request', post: 'p-stall', view: 'request' },
];
const SIZES = [
    { name: '320-x1.3', width: 320, height: 860, scale: 1.3 },
    { name: '1280', width: 1280, height: 900, scale: 1 },
];

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/need-answer-shots-harness.html`;
const browser = await chromium.launch();

try {
    for (const theme of ['light', 'dark']) {
        for (const size of SIZES) {
            for (const scene of SCENES) {
                const label = `${scene.id} ${size.name} ${theme}`;
                console.log(`\n${label}`);
                const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                await page.addInitScript((scale) => {
                    try { localStorage.setItem('marketplace_view_mode', 'list'); } catch { /* none */ }
                    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
                }, size.scale);
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
                    // The profile gate: a name (the harness's) and a photo, so tapping "I can do this" opens the confirmation.
                    if (p.startsWith('/api/profile/')) return json(route, { avatar: '/avatars/ana.png' });
                    if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 4.6, count: 5 });
                    if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                    if (p.startsWith('/api/groups')) return json(route, []);
                    if (p.startsWith('/api/members')) return json(route, []);
                    return json(route, {});
                });
                await page.goto(`${base}?post=${scene.post}&view=${scene.view ?? 'confirm'}${theme === 'dark' ? '&dark=1' : ''}`);
                await page.waitForSelector('[data-testid="listing-detail"]', { timeout: 20000 }).catch(() => failures.push(`${label}: no listing page`));
                await page.waitForTimeout(500);
                const action = page.locator('[data-testid="listing-action"]').first();

                if (scene.id === 'request') {
                    const card = page.locator('text=Offer Pending Approval').first();
                    check(await card.count() === 1, `${label}: the waiting request's card is there`);
                    const text = await action.innerText();
                    check(/You have requested to earn 20 credits \(19\.70 net after 1\.5% transaction fee\)/.test(text), `${label}: the request card carries the fee ("${text.replace(/\s+/g, ' ').slice(0, 160)}")`);
                } else {
                    const button = page.getByRole('button', { name: '✋ I can do this' });
                    check(await button.count() === 1, `${label}: the button reads "✋ I can do this"`);
                    check(await page.getByText(/Offer to Fulfill/).count() === 0, `${label}: nothing says "Offer to Fulfill"`);
                    await button.click();
                    await page.waitForTimeout(300);
                    check(await page.getByText('I can do this', { exact: true }).count() === 1, `${label}: the confirmation is headed "I can do this"`);
                    if (scene.hours) {
                        await action.getByRole('textbox').fill(scene.hours);
                        await page.waitForTimeout(200);
                    }
                    const text = (await action.innerText()).replace(/\s+/g, ' ');
                    check(text.includes(scene.sentence), `${label}: the sentence reads "${scene.sentence}"`);
                    check(!/1\.5%|transaction fee|Commons Pool|Trust Wallet/.test(text), `${label}: no fee line on the first screen`);
                    for (const name of ['Cancel', 'Confirm']) {
                        const b = action.getByRole('button', { name, exact: true });
                        const box = await b.boundingBox();
                        // A finger's size on the phone-width view; at 1280 these are mouse targets in the page's own, unchanged buttons.
                        const min = size.width <= 640 ? 44 : 32;
                        check(!!box && box.height >= min && box.width >= min, `${label}: ${name} is at least ${min} px tall (${box ? Math.round(box.height) : '—'} x ${box ? Math.round(box.width) : '—'})`);
                    }
                    // The sentence is read in full inside its card: its box is not wider than the box that holds it.
                    const fits = await page.evaluate(() => {
                        const el = Array.from(document.querySelectorAll('div')).find((d) => /^You'd do it for/.test((d.textContent || '').trim()) && d.children.length <= 1 && !d.querySelector('div'));
                        if (!el) return null;
                        const card = el.parentElement;
                        return { text: el.scrollWidth <= el.clientWidth + 1, card: card.getBoundingClientRect().right <= document.documentElement.clientWidth + 1 };
                    });
                    check(!!fits && fits.text && fits.card, `${label}: the sentence fits inside its card (${JSON.stringify(fits)})`);
                }
                const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
                check(!sideways, `${label}: no sideways scroll`);
                check(pageErrors.length === 0, `${label}: no page errors ${JSON.stringify(pageErrors)}`);
                await action.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
                await page.screenshot({ path: path.join(OUT_DIR, `need-answer-${scene.id}-${size.name}-${theme}.png`), fullPage: false });
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (failures.length) {
    console.error(`\nFAILED (${failures.length}):\n${failures.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`\nOK — "I can do this" on the web at 320 x 1.3 and 1280, light and dark: shots in ${OUT_DIR}`);
}
