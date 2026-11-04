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
 * The style box's list card (W2, DESIGN-card-style-box-fable.md §1; DESIGN-market-event-cards-fable.md §3 W2), measured on
 * every listing and event list card, in the local case at 320 px x 1.3 and again at 1280 px beside a 256 px stand-in for
 * the sidebar (`web-local-list-1280-*`): the picture's box starts at the card's left edge (inside its border) and is the
 * card's full height, 80 wide; a photo, once drawn, covers it; the corners are 14, the ground the card token; every chip
 * is the one chip (10/800, 2 x 6, corners 6); the when is the event token and a title the page's ink.
 *
 * #2873: an Elder's listing in the longest category ("📜 Mindset & Philosophy"): every chip ends inside its card (a chip
 * longer than its row ends in an ellipsis), and the Elder's 3 px gold left border holds in dark as in light. The same
 * list again in Malayalam and German (`?lang=`), whose category words are longer still (`web-local-list-c-yesterday-ml-*`).
 *
 * C1 (DESIGN-card-style-box-fable.md §2, the compact rows): the same community in the COMPACT view, with a poll the reader has
 * answered, at 320 px x 1.3 and at 1280 px beside the sidebar (`web-local-compact-*`). Every event and the poll is a compact
 * row like a listing's: one button; no taller than a listing's row and one line; its picture 32 square; its chip the one chip
 * (10/800); the event's when whole; the poll's mark its chosen answer ✓; nothing on the poll's row to vote with.
 *
 * compact-kinds (the review of #2904): the compact view at 320 px x 1.3 in en, fr, de, ru, es and pt, the reader in Brisbane,
 * with an event in person, one online, one read in another clock and one over two days, light and dark
 * (`web-compact-kinds-{de,ru}-*`). Fails when an event row overflows itself, or its EVENT chip or its mark is cut or past the
 * row's content edge, or the start's date and time give way while the end still has room to give, or the row is taller than
 * a listing's row and one line. Run it alone: `node e2e/market-order-shots.mjs <out-dir> compact-kinds`.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, localStorage, getComputedStyle, URL -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, settle, TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse, IDENTITY } from './fixtures.mjs';

const out = process.argv[2];
// An optional case name runs that case alone: `node e2e/market-order-shots.mjs <out-dir> compact-kinds`.
const only = process.argv[3] ?? null;
const CASES = ['local', 'lang', 'compact', 'local-1280', 'global', 'compact-kinds'];
if (!out || (only && !CASES.includes(only))) {
    console.error(`usage: node e2e/market-order-shots.mjs <out-dir> [${CASES.join('|')}]`);
    process.exit(2);
}
const run = (name) => !only || only === name;
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

const ELDER_TITLE = 'Meditation circle';

// C1, the compact view only: the reader's answer on Repair Cafe, and the pinned event theirs to host (the node sends a host
// the RSVP list), so the rows carry the longest marks.
const COMPACT_MARKS = { 'ev-1': { myRsvp: 'interested' }, 'ev-pin': { eventRsvps: [] } };

// C1: a poll the reader has answered, for the compact view only (the list view's checks count its cards without one).
const POLL = {
    ...listing('poll-1', 'What would make trading here easier for you?', 'Ana', at(10, 3, 10, 0), { category: 'community' }), type: 'poll',
    description: 'Tell us what to build next.', userVotedOptionId: 'a', pollOpenVote: false, totalVotes: 5,
    pollOptions: [{ id: 'a', text: 'Better matches between offers and needs', votes: 3, percentage: 60 }, { id: 'b', text: 'More events', votes: 2, percentage: 40 }],
    pollClosesAt: new Date(2026, 10, 14, 16, 0).toISOString(),
};

// C1, the compact view in six languages (the review of #2904): an event of each kind the row's when reads differently, the
// reader in Brisbane (UTC+10) and every clock given in UTC, so the case reads the same on any machine. Each carries a mark,
// so the row's end holds the mark above EVENT, and the end is what a too-wide when pushed out of the row.
const KINDS_ZONE = 'Australia/Brisbane';
const kind = (id, title, startAt, endAt, startLocal, endLocal, tz, over = {}) => eventPost(id, title, at(10, 1, 9, 0), new Date(startAt), {
    eventStartAt: startAt, eventEndAt: endAt, eventStartLocal: startLocal, eventEndLocal: endLocal, eventTz: tz, myRsvp: 'interested', ...over,
});
const KIND_EVENTS = [
    // In person, on the reader's own clock: "SAT 7 NOV · 16:00–18:00".
    kind('k-plain', 'Repair Cafe', '2026-11-07T06:00:00.000Z', '2026-11-07T08:00:00.000Z', '2026-11-07T16:00', '2026-11-07T18:00', KINDS_ZONE),
    // Online, hosted from Sydney (UTC+11): the reader's own clock, "16:00–18:00 your time".
    kind('k-online', 'Seed swap call', '2026-11-07T06:00:00.000Z', '2026-11-07T08:00:00.000Z', '2026-11-07T17:00', '2026-11-07T19:00', 'Australia/Sydney', { eventOnline: true, eventPlaceName: null }),
    // In person in Sydney, read in Brisbane: the reader's clock again, "your time".
    kind('k-zone', 'Harbour clean-up', '2026-11-07T06:00:00.000Z', '2026-11-07T08:00:00.000Z', '2026-11-07T17:00', '2026-11-07T19:00', 'Australia/Sydney'),
    // Over two days: "SAT 7 NOV 16:00 –" / "SUN 8 NOV 10:00".
    kind('k-days', 'Overnight working bee', '2026-11-07T06:00:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-07T16:00', '2026-11-08T10:00', KINDS_ZONE, { myRsvp: 'going' }),
];
const KIND_LANGS = ['en', 'fr', 'de', 'ru', 'es', 'pt'];

const LOCAL = [
    listing('ana-1', 'Bike tune-up', 'Ana', at(10, 3, 14, 0)),
    listing('ana-2', 'Firewood, split', 'Ana', at(10, 3, 13, 30)),
    listing('ana-3', 'Chook manure, bagged', 'Ana', at(10, 3, 13, 0)),
    // A listing and an event with a photo, so the flush picture is measured with a photo drawn as well as with the tile.
    listing('lee-1', 'Kombucha scoby', 'Lee', at(10, 3, 12, 0), { category: 'food', photos: ['/assets/header-bg.png'] }),
    listing('sam-1', 'Lift to Lismore', 'Sam', at(10, 2, 23, 59), { type: 'need' }),
    // An Elder (the ⛰️ tier) in the category with the longest words, priced so the price takes the chip row's far end.
    listing('kai-1', ELDER_TITLE, 'Kai', at(10, 2, 12, 0), { category: 'mindset', credits: 25, priceType: 'hourly', authorEnergyCycled: 5000 }),
    eventPost('ev-1', 'Repair Cafe', at(8, 20, 9, 0), new Date(2026, 10, 4, 10, 0)),
    eventPost('ev-2', 'Garden day', at(9, 30, 9, 0), new Date(2026, 10, 10, 9, 0), { myRsvp: 'going', photos: ['/assets/neon-vines-banner.png'] }),
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

async function open(browser, origin, { dark, global, width = 320, scale = 1.3, sidebar = false, lang = null, view = 'list', timezoneId = null, feed = null }) {
    const context = await browser.newContext({
        viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', ...(timezoneId ? { timezoneId } : {}),
    });
    await context.addInitScript(([mode, list]) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
            localStorage.setItem('marketplace_view_mode', list);
        } catch { /* a picture of the default theme is still a picture */ }
    }, [dark ? 'dark' : 'light', view]);
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
                if (feed) body = q.get('type') === 'event' ? feed.filter(p => p.type === 'event') : feed;
                else body = global ? GLOBAL_POSTS : (q.get('type') === 'event' ? LOCAL.filter(p => p.type === 'event') : view === 'compact' ? [POLL, ...LOCAL_FEED] : LOCAL_FEED);
                // The compact rows' longest marks: Repair Cafe "Interested ✓", and the pinned event the reader hosts.
                if (view === 'compact') body = body.map(p => ({ ...p, ...COMPACT_MARKS[p.id] }));
            }
        } else body = mockResponse(url.pathname, url.search, []);
        if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.route('**/ws**', (route) => route.abort());
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.goto(`${origin}/e2e/harness.html${lang ? `?lang=${lang}` : ''}`, { waitUntil: 'load' });
    await page.addStyleTag({ content: TEXT_SCALE_CSS(scale) });
    // The app shell's sidebar is w-64 (App.tsx): a 256 px stand-in on the left, so the Market has the width it has in the app.
    if (sidebar) {
        await page.addStyleTag({ content: `body { padding-left: ${SIDEBAR}px; } body::before { content: ''; position: fixed; left: 0; top: 0; bottom: 0; width: ${SIDEBAR}px; background: var(--bg-secondary); border-right: 1px solid var(--border-primary); }` });
    }
    await page.waitForSelector(global ? 'text=Sourdough starter' : 'text=Bike tune-up', { timeout: 20_000 });
    await settle(page);
    return { context, page, reads };
}

const SIDEBAR = 256;

/**
 * Every list card on the page, measured on the style box (W2). The picture slot's offsets are from the card's padding box
 * (inside its border, which is 1 px, or an Elder's 3 px on the left), so 0 means flush. Waits for the photos to draw first.
 */
async function listCards(page) {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="listing-list-photo"], [data-testid="event-list-photo"]'))
        .every(slot => !slot.querySelector('img') || !slot.querySelector('[data-testid="category-tile"]')), null, { timeout: 15_000 }).catch(() => {});
    return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="listing-list-card"], [data-testid="event-card"]')).map((card) => {
        const css = getComputedStyle(card);
        const c = card.getBoundingClientRect();
        const slot = card.querySelector('[data-testid="listing-list-photo"], [data-testid="event-list-photo"]');
        const s = slot?.getBoundingClientRect();
        const img = slot?.querySelector('img');
        const drawn = !!img && !slot.querySelector('[data-testid="category-tile"]');
        const i = img?.getBoundingClientRect();
        const chips = Array.from(card.querySelectorAll('[data-testid="listing-list-chips"] > span, [data-testid="event-chips"] > span')).map((el) => {
            const st = getComputedStyle(el);
            return `${st.fontSize}/${st.fontWeight} ${st.paddingTop} ${st.paddingRight} r${st.borderTopLeftRadius} ${st.whiteSpace === 'nowrap' ? 'one-line' : 'wraps'} ${st.textOverflow}`;
        });
        // The card's inside edge on the right (inside its border): a chip past it is cut by the card's corners.
        const inner = c.left + card.clientLeft + card.clientWidth;
        const chipsOut = Array.from(card.querySelectorAll('[data-testid="listing-list-chips"] > span, [data-testid="event-chips"] > span'))
            .filter(el => el.getBoundingClientRect().right > inner + 0.5).map(el => el.textContent);
        const when = card.querySelector('[data-testid="event-when"] span');
        const title = card.querySelector('h3');
        // A listing's head (the chips and the floated price): the title starts one row gap under the lower of the two.
        const headParts = [card.querySelector('[data-testid="listing-list-price"]'), ...card.querySelectorAll('[data-testid="listing-list-chips"] > span')].filter(Boolean);
        const headGap = title && headParts.length ? +(title.getBoundingClientRect().top - Math.max(...headParts.map(e => e.getBoundingClientRect().bottom))).toFixed(2) : null;
        return {
            name: (title?.textContent ?? card.querySelector('button')?.getAttribute('aria-label') ?? '').slice(0, 40),
            kind: card.getAttribute('data-testid'),
            width: Math.round(c.width), over: card.scrollWidth > card.clientWidth + 1,
            slotLeft: s ? +(s.left - c.left - card.clientLeft).toFixed(2) : null,
            slotTop: s ? +(s.top - c.top - card.clientTop).toFixed(2) : null,
            slotGap: s ? +(card.clientHeight - s.height).toFixed(2) : null,
            slotWidth: s ? +s.width.toFixed(2) : null,
            height: Math.round(c.height),
            photo: drawn ? Math.max(Math.abs(i.left - s.left), Math.abs(i.top - s.top), Math.abs(i.width - s.width), Math.abs(i.height - s.height)) : null,
            radius: css.borderTopLeftRadius, ground: css.backgroundColor,
            left: `${css.borderLeftWidth} ${css.borderLeftColor}`,
            chips, chipsOut, headGap,
            when: when ? getComputedStyle(when).color : null,
            titleInk: title ? getComputedStyle(title).color : null,
        };
    }));
}

/**
 * The style box's checks on what listCards() measured (the numbers are core's market-card-shell.ts and brand-colours.ts).
 * `scale` is the text scale the page was opened at: TEXT_SCALE_CSS scales the root font, so every rem size (the photo's
 * 80, a chip's padding and corners) and every arbitrary px font size scales with it; the card's px corners do not.
 */
function checkListCards(cards, { label, dark, maxWidth, photos, scale, count = 9, events = 3, elders = 1 }) {
    const INK = dark ? { ground: 'rgb(42, 50, 42)', event: 'rgb(196, 181, 253)', title: 'rgb(246, 244, 240)', outline: 'rgb(67, 78, 67)' }
        : { ground: 'rgb(255, 255, 255)', event: 'rgb(91, 33, 182)', title: 'rgb(29, 35, 29)', outline: 'rgb(220, 227, 220)' };
    const px = (n) => `${+(n * scale).toFixed(2)}px`;
    const near = (v, d = 0.5) => v !== null && Math.abs(v) <= d;
    check(cards.length === count && cards.filter(c => c.kind === 'event-card').length === events, `${label}: ${cards.length} list cards (${count - events} listings, ${events} events)`);
    const bad = cards.filter(c => !(near(c.slotLeft) && near(c.slotTop) && near(c.slotGap, 1) && near(c.slotWidth - 80 * scale, 0.05)));
    check(bad.length === 0, `${label}: every list card's picture starts at its left edge and is its full height, ${px(80)} wide (${JSON.stringify(bad.length ? bad : cards.map(c => `${c.name}: ${c.height}px`))})`);
    const drawn = cards.filter(c => c.photo !== null);
    check(drawn.length === photos && drawn.every(c => c.photo <= 0.5), `${label}: the ${photos} photos drew and each covers its slot (${JSON.stringify(drawn.map(c => [c.name, c.photo]))})`);
    check(cards.every(c => c.width <= maxWidth && !c.over), `${label}: no list card is wider than ${maxWidth}px or overflows itself (${cards.map(c => c.width).join(', ')})`);
    const out = cards.filter(c => c.chipsOut.length);
    check(out.length === 0, `${label}: every chip ends inside its card (${JSON.stringify(out.map(c => [c.name, c.chipsOut]))})`);
    // #2873: the Elder's band is trust.star's gold, 3 px, in dark as in light; every other card keeps its 1 px outline.
    const lefts = cards.map(c => [c.name, c.left, c.name.startsWith(ELDER_TITLE) ? '3px rgb(251, 191, 36)' : `1px ${INK.outline}`]);
    const elderSeen = cards.filter(c => c.name.startsWith(ELDER_TITLE)).length;
    check(elderSeen === elders && lefts.every(([, got, want]) => got === want),
        `${label}: the Elder's left border is 3px gold, every other card's its 1px outline (${JSON.stringify(lefts.filter(([, got, want]) => got !== want).length ? lefts : [...new Set(lefts.map(l => l[1]))])})`);
    check(cards.every(c => c.radius === '14px' && c.ground === INK.ground), `${label}: corners 14 and the card ground ${INK.ground} (${JSON.stringify([...new Set(cards.map(c => `${c.radius} ${c.ground}`))])})`);
    const chips = [...new Set(cards.flatMap(c => c.chips))];
    // The group lock is the one chip that wraps; there is none in this fixture. A chip longer than its row ends in "…".
    const one = `${px(10)}/800 ${px(2)} ${px(6)} r${px(6)} one-line ellipsis`;
    check(chips.length === 1 && chips[0] === one, `${label}: every chip is the one chip, 10/800, 2 x 6, corners 6, one line, at ${scale}x text (${JSON.stringify(chips)})`);
    const eventCards = cards.filter(c => c.kind === 'event-card');
    check(eventCards.every(c => c.when === INK.event), `${label}: the when is the event token ${INK.event} (${JSON.stringify(eventCards.map(c => c.when))})`);
    const listings = cards.filter(c => c.kind === 'listing-list-card');
    const gaps = listings.map(c => c.headGap);
    check(gaps.every(g => g !== null && Math.abs(g - 4 * scale) <= 0.5), `${label}: a listing's title starts ${px(4)} under its chips and its price, rows 4 apart (${JSON.stringify(gaps)})`);
    check(listings.every(c => c.titleInk === INK.title), `${label}: a listing's title is the page's ink ${INK.title} (${JSON.stringify([...new Set(listings.map(c => c.titleInk))])})`);
}

/**
 * Every compact row on the page (C1), measured: its kind, height, width, picture, its chip's type, and for an event its when
 * (whole or cut) and for a poll its mark and anything on it to press besides the row. Waits for the photos to draw first.
 */
async function compactRows(page) {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="compact-picture"]'))
        .every(slot => !slot.querySelector('img') || !slot.querySelector('[data-testid="category-tile"]')), null, { timeout: 15_000 }).catch(() => {});
    return page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="listing-compact-row"], [data-testid="event-compact-row"], [data-testid="poll-compact-row"]')).map((row) => {
        const r = row.getBoundingClientRect();
        const kind = row.getAttribute('data-testid').split('-')[0];
        const pic = row.querySelector('[data-testid="compact-picture"], .w-8.h-8');
        const chipEl = row.querySelector('[data-testid="compact-type-chip"], [data-testid="event-type-chip"], [data-testid="poll-badge"]');
        const chipCss = chipEl ? getComputedStyle(chipEl) : null;
        // The when's whole pieces (the date, the time): each drawn whole, and inside the two lines the block shows.
        const lines = row.querySelector('[data-testid="event-row-lines"]');
        const whenPieces = Array.from(row.querySelectorAll('[data-testid="event-when"] > span[data-piece="whole"]'));
        const line = row.querySelector('[data-testid="event-row-lines"], [data-testid="poll-compact-line"]');
        return {
            kind,
            name: (row.querySelector('h3, [data-testid="event-row-title"], [data-testid="poll-row-question"]')?.textContent ?? '').slice(0, 40),
            height: +r.height.toFixed(2), width: Math.round(r.width), over: row.scrollWidth > row.clientWidth + 1,
            picture: pic ? `${Math.round(pic.getBoundingClientRect().width)}x${Math.round(pic.getBoundingClientRect().height)} r${getComputedStyle(pic).borderTopLeftRadius}` : null,
            chip: chipCss ? `${chipCss.fontSize}/${chipCss.fontWeight}` : null,
            // One short line's height: the line box the row's words are set on (`leading-snug`), as drawn.
            lineHeight: line ? +parseFloat(getComputedStyle(line).lineHeight).toFixed(2) : null,
            when: whenPieces.map(p => p.textContent).join(' ') || null,
            // The start's date and its time (the first two whole pieces) whole and inside the two lines; a piece gives way ("…")
            // only when it is wider than the words' whole room AND the end has already given way down to its chip. Any later
            // piece (the end of a two-day event) is whole where it is shown.
            whenWhole: lines ? (() => {
                const whole = (p) => p.scrollWidth <= p.clientWidth + 0.5;
                const shown = (p) => p.getBoundingClientRect().bottom <= lines.getBoundingClientRect().bottom + 0.5;
                const endAtChip = chipEl ? chipEl.parentElement.getBoundingClientRect().width <= chipEl.getBoundingClientRect().width + 1 : false;
                const mayGiveWay = (p) => p.scrollWidth > lines.clientWidth + 0.5 && endAtChip;
                const start = whenPieces.slice(0, 2);
                return start.length === 2 && start.every(p => shown(p) && (whole(p) || mayGiveWay(p)))
                    && whenPieces.slice(2).every(p => !shown(p) || whole(p) || mayGiveWay(p));
            })() : null,
            cut: whenPieces.filter(p => p.scrollWidth > p.clientWidth + 0.5).map(p => p.textContent),
            mark: row.querySelector('[data-testid="event-mark"], [data-testid="poll-mark"]')?.textContent ?? null,
            ...(() => {
                // The row's end (the mark above the chip): its right edge measured from the row's content edge (inside the border
                // and the padding; negative is past it), the chip whole, and the words column ending before the end starts.
                const css = getComputedStyle(row);
                const inner = r.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
                const markEl = row.querySelector('[data-testid="event-mark"], [data-testid="poll-mark"]');
                const mr = markEl?.getBoundingClientRect();
                const words = row.querySelector('[data-testid="event-row-lines"]')?.parentElement?.getBoundingClientRect();
                const end = chipEl?.parentElement?.getBoundingClientRect();
                return {
                    scroll: `${row.scrollWidth}/${row.clientWidth}`,
                    chipRight: chipEl ? +(inner - chipEl.getBoundingClientRect().right).toFixed(1) : null,
                    chipWhole: chipEl ? chipEl.scrollWidth <= chipEl.clientWidth + 0.5 : null,
                    chipText: chipEl?.textContent ?? null,
                    markRight: mr ? +(inner - mr.right).toFixed(1) : null,
                    markShown: mr ? mr.width >= 12 && mr.height > 0 : null,
                    wordsClear: words && end ? words.right <= end.left + 0.5 : null,
                    lines: lines ? Math.round(lines.getBoundingClientRect().height / parseFloat(getComputedStyle(lines).lineHeight)) : null,
                };
            })(),
            controls: row.querySelectorAll('button, input, a, [role="button"], [role="progressbar"]').length,
            isButton: row.tagName === 'BUTTON' || row.closest('[role="button"]') !== null,
        };
    }));
}

/** C1's checks on what compactRows() measured, at a text `scale`. */
function checkCompactRows(rows, { label, maxWidth, scale }) {
    const listings = rows.filter(r => r.kind === 'listing');
    const events = rows.filter(r => r.kind === 'event');
    const polls = rows.filter(r => r.kind === 'poll');
    check(listings.length === 6 && events.length === 3 && polls.length === 1, `${label}: ${listings.length} listing rows, ${events.length} event rows, ${polls.length} poll row`);
    // "A listing's row": the plainest listing's (the shortest), and "one line": the row's own short line, as drawn.
    const listingRow = Math.min(...listings.map(r => r.height));
    const oneLine = Math.max(...rows.filter(r => r.lineHeight !== null).map(r => r.lineHeight));
    const bound = +(listingRow + oneLine + 0.5).toFixed(2);
    const tall = [...events, ...polls].filter(r => r.height > bound);
    check(tall.length === 0, `${label}: every event and poll row is a listing's row (${listingRow}px) and one line (${oneLine}px) at most, ${bound}px (${JSON.stringify([...events, ...polls].map(r => `${r.name}: ${r.height}`))})`);
    check(rows.every(r => r.width <= maxWidth && !r.over), `${label}: no row wider than ${maxWidth}px or overflowing itself (${[...new Set(rows.map(r => r.width))].join(', ')})`);
    const px = (n) => `${+(n * scale).toFixed(2)}px`;
    const pics = [...new Set(rows.map(r => r.picture))];
    const side = Math.round(32 * scale);
    check(pics.length === 1 && pics[0] === `${side}x${side} r${px(8)}`, `${label}: every row's picture is 32 square, corners 8, at ${scale}x (${JSON.stringify(pics)})`);
    const chips = [...new Set(rows.map(r => r.chip))];
    check(chips.length === 1 && chips[0] === `${px(10)}/800`, `${label}: every row's type chip is the one chip, 10/800 (${JSON.stringify(chips)})`);
    check([...events, ...polls].every(r => r.isButton && r.controls === 0), `${label}: each event and poll row is one button with nothing else to press on it`);
    check(events.every(r => r.whenWhole), `${label}: every event row's date and time are whole and shown (${JSON.stringify(events.map(r => [r.when, r.whenWhole]))})`);
    const garden = events.find(r => r.name.startsWith('Garden day'));
    check(garden?.mark === 'Going ✓', `${label}: Garden day's row carries my answer, Going ✓ (${garden?.mark})`);
    const repair = events.find(r => r.name.startsWith('Repair Cafe'));
    const hosted = events.find(r => r.name.startsWith('Byron Bay'));
    check(repair?.mark === 'Interested ✓' && hosted?.mark === "You're hosting this event", `${label}: the longest marks, Interested ✓ and You're hosting this event (${repair?.mark}; ${hosted?.mark})`);
    check(polls[0]?.mark === 'Better matches between offers and needs ✓', `${label}: the poll's row carries my answer ✓ (${polls[0]?.mark})`);
    return { listingRow, oneLine, bound, events: events.map(r => [r.name, r.height]), poll: polls.map(r => [r.name, r.height]) };
}

/**
 * The review of #2904: in a language whose when runs wider than English's, an event's row must still hold its end. Every event
 * row: nothing past the row (scrollWidth), the EVENT chip whole and inside the row's content edge, the mark shown and inside
 * it, the words ending before the end, the date and the time whole, and the row a listing's row and one line at most.
 */
function checkCompactEnds(rows, { label }) {
    const events = rows.filter(r => r.kind === 'event');
    check(events.length === KIND_EVENTS.length, `${label}: ${events.length} event rows (${KIND_EVENTS.length})`);
    const show = (r) => `${r.name}: scroll ${r.scroll}, chip ${r.chipRight}${r.chipWhole ? '' : ' CUT'}, mark ${r.markRight}${r.markShown ? '' : ' GONE'} ${JSON.stringify(r.mark)}, when ${JSON.stringify(r.when)} ${r.whenWhole ? 'whole' : 'CUT'}${r.cut.length ? ` (gives way: ${JSON.stringify(r.cut)})` : ''}, ${r.lines} lines, ${r.height}px`;
    for (const r of events) {
        const ok = !r.over && r.chipWhole && r.chipRight >= -0.5 && r.markShown && r.markRight >= -0.5 && r.wordsClear && r.whenWhole;
        check(ok, `${label}: ${show(r)}`);
    }
    const listingRow = Math.min(...rows.filter(r => r.kind === 'listing').map(r => r.height));
    const oneLine = Math.max(...rows.filter(r => r.lineHeight !== null).map(r => r.lineHeight));
    const bound = +(listingRow + oneLine + 0.5).toFixed(2);
    check(events.every(r => r.height <= bound && r.lines <= 2), `${label}: every event row two short lines at most, a listing's row (${listingRow}px) and one line, ${bound}px (${JSON.stringify(events.map(r => [r.name, r.height, r.lines]))})`);
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

        if (run('local')) {
            const { context, page, reads } = await open(browser, server.origin, { dark, global: false });
            const seq = await sequence(page, LOCAL.map(p => p.title));
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= 320, `${theme} local: nothing wider than the screen (${wide}px)`);
            check(JSON.stringify(seq) === JSON.stringify([
                'Pinned', PINNED_EVENT.title,
                'Today', 'Bike tune-up', 'Firewood, split', 'Kombucha scoby', 'Repair Cafe', 'Chook manure, bagged',
                'Yesterday', 'Lift to Lismore', ELDER_TITLE, 'This Week', 'Garden day',
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
            checkListCards(await listCards(page), { label: `${theme} local 320`, dark, maxWidth: 320, photos: 2, scale: 1.3 });
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

        for (const lang of run('lang') ? ['ml', 'de'] : []) {
            // #2873: the same list in a language whose category words run longer than English's (Malayalam "📜 മനോഭാവവും
            // തത്ത്വചിന്തയും", German "📜 Lebensart & Philosophie"): every chip still ends inside its card.
            const { context, page } = await open(browser, server.origin, { dark, global: false, lang });
            const shown = await page.evaluate(() => document.documentElement.lang);
            check(shown === lang, `${theme} local ${lang}: the page is in ${lang} (${shown})`);
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= 320, `${theme} local ${lang}: nothing wider than the screen (${wide}px)`);
            checkListCards(await listCards(page), { label: `${theme} local ${lang} 320`, dark, maxWidth: 320, photos: 2, scale: 1.3 });
            await page.evaluate((title) => {
                const el = [...document.querySelectorAll('h3')].find(e => e.textContent.trim() === title);
                if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200);
            }, ELDER_TITLE);
            await page.waitForTimeout(150);
            await page.screenshot({ path: path.join(out, `web-local-list-c-yesterday-${lang}-${theme}.png`) });
            await context.close();
        }

        for (const [width, scale, sidebar] of run('compact') ? [[320, 1.3, false], [1280, 1, true]] : []) {
            // C1: the compact view, at 320 x 1.3 and at 1280 beside the sidebar.
            const { context, page } = await open(browser, server.origin, { dark, global: false, width, scale, sidebar, view: 'compact' });
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= width, `${theme} compact ${width}: nothing wider than the window (${wide}px)`);
            const measured = checkCompactRows(await compactRows(page), { label: `${theme} compact ${width}`, maxWidth: sidebar ? width - SIDEBAR : width, scale });
            console.log(`     ${theme} compact ${width}: ${JSON.stringify(measured)}`);
            const tag = width === 320 ? '' : `-${width}`;
            await page.screenshot({ path: path.join(out, `web-local-compact${tag}-a-${theme}.png`) });
            if (width === 320) {
                await page.evaluate(() => {
                    const el = [...document.querySelectorAll('span.tracking-widest')].find(e => e.textContent.trim() === 'Yesterday');
                    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200);
                });
                await page.waitForTimeout(150);
                await page.screenshot({ path: path.join(out, `web-local-compact-b-${theme}.png`) });
            }
            await context.close();
        }

        if (run('local-1280')) {
            // A desktop window: 1280 px at 1x text, the Market beside the sidebar (the style box's W2 shot "web also 1280 + sidebar").
            const { context, page } = await open(browser, server.origin, { dark, global: false, width: 1280, scale: 1, sidebar: true });
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= 1280, `${theme} local 1280: nothing wider than the window (${wide}px)`);
            checkListCards(await listCards(page), { label: `${theme} local 1280 + sidebar`, dark, maxWidth: 1280 - SIDEBAR, photos: 2, scale: 1 });
            await page.screenshot({ path: path.join(out, `web-local-list-1280-${theme}.png`) });
            await context.close();
        }

        if (run('global')) {
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
            // Each card here has its distance line under who: the picture still runs the card's full height.
            checkListCards(await listCards(page), { label: `${theme} global 320`, dark, maxWidth: 320, photos: 0, scale: 1.3, count: 4, events: 0, elders: 0 });
            await page.screenshot({ path: path.join(out, `web-global-line-${theme}.png`) });
            await context.close();
        }

        for (const lang of run('compact-kinds') ? KIND_LANGS : []) {
            // The review of #2904: the compact view at 320 x 1.3 in six languages, an event of each kind (in person, online, read
            // in another clock, over two days), the reader in Brisbane. Pictures in de and ru.
            const feed = [...LOCAL.filter(p => p.type !== 'event'), ...KIND_EVENTS];
            const { context, page } = await open(browser, server.origin, { dark, global: false, lang, view: 'compact', timezoneId: KINDS_ZONE, feed });
            const shown = await page.evaluate(() => document.documentElement.lang);
            check(shown === lang, `${theme} kinds ${lang}: the page is in ${lang} (${shown})`);
            const wide = await page.evaluate(() => document.documentElement.scrollWidth);
            check(wide <= 320, `${theme} kinds ${lang}: nothing wider than the screen (${wide}px)`);
            checkCompactEnds(await compactRows(page), { label: `${theme} kinds ${lang} 320` });
            if (lang === 'de' || lang === 'ru') {
                await page.evaluate(() => document.querySelector('[data-testid="event-compact-row"]')?.scrollIntoView({ block: 'start' }));
                await page.waitForTimeout(150);
                await page.screenshot({ path: path.join(out, `web-compact-kinds-${lang}-${theme}.png`) });
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(failures === 0 ? 'the web Market orders as designed' : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
