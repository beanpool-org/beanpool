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
 * pins (the cap: a listing, the event and the poll), and from three columns up the poll in the last column of the first
 * row. Light and dark, a picture of each.
 *
 * Checks, every grid of every case and scheme (a non-zero exit names each miss):
 *   - the column count for the width;
 *   - every cell in a row is the row's height (the grid's own tracks), and every listing / Pulse tile fills its cell;
 *   - every listing / Pulse tile's text block is core's MARKET_GRID_TEXT_BLOCK_REM (7.0625rem) at the root size, +-1 px;
 *   - a row of only listing / Pulse tiles is no taller than its tiles' own photo + text block (+-1 px): one tile height;
 *   - the poll is the whole row (one row tall) below 1024 px and a 2 x 2 square from 1024; its own content fits two tile
 *     heights plus the gap (at 1x exactly, +1 px; at 1.3x within one text row), and the two rows it spans are no taller;
 *   - no empty cell that a later one-cell tile could have taken (dense flow back-fills; the feed simply ending is not one);
 *   - the pins are the grid's first items and as many as pinned (newest first and each once are MarketplacePage.pins.test.tsx's
 *     to check, not this script's); on screen no stream tile comes before a pinned
 *     listing or event, and a pinned poll starts no lower than the row after them;
 *   - nothing is wider than the screen.
 * The event tile is not on the lattice until slice W3': it is drawn and named in the output, and left out of the tile
 * checks; a row it sits in is checked for cell heights only.
 *
 * `--miss=self-start` puts #1092's cell back (`self-start`, no `h-full`), `--miss=block` lets the text block take its own
 * height: either must make this exit non-zero (a check that cannot fail is not a check).
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
if (!out) {
    console.error('usage: node e2e/market-grid-shots.mjs <out-dir> [--miss=self-start|block]');
    process.exit(2);
}
const MISSES = {
    // #1092's cell: `self-start` and no `h-full` (with `h-full` a start-aligned cell is still its grid area's height).
    'self-start': 'div.grid.grid-flow-row-dense > * { align-self: start !important; height: auto !important; }',
    block: '[data-testid="grid-text-block"] { height: auto !important; }',
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
const CASES = [
    { name: 'fixture', posts: POSTS, pins: [] },
    // The Market shows the node's Pulse only while it has fewer than two listings (MarketplacePage): one listing, the
    // event, the poll and the Pulse.
    { name: 'pulse', posts: [PULSE, ...POSTS.filter(p => ['m-1', 'e-1', 'p-1'].includes(p.id))], pins: [], needs: 'pulse' },
    { name: 'one-pin', posts: pin(POSTS, ['m-2']), pins: ['m-2'] },
    // Newest pin first: the listing, then the event, then the poll.
    { name: 'three-pins', posts: pin(POSTS, ['m-2', 'e-1', 'p-1']), pins: ['m-2', 'e-1', 'p-1'] },
    { name: 'poll-last-column', posts: null, pins: [], minColumns: 3 },
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
                label: (cell.getAttribute('aria-label') || tile?.querySelector('h3')?.textContent || cell.textContent).trim().slice(0, 40),
                cellH: r.height, tracksHeight, tileH: t.height,
                blockH: block ? block.getBoundingClientRect().height : null,
                natural, pollNatural,
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
function check(m, spec, pins) {
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
        const lattice = (c) => c.kind === 'listing' || c.kind === 'pulse';
        for (const c of g.cells) {
            if (Math.abs(c.cellH - c.tracksHeight) > 1) fail(`${at}"${c.label}" cell is ${c.cellH.toFixed(1)}px in a ${c.tracksHeight.toFixed(1)}px row: not the row's height`);
            if (lattice(c)) {
                if (Math.abs(c.tileH - c.cellH) > 1) fail(`${at}"${c.label}" tile is ${c.tileH.toFixed(1)}px in a ${c.cellH.toFixed(1)}px cell: it does not fill it`);
                if (c.blockH === null || Math.abs(c.blockH - block) > 1) fail(`${at}"${c.label}" text block is ${c.blockH?.toFixed(1)}px (expected ${block.toFixed(1)})`);
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
            const what = c.kind === 'event' ? ' (event: on the lattice in W3\')' : c.kind === 'poll' ? ` ${c.colSpan} x ${c.rowSpan}, needs ${c.pollNatural?.toFixed(0)}px` : '';
            console.log(`      r${c.row + 1}c${c.col + 1} ${c.kind.padEnd(7)} ${c.pinned ? '📌 ' : ''}tile ${c.tileH.toFixed(0)}${c.blockH ? ` block ${c.blockH.toFixed(1)}` : ''}${what}  "${c.label}"`);
        }
    }
}

const problems = [];
const { origin, close } = await startServer();
const browser = await launch();
try {
    for (const kase of CASES) {
        for (const spec of WIDTHS) {
            if (kase.minColumns && spec.columns < kase.minColumns) continue;
            const posts = kase.posts ?? postsWithPollAt(spec.columns - 1);
            for (const dark of [false, true]) {
                const name = `${kase.name}-${spec.name}-${dark ? 'dark' : 'light'}`;
                const { context, page, unrouted } = await openMarket(browser, origin, {
                    width: spec.width, height: 1200, dark, textScale: spec.textScale ?? 1, posts,
                });
                if (spec.shim) await page.addStyleTag({ content: '#root { padding-left: 256px; }' });
                if (miss) await page.addStyleTag({ content: MISSES[miss] });
                if (spec.shim || miss) await settle(page);
                const file = path.join(out, `${name}.png`);
                const first = page.locator('div.grid.grid-flow-row-dense').first();
                await first.locator('..').screenshot({ path: file, animations: 'disabled' });
                const unexpected = [...new Set(unrouted)].filter(p => !ANSWERED_404.has(p));
                if (unexpected.length) problems.push(`${name}: unanswered API paths ${unexpected.join(', ')}`);
                const m = await page.evaluate(measure);
                const misses = check(m, spec, kase.pins);
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
