/* eslint-disable no-undef */
/**
 * Calendar doors on the web (DESIGN-map-calendar-fable.md §8 S4), on the REAL pages, at the floor (320 px wide, text at
 * 130%), in light and dark: node apps/pwa/e2e/calendar-doors-320.mjs [--shots <dir>]
 *   1. Home's "Coming up" card: "Calendar ›" and "All events ›" (the real HomePage)
 *   2. The Market on its Events pill: the calendar button at the end of the chip row (the real MarketplacePage)
 *
 * The real HomePage and MarketplacePage with the real stylesheet (e2e/calendar-doors-harness.tsx); every /api call is
 * answered here and nothing leaves the machine. Checks: no sideways scroll on the page; each door's box is read from the
 * live layout (at least 44 px tall, the button 44 px wide) and a door at the end of the chip row is reached by scrolling the
 * row, so its place is reported; pressing each door asks the app for the right place (map-calendar; marketplace + events).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;
const HEIGHT = 568;
const SCALE = 1.3;

const LIMIT_S = Number(process.env.CALENDAR_DOORS_LIMIT_S || 240);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const day = 86_400_000;
const homeAnswer = () => ({
    generatedAt: new Date().toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: [{ id: 'events', type: 'events' }], dismissed: {}, updatedAt: null },
    cards: {
        needs: { items: [] },
        events: {
            items: [{ id: 'e0', title: 'Spring Working Bee & Tool Care Workshop', startsAt: new Date(Date.now() + day).toISOString(), endsAt: null, place: 'Community Hall', rsvp: 'going' }],
            radiusKm: null,
        },
    },
});

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/calendar-doors-harness.html`;
const browser = await chromium.launch();
const problems = [];

try {
    for (const scheme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: 'reduce' });
        await context.addInitScript(([mode]) => {
            try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
        }, [scheme]);
        await context.route('**/api/**', async (route) => {
            const url = new URL(route.request().url());
            const body = url.pathname === '/api/home' ? homeAnswer() : mockResponse(url.pathname, url.search);
            if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"doors-1"' }, body: JSON.stringify(body) }).catch(() => {});
        });
        await context.route('**/socket.io/**', (route) => route.abort());
        await context.route('**/ws**', (route) => route.abort());

        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base, { waitUntil: 'load' });
        await page.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
        await page.waitForSelector('[data-testid="home-events-calendar"]', { timeout: 60_000 });
        await page.waitForSelector('[data-testid="home-events-all"]');
        await page.waitForSelector('[data-testid="market-calendar-button"]', { timeout: 60_000 });
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await page.waitForTimeout(350);

        const found = await page.evaluate((width) => {
            const out = [];
            const sideways = document.documentElement.scrollWidth > width;
            if (sideways) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
            const seen = {};
            for (const id of ['home-events-calendar', 'home-events-all', 'market-calendar-button']) {
                const el = document.querySelector(`[data-testid="${id}"]`);
                const r = el.getBoundingClientRect();
                seen[id] = { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
                if (r.height < 43.5) out.push(`${id} height ${r.height.toFixed(1)} < 44px`);
                if (id === 'market-calendar-button' && r.width < 43.5) out.push(`${id} width ${r.width.toFixed(1)} < 44px`);
                if (id.startsWith('home-') && r.right > width + 0.5) out.push(`${id} runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                // Words cut: the link's text must fit inside its own box.
                if (id.startsWith('home-') && el.scrollWidth > el.clientWidth + 1) out.push(`${id} words are cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
            }
            // The chip row scrolls sideways by design; where its last button sits is a fact the PR reports.
            const btn = document.querySelector('[data-testid="market-calendar-button"]');
            const row = btn.closest('[role="group"]');
            seen.chipRow = { rowWidth: Math.round(row.clientWidth), rowScrollWidth: row.scrollWidth, buttonRight: Math.round(btn.getBoundingClientRect().right) };
            return { out, seen };
        }, WIDTH);
        problems.push(...found.out.map((p) => `${scheme}: ${p}`));
        console.log(`${scheme}: ${JSON.stringify(found.seen)}`);

        // Press each door: the app is asked for the right place.
        await page.evaluate(() => { window.__navs.length = 0; });
        await page.click('[data-testid="home-events-calendar"]');
        await page.click('[data-testid="home-events-all"]');
        await page.locator('[data-testid="market-calendar-button"]').scrollIntoViewIfNeeded();
        await page.click('[data-testid="market-calendar-button"]');
        const navs = await page.evaluate(() => window.__navs);
        const want = JSON.stringify([['map-calendar'], ['marketplace', 'events'], ['map-calendar']]);
        if (JSON.stringify(navs) !== want) problems.push(`${scheme}: doors asked for ${JSON.stringify(navs)}, wanted ${want}`);
        if (errors.length) problems.push(`${scheme}: page errors: ${errors.join(' | ')}`);

        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.locator('[data-testid="home-events-calendar"]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(SHOTS, `web-doors-320-${scheme}-home.png`) });
            await page.locator('[data-testid="market-calendar-button"]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(SHOTS, `web-doors-320-${scheme}-market.png`) });
        }
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('web calendar-doors-320: passed');
process.exit(0);
