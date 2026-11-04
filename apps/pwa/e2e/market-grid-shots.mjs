#!/usr/bin/env node
/**
 * The Market grid as a lattice (G2, DESIGN-market-grid-sizes-fable.md §2.2 to §2.4, §3 G2): pictures for review, and
 * the row checks, measured in a real Chromium from the live layout:
 *
 *   node e2e/market-grid-shots.mjs <out-dir> [--miss=self-start|block]
 *
 * Widths: 320, 320 at 1.3x text, 640, and with a 256 px left shim standing in for the app's sidebar (the harness has no
 * App shell; the Tailwind breakpoints are the viewport's, the columns are not) 768, 768 at 1.3x, 1024, 1280 and 1920.
 * Cases: the fixture (e2e/fixtures.mjs), the node's Daily Pulse (shown while there are under two listings), one pin, three
 * pins (the cap: a listing, the event and the poll), from three columns up the poll in the last column of the first row,
 * the events (W3': a group-only event, an online one, a Byron event read across the zone line, one that ends the next day,
 * your Going and your Interested) and a member's copy of an event on the global community. The reader is in Queensland
 * (Australia/Brisbane, UTC+10, no daylight time), so a NSW event in November is an hour ahead of them. Light and dark, a
 * picture of each.
 *
 * Checks, every grid of every case and scheme (a non-zero exit names each miss):
 *   - the column count for the width;
 *   - every cell in a row is the row's height (the grid's own tracks), and every listing / event / Pulse tile fills its cell;
 *   - every listing / event / Pulse tile's text block is core's MARKET_GRID_TEXT_BLOCK_REM (7.0625rem) at the root size, +-1 px;
 *   - a row of only listing / event / Pulse tiles is no taller than its tiles' own photo + text block (+-1 px): one tile height;
 *   - no tile row is cut: a row of the text block wider inside than it is (scrollWidth > clientWidth) is a miss; on an event
 *     tile the date, the time's shown pieces, "🕒 your time" and every pill on the photo are whole too (a title or a place
 *     that ends in its own "…" inside its row is the design); and an event's time row never ends in a dash;
 *   - the poll is the whole row (one row tall) below 1024 px and a 2 x 2 square from 1024; its own content fits two tile
 *     heights plus the gap (at 1x exactly, +1 px; at 1.3x within one text row), and the two rows it spans are no taller;
 *   - no empty cell that a later one-cell tile could have taken (dense flow back-fills; the feed simply ending is not one);
 *   - the pins are the grid's first items and as many as pinned (newest first and each once are MarketplacePage.pins.test.tsx's
 *     to check, not this script's); on screen no stream tile comes before a pinned
 *     listing or event, and a pinned poll starts no lower than the row after them;
 *   - nothing is wider than the screen.
 *
 * `--miss=self-start` puts #1092's cell back (`self-start`, no `h-full`), `--miss=block` lets the text block take its own
 * height, `--miss=time-one-line` makes an event's time one shrinking line (the end piece cut instead of dropped whole), and
 * `--miss=dash-first` moves the dash onto the start piece: each must make this exit non-zero (a check that cannot fail is
 * not a check). `--only=<case>[,<case>]` runs those cases.
 *
 * Nothing here talks to a node: every /api call is answered from e2e/fixtures.mjs (harness.mjs).
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openMarket, settle } from './harness.mjs';
import { POSTS, postsWithPollAt } from './fixtures.mjs';

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
const miss = (args.find(a => a.startsWith('--miss=')) || '').slice('--miss='.length) || null;
const only = (args.find(a => a.startsWith('--only=')) || '').slice('--only='.length) || null;
if (!out) {
    console.error('usage: node e2e/market-grid-shots.mjs <out-dir> [--miss=self-start|block|time-one-line|dash-first] [--only=<case>]');
    process.exit(2);
}
const MISSES = {
    // #1092's cell: `self-start` and no `h-full` (with `h-full` a start-aligned cell is still its grid area's height).
    'self-start': 'div.grid.grid-flow-row-dense > * { align-self: start !important; height: auto !important; }',
    block: '[data-testid="grid-text-block"] { height: auto !important; }',
    // The time as one line that gives way: the end piece shrinks into "…" instead of dropping whole.
    'time-one-line': '[data-testid="event-tile-time"] { flex-wrap: nowrap !important; } [data-testid="event-time-piece"] { flex-shrink: 1 !important; min-width: 0 !important; }',
    // The dash on the start piece ("10:26–" / "14:26"): where the end piece drops, the row would end in a dash.
    'dash-first': () => {
        for (const row of document.querySelectorAll('[data-testid="event-tile-time"]')) {
            const [start, end] = row.querySelectorAll('[data-testid="event-time-piece"]');
            if (start && end && end.textContent.startsWith('–')) {
                start.textContent = `${start.textContent}–`;
                end.textContent = end.textContent.slice(1);
            }
        }
    },
};
if (miss && !MISSES[miss]) {
    console.error(`unknown --miss=${miss}; one of ${Object.keys(MISSES).join(', ')}`);
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

/**
 * Paths the harness answers 404 on purpose: the community's info (harness.mjs: absent, as on a node older than the switch,
 * so no example cards) and the reader's node role (the poll card asks it for the owners' panel; a 404 is "not an owner").
 * Any other unanswered path is a miss.
 */
const ANSWERED_404 = new Set(['/api/community/info', '/api/node-admin/me']);

/** core's MARKET_GRID_TEXT_BLOCK_REM and one row of it (market-card-shell.ts); the web shell's test holds the classes to them. */
const BLOCK_REM = 7.0625;
const ROW_REM = 1.203125;

const WIDTHS = [
    { name: '320', width: 320, columns: 2 },
    { name: '320-x1.3', width: 320, columns: 2, textScale: 1.3 },
    { name: '640', width: 640, columns: 2 },
    { name: '768-shim', width: 768, columns: 3, shim: true },
    { name: '768-shim-x1.3', width: 768, columns: 3, shim: true, textScale: 1.3 },
    { name: '1024-shim', width: 1024, columns: 4, shim: true },
    { name: '1280-shim', width: 1280, columns: 5, shim: true },
    { name: '1920-shim', width: 1920, columns: 5, shim: true },
];

const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
/** The node's own Daily Pulse, drawn as the Pulse tile (its author is "Daily Pulse"). */
const PULSE = {
    id: 'pulse-1', type: 'offer', category: 'community', status: 'active', active: true, credits: 0, priceType: 'fixed',
    title: 'Daily Pulse: what the village is up to', description: 'Three new offers, a working bee on Saturday and the shed poll.',
    authorPublicKey: 'daily-pulse', authorCallsign: 'Daily Pulse', createdAt: iso(-HOUR / 2), photos: [],
};
const pin = (posts, ids) => posts.map(p => (ids.includes(p.id)
    ? { ...p, pinnedUntil: iso(48 * HOUR), pinnedAt: iso(-HOUR * (ids.indexOf(p.id) + 1)) }
    : p));
/** The reader's zone: Queensland, UTC+10 all year, an hour behind NSW on daylight time (October to April). */
const READER_TZ = 'Australia/Brisbane';
const event = (over) => ({
    type: 'event', category: 'community', status: 'active', active: true, credits: 0, priceType: 'fixed', repeatable: false,
    photos: [], description: '', authorPublicKey: 'member-eve', authorCallsign: 'Eve', authorEnergyCycled: 65, createdAt: iso(-3 * HOUR),
    lat: -28.64, lng: 153.61, eventState: 'scheduled', goingCount: 4, interestedCount: 2, myRsvp: null, ...over,
});
/**
 * W3' (DESIGN-grid-event-rows-fable.md): the events the tile must hold at every width, fixed in November 2030 so NSW is on
 * daylight time whenever this runs. Each names what its tile must show: row 4, and how many pieces its time row has.
 */
const EVENTS = [
    // A NSW event read in Queensland: Sat 9 Nov 16:00–21:00 in Byron (UTC+11) is 15:00–20:00 here, so "🕒 your time" leads row 4.
    {
        post: event({ id: 'e-byron', title: 'Byron Bay Twilight Market', eventPlaceName: 'Railway Park', myRsvp: 'interested',
            eventStartAt: '2030-11-09T05:00:00.000Z', eventEndAt: '2030-11-09T10:00:00.000Z',
            eventStartLocal: '2030-11-09T16:00', eventEndLocal: '2030-11-09T21:00', eventTz: 'Australia/Sydney' }),
        rows: ['SAT 9 NOV', '15:00–20:00', /^🕒 your time📍 Railway Park/], pieces: 2,
    },
    // Group-only, in the reader's own zone: the plain span, and the 🔒 pill on the photo.
    {
        post: event({ id: 'e-group', title: 'Seed library sorting bee', eventPlaceName: 'Mullumbimby Community Garden', myRsvp: 'going',
            audienceScope: 'group', targetGroupId: 'g-garden', targetGroupName: 'Byron Gardeners',
            eventStartAt: '2030-11-08T00:26:00.000Z', eventEndAt: '2030-11-08T04:26:00.000Z',
            eventStartLocal: '2030-11-08T10:26', eventEndLocal: '2030-11-08T14:26', eventTz: 'Australia/Brisbane' }),
        rows: ['FRI 8 NOV', '10:26–14:26', /^📍 Mullumbimby Community Garden/], pieces: 2, lock: true,
    },
    // Online, a Sydney host's 20:50 (AEDT): 19:50–21:50 here, the bare span, and "your time" in no row.
    {
        post: event({ id: 'e-online', title: 'Repair café: ask a fixer online', eventOnline: true, lat: undefined, lng: undefined,
            eventStartAt: '2030-11-08T09:50:00.000Z', eventEndAt: '2030-11-08T11:50:00.000Z',
            eventStartLocal: '2030-11-08T20:50', eventEndLocal: '2030-11-08T22:50', eventTz: 'Australia/Sydney' }),
        rows: ['FRI 8 NOV', '19:50–21:50', /^🌐 Online$/], pieces: 2,
    },
    // Ends the next day: the start's date and its time alone.
    {
        post: event({ id: 'e-two-day', title: 'Two-day permaculture course', eventPlaceName: 'Bangalow Showground',
            eventStartAt: '2030-11-08T00:26:00.000Z', eventEndAt: '2030-11-09T02:26:00.000Z',
            eventStartLocal: '2030-11-08T10:26', eventEndLocal: '2030-11-09T12:26', eventTz: 'Australia/Brisbane' }),
        rows: ['FRI 8 NOV', '10:26', /^📍 Bangalow Showground/], pieces: 1,
    },
];
/** A member's copy of an event on the global community: whose it is stands in row 4, where the place would. */
const COPY = {
    post: event({ id: 'e-copy', title: 'Mullumbimby farmers market', eventPlaceName: 'Mullumbimby showground', myRsvp: 'going',
        shownCopy: true, shownFrom: { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' },
        eventStartAt: '2030-11-07T21:00:00.000Z', eventEndAt: '2030-11-08T01:00:00.000Z' }),
    rows: ['FRI 8 NOV', '7:00–11:00', /^from Mullumbimby$/], pieces: 2, noMark: true,
};
const CASES = [
    { name: 'fixture', posts: POSTS, pins: [] },
    // The Market shows the node's Pulse only while it has fewer than two listings (MarketplacePage): one listing, the
    // event, the poll and the Pulse.
    { name: 'pulse', posts: [PULSE, ...POSTS.filter(p => ['m-1', 'e-1', 'p-1'].includes(p.id))], pins: [], needs: 'pulse' },
    { name: 'one-pin', posts: pin(POSTS, ['m-2']), pins: ['m-2'] },
    // Newest pin first: the listing, then the event, then the poll.
    { name: 'three-pins', posts: pin(POSTS, ['m-2', 'e-1', 'p-1']), pins: ['m-2', 'e-1', 'p-1'] },
    { name: 'poll-last-column', posts: null, pins: [], minColumns: 3 },
    { name: 'events', posts: [...POSTS, ...EVENTS.map(e => e.post)], pins: [], events: EVENTS },
    // The global community's view of a member's copy (its directory row in shownFrom).
    { name: 'global-copy', posts: [...POSTS, COPY.post], pins: [], events: [COPY] },
];

/** Everything measured in the page, for every grid on it. */
function measure() {
    const px = (v) => parseFloat(v) || 0;
    const root = px(getComputedStyle(document.documentElement).fontSize);
    const grids = [...document.querySelectorAll('div.grid.grid-flow-row-dense')].map((gridEl) => {
        const cs = getComputedStyle(gridEl);
        const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).map(px);
        const rows = cs.gridTemplateRows.split(' ').filter(Boolean).map(px);
        const colGap = px(cs.columnGap);
        const rowGap = px(cs.rowGap);
        const g = gridEl.getBoundingClientRect();
        // Track starts, from the grid's own tracks.
        const colStarts = cols.map((_, i) => cols.slice(0, i).reduce((a, b) => a + b + colGap, 0));
        const rowStarts = rows.map((_, i) => rows.slice(0, i).reduce((a, b) => a + b + rowGap, 0));
        const nearest = (starts, v) => starts.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(starts[best] - v) ? i : best), 0);
        const cells = [...gridEl.children].map((cell, index) => {
            const r = cell.getBoundingClientRect();
            const top = r.top - g.top;
            const left = r.left - g.left;
            const row = nearest(rowStarts, top);
            const col = nearest(colStarts, left);
            const rowSpan = rowStarts.filter(s => s >= top - 1 && s < top + r.height - 1).length;
            const colSpan = colStarts.filter(s => s >= left - 1 && s < left + r.width - 1).length;
            const tracksHeight = rows.slice(row, row + rowSpan).reduce((a, b) => a + b, 0) + rowGap * (rowSpan - 1);
            const kind = cell.querySelector('[data-testid="event-card"]') ? 'event'
                : cell.querySelector('[data-testid="listing-grid-tile"]')
                    ? ((cell.getAttribute('aria-label') || '').startsWith('Daily Pulse') ? 'pulse' : 'listing')
                    : (cell.textContent.includes('POLL') ? 'poll' : 'other');
            const tile = cell.firstElementChild;
            const t = tile ? tile.getBoundingClientRect() : r;
            const block = cell.querySelector('[data-testid="grid-text-block"]');
            const photo = block ? block.previousElementSibling : null;
            // A row of the text block that is wider inside than it is: something in it runs past its edge and is cut there.
            const rowsCut = block ? [...block.children].map((row, i) => (row.scrollWidth > row.clientWidth
                ? `row ${i + 1} "${row.textContent}" (${row.scrollWidth} > ${row.clientWidth})` : null)).filter(Boolean) : [];
            // An event tile: what must be whole (the date, the time's shown pieces, "🕒 your time", the photo's pills), the
            // time row as it reads (only the pieces on its one visible line), and its four rows.
            let ev = null;
            if (kind === 'event' && block && photo) {
                const notWhole = [];
                const whole = (el, name) => { if (el && el.scrollWidth > el.clientWidth) notWhole.push(`${name} "${el.textContent}" (${el.scrollWidth} > ${el.clientWidth})`); };
                whole(cell.querySelector('[data-testid="event-tile-date"]'), 'the date');
                whole(cell.querySelector('[data-testid="event-your-time"]'), '"your time"');
                const time = cell.querySelector('[data-testid="event-tile-time"]');
                const tr = time.getBoundingClientRect();
                const pieces = [...time.querySelectorAll('[data-testid="event-time-piece"]')];
                const shown = pieces.filter(p => p.getBoundingClientRect().top - tr.top < tr.height / 2);
                for (const p of shown) whole(p, 'a time piece');
                const pr = photo.getBoundingClientRect();
                for (const pill of cell.querySelectorAll('[data-testid="grid-badge-row"] > *')) {
                    whole(pill, 'a pill');
                    const b = pill.getBoundingClientRect();
                    if (b.left < pr.left - 0.5 || b.right > pr.right + 0.5 || b.top < pr.top - 0.5) notWhole.push(`a pill "${pill.textContent}" runs off the photo`);
                }
                ev = {
                    title: cell.querySelector('[data-testid="event-tile-title"]')?.textContent ?? '',
                    rows: [...block.children].map(x => x.textContent),
                    time: shown.map(p => p.textContent).join(''),
                    shownPieces: shown.length, pieces: pieces.length,
                    lock: !!cell.querySelector('[data-testid="event-lock-pill"]'),
                    mark: cell.querySelector('[data-testid="event-mark"]')?.textContent ?? null,
                    notWhole,
                };
            }
            const tcs = tile ? getComputedStyle(tile) : null;
            const natural = block && photo
                ? photo.getBoundingClientRect().height + block.getBoundingClientRect().height + px(tcs.borderTopWidth) + px(tcs.borderBottomWidth)
                : null;
            // The poll's own height: what its content needs, measured with the stretch taken off for a moment.
            let pollNatural = null;
            if (kind === 'poll' && tile) {
                const was = [cell.style.alignSelf, tile.style.height];
                cell.style.alignSelf = 'start';
                tile.style.height = 'auto';
                pollNatural = tile.getBoundingClientRect().height;
                [cell.style.alignSelf, tile.style.height] = was;
            }
            return {
                index, kind, row, col, rowSpan, colSpan,
                pinned: cell.getAttribute('data-testid') === 'market-pinned-tile',
                label: (cell.getAttribute('aria-label') || ev?.title || tile?.querySelector('h3')?.textContent || cell.textContent).trim().slice(0, 40),
                cellH: r.height, tracksHeight, tileH: t.height,
                blockH: block ? block.getBoundingClientRect().height : null,
                natural, pollNatural, rowsCut, ev,
            };
        });
        return { cols: cols.length, colWidth: cols[0], colGap, rowGap, rows, cells };
    });
    return {
        root,
        grids,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
}

/** Every check for one measured page; returns the misses. */
function check(m, spec, pins, events = []) {
    const misses = [];
    const fail = (msg) => misses.push(msg);
    const scale = spec.textScale ?? 1;
    const block = BLOCK_REM * m.root;
    const textRow = ROW_REM * m.root;
    if (m.overflow > 0) fail(`page is ${m.overflow}px wider than the screen`);
    if (!m.grids.length) fail('no grid drawn');
    m.grids.forEach((g, gi) => {
        const at = m.grids.length > 1 ? `grid ${gi + 1}: ` : '';
        if (g.cols !== spec.columns) fail(`${at}${g.cols} columns (expected ${spec.columns})`);
        // W3': the event tile is on the lattice, as the listing and the Pulse are.
        const lattice = (c) => c.kind === 'listing' || c.kind === 'pulse' || c.kind === 'event';
        for (const c of g.cells) {
            if (Math.abs(c.cellH - c.tracksHeight) > 1) fail(`${at}"${c.label}" cell is ${c.cellH.toFixed(1)}px in a ${c.tracksHeight.toFixed(1)}px row: not the row's height`);
            if (lattice(c)) {
                if (Math.abs(c.tileH - c.cellH) > 1) fail(`${at}"${c.label}" tile is ${c.tileH.toFixed(1)}px in a ${c.cellH.toFixed(1)}px cell: it does not fill it`);
                if (c.blockH === null || Math.abs(c.blockH - block) > 1) fail(`${at}"${c.label}" text block is ${c.blockH?.toFixed(1)}px (expected ${block.toFixed(1)})`);
                for (const x of c.rowsCut) fail(`${at}"${c.label}" ${x}: cut`);
            }
            if (c.kind === 'event') {
                if (!c.ev) { fail(`${at}"${c.label}" event tile has no four-row block`); continue; }
                for (const x of c.ev.notWhole) fail(`${at}"${c.label}" ${x}: cut`);
                if (!c.ev.time) fail(`${at}"${c.label}" time row shows nothing`);
                if (/[–-]\s*$/.test(c.ev.time)) fail(`${at}"${c.label}" time row ends in a dash: "${c.ev.time}"`);
            }
        }
        // One tile height: a row of only lattice tiles (none spanning into it) is its tiles' own height.
        const tile = Math.max(0, ...g.cells.filter(lattice).map(c => c.natural));
        g.rows.forEach((h, r) => {
            const inRow = g.cells.filter(c => r >= c.row && r < c.row + c.rowSpan);
            if (!inRow.length || !inRow.every(c => lattice(c) && c.rowSpan === 1)) return;
            const own = Math.max(...inRow.map(c => c.natural));
            if (h > own + 1) fail(`${at}row ${r + 1} is ${h.toFixed(1)}px for tiles of ${own.toFixed(1)}px`);
            const spread = own - Math.min(...inRow.map(c => c.natural));
            if (spread > 1) fail(`${at}row ${r + 1}: its tiles' own heights differ by ${spread.toFixed(1)}px`);
        });
        // The poll.
        for (const p of g.cells.filter(c => c.kind === 'poll')) {
            if (spec.columns < 4) {
                if (p.colSpan !== g.cols || p.rowSpan !== 1) fail(`${at}poll is ${p.colSpan} x ${p.rowSpan} (expected the whole row, ${g.cols} x 1)`);
            } else {
                if (p.colSpan !== 2 || p.rowSpan !== 2) fail(`${at}poll is ${p.colSpan} x ${p.rowSpan} (expected 2 x 2)`);
                const square = 2 * tile + g.rowGap;
                const allow = scale === 1 ? 1 : textRow;
                if (p.pollNatural > square + allow) fail(`${at}poll needs ${p.pollNatural.toFixed(1)}px; its square is ${square.toFixed(1)} (+${allow.toFixed(1)} allowed)`);
                const beside = g.cells.filter(c => c !== p && c.row >= p.row && c.row < p.row + 2);
                const rowsTotal = p.tracksHeight;
                if (beside.every(lattice) && rowsTotal > square + allow) fail(`${at}the poll's two rows are ${rowsTotal.toFixed(1)}px; two tiles and the gap are ${square.toFixed(1)}`);
            }
        }
        // No empty cell a later one-cell tile could have taken.
        const filled = g.rows.map(() => new Array(g.cols).fill(false));
        for (const c of g.cells) for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) if (filled[r]) filled[r][k] = true;
        filled.forEach((cells, r) => {
            const empty = cells.filter(x => !x).length;
            const later = g.cells.some(c => c.row > r && c.rowSpan === 1 && c.colSpan === 1);
            if (empty && later) fail(`${at}row ${r + 1} has ${empty} empty cell(s) and a tile drawn below it`);
        });
    });
    // The case's events, each drawn as a tile with the rows it is here for (so the zone and the copy really were read).
    const tiles = m.grids.flatMap(g => g.cells.filter(c => c.kind === 'event' && c.ev));
    for (const e of events) {
        const c = tiles.find(x => x.ev.title === e.post.title);
        if (!c) { fail(`no event tile for "${e.post.title}"`); continue; }
        const [date, time, , last] = c.ev.rows;
        if (date !== e.rows[0]) fail(`"${e.post.title}" row 1 is "${date}" (expected "${e.rows[0]}")`);
        if (time !== e.rows[1]) fail(`"${e.post.title}" row 2 holds "${time}" (expected "${e.rows[1]}")`);
        if (!e.rows[2].test(last)) fail(`"${e.post.title}" row 4 is "${last}" (expected ${e.rows[2]})`);
        if (c.ev.pieces !== e.pieces) fail(`"${e.post.title}" time row has ${c.ev.pieces} piece(s) (expected ${e.pieces})`);
        if (c.ev.lock !== !!e.lock) fail(`"${e.post.title}" ${c.ev.lock ? 'has' : 'has no'} 🔒 pill`);
        if (!!e.noMark && c.ev.mark) fail(`"${e.post.title}" shows a mark "${c.ev.mark}" on a copy`);
        if (!e.noMark && e.post.myRsvp && !c.ev.mark) fail(`"${e.post.title}" shows no mark for the reader's ${e.post.myRsvp}`);
    }
    // Pins: the first items of the first grid, as many as pinned; no stream tile before a pinned listing or event.
    if (pins.length && m.grids.length) {
        const first = m.grids[0].cells;
        const pinned = m.grids.flatMap(g => g.cells.filter(c => c.pinned));
        if (pinned.length !== pins.length) fail(`${pinned.length} pinned tiles (expected ${pins.length})`);
        if (!first.slice(0, pins.length).every(c => c.pinned)) fail('the pins are not the grid\'s first items');
        const order = [...first].sort((a, b) => a.row - b.row || a.col - b.col);
        const lastPin = Math.max(-1, ...order.map((c, i) => (c.pinned && c.kind !== 'poll' ? i : -1)));
        const firstStream = order.findIndex(c => !c.pinned);
        if (firstStream !== -1 && firstStream < lastPin) fail('a stream tile is drawn before a pinned tile');
        const pinRows = first.filter(c => c.pinned && c.kind !== 'poll').map(c => c.row);
        for (const p of first.filter(c => c.pinned && c.kind === 'poll')) {
            if (pinRows.length && p.row > Math.max(...pinRows) + 1) fail(`the pinned poll starts at row ${p.row + 1}, below the other pins' rows`);
        }
    }
    return misses;
}

function report(m) {
    for (const [gi, g] of m.grids.entries()) {
        console.log(`    grid${m.grids.length > 1 ? ` ${gi + 1}` : ''}: ${g.cols} x ${g.colWidth.toFixed(0)}px, gap ${g.colGap}, rows ${g.rows.map(r => r.toFixed(0)).join('/')}`);
        for (const c of g.cells) {
            const what = c.kind === 'event' && c.ev
                ? ` | ${c.ev.rows.join(' | ')} | time shows "${c.ev.time}" (${c.ev.shownPieces} of ${c.ev.pieces})${c.ev.mark ? ` | mark "${c.ev.mark}"` : ''}${c.ev.lock ? ' | 🔒' : ''}`
                : c.kind === 'poll' ? ` ${c.colSpan} x ${c.rowSpan}, needs ${c.pollNatural?.toFixed(0)}px` : '';
            console.log(`      r${c.row + 1}c${c.col + 1} ${c.kind.padEnd(7)} ${c.pinned ? '📌 ' : ''}tile ${c.tileH.toFixed(0)}${c.blockH ? ` block ${c.blockH.toFixed(1)}` : ''}${what}  "${c.label}"`);
        }
    }
}

const problems = [];
const { origin, close } = await startServer();
const browser = await launch();
try {
    for (const kase of CASES) {
        if (only && !only.split(',').includes(kase.name)) continue;
        for (const spec of WIDTHS) {
            if (kase.minColumns && spec.columns < kase.minColumns) continue;
            const posts = kase.posts ?? postsWithPollAt(spec.columns - 1);
            for (const dark of [false, true]) {
                const name = `${kase.name}-${spec.name}-${dark ? 'dark' : 'light'}`;
                const { context, page, unrouted } = await openMarket(browser, origin, {
                    width: spec.width, height: 1200, dark, textScale: spec.textScale ?? 1, posts, timezoneId: READER_TZ,
                });
                if (spec.shim) await page.addStyleTag({ content: '#root { padding-left: 256px; }' });
                if (miss && typeof MISSES[miss] === 'string') await page.addStyleTag({ content: MISSES[miss] });
                if (miss && typeof MISSES[miss] === 'function') await page.evaluate(MISSES[miss]);
                if (spec.shim || miss) await settle(page);
                const file = path.join(out, `${name}.png`);
                const first = page.locator('div.grid.grid-flow-row-dense').first();
                await first.locator('..').screenshot({ path: file, animations: 'disabled' });
                const unexpected = [...new Set(unrouted)].filter(p => !ANSWERED_404.has(p));
                if (unexpected.length) problems.push(`${name}: unanswered API paths ${unexpected.join(', ')}`);
                const m = await page.evaluate(measure);
                const misses = check(m, spec, kase.pins, kase.events);
                if (kase.needs && !m.grids.some(g => g.cells.some(c => c.kind === kase.needs))) misses.push(`no ${kase.needs} tile drawn`);
                console.log(`${misses.length ? '✗' : '✓'} ${name} (root ${m.root}px, block ${(BLOCK_REM * m.root).toFixed(1)}px)  ${file}`);
                if (!dark) report(m);
                for (const x of misses) {
                    console.log(`    ✗ ${x}`);
                    problems.push(`${name}: ${x}`);
                }
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await close();
}

if (problems.length) {
    console.error(`\n${problems.length} miss(es)${miss ? ` (with --miss=${miss})` : ''}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}
console.log('\nMarket grid: every width, case and scheme checked; the lattice holds.');
