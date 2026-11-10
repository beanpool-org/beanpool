/* eslint-disable no-undef */
// (home-look-s2) Home's cards coloured by what they are about, and the dot before a card is on Home, on the web in a real
// browser: node apps/pwa/e2e/home-look-s2-shots.mjs [--out <dir>]
//
// The real HomePage (e2e/home-pack-harness.tsx), every /api call answered here, nothing leaves the machine. Saved searches
// carry a category (as searchFromMarket makes them) and chats carry a kind; the bands are read back from the live page and
// must carry the category's hue. At 320 px wide with text at 1.3x and at 1280 px, light and dark: Home, Arrange and the
// Add a card dialog. In the dialog every row's dot is 10 px, and a name keeps at least 140 px beside it at 320 px.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'home-look-s2'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 240 s, not finished.'); process.exit(2); }, 240_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const SEARCHES = [
    ['search-k7mq', 'seedlings', 'garden', 'lime'],
    ['search-m4p9', 'duck eggs', 'food', 'orange'],
    ['search-r8t2', 'spare room', 'housing', 'clay'],
    ['search-w3v6', 'phone repair', 'tech', 'sky'],
    ['search-z5c1', 'bicycles', undefined, 'orange'],
];
const CARDS = [
    { id: 'market', type: 'market' }, { id: 'events', type: 'events' },
    ...SEARCHES.map(([id, q, category]) => ({ id, type: 'search', settings: { q, kind: 'offer', ...(category ? { category } : {}) } })),
];
const NOW = Date.now();
const answer = () => ({
    generatedAt: new Date(NOW).toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: CARDS, dismissed: {}, updatedAt: null },
    cards: {
        events: { items: [{ id: 'e0', title: 'Seed swap', startsAt: new Date(NOW + 86_400_000).toISOString(), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null },
        market: { items: [{ id: 'p0', type: 'offer', title: 'Pottery lessons', category: 'arts', price_c: 1000, photoUrl: null }], total14d: 1, more: false },
        community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
    },
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/home-pack-harness.html`;
const browser = await chromium.launch();

async function open({ width, dark, textScale }) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
    }, [dark ? 'dark' : 'light']);
    await context.route('**/api/**', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/api/home') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"look-1"' }, body: JSON.stringify(answer()) }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await page.goto(base, { waitUntil: 'load' });
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await page.waitForSelector('[data-testid="home-card-community"]', { timeout: 60_000 });
    await settle(page);
    return { context, page };
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
const shot = async (page, name) => {
    const size = page.viewportSize();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height: Math.min(height, 2600) });
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    await page.setViewportSize(size);
};

try {
    for (const [width, textScale, size] of [[320, 1.3, '320'], [1280, 1, 'desktop']]) {
        for (const dark of [false, true]) {
            const theme = dark ? 'dark' : 'light';
            const { context, page } = await open({ width, dark, textScale });
            const label = `${size}-${theme}`;
            // Home: each saved search's band carries its category's hue (from the live page).
            for (const [id, , , hue] of SEARCHES) {
                const band = await page.getByTestId(`card-band-${id}`).evaluate((el) => ({ bg: el.style.backgroundColor, ink: el.style.color }));
                check(band.bg === `var(--bp-card-${hue}-tint)` && band.ink === `var(--bp-card-${hue}-ink)`, `${label}: ${id} band is ${hue}`);
            }
            check(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), `${label}: Home does not scroll sideways`);
            await shot(page, `home-${label}`);
            // The picker: a dot in each row's hue before the name.
            await page.getByTestId('home-add-open').scrollIntoViewIfNeeded();
            await page.getByTestId('home-add-open').click();
            await page.getByTestId('home-add-dialog').waitFor();
            await settle(page);
            const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="home-add-row-"]')).map((row) => {
                const dot = row.querySelector('[data-testid^="home-add-dot-"]');
                const d = dot.getBoundingClientRect();
                const name = dot.nextElementSibling.getBoundingClientRect();
                const text = dot.parentElement.getBoundingClientRect();
                return { id: row.getAttribute('data-testid'), w: d.width, h: d.height, hidden: dot.getAttribute('aria-hidden'), bg: getComputedStyle(dot).backgroundColor, nameRoom: text.right - name.left, nameWidth: name.width, past: row.getBoundingClientRect().right > innerWidth + 0.5 };
            }));
            check(rows.length >= 10, `${label}: ${rows.length} picker rows`);
            check(rows.every((r) => r.w === 10 && r.h === 10 && r.hidden === 'true' && r.bg !== 'rgba(0, 0, 0, 0)'), `${label}: every row has a 10 px dot, hidden from a screen reader, filled`);
            check(rows.every((r) => !r.past), `${label}: no row runs past the window`);
            if (width === 320) check(rows.every((r) => r.nameRoom >= 140), `${label}: every name keeps at least 140 px beside its dot (least ${Math.round(Math.min(...rows.map((r) => r.nameRoom)))} px)`);
            await page.screenshot({ path: path.join(OUT_DIR, `picker-${label}.png`) });
            await page.keyboard.press('Escape');
            await page.getByTestId('home-add-dialog').waitFor({ state: 'detached' }).catch(() => {});
            // Arrange: the same hue on the folded bands.
            await page.getByTestId('home-arrange-open').scrollIntoViewIfNeeded();
            await page.getByTestId('home-arrange-open').click();
            await page.getByTestId('home-arrange-bar').waitFor();
            await settle(page);
            const folded = await page.getByTestId('card-band-search-k7mq').evaluate((el) => el.style.backgroundColor);
            check(folded === 'var(--bp-card-lime-tint)', `${label}: Arrange keeps the garden search lime`);
            await shot(page, `arrange-${label}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
