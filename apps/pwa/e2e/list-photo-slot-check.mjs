/* eslint-disable no-undef */
// List photos that are still loading, in a real Chromium layout (review of #2853):
//   node e2e/list-photo-slot-check.mjs        # from apps/pwa; exits non-zero on any failed check
//
// 1. Home (finding 2): the real HomePage in a `main` like App's, at 800 px and 320 px, light and dark, with photos that never
//    answer, so every photo is loading the whole time. While they load: `main` and the page do not scroll sideways, and every
//    hidden photo's containing block is its own slot (offsetParent is the element it sits in) and it lies inside that slot.
// 2. The map's stacked list (finding 1): 40 pins, every photo `loading="lazy"`, at 360 x 740. The page's clock is Playwright's,
//    so 40 s pass at once. A photo the browser has not asked for is never stepped down; once the list is scrolled to it, it
//    is asked for, and it is stepped down only LIST_PHOTO_WAIT_MS after that.
//
// e2e/list-photo-slot-harness.tsx draws both. Every /api request is answered here (photos: never); nothing leaves the machine.
// Needs @beanpool/core built, and Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);

// A browser step that never comes back must end the run, not hold it: this is run by hand and by headless lanes.
const LIMIT_S = Number(process.env.LIST_PHOTO_SLOT_LIMIT_S || 240);
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
            items: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, type: i % 3 === 2 ? 'need' : 'offer', title: TITLES[i % TITLES.length], category: 'food', credits: 10 + i, photoUrl: `/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}` })),
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
        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); } catch { /* the default theme is still a theme */ }
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
        await page.clock.runFor(40_000);
        await page.waitForTimeout(200);
        const after40 = await srcs();
        const last = after40.length - 1;
        const small = (i) => `/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}&size=thumb2`;
        const notAsked = after40.map((_, i) => i).filter((i) => !asked.includes(small(i)));
        const steppedUnasked = notAsked.filter((i) => after40[i] !== small(i));
        console.log(`  first pins after 40 s: ${after40.slice(0, 5).map((s) => (s ? s.replace(/^.*photos\/0/, "") : "emoji")).join(" ")}`);
        console.log(`  ${askedBefore} of 40 photos asked for before scrolling; after 40 s, ${after40.filter((s) => s === null).length} pins show only their emoji, ${notAsked.length} were never asked for`);
        check(after40.length === 40, `the list draws 40 pins (${after40.length})`);
        check(notAsked.length > 0, `some photos are off screen and not asked for (${notAsked.length})`);
        // The page's clock did run: the photos in view, asked for and never answered, have stepped down.
        const steppedAsked = after40.map((_, i) => i).filter((i) => asked.includes(small(i)) && after40[i] !== small(i));
        check(steppedAsked.length > 0, `the photos in view, asked for and never answered, have stepped down (${steppedAsked.length})`);
        check(steppedUnasked.length === 0, `after 40 s, every photo not asked for still waits on its small copy, never stepped down${steppedUnasked.length ? ` (stepped: ${steppedUnasked.join(', ')})` : ''}`);
        check(after40[last] !== null && after40[last].endsWith('size=thumb2'), `the last pin still has its small copy (${after40[last]})`);
        await page.evaluate(() => { const ul = document.querySelector('[data-testid="map-stack-list"] ul'); ul.scrollTop = ul.scrollHeight; });
        await page.waitForTimeout(500);
        await page.clock.runFor(500);
        await page.waitForTimeout(200);
        const lastSrc = (await srcs())[last];
        check(asked.includes(lastSrc), `scrolled to, the last pin's photo is asked for (${lastSrc})`);
        await page.clock.runFor(8_000);
        await page.waitForTimeout(100);
        check((await srcs())[last] === lastSrc, 'and it is not stepped down before LIST_PHOTO_WAIT_MS');
        await page.clock.runFor(2_500);
        await page.waitForTimeout(200);
        const stepped = (await srcs())[last];
        check(stepped !== null && stepped.endsWith('&retry=1'), `LIST_PHOTO_WAIT_MS after it came into view, a photo that never answers steps down (${stepped})`);
        check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (failures.length) {
    console.error(`\n✗ ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ loading photos stay in their slots at 800 px and 320 px, and a lazy photo waits until it is asked for');
process.exit(0);
