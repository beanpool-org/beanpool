/* eslint-disable no-undef */
/**
 * Home's Market card as picture tiles (slice S8) on the web, at the floor: 320 px wide with text at 130% (the shared
 * recipe, harness.mjs TEXT_SCALE_CSS), in light and dark, in every language: node apps/pwa/e2e/home-market-tiles-320.mjs [--shots <dir>]
 *
 * The real HomePage and stylesheet with only the Market card (e2e/home-market-tiles-harness.tsx); every /api call is answered
 * here and nothing leaves the machine. Every number is read from the live layout. Rows (review of #3322 at 58c7d736):
 *   - a one-word title of 60 letters, a title of three lines and more, a right-to-left title: each is cut to two lines with
 *     an ellipsis (the clamp is in force, its box two lines tall, more words than it shows), and no word runs past the tile;
 *   - OFFER and NEED on the photo's corner in each of the 25 languages (the web's own words, 'listing type'): the chip sits
 *     whole inside its photo, on one line, its word not cut;
 *   - the two tiles of a row share it equally, and the page never scrolls sideways.
 * Run by the pwa_wide_pages check (package.json wide-pages-check).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEXT_SCALE_CSS } from './harness.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;
const SCALE = 1.3;

const LIMIT_S = Number(process.env.HOME_MARKET_TILES_LIMIT_S || 240);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

// ---------- the rows ----------

const ONE_WORD = 'Neighbourhoodwheelbarrowpuncturerepairsandhandlesharpeningok';
const THREE_LINES = 'Hand-built cedar garden bench with a curved back, oiled twice, seats three';
const RTL = 'دراجة هوائية للأطفال بحالة ممتازة مع خوذة وأضواء وجرس';
if ([...ONE_WORD].length !== 60 || /\s/.test(ONE_WORD)) throw new Error('the one-word title must be one word of 60 letters');

const ITEMS = [
    { id: 't1', row: 'one word of 60 letters', clamp: true, type: 'offer', title: ONE_WORD, category: 'tools', price_c: 1200, photoUrl: null },
    { id: 't2', row: 'three lines and more', clamp: true, type: 'need', title: THREE_LINES, category: 'goods', price_c: 2500, photoUrl: null },
    { id: 't3', row: 'right to left', clamp: true, rtl: true, type: 'offer', title: RTL, category: 'goods', price_c: 800, photoUrl: null },
    { id: 't4', row: 'short', clamp: false, type: 'need', title: 'Duck eggs', category: 'food', price_c: 500, photoUrl: null },
];

// Every language the web ships: English and each of its words files, OFFER and NEED in the chip's own context.
const WORDS_DIR = path.join(PWA_DIR, 'words');
const LANGS = [{ lang: 'en', OFFER: 'OFFER', NEED: 'NEED' }].concat(fs.readdirSync(WORDS_DIR).filter(f => f.endsWith('.json')).sort().map((f) => {
    const cat = JSON.parse(fs.readFileSync(path.join(WORDS_DIR, f), 'utf8'));
    return { lang: f.replace(/\.json$/, ''), OFFER: cat['OFFER\u0004listing type'], NEED: cat['NEED\u0004listing type'] };
}));
if (LANGS.length < 25 || LANGS.some(l => !l.OFFER || !l.NEED)) throw new Error(`expected 25 languages each with OFFER and NEED, read ${LANGS.length}`);

const homeAnswer = () => ({
    generatedAt: new Date().toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: [{ id: 'market', type: 'market' }], dismissed: {}, updatedAt: null },
    cards: {
        needs: { items: [] },
        market: { items: ITEMS.map(({ row, clamp, rtl, ...item }) => item), total14d: ITEMS.length, more: false },
    },
});

// ---------- reading the live layout ----------

/** Each tile's boxes, its title's lines and clamp, its chip, from the page as drawn. */
const readTiles = (page) => page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const grid = document.querySelector('[data-testid="home-market-items"]');
    return {
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        grid: rect(grid),
        tiles: Array.from(grid.querySelectorAll('[data-testid="home-market-item"]')).map((tile) => {
            const slot = tile.querySelector('[data-testid="home-photo-slot"]');
            const chip = slot.querySelector(':scope > span[aria-hidden="true"]');
            const title = tile.querySelector(':scope > span[dir="auto"]');
            const ts = getComputedStyle(title);
            const cs = getComputedStyle(chip);
            // Where words are drawn: the text's own line boxes, so a word running past the tile shows even where a parent
            // clips it. The category tile's name is the shared CategoryTile's, which ends its own long names in an ellipsis
            // (checked where it is made); its box must still sit inside the photo.
            const drawn = (root, skip) => {
                let left = Infinity; let right = -Infinity;
                const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                    if (skip && n.parentElement?.closest(skip)) continue;
                    const range = document.createRange();
                    range.selectNodeContents(n);
                    for (const r of range.getClientRects()) {
                        if (r.width === 0) continue;
                        left = Math.min(left, r.left); right = Math.max(right, r.right);
                    }
                }
                return { left, right };
            };
            const text = drawn(tile, '[data-testid="category-tile"]');
            const titleText = drawn(title, null);
            const cat = slot.querySelector('[data-testid="category-tile"]');
            return {
                tile: rect(tile), slot: rect(slot), chip: rect(chip), textLeft: text.left, textRight: text.right, cat: cat ? rect(cat) : null,
                chipText: chip.textContent, chipScroll: chip.scrollWidth, chipClient: chip.clientWidth,
                chipLine: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5, chipPadY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), chipFont: parseFloat(cs.fontSize),
                title: rect(title), titleDisplay: ts.display, titleClamp: ts.webkitLineClamp, titleDir: ts.direction,
                titleLine: parseFloat(ts.lineHeight), titleScrollH: title.scrollHeight, titleClientH: title.clientHeight,
                titleTextLeft: titleText.left, titleTextRight: titleText.right,
            };
        }),
    };
});

const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } return ok; };
const px = (n) => `${Math.round(n * 10) / 10}px`;

/** The rows for one language and look. Title rows are reported in English; chips in every language. */
function judge(label, read, l, report) {
    check(read.sideways <= 0, `${label}: the page scrolls sideways by ${px(read.sideways)}`);
    check(read.tiles.length === ITEMS.length, `${label}: ${read.tiles.length} tiles drawn, wanted ${ITEMS.length}`);
    for (let i = 0; i + 1 < read.tiles.length; i += 2) {
        const [a, b] = [read.tiles[i].tile, read.tiles[i + 1].tile];
        check(Math.abs(a.width - b.width) < 1, `${label}: tiles ${i + 1} and ${i + 2} share their row unequally (${px(a.width)} and ${px(b.width)})`);
    }
    const chips = [];
    read.tiles.forEach((t, i) => {
        const item = ITEMS[i];
        const row = `${label}, ${item.row}`;
        // Nothing runs past the tile or out of the card.
        check(t.tile.left >= read.grid.left - 0.5 && t.tile.right <= read.grid.right + 0.5, `${row}: the tile runs out of the card (${px(t.tile.left)}..${px(t.tile.right)} in ${px(read.grid.left)}..${px(read.grid.right)})`);
        check(t.textLeft >= t.tile.left - 0.5 && t.textRight <= t.tile.right + 0.5, `${row}: words drawn past the tile (${px(t.textLeft)}..${px(t.textRight)} in ${px(t.tile.left)}..${px(t.tile.right)})`);
        check(!t.cat || (t.cat.left >= t.slot.left - 0.5 && t.cat.right <= t.slot.right + 0.5), `${row}: the category tile runs out of the photo`);
        // Read from the words as drawn, not scrollWidth: a right-to-left line's hanging space counts in scrollWidth, unseen.
        check(t.titleTextLeft >= t.title.left - 0.5 && t.titleTextRight <= t.title.right + 0.5, `${row}: the title is cut sideways (${px(t.titleTextLeft)}..${px(t.titleTextRight)} in ${px(t.title.left)}..${px(t.title.right)})`);
        // The title: never more than two lines; a long one cut with an ellipsis (the clamp in force and more words than it shows).
        const lines = t.title.height / t.titleLine;
        check(lines <= 2.05, `${row}: the title takes ${lines.toFixed(1)} lines, the tile allows 2`);
        if (item.clamp) {
            // Judged by its effect, not the display's name (Chromium 153 reports a clamped box as flow-root, older ones as
            // -webkit-box): two lines drawn, the clamp set, and more words than it shows, which the clamp ends in an ellipsis.
            check(String(t.titleClamp) === '2', `${row}: the title has no two-line clamp (line clamp ${t.titleClamp})`);
            check(t.titleScrollH > t.titleClientH + 1, `${row}: the title is not cut, so no ellipsis (${t.titleScrollH}px of ${t.titleClientH}px shown, display ${t.titleDisplay})`);
        }
        if (item.rtl) check(t.titleDir === 'rtl', `${row}: the title reads ${t.titleDir}, wanted rtl`);
        if (l.lang === 'en') report.push(`  ${row}: ${lines.toFixed(1)} lines (${px(t.title.height)} at ${px(t.titleLine)} a line), ${t.titleDisplay}${item.rtl ? `, ${t.titleDir}` : ''}`);
        // The chip: its word, whole, inside the photo, on one line.
        const kind = item.type === 'need' ? 'NEED' : 'OFFER';
        const chip = `${label}, ${kind} «${t.chipText}»`;
        check(t.chipText === l[kind], `${chip}: the chip says «${t.chipText}», the words file says «${l[kind]}»`);
        check(t.chip.left >= t.slot.left - 0.5 && t.chip.right <= t.slot.right + 0.5 && t.chip.top >= t.slot.top - 0.5 && t.chip.bottom <= t.slot.bottom + 0.5,
            `${chip}: cut by the photo's edge (chip ${px(t.chip.left - t.slot.left)}..${px(t.chip.right - t.slot.left)} in a photo ${px(t.slot.width)} wide)`);
        check(t.chipScroll <= t.chipClient + 1, `${chip}: the word is cut inside the chip (${t.chipScroll}px of ${t.chipClient}px)`);
        check(t.chip.height <= t.chipLine + t.chipPadY + 1.5, `${chip}: the chip runs to two lines (${px(t.chip.height)})`);
        if (i < 2) chips.push(`${kind} «${t.chipText}» ${px(t.chip.right - t.slot.left)}/${px(t.slot.width)} at ${px(t.chipFont)}`);
    });
    report.push(`  ${label}: ${chips.join(', ')}`);
}

// ---------- the page ----------

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/home-market-tiles-harness.html`;
const browser = await chromium.launch();

try {
    for (const scheme of ['light', 'dark']) {
        console.log(`\n320 px, text 130%, ${scheme}`);
        const context = await browser.newContext({ viewport: { width: WIDTH, height: 1400 }, colorScheme: scheme, reducedMotion: 'reduce' });
        await context.addInitScript(([mode]) => {
            try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
        }, [scheme]);
        await context.route('**/api/**', async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname !== '/api/home') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
            return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: 'W/"tiles-1"' }, body: JSON.stringify(homeAnswer()) }).catch(() => {});
        });
        await context.route('**/socket.io/**', (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(base, { waitUntil: 'load' });
        await page.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
        await page.waitForSelector('[data-testid="home-market-item"]', { timeout: 60_000 });

        const report = [];
        for (const l of LANGS) {
            if (l.lang !== 'en') check(await page.evaluate((lang) => window.__showLanguage(lang), l.lang), `${scheme} ${l.lang}: the words did not load`);
            await page.waitForFunction(([lang, offer]) => document.documentElement.lang === lang
                && document.querySelector('[data-testid="home-photo-slot"] > span[aria-hidden="true"]')?.textContent === offer, [l.lang, l.OFFER]).catch(() => {});
            await page.evaluate(() => document.fonts?.ready).catch(() => {});
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))));
            judge(`${scheme} ${l.lang}`, await readTiles(page), l, report);
            if (SHOTS && (l.lang === 'en' || l.lang === 'ru')) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.locator('[data-testid="home-card-market"]').screenshot({ path: path.join(SHOTS, `home-market-tiles-320-130-${scheme}-${l.lang}.png`) });
            }
        }
        console.log(report.join('\n'));
        check(!errors.length, `${scheme}: page errors: ${errors.join(' | ')}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (failures.length) {
    console.error(`\nweb home-market-tiles-320: ${failures.length} failed`);
    process.exit(1);
}
console.log('\nweb home-market-tiles-320: passed');
process.exit(0);
