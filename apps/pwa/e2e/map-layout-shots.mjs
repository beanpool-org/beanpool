/* global process, console, document, getComputedStyle, window */
/**
 * The web map's pin card, Calendar panel and chip rows never cover each other, at every width (web-map-layout; Marty, 3 Nov:
 * "if you have a card up and you click calendar they impact", "same with offers", "cuts off the all events when at mobile size").
 * The real MapPage under the real header (e2e/map-type-filter-harness.tsx) in headless Chromium, at 320 px with text at 130%,
 * 600, 768, 900 and 1280, light and dark.
 *
 * Fails (exit 1) when, at any step:
 *   CARD   - with the Calendar open and an event's or an offer's card opened (pin tapped), the card's box meets the panel's box;
 *            the card is not whole on the screen; one of its buttons has something else over it at its centre; from md up the card
 *            is not at the LEFT of the map (it is centred); on a phone it is narrower than the screen allows. Where the map
 *            is too narrow for a card beside the panel (a phone; a tablet with the side bar) the panel must have closed instead.
 *   CHIPS  - a chip row (the type row; the date row under Events) overflows its box and shows no "›" hint, or shows the hint
 *            while it fits, or keeps the hint at the end of its scroll; or a chip cannot be scrolled to.
 *
 * Run from apps/pwa: node e2e/map-layout-shots.mjs   (MAP_LAYOUT_SHOTS_DIR=<dir>; default e2e/screenshots/web-map-layout,
 * gitignored). Nothing here talks to a node: every request off this machine is aborted and every /api request is answered here.
 * MAP_LAYOUT_EXPECT_RED=1 inverts the exit code (for proving the checks fail on code without the change).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.MAP_LAYOUT_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'web-map-layout');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const base = { description: '', price_c: 500, priceType: 'fixed', authorCallsign: 'Bea', createdAt: iso(-5 * HOUR), active: true, status: 'active', repeatable: true, photos: [] };
const at = (n) => ({ lat: -28.64 - n * 0.006, lng: 153.5 + n * 0.008 });
const POSTS = [
    { ...base, id: 'p1', type: 'offer', category: 'food', title: 'A dozen eggs', authorPublicKey: 'pk-bea', ...at(1) },
    { ...base, id: 'p2', type: 'offer', category: 'tools', title: 'Ladder to lend', authorPublicKey: 'pk-bea', ...at(3) },
    { ...base, id: 'p3', type: 'need', category: 'food', title: 'A lift to the market', authorPublicKey: 'pk-cal', ...at(5) },
    { ...base, id: 'e1', type: 'event', category: 'community', title: 'Repair café', authorPublicKey: 'pk-hazel', price_c: 0, repeatable: false,
      eventStartAt: iso(2 * HOUR), eventState: 'scheduled', goingCount: 2, interestedCount: 1, myRsvp: null, ...at(2) },
    { ...base, id: 'e2', type: 'event', category: 'community', title: 'Working bee', authorPublicKey: 'pk-hazel', price_c: 0, repeatable: false,
      eventStartAt: iso(20 * 24 * HOUR), eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null, ...at(6) },
];

function answer(pathname, search) {
    const params = new URLSearchParams(search);
    if (pathname === '/api/marketplace/posts') {
        const types = (params.get('types') || 'offer,need').split(',');
        return POSTS.filter(p => types.includes(p.type));
    }
    if (pathname === '/api/enterprises/map') return { enterprises: [] };
    if (pathname === '/api/enterprises/statuses') return { enterprises: [] };
    if (pathname === '/api/treasuries') return { treasuries: [] };
    if (pathname === '/api/groups') return [];
    if (pathname === '/api/activity/feed') return { feed: [] };
    if (pathname === '/api/community/members') return [];
    if (pathname === '/api/events/mine') return [];
    if (pathname === '/api/node/config') return { readAuthRequired: false };
    if (pathname === '/api/node/info') return { callsign: 'Harness', peerNodes: [] };
    if (pathname === '/api/federation/peers/reachable') return { peers: [] };
    if (pathname.startsWith('/api/ledger/balance')) return { balance_c: 24000, isBlockedFromTrading: false };
    return undefined;
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

/** In the page: the card against the panel, as laid out now. `expect` says which of the two outcomes the width allows. */
const measureCard = () => {
    const r = (e) => e.getBoundingClientRect();
    const problems = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const wrap = document.querySelector('[data-testid="map-preview-card"]');
    const panel = document.querySelector('[data-testid="map-calendar"]');
    const info = { vw, card: null, panel: panel ? r(panel).toJSON() : null };
    if (!wrap) return { problems: ['no pin card opened'], ...info };
    const card = wrap.firstElementChild;
    const c = r(card);
    info.card = c.toJSON();
    if (c.left < -0.5 || c.right > vw + 0.5 || c.top < -0.5 || c.bottom > vh + 0.5) problems.push(`the card is not whole on the screen (${c.left.toFixed(0)}..${c.right.toFixed(0)} x ${c.top.toFixed(0)}..${c.bottom.toFixed(0)} of ${vw}x${vh})`);
    if (panel) {
        const p = r(panel);
        if (!(c.right <= p.left + 0.5 || c.left >= p.right - 0.5 || c.bottom <= p.top + 0.5 || c.top >= p.bottom - 0.5)) problems.push(`the card (${c.left.toFixed(0)}..${c.right.toFixed(0)}) meets the Calendar panel (${p.left.toFixed(0)}..${p.right.toFixed(0)})`);
    }
    // The locate / zoom pill stands at the map's left edge too: from md up it gives way to the card, and it is never under it.
    const locate = document.querySelector('button[aria-label="My location"]');
    // (On a phone the card keeps what it had: it lies over the pill there, as before this change.)
    if (vw >= 768 && locate && locate.offsetParent !== null) {
        const l = r(locate);
        if (!(c.right <= l.left || c.left >= l.right || c.bottom <= l.top || c.top >= l.bottom)) problems.push('the card is over the locate / zoom pill');
    }
    const mapBox = r(wrap);
    if (vw >= 768) {
        // Left-justified: against the map's left edge (the card's own margin, up to 1rem), not centred.
        if (c.left - mapBox.left > 24) problems.push(`the card is not at the left of the map (it starts ${(c.left - mapBox.left).toFixed(0)} px in)`);
    } else {
        // A phone keeps the width it has: the screen less its margins (0.75 to 1rem a side), up to the card's 28rem.
        const room = Math.min(448, vw - 2 * 1.0 * parseFloat(getComputedStyle(document.documentElement).fontSize));
        if (c.width < room - 1) problems.push(`the card is narrower than the screen allows (${c.width.toFixed(0)}, the screen allows ${room.toFixed(0)})`);
    }
    for (const b of card.querySelectorAll('button')) {
        const bb = r(b);
        if (bb.width === 0) continue;
        const cx = bb.left + bb.width / 2, cy = bb.top + bb.height / 2;
        if (cx < 0 || cx > vw || cy < 0 || cy > vh) { problems.push(`a card button ("${b.textContent.trim() || b.getAttribute('aria-label')}") is off the screen`); continue; }
        const top = document.elementFromPoint(cx, cy);
        if (top && !b.contains(top) && !top.contains(b)) problems.push(`a card button ("${b.textContent.trim() || b.getAttribute('aria-label')}") has ${top.tagName.toLowerCase()}[${top.getAttribute('data-testid') || ''}] over it`);
    }
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    return { problems, ...info };
};

/** In the page: each chip row either fits with no hint, or overflows WITH the hint; the hint goes at the end of the scroll. */
const measureRows = () => {
    const r = (e) => e.getBoundingClientRect();
    const problems = [];
    const rows = [];
    for (const row of document.querySelectorAll('[data-testid="map-filter-row"], [data-testid="event-window-chips"]')) {
        const id = row.getAttribute('data-testid');
        const hint = () => row.parentElement.querySelector('[data-testid="map-more-hint"]');
        const overflows = row.scrollWidth > row.clientWidth + 4;
        const more = row.scrollWidth - row.scrollLeft - row.clientWidth > 4; // chips lie past the right edge now
        const had = !!hint();
        const rowBox = r(row);
        const vw = document.documentElement.clientWidth;
        if (rowBox.right > vw + 1) problems.push(`${id}: the row runs past the screen (${rowBox.right.toFixed(0)} > ${vw})`);
        if (more && !had) problems.push(`${id}: ${row.scrollWidth} px of chips in ${row.clientWidth} px (scrolled ${Math.round(row.scrollLeft)}) and no › hint`);
        if (!more && had) problems.push(`${id}: nothing lies past the right edge but a › hint shows`);
        if (overflows && getComputedStyle(row).overflowX !== 'auto' && getComputedStyle(row).overflowX !== 'scroll') problems.push(`${id}: overflows and does not scroll`);
        // A row under the Calendar panel is cut by it, whatever the row thinks: the visible part is what counts.
        const panel = document.querySelector('[data-testid="map-calendar"]');
        if (panel && r(panel).width < vw) {
            const p = r(panel);
            if (rowBox.right > p.left + 0.5 && rowBox.left < p.right) problems.push(`${id}: the row (${rowBox.left.toFixed(0)}..${rowBox.right.toFixed(0)}) runs under the Calendar panel (from ${p.left.toFixed(0)})`);
        }
        rows.push({ id, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, hint: had, overflows, rowEnd: overflows ? { lastRight: r(row.lastElementChild).right, rowRight: r(row).right } : null });
    }
    return { problems, rows };
};
/** Scrolled to its end: the last chip is whole in the row and the hint is gone; then back to the start. */
const scrollRows = (to) => {
    for (const row of document.querySelectorAll('[data-testid="map-filter-row"], [data-testid="event-window-chips"]')) row.scrollLeft = to ? row.scrollWidth : 0;
};
const measureRowsAtEnd = () => {
    const r = (e) => e.getBoundingClientRect();
    const problems = [];
    for (const row of document.querySelectorAll('[data-testid="map-filter-row"], [data-testid="event-window-chips"]')) {
        if (row.scrollWidth <= row.clientWidth + 4) continue;
        const id = row.getAttribute('data-testid');
        const last = r(row.lastElementChild), box = r(row);
        if (last.right > box.right + 1.5) problems.push(`${id}: scrolled to the end, the last chip still runs past the row (${last.right.toFixed(0)} > ${box.right.toFixed(0)})`);
        if (row.parentElement.querySelector('[data-testid="map-more-hint"]')) problems.push(`${id}: scrolled to the end, the › hint is still shown`);
    }
    return { problems };
};

const results = [];
let failed = false;
const VIEWS = [
    { name: '320x1.3', width: 320, height: 640, scale: 1.3 },
    { name: '600', width: 600, height: 800, scale: 1 },
    { name: '768', width: 768, height: 800, scale: 1 },
    { name: '900', width: 900, height: 800, scale: 1 },
    { name: '1280', width: 1280, height: 800, scale: 1 },
];

try {
    for (const view of VIEWS) {
        for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: theme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => {
                try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme */ }
            }, [theme]);
            await context.route('**/*', async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                if (!url.pathname.startsWith('/api/')) return route.continue();
                const body = answer(url.pathname, url.search);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            });
            const page = await context.newPage();
            await page.goto(`${origin}/e2e/map-type-filter-harness.html?dark=${theme === 'dark' ? 1 : 0}`, { waitUntil: 'load' });
            if (view.scale !== 1) await page.addStyleTag({ content: `html { font-size: ${view.scale * 100}% !important; }` });
            await page.waitForSelector('[data-testid="map-filter-bar"]', { timeout: 30_000 });
            await page.waitForSelector('.custom-map-pin', { timeout: 30_000 });
            await page.waitForTimeout(800);

            const record = async (label, m, extra = '') => {
                const file = `${view.name}-${theme}-${label}.png`;
                await page.screenshot({ path: path.join(SHOTS_DIR, file) });
                results.push({ file, ...m });
                for (const p of m.problems) { failed = true; console.error(`FAIL ${file}: ${p}`); }
                console.log(`${m.problems.length ? 'FAIL' : 'ok  '} ${file} ${extra}`);
            };
            const click = (id) => page.getByTestId(id).click();
            // For the card steps: a DOM click, so that a card lying over a control (the fault being tested for) fails the
            // measurement below and not the click.
            const domClick = (id) => page.evaluate((i) => document.querySelector(`[data-testid="${i}"]`)?.click(), id);
            // A pin is tapped by a DOM click on its marker: at a phone's width the panel covers it, which is the point.
            const tapPin = (selector) => page.evaluate((sel) => document.querySelector(sel)?.click(), selector);

            // CHIPS: the type row on its own, then with Events (its date row under it).
            for (const [label, act] of [['chips-all', null], ['chips-events', () => click('map-type-events')]]) {
                if (act) await act();
                await page.waitForTimeout(400);
                const m = await page.evaluate(measureRows);
                await record(label, m, m.rows.map(x => `${x.id}:${x.scrollWidth}/${x.clientWidth}${x.hint ? '+hint' : ''}`).join(' '));
                await page.evaluate(scrollRows, true);
                await page.waitForTimeout(300);
                const end = await page.evaluate(measureRowsAtEnd);
                await page.evaluate(scrollRows, false);
                await page.waitForTimeout(300);
                for (const p of end.problems) { failed = true; console.error(`FAIL ${view.name}-${theme}-${label}: ${p}`); }
                results.push({ file: `${view.name}-${theme}-${label}-end`, ...end });
            }

            // CHIPS under the open Calendar: the rows stop at the panel (from md up) and the panel is not over a chip.
            await click('map-calendar-button');
            await page.waitForSelector('[data-testid="map-calendar"]', { timeout: 10_000 });
            await page.waitForTimeout(500);
            {
                const m = await page.evaluate(measureRows);
                await record('chips-events-calendar', m, m.rows.map(x => `${x.id}:${x.scrollWidth}/${x.clientWidth}${x.hint ? '+hint' : ''}`).join(' '));
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            }

            // CARD: the Calendar open, then an event's card, then (fresh) an offer's.
            await domClick('map-type-all');
            for (const [label, selector, filter] of [['calendar-event-card', '.custom-event-pin', 'map-type-events'], ['calendar-offer-card', '.custom-map-pin', 'map-type-offers']]) {
                await domClick(filter);
                await page.waitForTimeout(500);
                await domClick('map-calendar-button');
                await page.waitForSelector('[data-testid="map-calendar"]', { timeout: 10_000 });
                await page.waitForTimeout(300);
                await tapPin(selector);
                await page.waitForSelector('[data-testid="map-preview-card"]', { timeout: 10_000 });
                await page.waitForTimeout(500);
                const m = await page.evaluate(measureCard);
                // Where a card cannot sit beside the panel, the panel has closed (and so cannot be met); where it can, the panel is still open.
                const panelOpen = !!m.panel;
                await record(label, m, `panel ${panelOpen ? `${Math.round(m.panel.left)}..${Math.round(m.panel.right)}` : 'closed'}  card ${m.card ? `${Math.round(m.card.left)}..${Math.round(m.card.right)}` : '-'}`);
                // Reset: close the card and the panel.
                await page.evaluate(() => document.querySelector('[data-testid="map-preview-card"] button[aria-label="Close preview"], [data-testid="map-preview-card"] button[aria-label="Close"]')?.click());
                if (await page.getByTestId('map-calendar').count()) await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
            }
            // CARD alone (no Calendar): at the left from md up, over nothing.
            await domClick('map-type-all');
            await page.waitForTimeout(400);
            await tapPin('.custom-map-pin');
            await page.waitForSelector('[data-testid="map-preview-card"]', { timeout: 10_000 });
            await page.waitForTimeout(500);
            await record('card-only', await page.evaluate(measureCard));
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
}
const red = process.env.MAP_LAYOUT_EXPECT_RED === '1';
if (failed) { console.error('map-layout-shots: FAILED'); process.exit(red ? 0 : 1); }
console.log(`map-layout-shots: ${results.length} checks, none failing, in ${SHOTS_DIR}`);
process.exit(red ? 1 : 0);
