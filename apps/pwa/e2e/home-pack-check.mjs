/* eslint-disable no-undef */
// Home's packing in a real browser (PR #2748, DESIGN-home-layout-fable.md §3.1 and slice L1), with cards that grow after
// mount: node apps/pwa/e2e/home-pack-check.mjs [--out <dir>] [--only widths,loop,hops,narrow]
//
// The real HomePage, its cards and stylesheet (e2e/home-pack-harness.tsx); every /api call is routed here, nothing leaves
// the machine. Every number is read from the live layout: each direct child of the grid is a box, the boxes are stacked
// by column, and each neighbour pair is measured, before and after a card grows. A card under a full row or a card must
// stand 12 to 20 px below it, and nothing overlaps. Writes the shots and report.json to --out (default e2e/screenshots/home-pack).
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const argAt = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT_DIR = path.resolve(argAt('--out') ?? path.join(PWA_DIR, 'e2e', 'screenshots', 'home-pack'));
const ONLY = argAt('--only')?.split(',') ?? ['widths', 'narrow', 'loop', 'hops'];
fs.mkdirSync(OUT_DIR, { recursive: true });
const AXE = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

// A browser step that never comes back must end the run, not hold it: this is run by hand and by headless lanes.
const LIMIT_S = Number(process.env.HOME_PACK_LIMIT_S || 280);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const failures = [];
const report = {};
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

// ---------- the fixture: a long, busy Home ----------

const LONG_HOME = ['safety', 'tips', 'deals', 'events', 'market', 'decide', 'groups', 'joined', 'pulse', 'beans', 'notices', 'interests'];
const TITLES = ['Pottery lessons', 'Sourdough', 'Borrow a drill', 'Seedlings to give away', 'Bike repairs on Saturdays', 'Duck eggs', 'Long ladder', 'Help at the market stall', 'Mend the polytunnel', 'Pick the olives'];
const day = 86_400_000;
const NOW = Date.now();

function answer({ listings = 4, events = 2 } = {}) {
    return {
        generatedAt: new Date(NOW).toISOString(), profile: 'local',
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
        me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
        layout: { v: 2, cards: LONG_HOME.map(t => ({ id: t, type: t })), dismissed: {}, updatedAt: null },
        cards: {
            needs: { items: [{ kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you: Sourdough', target: { to: 'deal', postId: 'p2', txId: 't1' } }] },
            safety: { words: true, signInLinked: false },
            deals: { open: 2, waiting: 1, waitingOnMe: null },
            events: {
                items: Array.from({ length: events }, (_, i) => ({ id: `e${i}`, title: ['Seed swap', 'Repair cafe', 'Farmers market', 'Skill share', 'Community lunch'][i % 5], startsAt: new Date(NOW + (i + 1) * day).toISOString(), endsAt: null, place: 'Town Hall', rsvp: i ? null : 'going' })),
                radiusKm: null,
            },
            market: {
                items: Array.from({ length: listings }, (_, i) => ({ id: `p${i}`, type: i % 3 === 2 ? 'need' : 'offer', title: TITLES[i % TITLES.length], category: 'food', price_c: (10 + i) * 100, photoUrl: null })),
                total14d: listings, more: false,
            },
            decide: { open: 1, soonestClosesAt: new Date(NOW + 3 * day).toISOString(), polls: 2, pollsMore: false },
            groups: { items: [{ id: 'g1', kind: 'group', name: 'Garden group', unread: 2, muted: false }, { id: 'g2', kind: 'group', name: 'Tool library', unread: 0, muted: false }], total: 2 },
            joined: { count7d: 5, radiusKm: null, names: [{ callsign: 'Kofi', avatarUrl: null }, { callsign: 'Wren', avatarUrl: null }] },
            pulse: { items: [{ id: 'u1', title: 'How our LETS started', thumbnailUrl: null, platform: 'youtube', callsign: 'River Folk', category: 'education', url: null }, { id: 'u2', title: 'Mending day at the hall', thumbnailUrl: null, platform: 'youtube', callsign: 'Wren', category: 'education', url: null }] },
            beans: { balance_c: 123456, room_c: 20000, tier: 'Resident', activated: true, frozen: false },
            notices: { unseen: 1, first: { id: 'n1', title: 'Market day moved', line: 'Saturday, not Sunday.' } },
            community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
        },
    };
}

// ---------- the page ----------

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/home-pack-harness.html`;

async function open(browser, { width, height = 900, dark = false, textScale = 1 }) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
    }, [dark ? 'dark' : 'light']);
    const node = { answer: answer(), held: null, tag: 1 };
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== '/api/home') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
        if (node.held) await node.held;
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: `W/"pack-${node.tag}"` }, body: JSON.stringify(node.answer) }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base, { waitUntil: 'load' });
    if (textScale !== 1) {
        await page.addStyleTag({ content: `html { font-size: ${textScale * 100}% !important; }\n${[8, 9, 10, 11, 12, 13, 14, 15, 16].map(px => `.text-\\[${px}px\\] { font-size: ${px * textScale}px !important; }`).join('\n')}` });
    }
    await page.waitForSelector('[data-testid="home-card-community"]', { timeout: 60_000 });
    await settle(page);
    return { context, page, node, errors };
}

const settle = async (page) => {
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120)))));
};

/** The grid's children as boxes, from the live layout. */
const readBoxes = (page) => page.evaluate(() => {
    const grid = document.querySelector('[data-testid="home-grid"]');
    return {
        columns: Number(document.querySelector('[data-testid="home-page"]').dataset.columns),
        autoRows: grid.style.gridAutoRows,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        boxes: Array.from(grid.children).map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.testid, left: Math.round(r.left), width: Math.round(r.width), top: r.top + scrollY, bottom: r.bottom + scrollY, row: el.style.gridRow, col: el.style.gridColumn };
        }).filter(b => b.bottom > b.top),
    };
});

/** Neighbours in each column: the gaps, the worst overlap. A card over a full row may wait for its column; a card never does. */
/**
 * A picture of the whole page as a member has it. Not `fullPage`: Chromium shrinks the viewport to 1×1 for a moment, the packing
 * falls to one column and comes back, and the shot lands in that moment, with a gap and a card in a column no member ever sees.
 * A resize of the height alone writes no style.
 */
async function wholePage(page, file) {
    const size = page.viewportSize();
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height });
    await page.screenshot({ path: file });
    await page.setViewportSize(size);
}

function measure({ boxes }) {
    const lefts = [...new Set(boxes.filter(b => b.col !== '1 / -1').map(b => b.left))].sort((a, b) => a - b);
    const gaps = [];
    for (const left of lefts) {
        const stack = boxes.filter(b => b.left === left || b.col === '1 / -1').sort((a, b) => a.top - b.top);
        for (let i = 1; i < stack.length; i += 1) gaps.push({ over: stack[i - 1].id, under: stack[i].id, gap: stack[i].top - stack[i - 1].bottom, waits: stack[i].col === '1 / -1' });
    }
    const tight = gaps.map(g => g.gap);
    const free = gaps.filter(g => !g.waits).map(g => g.gap);
    return { gaps, lefts, smallest: Math.min(...tight), largest: Math.max(...free, 0) };
}

function assertPacked(label, layout) {
    const m = measure(layout);
    const near = (n) => Math.round(n * 10) / 10;
    check(layout.autoRows === '4px' && m.lefts.length === layout.columns, `${label}: packed in ${layout.columns} columns`);
    check(m.smallest >= 12, `${label}: no overlap (closest neighbours ${near(m.smallest)} px apart)`);
    check(m.largest <= 20, `${label}: no gap (widest ${near(m.largest)} px, the design's limit 20)`);
    if (m.largest > 20 || m.smallest < 12) console.error(m.gaps.filter(g => g.gap < 12 || (!g.waits && g.gap > 20)));
    check(!layout.sideways, `${label}: no sideways scroll`);
    return m;
}

const grow = (page, testId, px) => page.evaluate(([id, h]) => {
    const extra = document.createElement('div');
    extra.dataset.grown = '1';
    extra.style.height = `${h}px`;
    document.querySelector(`[data-testid="${id}"]`).appendChild(extra);
}, [testId, px]);
const ungrow = (page) => page.evaluate(() => document.querySelectorAll('[data-grown]').forEach(e => e.remove()));
const spanOf = (layout, id) => Number(layout.boxes.find(b => b.id === id)?.row.split('span ')[1]);

// ---------- 1280 and 1600 px, light and dark: cards that grow after mount ----------

async function widths(browser) {
    for (const width of [1280, 1600]) for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        const name = `${width} ${theme}`;
        console.log(`\n${name}`);
        const { context, page, node, errors } = await open(browser, { width, dark });
        const entry = (report[`${width}-${theme}`] = {});
        const steps = entry.steps = {};
        const note = (step, layout) => { const m = assertPacked(`${name}, ${step}`, layout); steps[step] = { closest: Math.round(m.smallest * 10) / 10, widest: Math.round(m.largest * 10) / 10 }; return m; };
        const domOrder = (layout) => layout.boxes.map(b => b.id);

        const first = await readBoxes(page);
        note('landed', first);
        await wholePage(page, path.join(OUT_DIR, `home-${width}-${theme}-1-landed.png`));

        // A card that loads late: the kept answer drawn, then the node's, with the Market and Coming up longer.
        node.held = new Promise((release) => { node.release = release; });
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('[data-testid="home-card-community"]');
        await settle(page);
        const cached = await readBoxes(page);
        note('kept answer drawn', cached);
        node.answer = answer({ listings: 8, events: 5 });
        node.tag += 1;
        const release = node.release;
        node.held = null;
        release();
        await page.waitForFunction((was) => document.querySelector('[data-testid="home-card-market"]').offsetHeight !== was, cached.boxes.find(b => b.id === 'home-card-market').bottom - cached.boxes.find(b => b.id === 'home-card-market').top);
        await settle(page);
        const late = await readBoxes(page);
        note('Market and Coming up grew late', late);
        check(spanOf(late, 'home-card-market') > spanOf(cached, 'home-card-market'), `${name}: the late card's span followed it (${spanOf(cached, 'home-card-market')} → ${spanOf(late, 'home-card-market')})`);
        check(domOrder(late).join() === domOrder(cached).join(), `${name}: the DOM order is the saved order`);
        await wholePage(page, path.join(OUT_DIR, `home-${width}-${theme}-2-late-card.png`));

        // A card that opens, and closes: what the "One way back" frame does on a sign-in problem, and an ordinary card.
        const open1 = await readBoxes(page);
        await grow(page, 'one-way-back-landing', 120);
        await settle(page);
        const frameTaller = await readBoxes(page);
        note('"One way back" grew', frameTaller);
        check(spanOf(frameTaller, 'home-card-safety') > spanOf(open1, 'home-card-safety'), `${name}: the frame's span followed it`);
        await grow(page, 'home-card-events', 260);
        await settle(page);
        const opened = await readBoxes(page);
        note('Coming up opened', opened);
        await wholePage(page, path.join(OUT_DIR, `home-${width}-${theme}-3-card-opened.png`));
        await ungrow(page);
        await settle(page);
        const closed = await readBoxes(page);
        note('both closed', closed);
        check(closed.boxes.map(b => `${b.id}${b.row}${b.col}`).join() === open1.boxes.map(b => `${b.id}${b.row}${b.col}`).join(), `${name}: closing puts every card back where it stood`);

        // A real open-and-close: Tips' Next redraws the card; the two ✕ take a packed child away.
        const next = page.locator('[data-testid="home-card-tips"] button', { hasText: 'Next' }).first();
        if (await next.count()) { await next.click(); await settle(page); note('Tips: Next', await readBoxes(page)); }
        const closeHint = page.getByRole('button', { name: 'Close this tip' });
        if (await closeHint.count()) { await closeHint.click(); await settle(page); note('the hint closed', await readBoxes(page)); }
        await page.getByRole('button', { name: 'Hide this for now' }).click();
        await settle(page);
        const noFrame = await readBoxes(page);
        note('"One way back" put away', noFrame);
        check(!noFrame.boxes.some(b => b.id === 'home-card-safety'), `${name}: its cell went with it`);

        // A window resize, down through a change of columns and back.
        for (const w of [width - 60, width - 180, width - 320, width]) {
            await page.setViewportSize({ width: w, height: 900 });
            await settle(page);
            const at = await readBoxes(page);
            if (at.columns > 1) note(`resized to ${w}`, at);
        }
        check(await quiet(page), `${name}: nothing moves once the window has stopped`);

        await page.addScriptTag({ content: AXE });
        const violations = await page.evaluate(async () => (await axe.run('[data-testid="home-grid"]', { resultTypes: ['violations'] })).violations.map(v => `${v.id}: ${v.nodes.length}`));
        check(violations.length === 0, `${name}: axe clean${violations.length ? ` (${violations.join('; ')})` : ''}`);
        check(errors.length === 0, `${name}: no page errors${errors.length ? ` (${errors[0]})` : ''}`);
        await context.close();
    }
}

/** No card's place changes for half a second. */
const quiet = (page) => page.evaluate(() => new Promise((resolve) => {
    let moves = 0;
    const grid = document.querySelector('[data-testid="home-grid"]');
    const seen = new MutationObserver((m) => { moves += m.length; });
    seen.observe(grid, { subtree: true, attributes: true, attributeFilter: ['style'] });
    setTimeout(() => { seen.disconnect(); resolve(moves === 0); }, 500);
}));

// ---------- 320 px × 1.3: narrow is unchanged ----------

async function narrow(browser) {
    for (const dark of [false, true]) {
        const theme = dark ? 'dark' : 'light';
        const name = `320 × 1.3 ${theme}`;
        console.log(`\n${name}`);
        const { context, page } = await open(browser, { width: 320, height: 720, dark, textScale: 1.3 });
        const packedStyles = (l) => l.boxes.filter(b => b.row || (b.col && b.col !== '1 / -1')).length;
        const before = await readBoxes(page);
        await page.screenshot({ path: path.join(OUT_DIR, `home-320x1.3-${theme}-1-landed.png`), fullPage: true });
        await grow(page, 'home-card-events', 200);
        await settle(page);
        const after = await readBoxes(page);
        for (const [when, l] of [['landed', before], ['after a card grew', after]]) {
            const m = measure(l);
            check(l.columns === 1 && l.autoRows === '' && packedStyles(l) === 0, `${name}, ${when}: one column, no packing on any card`);
            check(m.smallest >= 8, `${name}, ${when}: no overlap (closest ${Math.round(m.smallest * 10) / 10} px)`);
            check(!l.sideways, `${name}, ${when}: no sideways scroll`);
        }
        report[`320-${theme}`] = { boxes: before.boxes.map(b => ({ id: b.id, top: Math.round(b.top * 10) / 10, height: Math.round((b.bottom - b.top) * 10) / 10 })) };
        await context.close();
    }
}

// ---------- the one loop there is: a card that crosses `wide` with the scrollbar ----------

async function loop() {
    // Classic 15 px scrollbars, which a Mac hides and Windows doesn't. The Market card is made taller when it is `wide`, so
    // a page that fits brings the scrollbar, the scrollbar narrows the card under 480 px, and the page fits again.
    console.log('\nThe scrollbar loop');
    const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    const { context, page } = await open(browser, { width: 1240, height: 900 });
    await page.addStyleTag({ content: '[data-testid="home-card-market"][data-card-wide="true"] { padding-bottom: 300px !important; }\nhtml { overflow-y: auto; }' });
    const widthFor = 256 + 32 + 2 * 482 + 16;
    await page.setViewportSize({ width: widthFor, height: 900 });
    await settle(page);
    // The page's height with the card narrow and with it wide; the window goes between the two.
    const heights = await page.evaluate(async () => {
        const market = document.querySelector('[data-testid="home-card-market"]');
        const tall = document.documentElement.scrollHeight;
        return { tall, wide: market.dataset.cardWide, width: market.clientWidth };
    });
    console.log('  page', heights);
    let best = { moves: 0 };
    for (let h = heights.tall + 30; h >= heights.tall - 400; h -= 25) {
        await page.setViewportSize({ width: widthFor, height: h });
        const seen = await page.evaluate(() => new Promise((resolve) => {
            let moves = 0;
            let widths = 0;
            const grid = document.querySelector('[data-testid="home-grid"]');
            const market = document.querySelector('[data-testid="home-card-market"]');
            const seenGrid = new MutationObserver((m) => { moves += m.length; });
            seenGrid.observe(grid, { subtree: true, attributes: true, attributeFilter: ['style'] });
            const seenCard = new MutationObserver(() => { widths += 1; });
            seenCard.observe(market, { attributes: true, attributeFilter: ['data-card-wide'] });
            setTimeout(() => { seenGrid.disconnect(); seenCard.disconnect(); resolve({ moves, widths }); }, 1500);
        }));
        if (seen.moves > best.moves) best = { ...seen, height: h };
        if (seen.widths > 0) console.log(`  window ${widthFor} × ${h}: ${seen.moves} style writes, the card crossed wide ${seen.widths} times in 1.5 s`);
    }
    report.loop = best;
    console.log(`  worst window: ${JSON.stringify(best)}`);
    check(best.moves < 200, `the scrollbar loop is bounded: at worst ${best.moves} style writes in 1.5 s at ${widthFor} × ${best.height ?? '-'}`);
    check(await quiet(page), 'and nothing moves once it has stood');
    const layout = await readBoxes(page);
    check(measure(layout).smallest >= 12, 'and no card overlaps the next');
    await context.close();
    await browser.close();
}

// ---------- column hops: reload a long Home ten times ----------

async function hops(browser) {
    const columnOf = (l) => Object.fromEntries(l.boxes.filter(b => b.col !== '1 / -1').map(b => [b.id, b.col]));
    const runs = report.hops = {};
    for (const width of [1280, 1600]) for (const [kind, nextAnswer] of [
        ['fresh answer identical to the kept one', (i) => answer({ listings: 4, events: 2, i })],
        // 5, 6, 7, 8 listings, then back to 4, and round again: a fresh answer one listing longer on eight reloads in ten.
        ['fresh answer one listing longer than the kept one', (i) => answer({ listings: 4 + ((i + 1) % 5), events: 2 })],
    ]) {
        console.log(`\nColumn hops at ${width}: ${kind}`);
        const { context, page, node } = await open(browser, { width });
        let hopped = 0;
        let reloadsWithHop = 0;
        const perReload = [];
        const who = {};
        for (let i = 0; i < 10; i += 1) {
            node.held = new Promise((release) => { node.release = release; });
            await page.reload({ waitUntil: 'load' });
            await page.waitForSelector('[data-testid="home-card-community"]');
            await settle(page);
            const kept = columnOf(await readBoxes(page));
            node.answer = nextAnswer(i);
            node.tag += 1;
            const release = node.release;
            node.held = null;
            release();
            await page.waitForLoadState('networkidle').catch(() => {});
            await settle(page);
            const fresh = columnOf(await readBoxes(page));
            const moved = Object.keys(fresh).filter(id => kept[id] && kept[id] !== fresh[id]);
            perReload.push(moved.length);
            for (const id of moved) who[id] = (who[id] ?? 0) + 1;
            hopped += moved.length;
            if (moved.length) reloadsWithHop += 1;
        }
        runs[`${width}: ${kind}`] = { reloads: 10, cards: Object.keys(columnOf(await readBoxes(page))).length, hops: hopped, reloadsWithHop, perReload, who };
        console.log(`  ${hopped} hops over 10 reloads, ${reloadsWithHop} reloads with a hop; per reload ${perReload.join(' ')}; ${JSON.stringify(who)}`);
        await context.close();
    }
}

const browser = await chromium.launch();
try {
    if (ONLY.includes('widths')) await widths(browser);
    if (ONLY.includes('narrow')) await narrow(browser);
    if (ONLY.includes('hops')) await hops(browser);
    if (ONLY.includes('loop')) await loop();
} finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(failures.length ? `\n${failures.length} FAILED:\n${failures.join('\n')}` : '\nAll held.');
process.exit(failures.length ? 1 : 0);
