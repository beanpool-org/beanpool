/* eslint-disable no-undef */
// List photos that are still loading, in a real Chromium layout (review of #2853):
//   node e2e/list-photo-slot-check.mjs        # from apps/pwa; exits non-zero on any failed check
//
// 1. Home (finding 2): the real HomePage in a `main` like App's, at 800 px and 320 px, light and dark, with photos that never
//    answer, so every photo is loading the whole time. While they load: `main` and the page do not scroll sideways, and every
//    hidden photo's containing block is its own slot (offsetParent is the element it sits in) and it lies inside that slot.
// 2. The map's stacked list (finding 1): 40 pins, every photo `loading="lazy"`, at 360 x 740. The page's clock is Playwright's,
//    so minutes pass at once. A photo the browser has not asked for is never stepped down; once the list is scrolled to it,
//    it is asked for, and it is stepped down no sooner than LIST_PHOTO_QUEUED_MS after that (later if its turn in the line
//    comes later), and in the end it is.
// 3. The Market page on a slow link (round 3): 50 real Market cards, eager photos, from a server here that runs HTTP/1.1 and
//    shares one link of 25 KB/s across its responses, so the browser runs 6 at once and the rest wait their turn with no
//    event. The page's clock runs about 4 times as fast as the link, so the line takes far longer than LIST_PHOTO_QUEUED_MS
//    by the page's clock: no photo is stepped down before its request reaches the server, and every card draws its photo.
//
// e2e/list-photo-slot-harness.tsx draws all three. Every /api request is answered here (photos: never, or by the slow server
// on 127.0.0.1); nothing leaves the machine.
// Needs @beanpool/core built, and Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import { LIST_PHOTO_QUEUED_MS } from '@beanpool/core';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);

// A browser step that never comes back must end the run, not hold it: this is run by hand and by headless lanes.
const LIMIT_S = Number(process.env.LIST_PHOTO_SLOT_LIMIT_S || 360);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

const NOW = Date.now();
const TITLES = ['Pottery lessons', 'Sourdough', 'Borrow a drill', 'Seedlings to give away', 'Bike repairs on Saturdays', 'Duck eggs', 'Long ladder', 'Help at the market stall', 'Mend the polytunnel', 'Pick the olives'];
const HOME = {
    generatedAt: new Date(NOW).toISOString(), profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: ['arts'], area: null, firstOffer: false, standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' } },
    layout: { v: 2, cards: ['market', 'deals', 'community'].map((t) => ({ id: t, type: t })), dismissed: {}, updatedAt: null },
    cards: {
        deals: { open: 2, waiting: 1, waitingOnMe: null },
        market: {
            items: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, type: i % 3 === 2 ? 'need' : 'offer', title: TITLES[i % TITLES.length], category: 'food', price_c: (10 + i) * 100, photoUrl: `/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}` })),
            total14d: 12, more: false,
        },
        community: { name: 'Mullumbimby', members: 81, tradesThisMonth: 23 },
    },
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/list-photo-slot-harness.html`;
const browser = await chromium.launch();

/** A context whose /api answers Home, whose photos never answer, and which records every photo the browser asks for. */
async function open({ width, height, dark = false, view, clock = false }) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.addInitScript(([mode]) => {
        try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
    }, [dark ? 'dark' : 'light']);
    const asked = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.includes('/photos/')) { asked.push(url.pathname + url.search); return; } // never answered: still loading
        if (url.pathname === '/api/home') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HOME) }).catch(() => {});
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' }).catch(() => {});
    });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (clock) await page.clock.install();
    await page.goto(`${base}?view=${view}`, { waitUntil: 'load' });
    return { context, page, asked, errors };
}

/** An 80 x 80 BMP: 19,254 bytes, about a small copy's size (review of #2853, round 3: 19 KB), that every browser draws. */
function bmp(w, h) {
    const row = Math.ceil((w * 3) / 4) * 4;
    const b = Buffer.alloc(54 + row * h);
    b.fill(0x60, 54); // the pixels: one colour; the header is zeros but for what is written below
    b.write('BM', 0);
    b.writeUInt32LE(b.length, 2);
    b.writeUInt32LE(54, 10);
    b.writeUInt32LE(40, 14);
    b.writeInt32LE(w, 18);
    b.writeInt32LE(h, 22);
    b.writeUInt16LE(1, 26);
    b.writeUInt16LE(24, 28);
    b.writeUInt32LE(row * h, 34);
    return b;
}

/**
 * Round 3: the Market page's eager photos on a slow link. A photo server on 127.0.0.1 (its own host, so its own line in the
 * browser) speaks HTTP/1.1 and shares RATE bytes a second across every response it is sending, as one slow link does. The
 * page's clock (Playwright's) is moved on 3 s for every real second it also runs, so the page waits about 4 times as long as
 * the link takes: the line of 50 takes about 38 s on the link and well over LIST_PHOTO_QUEUED_MS on the page's clock.
 */
async function marketOnASlowLink() {
    const PHOTO = bmp(80, 80);
    const RATE = 25_000;
    const N = 50;
    const requested = new Map(); // path and query -> when the request reached the server (real time)
    const sending = new Set();
    let most = 0;
    const photos = http.createServer((req, res) => {
        requested.set(req.url, Date.now());
        if (!/^\/api\/marketplace\/posts\/[^/]+\/photos\/\d+/.test(req.url)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/bmp', 'Content-Length': String(PHOTO.length), 'Cache-Control': 'no-store' });
        const r = { res, sent: 0 };
        sending.add(r);
        most = Math.max(most, sending.size);
        res.on('close', () => sending.delete(r));
    });
    const TICK_MS = 50;
    const link = setInterval(() => {
        if (sending.size === 0) return;
        const share = Math.max(1, Math.floor((RATE * TICK_MS) / 1000 / sending.size));
        for (const r of [...sending]) {
            const n = Math.min(share, PHOTO.length - r.sent);
            r.res.write(PHOTO.subarray(r.sent, r.sent + n));
            r.sent += n;
            if (r.sent >= PHOTO.length) { sending.delete(r); r.res.end(); }
        }
    }, TICK_MS);
    await new Promise((resolve) => photos.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${photos.address().port}`;
    const pathOf = (src) => { const u = new URL(src, origin); return u.pathname + u.search; };

    const context = await browser.newContext({ viewport: { width: 800, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/socket.io/**', (route) => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Every step down (an <img>'s src moving to another URL) and every photo drawn, by real time, from the page's first moment.
    const steps = [];
    const drawn = new Map();
    await page.exposeFunction('__photoStep', (from, to) => steps.push({ from, to, at: Date.now() }));
    await page.exposeFunction('__photoDrawn', (src) => { if (!drawn.has(src)) drawn.set(src, Date.now()); });
    await page.addInitScript(() => {
        new MutationObserver((records) => {
            for (const r of records) if (r.target instanceof HTMLImageElement && r.oldValue && r.oldValue !== r.target.getAttribute('src')) window.__photoStep(r.oldValue, r.target.getAttribute('src'));
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['src'], attributeOldValue: true });
        document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) window.__photoDrawn(e.target.getAttribute('src')); }, true);
    });
    await page.clock.install();
    const startedAt = Date.now();
    await page.goto(`${base}?view=market&n=${N}&photos=${encodeURIComponent(origin)}`, { waitUntil: 'domcontentloaded' }); // 'load' waits for every photo
    const pageStart = await page.evaluate(() => Date.now());
    const small = (i) => `${origin}/api/marketplace/posts/m${i}/photos/0?v=1&k=K${i}&size=thumb2`;
    const allDrawn = () => Array.from({ length: N }, (_, i) => small(i)).every((s) => drawn.has(s));
    const realLimit = Date.now() + 150_000;
    while (!allDrawn() && Date.now() < realLimit) {
        await page.clock.runFor(750);
        await page.waitForTimeout(250);
    }
    // How long the line took, by the page's clock and by the link's.
    const pageSeconds = Math.round(((await page.evaluate(() => Date.now())) - pageStart) / 1000);
    const realSeconds = Math.round((Date.now() - startedAt) / 1000);
    // A little more of the page's clock: a wait still running for a card that has drawn would show here.
    await page.clock.runFor(LIST_PHOTO_QUEUED_MS);
    await page.waitForTimeout(300);
    const drew = Array.from({ length: N }, (_, i) => i).filter((i) => drawn.has(small(i)));
    const lastDrawnAt = drew.length ? Math.max(...drew.map((i) => drawn.get(small(i)))) : startedAt;
    const photoSteps = steps.filter((s) => s.from.startsWith(origin));
    const beforeAsked = photoSteps.filter((s) => !requested.has(pathOf(s.from)) || requested.get(pathOf(s.from)) > s.at);
    const tiles = await page.evaluate(() => document.querySelectorAll('[data-testid="category-tile"]').length);
    console.log(`  link ${RATE / 1000} KB/s; at most ${most} responses at once; ${requested.size} requests; ${drew.length} of ${N} cards drew, the last ${Math.round((lastDrawnAt - startedAt) / 1000)} s in; ${photoSteps.length} step downs (${beforeAsked.length} before the request reached the server); page clock ${pageSeconds} s for ${realSeconds} s real; ${tiles} tiles left`);
    check(most === 6, `the browser ran 6 photos at once to the photo host and the rest waited their turn (${most})`);
    check(pageSeconds > LIST_PHOTO_QUEUED_MS / 1000, `the line took longer than LIST_PHOTO_QUEUED_MS by the page's clock, so a wait from the page's first moment would have run out (${pageSeconds} s)`);
    check(beforeAsked.length === 0, `no photo was stepped down before its request reached the server${beforeAsked.length ? ` (${beforeAsked.length}, first ${JSON.stringify(beforeAsked[0])})` : ''}`);
    check(photoSteps.length === 0, `no photo was stepped down at all: each drew within its wait from its turn (${photoSteps.length})`);
    check(drew.length === N, `every card drew its small copy (${drew.length} of ${N})`);
    check(tiles === 0, `no card is left on its tile (${tiles})`);
    check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
    await context.close();
    clearInterval(link);
    for (const r of sending) r.res.destroy();
    photos.closeAllConnections?.();
    await new Promise((resolve) => photos.close(resolve));
}

/** Runs in the page: what scrolls sideways, and each photo still loading against the slot it sits in. */
const READ_HOME = () => {
    const main = document.querySelector('[data-testid="app-main"]');
    const loading = Array.from(document.querySelectorAll('img')).filter((img) => img.style.opacity === '0');
    return {
        mainScrollWidth: main.scrollWidth,
        mainClientWidth: main.clientWidth,
        pageSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        loading: loading.length,
        wide: document.querySelectorAll('[data-testid="home-photo-slot"].w-full').length,
        outside: loading.map((img) => {
            const r = img.getBoundingClientRect();
            const s = img.parentElement.getBoundingClientRect();
            return {
                ownBlock: img.offsetParent === img.parentElement,
                inside: r.left >= s.left - 0.5 && r.right <= s.right + 0.5 && r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5,
                img: [Math.round(r.left), Math.round(r.right)], slot: [Math.round(s.left), Math.round(s.right)],
            };
        }).filter((x) => !x.ownBlock || !x.inside),
    };
};

try {
    console.log('Home, photos still loading (finding 2):');
    for (const dark of [false, true]) {
        for (const vp of [{ width: 800, height: 900 }, { width: 320, height: 640 }]) {
            const tag = `${vp.width} px ${dark ? 'dark' : 'light'}`;
            const { context, page, errors } = await open({ ...vp, dark, view: 'home' });
            await page.waitForSelector('[data-testid="app-main"] img', { state: 'attached', timeout: 60_000 });
            await page.evaluate(() => document.fonts?.ready).catch(() => {});
            await page.waitForTimeout(300);
            const r = await page.evaluate(READ_HOME);
            console.log(`  ${tag}: main scrollWidth ${r.mainScrollWidth} for ${r.mainClientWidth}; ${r.loading} photos loading, ${r.wide} wide tiles`);
            check(r.loading > 0, `${tag}: photos are loading while measured (${r.loading})`);
            if (vp.width === 800) check(r.wide > 0, `${tag}: Home draws its wide tiles (${r.wide})`);
            check(r.mainScrollWidth <= r.mainClientWidth, `${tag}: main does not scroll sideways (${r.mainScrollWidth} for ${r.mainClientWidth})`);
            check(!r.pageSideways, `${tag}: the page does not scroll sideways`);
            check(r.outside.length === 0, `${tag}: every loading photo's containing block is its slot, and it lies inside it${r.outside.length ? ` (${JSON.stringify(r.outside.slice(0, 3))})` : ''}`);
            check(errors.length === 0, `${tag}: no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
            await context.close();
        }
    }

    console.log('The map\'s stacked list, lazy photos (finding 1):');
    {
        const { context, page, asked, errors } = await open({ width: 360, height: 740, view: 'stack', clock: true });
        await page.waitForSelector('[data-testid="map-stack-list"] img');
        await page.waitForTimeout(500);
        const srcs = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="map-stack-list"] li')).map((li) => li.querySelector('img')?.getAttribute('src') ?? null));
        const askedBefore = new Set(asked).size;
        // Past one wait: the first photos in line, asked for and never answered, have had their whole wait.
        await page.clock.runFor(LIST_PHOTO_QUEUED_MS + 10_000);
        await page.waitForTimeout(200);
        const after40 = await srcs();
        const last = after40.length - 1;
        const small = (i) => `/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}&size=thumb2`;
        const notAsked = after40.map((_, i) => i).filter((i) => !asked.includes(small(i)));
        const steppedUnasked = notAsked.filter((i) => after40[i] !== small(i));
        console.log(`  first pins after 40 s: ${after40.slice(0, 5).map((s) => (s ? s.replace(/^.*photos\/0/, "") : "emoji")).join(" ")}`);
        console.log(`  ${askedBefore} of 40 photos asked for before scrolling; after ${(LIST_PHOTO_QUEUED_MS + 10_000) / 1000} s, ${after40.filter((s) => s === null).length} pins show only their emoji, ${notAsked.length} were never asked for`);
        check(after40.length === 40, `the list draws 40 pins (${after40.length})`);
        check(notAsked.length > 0, `some photos are off screen and not asked for (${notAsked.length})`);
        // The page's clock did run: the photos in view, asked for and never answered, have stepped down.
        const steppedAsked = after40.map((_, i) => i).filter((i) => asked.includes(small(i)) && after40[i] !== small(i));
        check(steppedAsked.length > 0, `the photos in view, asked for and never answered, have stepped down (${steppedAsked.length})`);
        check(steppedUnasked.length === 0, `after ${(LIST_PHOTO_QUEUED_MS + 10_000) / 1000} s, every photo not asked for still waits on its small copy, never stepped down${steppedUnasked.length ? ` (stepped: ${steppedUnasked.join(', ')})` : ''}`);
        check(after40[last] !== null && after40[last].endsWith('size=thumb2'), `the last pin still has its small copy (${after40[last]})`);
        await page.evaluate(() => { const ul = document.querySelector('[data-testid="map-stack-list"] ul'); ul.scrollTop = ul.scrollHeight; });
        await page.waitForTimeout(500);
        await page.clock.runFor(500);
        await page.waitForTimeout(200);
        const lastSrc = (await srcs())[last];
        check(asked.includes(lastSrc), `scrolled to, the last pin's photo is asked for (${lastSrc})`);
        // It joins the back of the page's line for its host, behind the photos seen in view before it that have not drawn, and
        // its wait starts at its turn: never sooner than LIST_PHOTO_QUEUED_MS after it was asked for. (The page counts a lazy
        // photo once it is in view; the browser asks for some sooner, so its own line can be longer.) Step the clock 5 s at a
        // time until it steps down.
        let waited = 0;
        let stepped = lastSrc;
        while (stepped === lastSrc && waited < 10 * LIST_PHOTO_QUEUED_MS) {
            await page.clock.runFor(5_000);
            waited += 5_000;
            await page.waitForTimeout(40);
            stepped = (await srcs())[last];
        }
        console.log(`  the last pin, asked for once scrolled to, stepped down ${waited / 1000} s later by the page's clock`);
        check(waited >= LIST_PHOTO_QUEUED_MS, `it is not stepped down sooner than LIST_PHOTO_QUEUED_MS after it was asked for (${waited / 1000} s)`);
        check(stepped !== null && stepped.endsWith('&retry=1'), `a photo that never answers does step down in the end, once its turn has come (${stepped})`);
        check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
        await context.close();
    }

    console.log('The Market page, 50 eager photos on a slow HTTP/1.1 link (round 3):');
    await marketOnASlowLink();
} finally {
    await browser.close();
    await server.close();
}

if (failures.length) {
    console.error(`\n✗ ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ loading photos stay in their slots at 800 px and 320 px, a lazy photo waits until it is asked for, and an eager one until its turn');
process.exit(0);
