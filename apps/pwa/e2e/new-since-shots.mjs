#!/usr/bin/env node
/**
 * "New since you last looked" on the web (Market order S4, DESIGN-market-order-fable.md §2.9) at the floor: 320 px wide with
 * text at 1.3x, light and dark, in the list and in the grid, plus 1280 px. The real Market page through the e2e harness
 * (harness.mjs), every /api call answered from fixtures.mjs, and a stamp on the device as the page would have written it.
 *
 * Checks (each picture): exactly one line, whole on one row; no sideways scroll; the line sits between the posts newer than the
 * stamp and the first one at or before it, by the rects the browser drew (3 new posts: an odd count). Pictures go to e2e/screenshots/new-since (not committed).
 *
 *   node apps/pwa/e2e/new-since-shots.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openMarket, settle } from './harness.mjs';
import { POSTS } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'screenshots', 'new-since');
fs.mkdirSync(outDir, { recursive: true });

// Listed over the last few hours, one per 20 minutes, so they are all Today, and the stamp is the fourth post's own time.
const MIN = 60 * 1000;
const now = Date.now();
// Three more cards after the fixtures, so there are several already-seen tiles below the line: the 3 new cards are an odd
// count, which is when a dense grid pulled the first seen card up beside the last new one (review on #2811).
const more = POSTS.filter(p => p.type !== 'poll').slice(0, 3).map(p => ({ ...p, id: `${p.id}-again`, title: `${p.title} again` }));
const posts = [...POSTS, ...more].map((p, i) => ({ ...p, createdAt: new Date(now - (i + 1) * 20 * MIN).toISOString(), authorPublicKey: `member-${i}` }));
const STAMP = String(Date.parse(posts[3].createdAt));

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL', msg); };

async function run() {
    const server = await startServer();
    const browser = await launch();
    try {
        const configs = [
            { name: '320-x1.3-list-light', width: 320, height: 900, textScale: 1.3, dark: false, view: 'list' },
            { name: '320-x1.3-list-dark', width: 320, height: 900, textScale: 1.3, dark: true, view: 'list' },
            { name: '320-x1.3-grid-light', width: 320, height: 900, textScale: 1.3, dark: false, view: 'grid' },
            { name: '320-x1.3-grid-dark', width: 320, height: 900, textScale: 1.3, dark: true, view: 'grid' },
            { name: '1280-grid-light', width: 1280, height: 900, textScale: 1, dark: false, view: 'grid' },
        ];
        for (const cfg of configs) {
            const { context, page } = await openMarket(browser, server.origin, {
                width: cfg.width, height: cfg.height, dark: cfg.dark, textScale: cfg.textScale, posts,
                storage: { marketplace_view_mode: cfg.view, bp_market_seen_listed: STAMP },
            });
            console.log(cfg.name);
            const line = page.locator('[data-testid="market-new-since"]');
            await line.first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            const count = await line.count();
            if (count !== 1) fail(`${count} lines, want 1`);
            else {
                await line.scrollIntoViewIfNeeded();
                await settle(page);
                const facts = await page.evaluate((W) => {
                    const el = document.querySelector('[data-testid="market-new-since"]');
                    const label = el.querySelector('span');
                    const r = label.getBoundingClientRect();
                    const oneRow = r.height < parseFloat(getComputedStyle(label).lineHeight || '0') * 1.5 || r.height < 30 * (parseFloat(getComputedStyle(document.documentElement).fontSize) / 16);
                    return {
                        text: label.textContent, oneRow, height: r.height, right: el.getBoundingClientRect().right,
                        sideways: document.documentElement.scrollWidth > W,
                        // The post cards before and after the line, in document order.
                        before: el.previousElementSibling ? el.previousElementSibling.textContent.slice(0, 40) : null,
                        after: el.nextElementSibling ? el.nextElementSibling.textContent.slice(0, 40) : null,
                    };
                }, cfg.width);
                console.log('  line:', JSON.stringify(facts));
                if (facts.text !== 'New since you last looked') fail(`words: ${facts.text}`);
                if (!facts.oneRow) fail('the line wraps');
                if (facts.sideways) fail('sideways scroll');
                if (facts.right > cfg.width + 1) fail(`the line is drawn past the ${cfg.width}px edge`);
                if (!facts.before || !facts.after) fail('nothing on one side of the line');
                // The picture, not the DOM: with 3 new posts (an odd count) a dense grid used to draw the first seen tile beside the
                // last new one, above the line (review on #2811). Every card that comes before the line in the page must END above
                // it and every card after it must START below it, in the rects the browser drew.
                const layout = await page.evaluate(() => {
                    const el = document.querySelector('[data-testid="market-new-since"]');
                    const lr = el.getBoundingClientRect();
                    // Every tile of a grid and every row of a list (a listing, an event or a poll), not the buttons inside them.
                    const cards = [...document.querySelectorAll('.grid-flow-row-dense > *, div.flex.flex-col.gap-1\\.5.mb-2 > div.flex.flex-col.gap-1\\.5 > *')]
                        .filter(c => c.getBoundingClientRect().height > 40 && c !== el);
                    const above = cards.filter(c => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING);
                    const below = cards.filter(c => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
                    return {
                        above: above.length, below: below.length,
                        lateAbove: above.filter(c => c.getBoundingClientRect().bottom > lr.top + 1).map(c => (c.textContent || '').slice(0, 30)),
                        earlyBelow: below.filter(c => c.getBoundingClientRect().top < lr.bottom - 1).map(c => (c.textContent || '').slice(0, 30)),
                    };
                });
                console.log('  layout:', JSON.stringify(layout));
                if (layout.above < 3) fail(`only ${layout.above} cards before the line, want the 3 new posts`);
                if (layout.below < 1) fail('no card after the line');
                if (layout.lateAbove.length) fail(`drawn on or below the line though listed before it: ${layout.lateAbove.join(' | ')}`);
                if (layout.earlyBelow.length) fail(`drawn on or above the line though listed after it: ${layout.earlyBelow.join(' | ')}`);
            }
            await page.screenshot({ path: path.join(outDir, `new-since-${cfg.name}.png`), fullPage: false });
            await context.close();
        }
    } finally {
        await browser.close();
        await server.close();
    }
    console.log(failures ? `${failures} failure(s)` : 'all checks passed');
    process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
