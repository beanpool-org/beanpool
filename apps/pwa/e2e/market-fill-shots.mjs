#!/usr/bin/env node
/**
 * Pictures of the web Market on a community that reads by area, when little is near the member (Damo via Marty,
 * 30 Oct: "Nearby, then fill"), for review:
 *
 *   node e2e/market-fill-shots.mjs <out-dir>
 *
 * 320 px wide at 1.3x text, in light and in dark, three cases: nothing near (the short line, then the newest from
 * elsewhere, no tap), 3 near (those 3, then "Newest from elsewhere" without repeating one), and 8 near (the list as it
 * always was, no section, no second read). Nothing here talks to a node: every /api call is answered by Playwright.
 *
 * It also checks, in the live layout, what the pictures are meant to show: nothing wider than the screen, the heading
 * and the short line where they belong, nothing listed twice, the near ones before the section, and the reads the page
 * made. A non-zero exit means one of those is wrong.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, settle, TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse, IDENTITY } from './fixtures.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/market-fill-shots.mjs <out-dir>');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const HOUR = 60 * 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
const AREA = { lat: -28.5, lng: 153.5 };

const listing = (id, title, over = {}) => ({
    id, title, type: 'offer', category: 'tools', credits: 0, priceType: 'fixed', status: 'active', active: true, repeatable: false,
    description: 'Some words about it, enough to run onto a second line at this width.',
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', authorEnergyCycled: 40, photos: [], createdAt: iso(-3 * HOUR), lat: -28.6, lng: 153.4, ...over,
});
const near = (n) => Array.from({ length: n }, (_, i) => listing(`near-${i}`, `Near ${i}`, { distanceKm: 3 + i, category: ['tools', 'food', 'garden'][i % 3] }));
const far = (n) => Array.from({ length: n }, (_, i) => listing(`far-${i}`, `Far ${i}`, {
    lat: 48.8, lng: 2.3, authorPublicKey: 'member-bo', authorCallsign: 'Bo', category: ['services', 'food', 'tools'][i % 3], createdAt: iso(-(i + 1) * HOUR),
}));

async function open(browser, origin, { dark, nearCount }) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        } catch { /* a picture of the default theme is still a picture */ }
    }, [dark ? 'dark' : 'light']);
    const reads = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        let body;
        if (url.pathname === '/api/community/info') body = GLOBAL;
        else if (url.pathname === '/api/community/me') body = { publicKey: IDENTITY.publicKey, area: AREA };
        else if (url.pathname === '/api/marketplace/posts') {
            const q = url.searchParams;
            // The viewer's own listings, one by id, and the online events (which have no place) are other reads than the feed's.
            if (q.get('author') || q.get('id') || q.get('online')) body = [];
            else {
                reads.push(q.get('lat') != null ? 'near' : 'everywhere');
                body = q.get('lat') != null ? near(nearCount) : far(12);
            }
        } else body = mockResponse(url.pathname, url.search, []);
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.route('**/ws**', (route) => route.abort());
    const page = await context.newPage();
    await page.goto(`${origin}/e2e/harness.html`, { waitUntil: 'load' });
    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
    await page.waitForSelector(nearCount > 0 ? 'text=Near 0' : 'text=Far 0', { timeout: 20_000 });
    await settle(page);
    return { context, page, reads };
}

const server = await startServer();
const browser = await launch();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

try {
    for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';

        // Nothing near: the short line, then the newest from elsewhere.
        {
            const { context, page, reads } = await open(browser, server.origin, { dark, nearCount: 0 });
            const m = await page.evaluate(() => ({
                wide: document.documentElement.scrollWidth,
                line: document.querySelector('[data-testid="market-near-empty"]')?.textContent ?? null,
                fill: document.querySelector('[data-testid="market-fill"]')?.textContent ?? '',
                link: !!document.querySelector('[data-testid="market-see-elsewhere"]'),
            }));
            check(m.wide <= 320, `${theme} 0 near: nothing wider than the screen (${m.wide}px)`);
            check(m.line === 'Nothing within 250 km yet.', `${theme} 0 near: the short line is above the fill`);
            check(/Newest from elsewhere/i.test(m.fill) && m.fill.includes('Far 0'), `${theme} 0 near: the newest from elsewhere are listed`);
            check(!m.link, `${theme} 0 near: no dead-end link to tap`);
            check(reads.filter(r => r === 'everywhere').length >= 1, `${theme} 0 near: elsewhere was read without a tap (${reads.join(',')})`);
            await page.screenshot({ path: path.join(out, `web-0-near-${theme}.png`) });
            await context.close();
        }

        // 3 near: those 3, then the section, nothing twice.
        {
            const { context, page } = await open(browser, server.origin, { dark, nearCount: 3 });
            const m = await page.evaluate(() => {
                const text = document.body.innerText;
                // A title is a leaf whose words are the whole of the listing's title.
                const titles = [...document.querySelectorAll('body *')].filter(e => e.children.length === 0 && /^(Near|Far) \d+$/.test(e.textContent.trim())).map(e => e.textContent.trim());
                const fill = document.querySelector('[data-testid="market-fill"]');
                const top = fill?.getBoundingClientRect().top ?? null;
                return {
                    wide: document.documentElement.scrollWidth, titles, hasFill: !!fill, top: top === null ? null : top + window.scrollY,
                    heading: /Newest from elsewhere/i.test(fill?.textContent ?? ''),
                    nearInFill: /Near \d/.test(fill?.textContent ?? ''), lastNear: text.lastIndexOf('Near 2'), headingAt: text.search(/Newest from elsewhere/i),
                };
            });
            check(m.wide <= 320, `${theme} 3 near: nothing wider than the screen (${m.wide}px)`);
            check(m.hasFill && m.heading, `${theme} 3 near: the section "Newest from elsewhere" is there`);
            check(!m.nearInFill, `${theme} 3 near: no near listing repeated in the section`);
            check(new Set(m.titles).size === m.titles.length, `${theme} 3 near: no listing twice (${m.titles.length} cards)`);
            check(m.lastNear >= 0 && m.lastNear < m.headingAt, `${theme} 3 near: the near ones come before the section`);
            await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 380)), m.top ?? 0);
            await page.waitForTimeout(150);
            await page.screenshot({ path: path.join(out, `web-3-near-${theme}.png`) });
            await context.close();
        }

        // 8 near: nothing changes.
        {
            const { context, page, reads } = await open(browser, server.origin, { dark, nearCount: 8 });
            const m = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth, fill: !!document.querySelector('[data-testid="market-fill"]'), far: /Far \d/.test(document.body.innerText) }));
            check(m.wide <= 320, `${theme} 8 near: nothing wider than the screen (${m.wide}px)`);
            check(!m.fill && !m.far, `${theme} 8 near: no section and nothing from elsewhere`);
            check(!reads.includes('everywhere'), `${theme} 8 near: elsewhere was not read (${reads.join(',')})`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(failures === 0 ? 'the web Market fills as designed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
