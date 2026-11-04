#!/usr/bin/env node
/**
 * Pictures of the web Market's page column by view (style box V1: DESIGN-card-style-box-fable.md §4 row V1), for review:
 *
 *   node e2e/market-view-column-shots.mjs <out-dir>
 *
 * The grid uses the width (max-w-7xl, 1280 px at most); the list and the compact view are a phone-width column, 672 px at
 * most (max-w-2xl), centred beside the sidebar. Three screens, each in the grid, the list and the compact view, light and dark:
 *   - 320 px at 1.3x text (a phone: nothing may move),
 *   - 1280 px with the 256 px sidebar's room kept free (a laptop: the page has 1024 px),
 *   - 2560 px with the sidebar's room kept free (a wide window: the page has 2304 px).
 * The harness has no App shell, so the sidebar is a 256 px left padding on the root, which is all the App's `w-64` aside is to
 * the page. Nothing here talks to a node: the feed is e2e/fixtures.mjs.
 *
 * It checks, in the live layout: the list and the compact view's column and every card are 672 px or less and the column is
 * centred in the room the page has; the grid's column is as wide as before (the room, to 1280 px); nothing is wider than the
 * screen; the search row, the filters and the cards are inside the column. For each wide list or compact case it also prints
 * the "before": the same page with the grid's max-w-7xl put back on the column. A non-zero exit means one of those is wrong.
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document -- Node, plus page.evaluate callbacks run in the browser */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openMarket, settle } from './harness.mjs';
import { POSTS } from './fixtures.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/market-view-column-shots.mjs <out-dir>');
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const SIDEBAR = 256;
const SCREENS = [
    { name: '320-x1.3', width: 320, textScale: 1.3, sidebar: 0, height: 900 },
    { name: '1280-sidebar', width: 1280, sidebar: SIDEBAR, height: 900 },
    { name: '2560-sidebar', width: 2560, sidebar: SIDEBAR, height: 1100 },
];
const MODES = ['grid', 'list', 'compact'];
const LIST_COLUMN_MAX = 672; // max-w-2xl
const GRID_COLUMN_MAX = 1280; // max-w-7xl

/** In the page: the column, its room, the cards, and anything that sticks out of the column or the screen. */
function measure(sidebar) {
    const col = document.querySelector('[data-testid="market-view-column"]');
    const box = col.getBoundingClientRect();
    const inside = (el) => {
        const r = el.getBoundingClientRect();
        return r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    };
    // A list or compact card's wrapper: the children of a section's list (the section is the outer `flex flex-col gap-1.5`,
    // holding the heading and then the list, itself a `flex flex-col gap-1.5`), so the heading and the list are not counted.
    const cards = [...col.querySelectorAll('.flex.flex-col.gap-1\\.5 > .flex.flex-col.gap-1\\.5 > div')];
    const search = col.querySelector('input[type="search"], input[placeholder]');
    const filter = col.querySelector('[data-testid="feed-type-filter"]');
    const grid = col.querySelector('div.grid.grid-flow-row-dense');
    return {
        room: document.documentElement.clientWidth - sidebar,
        left: box.left - sidebar,
        right: document.documentElement.clientWidth - box.right,
        width: box.width,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        cards: cards.length,
        widest: cards.reduce((m, c) => Math.max(m, c.getBoundingClientRect().width), 0),
        search: !!search && inside(search),
        filter: !!filter && inside(filter),
        allInside: cards.every(inside),
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
    };
}

const server = await startServer();
const browser = await launch();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

try {
    for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        for (const screen of SCREENS) {
            for (const mode of MODES) {
                const { context, page } = await openMarket(browser, server.origin, {
                    width: screen.width, height: screen.height, dark, textScale: screen.textScale ?? 1,
                    storage: { marketplace_view_mode: mode },
                });
                if (screen.sidebar) {
                    await page.addStyleTag({ content: `#root { box-sizing: border-box; padding-left: ${screen.sidebar}px; }` });
                    await settle(page);
                }
                const label = `${theme} ${screen.name} ${mode}`;
                const m = await page.evaluate(measure, screen.sidebar);
                const wide = m.room > LIST_COLUMN_MAX;

                check(m.scrollWidth <= m.clientWidth, `${label}: nothing wider than the screen (${m.scrollWidth} of ${m.clientWidth}px)`);
                check(m.search && m.filter, `${label}: the search row and the filters are inside the column`);
                if (mode === 'grid') {
                    const expected = Math.min(m.room, GRID_COLUMN_MAX);
                    check(Math.abs(m.width - expected) < 1, `${label}: the grid's column is as wide as before (${m.width}px; the room is ${m.room}px, 1280 at most) in ${m.columns} column(s)`);
                } else {
                    const expected = Math.min(m.room, LIST_COLUMN_MAX);
                    check(m.cards === POSTS.length, `${label}: ${m.cards} cards measured (the feed has ${POSTS.length} posts)`);
                    check(Math.abs(m.width - expected) < 1, `${label}: the column is ${m.width}px (the room is ${m.room}px, ${LIST_COLUMN_MAX} at most)`);
                    check(m.widest <= LIST_COLUMN_MAX, `${label}: the widest card is ${Math.round(m.widest)}px (672 at most)`);
                    check(m.allInside, `${label}: every card is inside the column`);
                    if (wide) {
                        check(Math.abs(m.left - m.right) < 1, `${label}: the column is centred in the room (${m.left}px each side, ${m.right}px)`);
                        // The before: the grid's max-w-7xl put back on the same page.
                        await page.evaluate(() => {
                            const col = document.querySelector('[data-testid="market-view-column"]');
                            col.classList.remove('max-w-2xl');
                            col.classList.add('max-w-7xl');
                        });
                        await settle(page);
                        const before = await page.evaluate(measure, screen.sidebar);
                        console.log(`     before (max-w-7xl): column ${before.width}px, widest card ${Math.round(before.widest)}px  ->  after: column ${m.width}px, widest card ${Math.round(m.widest)}px`);
                        await page.evaluate(() => {
                            const col = document.querySelector('[data-testid="market-view-column"]');
                            col.classList.remove('max-w-7xl');
                            col.classList.add('max-w-2xl');
                        });
                        await settle(page);
                    } else {
                        check(Math.abs(m.width - m.room) < 1, `${label}: on a screen narrower than the column, the column is the screen (${m.width}px)`);
                    }
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await page.screenshot({ path: path.join(out, `${theme}-${screen.name}-${mode}.png`) });
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
