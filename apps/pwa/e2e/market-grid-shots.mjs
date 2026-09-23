#!/usr/bin/env node
/**
 * Pictures of the Market grid (Card View), for review:
 *
 *   node e2e/market-grid-shots.mjs <out-dir>
 *
 * One picture of the grid per column count — 5 (1440px), 4 (1200px), 3 (800px), 2 (640px) and 1 (320px, at
 * normal and at 1.3x text) — in light and in dark. Nothing here talks to a node; the feed is e2e/fixtures.mjs.
 *
 * It also prints, for every width, what the pictures are meant to show, measured from the live layout rather
 * than eyeballed: the height of each listing tile, whether any VIEW button sits away from the bottom of its own
 * tile (the stretch this branch removes), whether the VIEW buttons in a row line up, how many columns the poll
 * spans, and whether any poll answer is truncated. A non-zero exit means one of those is wrong.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openMarket, grid } from './harness.mjs';

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
    const colCount = getComputedStyle(gridEl).gridTemplateColumns.split(' ').filter(Boolean).length;

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
                badgeRows: tile.firstElementChild.querySelectorAll(':scope > div > div.mt-1').length,
                // The description's own `mb-3` is the whole of this gap on a tile that is not stretched.
                gapBelowDescription: Math.round(v.top - (d.top + lineHeight)),
                viewBottom: Math.round(v.bottom + window.scrollY),
                tileTop: Math.round(t.top + window.scrollY),
            };
        });

    const pollCell = cells.find(c => c.textContent.includes('POLL'));
    const pollSpan = pollCell
        ? Math.round(pollCell.getBoundingClientRect().width / (gridEl.getBoundingClientRect().width / colCount))
        : 0;
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

    return { colCount, tiles, pollSpan, pollAnswers, pollAnswerColumns };
}

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
            }
            await context.close();
        }
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
