#!/usr/bin/env node
/**
 * Pictures of the web Market in the new order (market order S2: DESIGN-market-order-fable.md; core market-order), for review:
 *
 *   node e2e/market-order-shots.mjs <out-dir>
 *
 * 320 px wide at 1.3x text, light and dark, two cases:
 *   - a local community in the list view: the calendar-day headings (23:59 last night is Yesterday though it is under 24 h
 *     ago), the event posted six weeks ago back under Today (it is read beside the listings, as type=event), and one
 *     person's third post of the day after everyone else's;
 *   - the worldwide community: the line "Newest within 250 km of your area." with Show everywhere, the newest first, each
 *     card with its distance, and the node asked for sort=recent.
 * The clock is fixed at 15:00 local on 3 Nov 2026. Nothing here talks to a node: every /api call is answered by Playwright.
 *
 * It checks, in the live layout, what the pictures are meant to show: nothing wider than the screen, the headings and cards
 * in order, the line's words, the reads the page made. A non-zero exit means one of those is wrong.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, settle, TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse, IDENTITY } from './fixtures.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/market-order-shots.mjs <out-dir>');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const NOW = new Date(2026, 10, 3, 15, 0, 0);
const at = (month, day, hour = 12, minute = 0) => new Date(2026, month, day, hour, minute).toISOString();
const GLOBAL = { profile: 'global', features: { beans: false, nearbyListings: { radiusKm: 250, max: 500 } } };
const AREA = { lat: -28.5, lng: 153.5 };

const listing = (id, title, author, createdAt, over = {}) => ({
    id, title, type: 'offer', category: 'tools', credits: 0, priceType: 'fixed', status: 'active', active: true, repeatable: false,
    description: 'Some words about it, enough to run onto a second line at this width.',
    authorPublicKey: `member-${author.toLowerCase()}`, authorCallsign: author, authorEnergyCycled: 40, photos: [],
    createdAt, updatedAt: createdAt, lat: -28.6, lng: 153.4, ...over,
});
const eventPost = (id, title, createdAt, start, over = {}) => ({
    ...listing(id, title, 'Eve', createdAt, { category: 'community' }), type: 'event', credits: 0,
    eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 2 * 3600_000).toISOString(), eventPlaceName: 'Civic hall',
    eventState: 'scheduled', goingCount: 4, interestedCount: 2, myRsvp: null, ...over,
});

// W1 of DESIGN-market-event-cards-fable.md: a PINNED event whose title, place and date are Byron-length, with nobody
// answered yet (its "0 going · 0 interested" line is not drawn), and an event I am Going to (my answer, no buttons).
const PINNED_EVENT = eventPost('ev-pin', 'Byron Bay Twilight Market - Every Saturday', at(10, 2, 9, 0), new Date(2026, 10, 7, 16, 0), {
    eventPlaceName: 'Railway Park, Jonson Street, Byron Bay', goingCount: 0, interestedCount: 0,
    pinnedAt: at(10, 3, 9, 0), pinnedUntil: new Date(2026, 10, 10, 9, 0).toISOString(),
});

const LOCAL = [
    listing('ana-1', 'Bike tune-up', 'Ana', at(10, 3, 14, 0)),
    listing('ana-2', 'Firewood, split', 'Ana', at(10, 3, 13, 30)),
    listing('ana-3', 'Chook manure, bagged', 'Ana', at(10, 3, 13, 0)),
    listing('lee-1', 'Kombucha scoby', 'Lee', at(10, 3, 12, 0), { category: 'food' }),
    listing('sam-1', 'Lift to Lismore', 'Sam', at(10, 2, 23, 59), { type: 'need' }),
    eventPost('ev-1', 'Repair Cafe', at(8, 20, 9, 0), new Date(2026, 10, 4, 10, 0)),
    eventPost('ev-2', 'Garden day', at(9, 30, 9, 0), new Date(2026, 10, 10, 9, 0), { myRsvp: 'going' }),
    PINNED_EVENT,
];
// The node's page is the newest changed: the six-week-old event is not in it, and is read beside it.
const LOCAL_FEED = LOCAL.filter(p => p.id !== 'ev-1');

const GLOBAL_POSTS = [
    listing('g-1', 'Sourdough starter', 'Jo', at(10, 3, 11, 0), { distanceKm: 12, category: 'food' }),
    listing('g-2', 'Surplus pumpkins', 'Mo', at(10, 3, 9, 30), { distanceKm: 31, category: 'food' }),
    listing('g-3', 'Proofread a grant', 'Kit', at(10, 2, 20, 0), { distanceKm: 140, type: 'need', category: 'services' }),
    listing('g-4', 'Spare ladder', 'Bo', at(10, 1, 10, 0), { distanceKm: 3, category: 'tools' }),
];

async function open(browser, origin, { dark, global }) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode, list]) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            if (list) localStorage.setItem('marketplace_view_mode', 'list');
        } catch { /* a picture of the default theme is still a picture */ }
    }, [dark ? 'dark' : 'light', true]);
    const reads = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const q = url.searchParams;
        let body;
        if (global && url.pathname === '/api/community/info') body = GLOBAL;
        else if (global && url.pathname === '/api/community/me') body = { publicKey: IDENTITY.publicKey, area: AREA };
        else if (url.pathname === '/api/marketplace/posts') {
            if (q.get('author') || q.get('id') || q.get('online')) body = [];
            else {
                reads.push({ type: q.get('type'), sort: q.get('sort'), lat: q.get('lat') });
                body = global ? GLOBAL_POSTS : (q.get('type') === 'event' ? LOCAL.filter(p => p.type === 'event') : LOCAL_FEED);
            }
        } else body = mockResponse(url.pathname, url.search, []);
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.route('**/ws**', (route) => route.abort());
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(`${origin}/e2e/harness.html`, { waitUntil: 'load' });
    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
    await page.waitForSelector(global ? 'text=Sourdough starter' : 'text=Bike tune-up', { timeout: 20_000 });
    await settle(page);
    return { context, page, reads };
}

/** The headings and the card titles in page order (a heading is the small uppercase tracking-widest span). */
const sequence = (page, titles) => page.evaluate((known) => {
    const out = [];
    for (const e of document.querySelectorAll('body *')) {
        if (e.children.length !== 0) continue;
        const text = e.textContent.trim();
        if (e.matches('span.tracking-widest') || known.includes(text)) out.push(text);
    }
    return out;
}, titles);

const server = await startServer();
const browser = await launch();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

try {
    for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';

        {
            const { context, page, reads } = await open(browser, server.origin, { dark, global: false });
            const seq = await sequence(page, LOCAL.map(p => p.title));
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= 320, `${theme} local: nothing wider than the screen (${wide}px)`);
            check(JSON.stringify(seq) === JSON.stringify([
                'Pinned', PINNED_EVENT.title,
                'Today', 'Bike tune-up', 'Firewood, split', 'Kombucha scoby', 'Repair Cafe', 'Chook manure, bagged',
                'Yesterday', 'Lift to Lismore', 'This Week', 'Garden day',
            ]), `${theme} local: the pinned event first, calendar days, the old event back under Today, the third of the day last (${seq.join(' | ')})`);
            check(reads.some(r => r.type === 'event'), `${theme} local: the events were read beside the listings`);
            // W1 (DESIGN-market-event-cards-fable.md): the card is one button; the pin is a chip above the date, not in its row;
            // my answer is text; "0 going · 0 interested" is not drawn; the counts are, once someone has answered.
            const ev = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="event-card"]')).map((card) => {
                const when = card.querySelector('[data-testid="event-when"]');
                const row = when?.parentElement;
                const pin = card.querySelector('[data-testid="event-pinned-chip"]');
                const type = card.querySelector('[data-testid="event-type-chip"]');
                // `event-when` is display: contents (it has no box), so its row is what is measured.
                const lineBoxes = (el) => (el ? new Set(Array.from(el.querySelectorAll('span')).map(s => Math.round(s.getBoundingClientRect().top))).size : 0);
                return {
                    title: card.querySelector('button')?.getAttribute('aria-label') ?? '',
                    buttons: card.querySelectorAll('button').length,
                    rsvpRow: !!card.querySelector('[data-testid="event-rsvp-row"]'),
                    answer: card.querySelector('[data-testid="event-my-answer"]')?.textContent ?? null,
                    counts: card.querySelector('[data-testid="event-counts"]')?.textContent ?? null,
                    zeroLine: /\b0 going/.test(card.textContent),
                    typeChip: type?.textContent ?? null,
                    pinInDate: !!(pin && row?.contains(pin)),
                    pinAboveDate: !!(pin && row && pin.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 1),
                    dateLines: lineBoxes(row),
                    wide: card.getBoundingClientRect().width,
                    over: card.scrollWidth > card.clientWidth + 1,
                };
            }));
            check(ev.length === 3 && ev.every(e => e.buttons === 1 && !e.rsvpRow), `${theme} local: ${ev.length} event cards, each with one button (the one that opens it) and no Going / Interested row`);
            check(ev.every(e => e.typeChip === 'EVENT'), `${theme} local: every event card leads with the EVENT chip`);
            const pinnedCard = ev.find(e => e.title.includes(PINNED_EVENT.title));
            check(!!pinnedCard && pinnedCard.pinAboveDate && !pinnedCard.pinInDate, `${theme} local: the PINNED chip is above the date, not in its row (${JSON.stringify(pinnedCard)})`);
            check(!!pinnedCard && !pinnedCard.zeroLine && pinnedCard.counts === null, `${theme} local: nobody has answered, so no "0 going · 0 interested"`);
            const goingCard = ev.find(e => e.title.includes('Garden day'));
            check(goingCard?.answer === 'Going ✓' && goingCard.counts === null, `${theme} local: Garden day shows my answer "Going ✓" as text (${goingCard?.answer})`);
            const repairCard = ev.find(e => e.title.includes('Repair Cafe'));
            check(repairCard?.counts?.includes('4 going · 2 interested') && repairCard.answer === null, `${theme} local: Repair Cafe shows its counts (${repairCard?.counts})`);
            check(ev.every(e => e.wide <= 320 && !e.over), `${theme} local: no event card is wider than the screen or overflows itself`);
            // Pictures of the list: from the Pinned heading (the pinned event), the Today heading (the events with counts), the
            // Yesterday heading, and This Week (the event I am Going to); the last two are below the first screen.
            for (const [name, heading] of [['a-pinned', 'Pinned'], ['b-today', 'Today'], ['c-yesterday', 'Yesterday'], ['d-this-week', 'This Week']]) {
                await page.evaluate((h) => {
                    const el = [...document.querySelectorAll('span.tracking-widest')].find(e => e.textContent.trim() === h);
                    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 12);
                }, heading);
                await page.waitForTimeout(150);
                await page.screenshot({ path: path.join(out, `web-local-list-${name}-${theme}.png`) });
            }
            await context.close();
        }

        {
            const { context, page, reads } = await open(browser, server.origin, { dark, global: true });
            const m = await page.evaluate(() => ({
                wide: document.documentElement.scrollWidth,
                line: document.querySelector('[data-testid="market-near-line"]')?.textContent ?? null,
            }));
            const seq = await sequence(page, GLOBAL_POSTS.map(p => p.title));
            check(m.wide <= 320, `${theme} global: nothing wider than the screen (${m.wide}px)`);
            check(m.line?.startsWith('Newest within 250 km of your area.') && /Show everywhere/.test(m.line), `${theme} global: the line (${m.line})`);
            check(JSON.stringify(seq) === JSON.stringify(['Today', 'Sourdough starter', 'Surplus pumpkins', 'Yesterday', 'Proofread a grant', 'This Week', 'Spare ladder']),
                `${theme} global: newest first, not nearest (${seq.join(' | ')})`);
            check(reads.some(r => r.lat != null && r.sort === 'recent') && !reads.some(r => r.sort === 'distance'), `${theme} global: the node was asked for sort=recent`);
            await page.screenshot({ path: path.join(out, `web-global-line-${theme}.png`) });
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(failures === 0 ? 'the web Market orders as designed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
