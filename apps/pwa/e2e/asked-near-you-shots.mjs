/* eslint-disable no-undef */
// (cold-start N2) "Asked near you" and First steps' line "Ask for one thing you'd pay a neighbour for" on the web, in a real
// browser: node apps/pwa/e2e/asked-near-you-shots.mjs [--out <dir>]
//
// The real HomePage (e2e/home-pack-harness.tsx), every /api call answered here, nothing leaves the machine. At 320 px wide with
// text at 1.3x and at 1280 px, light and dark: the two cards are read back from the live page and must not run sideways, every
// row and the step line must be at least 44 px tall, and no row's words may be cut (a title wraps whole). Shots of the two cards.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'asked-near-you'));
fs.mkdirSync(OUT_DIR, { recursive: true });
setTimeout(() => { console.error('\nStopped after 240 s, not finished.'); process.exit(2); }, 240_000).unref();

const failures = [];
const check = (ok, what) => { if (ok) console.log(`  ok ${what}`); else { failures.push(what); console.error(`  x ${what}`); } };

const NOW = Date.now();
const H = 3_600_000;
const ago = (h) => new Date(NOW - h * H).toISOString();
const answer = () => ({
    generatedAt: new Date(NOW).toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    me: { joinedAt: new Date(NOW - 3 * 24 * H).toISOString(), isKeeper: false, probation: null, interests: ['labour'], area: null, firstOffer: true, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: ['steps', 'market', 'asked', 'events'].map((t) => ({ id: t, type: t })), dismissed: {}, updatedAt: null },
    cards: {
        steps: { joinedAt: new Date(NOW - 3 * 24 * H).toISOString(), firstOffer: true, firstNeed: false, firstPost: true, photo: true, interests: true, invited: false, area: false, knocked: null },
        events: { items: [{ id: 'e0', title: 'Seed swap', startsAt: new Date(NOW + 86_400_000).toISOString(), endsAt: null, place: 'Town Hall', rsvp: null }], radiusKm: null },
        market: { items: [{ id: 'p0', type: 'offer', title: 'Pottery lessons', category: 'arts', price_c: 1000, photoUrl: null }], total14d: 1, more: false },
        asked: { items: [
            { id: 'n1', title: 'Borrow a trailer Saturday', category: 'tools', price_c: 2000, priceType: 'hourly', createdAt: ago(2), photoUrl: null },
            { id: 'n2', title: 'Someone to dig a bed, and a long title that has to wrap whole on a phone', category: 'labour', price_c: 30000, priceType: 'monthly', createdAt: ago(26), photoUrl: null },
            { id: 'n3', title: 'Lift to Lismore Thursday', category: 'transport', price_c: 0, createdAt: ago(72), photoUrl: null },
        ] },
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
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"asked-1"' }, body: JSON.stringify(answer()) }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (e) => failures.push(`page error: ${e}`));
    await page.goto(base, { waitUntil: 'load' });
    if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }` });
    await page.waitForSelector('[data-testid="home-card-asked"]', { timeout: 60_000 });
    await settle(page);
    return { context, page };
}
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));

try {
    for (const [width, textScale, size] of [[320, 1.3, '320'], [1280, 1, 'desktop']]) {
        for (const dark of [false, true]) {
            const label = `${size}-${dark ? 'dark' : 'light'}`;
            const { context, page } = await open({ width, dark, textScale });
            check(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), `${label}: Home does not scroll sideways`);
            // The card: after the Market, three rows, each a button of at least 44 px, whole words, nothing past the card.
            const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="home-card-"]')).map((e) => e.getAttribute('data-testid').replace('home-card-', '')).filter((id) => id !== 'menu'));
            check(order.indexOf('asked') === order.indexOf('market') + 1, `${label}: Asked near you comes right after the Market (${order.join(', ')})`);
            const rows = await page.evaluate(() => {
                const card = document.querySelector('[data-testid="home-card-asked"]').getBoundingClientRect();
                return Array.from(document.querySelectorAll('[data-testid="home-asked-item"]')).map((row) => {
                    const r = row.getBoundingClientRect();
                    const words = Array.from(row.querySelectorAll('span')).filter((s) => s.children.length === 0 && s.textContent.trim());
                    return {
                        text: row.textContent.trim(), h: Math.round(r.height), isButton: row.tagName === 'BUTTON', inside: r.left >= card.left - 0.5 && r.right <= card.right + 0.5,
                        cut: words.some((s) => s.scrollWidth > s.clientWidth + 1),
                    };
                });
            });
            check(rows.length === 3, `${label}: three rows`);
            check(rows.every((r) => r.isButton && r.h >= 44), `${label}: every row is a button of at least 44 px (least ${Math.min(...rows.map((r) => r.h))} px)`);
            check(rows.every((r) => r.inside && !r.cut), `${label}: every row stays inside the card and no words are cut`);
            // The member's star (labour) puts the dig-a-bed Need first; the node's order holds inside each part.
            const line = (title) => rows.find((r) => r.text.includes(title))?.text ?? '';
            check(rows[0].text.includes('Someone to dig a bed') && /300 Beans \/mo · 1d ago/.test(rows[0].text), `${label}: the starred Need leads, "300 Beans /mo · 1d ago"`);
            check(/20 Beans \/hr · 2h ago/.test(line('trailer')) && /Free · 3d ago/.test(line('Lismore')), `${label}: the price lines read "20 Beans /hr · 2h ago" and "Free · 3d ago"`);
            const more = await page.getByTestId('home-asked-all').boundingBox();
            check(!!more && more.height >= 44, `${label}: See all Needs is at least 44 px tall (${Math.round(more?.height ?? 0)} px)`);
            const step = await page.getByRole('button', { name: "To do: Ask for one thing you'd pay a neighbour for" }).boundingBox();
            check(!!step && step.height >= 44, `${label}: the First steps line is at least 44 px tall (${Math.round(step?.height ?? 0)} px)`);
            await page.getByTestId('home-card-steps').screenshot({ path: path.join(OUT_DIR, `steps-${label}.png`) });
            await page.getByTestId('home-card-asked').screenshot({ path: path.join(OUT_DIR, `asked-${label}.png`) });
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`\n${failures.length} problem(s)`); process.exit(1); }
console.log(`\nShots in ${OUT_DIR}`);
