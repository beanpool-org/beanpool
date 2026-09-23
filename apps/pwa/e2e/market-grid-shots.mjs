#!/usr/bin/env node
/**
 * Pictures of the Market grid (Card View), for review:
 *
 *   node e2e/market-grid-shots.mjs <out-dir>
 *
 * One picture of the grid per column count — 5 (1440px), 4 (1200px), 3 (800px), 2 (640px) and 1 (320px, at
 * normal and at 1.3x text) — in light and in dark. Nothing here talks to a node; the feed is e2e/fixtures.mjs.
 *
 * Then one more picture per column count from `md` up, of the case the first set cannot show: the poll sitting in
 * the LAST column of a row, where the two columns it asks for do not fit. A plain auto-placed grid pushes it to
 * the next row and leaves that cell empty; the grid is `grid-flow-row-dense` so the tiles after it back-fill.
 *
 * It also prints, for every width, what the pictures are meant to show, measured from the live layout rather
 * than eyeballed: the height of each listing tile, whether any VIEW button sits away from the bottom of its own
 * tile (the stretch this branch removes), whether any tile's CELL — the clickable, focusable grid item around
 * it — is taller than the tile, whether the VIEW buttons in a row line up, how many columns the poll spans,
 * whether any poll answer is truncated, and whether any row of the grid has an empty cell in it. A non-zero
 * exit means one of those is wrong.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openMarket, grid } from './harness.mjs';
import { postsWithPollAt } from './fixtures.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/market-grid-shots.mjs <out-dir>');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const WIDTHS = [
    { name: '5col-1440', width: 1440, columns: 5 },
    { name: '4col-1200', width: 1200, columns: 4 },
    { name: '3col-800', width: 800, columns: 3 },
    { name: '2col-640', width: 640, columns: 2 },
    { name: '1col-320', width: 320, columns: 1 },
    { name: '1col-320-x1.3', width: 320, columns: 1, textScale: 1.3 },
];

/**
 * Measured in the page: for every listing tile, the dead space between the last line of its description and the
 * top of its VIEW button — the gap Marty photographed. It has to be measured from the TEXT, not from the
 * description's box: VIEW stays pinned to the bottom by `mt-auto` and `flex-1` made the box itself swallow the
 * stretch, so both the box's edge and VIEW's were exactly where they should be while the card was hollow. Also
 * the tile's height, and how many
 * optional badge rows it carries (👤 You, ⏸ Paused, 🔒 group, 🗞️ Daily Pulse — each one is a row of its own in
 * the tile's header, and the only thing left that still changes a tile's height). Plus the poll's column span,
 * how many columns its answers are in, and whether any answer is clipped.
 */
function measure() {
    const gridEl = document.querySelector('div.grid.grid-cols-1');
    const cells = [...gridEl.children];
    const columns = getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean);
    const colCount = columns.length;
    // How many columns a cell covers, from its width: one column plus a gap for each extra column it takes.
    const colWidth = parseFloat(columns[0]);
    const gap = parseFloat(getComputedStyle(gridEl).columnGap) || 0;
    const spanOf = (el) => Math.round((el.getBoundingClientRect().width + gap) / (colWidth + gap));

    const tiles = cells
        .map((cell) => ({ cell, view: cell.querySelector('div.rounded-full.mt-auto') }))
        .filter(t => t.view)
        .map(({ cell, view }) => {
            const tile = cell.firstElementChild;
            const t = tile.getBoundingClientRect();
            const v = view.getBoundingClientRect();
            const p = tile.querySelector('p');
            const d = p.getBoundingClientRect();
            // line-clamp-1: one line of text, wherever the box's own bottom edge has ended up.
            const lineHeight = parseFloat(getComputedStyle(p).lineHeight);
            return {
                title: (tile.querySelector('span.font-bold')?.textContent || '').slice(0, 28),
                tileHeight: Math.round(t.height),
                // The cell, not the tile: the cell is the grid item, and it is what carries the click and the
                // focus ring. Without `self-start` the grid stretches it to the row while the tile keeps its
                // own height, so the two come apart.
                cellHeight: Math.round(cell.getBoundingClientRect().height),
                badgeRows: tile.firstElementChild.querySelectorAll(':scope > div > div.mt-1').length,
                // The description's own `mb-3` is the whole of this gap on a tile that is not stretched.
                gapBelowDescription: Math.round(v.top - (d.top + lineHeight)),
                viewBottom: Math.round(v.bottom + window.scrollY),
                tileTop: Math.round(t.top + window.scrollY),
            };
        });

    const pollCell = cells.find(c => c.textContent.includes('POLL'));
    const pollSpan = pollCell ? spanOf(pollCell) : 0;

    // Every row of the grid, by the columns its cells actually cover. Cells in one row share a top edge (the row
    // stretches them), so that is what groups them. Any row but the last that does not add up to the full column
    // count has a hole in it — the empty cell a two-column poll leaves behind when it will not fit.
    const byTop = new Map();
    for (const cell of cells) {
        const top = Math.round(cell.getBoundingClientRect().top + window.scrollY);
        byTop.set(top, (byTop.get(top) || 0) + spanOf(cell));
    }
    const rows = [...byTop.entries()].sort((a, b) => a[0] - b[0]);
    const rowFill = rows.map(([, filled]) => filled);

    // Where the poll ended up on screen — not where it is in the feed. `grid-flow-row-dense` can move the tiles
    // after it, so the only honest answer comes from the geometry.
    const gridLeft = gridEl.getBoundingClientRect().left;
    const pollAt = pollCell
        ? {
            row: rows.findIndex(([top]) => top === Math.round(pollCell.getBoundingClientRect().top + window.scrollY)) + 1,
            column: Math.round((pollCell.getBoundingClientRect().left - gridLeft) / (colWidth + gap)) + 1,
        }
        : null;
    const pollAnswers = pollCell
        ? [...pollCell.querySelectorAll('button span.font-bold')].map(s => ({
            text: s.textContent.trim().slice(0, 40),
            clipped: s.scrollWidth > s.clientWidth + 1,
        }))
        : [];
    // The answer buttons are the ones carrying aria-pressed; the author's profile button comes before them.
    const answerButton = pollCell && [...pollCell.querySelectorAll('button')].find(b => b.hasAttribute('aria-pressed'));
    const pollAnswerColumns = answerButton
        ? getComputedStyle(answerButton.parentElement).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0;

    return { colCount, tiles, pollSpan, pollAt, pollAnswers, pollAnswerColumns, rowFill };
}

/**
 * The tiles whose CELL is taller than the tile itself. The cell is the grid item: it carries the `onClick`, the
 * `role="button"` and the `focus-visible` ring, so every pixel of that overhang is blank space that opens the
 * listing when clicked and that the focus ring draws around. A grid with no `items-*` stretches its items to the
 * row, so in the poll's row — and the poll is the tallest thing in the grid by design — this was the whole
 * difference between a ~257px card and the poll. `self-start` on the cell is what closes it.
 */
const stretchedCells = (m) => m.tiles
    .map(t => ({ title: t.title, overhang: t.cellHeight - t.tileHeight }))
    .filter(t => t.overhang > 1);

/** The rows with an empty cell in them: every row but the last that does not fill its columns. */
const holes = (m) => m.rowFill
    .slice(0, -1)
    .map((filled, i) => ({ row: i + 1, filled }))
    .filter(r => r.filled < m.colCount);

const problems = [];
const note = (width, ok, message) => {
    console.log(`  ${ok ? '✓' : '✗'} ${message}`);
    if (!ok) problems.push(`${width}: ${message}`);
};

const { origin, close } = await startServer();
const browser = await launch();
try {
    for (const spec of WIDTHS) {
        for (const dark of [false, true]) {
            const { context, page, unrouted } = await openMarket(browser, origin, {
                width: spec.width, height: 1000, dark, textScale: spec.textScale ?? 1,
            });
            const file = path.join(out, `${spec.name}-${dark ? 'dark' : 'light'}.png`);
            await grid(page).screenshot({ path: file, animations: 'disabled' });
            console.log(file);

            if (unrouted.length) problems.push(`${spec.name}: unanswered API paths ${[...new Set(unrouted)].join(', ')}`);

            if (!dark) {
                const m = await page.evaluate(measure);
                const label = `${spec.width}px${spec.textScale ? ` @${spec.textScale}x` : ''}`;
                note(label, m.colCount === spec.columns, `${m.colCount} columns (expected ${spec.columns})`);

                // The stretch Marty photographed: dead space between the description and VIEW. On a tile that
                // takes its own height this is exactly the description's `mb-3`, which is 0.75rem and so follows
                // the text scale.
                const margin = Math.round(12 * (spec.textScale ?? 1));
                const worst = Math.max(...m.tiles.map(t => t.gapBelowDescription));
                note(label, worst <= margin + 2,
                    `no tile stretched — largest dead space between the description's line and VIEW is ${worst}px `
                    + `(the description's own margin is ${margin}px)`);

                // ...and the cell around it, which the tile's own box cannot show.
                const stretched = stretchedCells(m);
                note(label, stretched.length === 0,
                    `every cell is its tile's height — no clickable overhang below a card`
                    + `${stretched.length ? `: ${stretched.map(t => `"${t.title}" +${t.overhang}px`).join(', ')}` : ''}`);

                // Same height: a tile's height no longer depends on its text or on whether it has a photo. An
                // optional badge (👤 You, ⏸ Paused, 🔒 group, 🗞️ Daily Pulse) still adds its own row — see the PR.
                const plain = m.tiles.filter(t => t.badgeRows === 0);
                const heights = [...new Set(plain.map(t => t.tileHeight))];
                note(label, heights.length === 1,
                    `every listing tile without an extra badge is ${heights.join('/')}px tall (${plain.length} of ${m.tiles.length} tiles)`);
                for (const t of m.tiles.filter(t => t.badgeRows > 0)) {
                    console.log(`    · "${t.title}" carries ${t.badgeRows} badge row(s) and is ${t.tileHeight - heights[0]}px taller`);
                }

                // Lined up: tiles that start on the same row end their VIEW on the same line.
                const rows = new Map();
                for (const t of plain) rows.set(t.tileTop, [...(rows.get(t.tileTop) || []), t.viewBottom]);
                const ragged = [...rows.entries()].filter(([, bottoms]) => new Set(bottoms).size > 1);
                note(label, ragged.length === 0, `VIEW buttons line up in every row (${rows.size} rows of tiles)`);

                const expectedSpan = spec.width >= 768 ? 2 : 1;
                note(label, m.pollSpan === expectedSpan, `poll spans ${m.pollSpan} column(s) (expected ${expectedSpan})`);
                const expectedAnswerCols = spec.width >= 768 ? 2 : 1;
                note(label, m.pollAnswerColumns === expectedAnswerCols,
                    `poll answers in ${m.pollAnswerColumns} column(s) (expected ${expectedAnswerCols})`);

                const clipped = m.pollAnswers.filter(a => a.clipped);
                note(label, clipped.length === 0,
                    `no poll answer truncated${clipped.length ? `: ${clipped.map(c => c.text).join(' | ')}` : ''}`);

                const empty = holes(m);
                note(label, empty.length === 0,
                    `no row has an empty cell — rows are ${m.rowFill.join('/')} of ${m.colCount} columns`
                    + `${empty.length ? ` (row ${empty.map(e => e.row).join(', ')} short)` : ''}`);
            }
            await context.close();
        }
    }

    // The poll in the LAST column of a row. The feed above happens to put it where its two columns fit at every
    // width but 1200px, so on its own it would let a grid that cannot place a wide tile through. Here the poll is
    // moved to the last column of the first row at each column count, which is the worst case there is.
    console.log('\nPoll in the last column of a row:');
    for (const spec of WIDTHS.filter(w => w.columns >= 3)) {
        const posts = postsWithPollAt(spec.columns - 1);
        const { context, page, unrouted } = await openMarket(browser, origin, {
            width: spec.width, height: 1000, posts,
        });
        const file = path.join(out, `poll-last-column-${spec.name}-light.png`);
        await grid(page).screenshot({ path: file, animations: 'disabled' });
        console.log(file);

        if (unrouted.length) problems.push(`poll-last-column-${spec.name}: unanswered API paths ${[...new Set(unrouted)].join(', ')}`);

        const m = await page.evaluate(measure);
        const label = `${spec.width}px, poll at ${spec.columns - 1}`;
        note(label, m.colCount === spec.columns, `${m.colCount} columns (expected ${spec.columns})`);
        note(label, m.pollSpan === 2, `poll still spans ${m.pollSpan} column(s) (expected 2)`);

        // This pass puts the poll in a row with listing tiles at every width, so it is the strongest case for
        // the overhang: the poll sets the row height and the tiles beside it are half of it.
        const stretched = stretchedCells(m);
        note(label, stretched.length === 0,
            `every cell is its tile's height — no clickable overhang below a card`
            + `${stretched.length ? `: ${stretched.map(t => `"${t.title}" +${t.overhang}px`).join(', ')}` : ''}`);

        // Without `grid-flow-row-dense` this is where the grid leaves a hole: the poll cannot start in the last
        // column, moves to the next row, and the cell it passed over stays blank.
        const empty = holes(m);
        note(label, empty.length === 0,
            `no row has an empty cell — rows are ${m.rowFill.join('/')} of ${m.colCount} columns`
            + `${empty.length ? ` (row ${empty.map(e => e.row).join(', ')} short)` : ''}`);
        console.log(`    · the poll asked for the last column of row 1 and is drawn at row ${m.pollAt.row}, `
            + `column ${m.pollAt.column}`
            + `${empty.length ? ', and row 1 is left with a blank cell' : '; a tile from after it fills row 1 instead'}`);
        await context.close();
    }
} finally {
    await browser.close();
    await close();
}

if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}
console.log('\nMarket grid: every width checked.');
