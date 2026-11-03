/* global process, console, document, getComputedStyle, window */
/**
 * The web map's filter bar (the phone's All / Offers / Needs / Events, web-map-type-filter) in the real MapPage under the real
 * header (e2e/map-type-filter-harness.tsx), in headless Chromium at 320 px with text at 130% and at desktop width (1280),
 * light and dark, with All, Offers + a category (Tools), Offers with the category panel open, and Events.
 *
 * Fails (exit 1) on, at any step: the bar's top above the header's bottom, or the bar over the header's sync chip (what drew
 * "Online" behind the Today chip at desktop width: the bar sat at md:top-3, on the header, which draws at every width); a
 * chip, a calendar button or a tile under another element at its centre (something drawn over it); a row that wraps (a
 * pill taller than one line) or a chip cut at the screen's edge with no way to scroll to it; the category panel past the
 * screen's edge; a tile's label cut by its tile; sideways scroll of the page.
 *
 * Run from apps/pwa: node e2e/map-type-filter-shots.mjs   (MAP_FILTER_SHOTS_DIR=<dir>: where the pictures and results.json
 * go; default e2e/screenshots/map-type-filter, gitignored). Nothing here talks to a node: every request off this machine is
 * aborted and every /api request is answered here.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.MAP_FILTER_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'map-type-filter');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const base = { description: '', credits: 5, priceType: 'fixed', authorCallsign: 'Bea', createdAt: iso(-5 * HOUR), active: true, status: 'active', repeatable: true, photos: [] };
const at = (n) => ({ lat: -28.64 - n * 0.006, lng: 153.5 + n * 0.008 });
const POSTS = [
    { ...base, id: 'p1', type: 'offer', category: 'food', title: 'A dozen eggs', authorPublicKey: 'pk-bea', ...at(1) },
    { ...base, id: 'p2', type: 'offer', category: 'tools', title: 'Ladder to lend', authorPublicKey: 'pk-bea', ...at(3) },
    { ...base, id: 'p3', type: 'need', category: 'food', title: 'A lift to the market', authorPublicKey: 'pk-cal', ...at(5) },
    { ...base, id: 'p4', type: 'offer', category: 'garden', title: 'Seedlings', authorPublicKey: 'pk-cal', ...at(7) },
    { ...base, id: 'e1', type: 'event', category: 'community', title: 'Repair café', authorPublicKey: 'pk-hazel', credits: 0, repeatable: false,
      eventStartAt: iso(2 * HOUR), eventState: 'scheduled', goingCount: 2, interestedCount: 1, myRsvp: null, ...at(2) },
    { ...base, id: 'e2', type: 'event', category: 'community', title: 'Working bee', authorPublicKey: 'pk-hazel', credits: 0, repeatable: false,
      eventStartAt: iso(20 * 24 * HOUR), eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null, ...at(6) },
];
const ENTERPRISES = [{ publicKey: 'ent-1', name: 'Tool Shed', callsign: 'Shed', avatar: '🔧', ...at(4), paused: false, status: 'active' }];

function answer(pathname, search) {
    const params = new URLSearchParams(search);
    if (pathname === '/api/marketplace/posts') {
        const types = (params.get('types') || 'offer,need').split(',');
        return POSTS.filter(p => types.includes(p.type));
    }
    if (pathname === '/api/enterprises/map') return { enterprises: ENTERPRISES };
    if (pathname === '/api/enterprises/statuses') return { enterprises: [] };
    if (pathname === '/api/treasuries') return { treasuries: [] };
    if (pathname === '/api/groups') return [];
    if (pathname === '/api/activity/feed') return { feed: [] };
    if (pathname === '/api/community/members') return [];
    if (pathname === '/api/events/mine') return [];
    if (pathname === '/api/node/config') return { readAuthRequired: false };
    if (pathname === '/api/node/info') return { callsign: 'Harness', peerNodes: [] };
    if (pathname === '/api/federation/peers/reachable') return { peers: [] };
    if (pathname.startsWith('/api/ledger/balance')) return { balance: 240, isBlockedFromTrading: false };
    return undefined;
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

/** In the page: everything the bar must not do, as laid out now. */
const measure = () => {
    const r = (e) => e.getBoundingClientRect();
    const problems = [];
    const vw = document.documentElement.clientWidth;
    const bar = document.querySelector('[data-testid="map-filter-bar"]');
    if (!bar) return { problems: ['no filter bar'], vw };
    const header = document.querySelector('header');
    const headerBox = header && getComputedStyle(header).display !== 'none' ? r(header) : null;
    const barBox = r(bar);
    if (headerBox) {
        if (barBox.top < headerBox.bottom - 0.5) problems.push(`the bar's top ${barBox.top.toFixed(1)} is above the header's bottom ${headerBox.bottom.toFixed(1)}`);
        const chip = header.querySelector('[data-testid="sync-chip"]');
        if (chip) {
            const c = r(chip);
            const hit = !(c.right <= barBox.left || c.left >= barBox.right || c.bottom <= barBox.top || c.top >= barBox.bottom);
            if (hit) problems.push('the bar is over the header\'s sync chip');
        }
    }
    // Every control is the top element at its own centre, unless it is scrolled out of its row.
    const controls = [...bar.querySelectorAll('button')];
    for (const b of controls) {
        const box = r(b);
        if (box.width === 0) continue;
        const row = b.closest('[data-testid="map-filter-row"], [data-testid="event-window-chips"]');
        const rowBox = row ? r(row) : null;
        const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
        const inView = !rowBox || (cx > rowBox.left && cx < rowBox.right);
        if (inView && cx > 0 && cx < vw) {
            // The centre and a point just inside each corner: a control drawn half under another (the locate pill over the
            // category tiles) has its centre clear.
            const points = [[cx, cy], [box.left + 6, box.top + 6], [box.right - 6, box.top + 6], [box.left + 6, box.bottom - 6], [box.right - 6, box.bottom - 6]];
            for (const [x, y] of points) {
                if (x <= 0 || x >= vw || y <= 0 || y >= window.innerHeight) continue;
                if (rowBox && (x <= rowBox.left || x >= rowBox.right)) continue;
                // A tile scrolled out of the panel's own box is clipped, not covered.
                const inPanel = b.closest('[data-testid="map-category-panel"]');
                if (inPanel) { const p = r(inPanel); if (x <= p.left || x >= p.right || y <= p.top || y >= p.bottom) continue; }
                const top = document.elementFromPoint(x, y);
                if (top && !b.contains(top) && !top.contains(b)) {
                    problems.push(`"${b.textContent.trim() || b.getAttribute('aria-label')}" has ${top.tagName.toLowerCase()}${top.getAttribute('data-testid') ? `[${top.getAttribute('data-testid')}]` : ''} over it at ${Math.round(x)},${Math.round(y)}`);
                    break;
                }
            }
        }
        // One line: a pill is not taller than its own padding and a line or two.
        if (box.height > 72) problems.push(`"${b.textContent.trim() || b.getAttribute('aria-label')}" wraps (${box.height.toFixed(0)} px tall)`);
    }
    // A row either fits, or scrolls sideways: a chip past the edge is reachable only if its row scrolls.
    for (const row of bar.querySelectorAll('[data-testid="map-filter-row"], [data-testid="event-window-chips"]')) {
        const box = r(row);
        const last = row.lastElementChild ? r(row.lastElementChild) : null;
        if (last && last.right > box.right + 1 && row.scrollWidth <= row.clientWidth + 1) problems.push('a chip is cut off by its row and the row does not scroll');
        if (box.right > vw + 1) problems.push(`a row runs past the screen (${box.right.toFixed(0)} > ${vw})`);
    }
    const panel = document.querySelector('[data-testid="map-category-panel"]');
    if (panel) {
        const p = r(panel);
        if (p.left < -0.5 || p.right > vw + 0.5) problems.push(`the category panel is past the screen's edge (${p.left.toFixed(0)}..${p.right.toFixed(0)} of ${vw})`);
        for (const tile of panel.querySelectorAll('button')) {
            const label = tile.querySelector('span:last-child');
            if (label && label.scrollWidth > tile.clientWidth + 1) problems.push(`the tile "${label.textContent}" is cut by its tile`);
        }
    }
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    return { problems, vw, bar: { top: barBox.top, bottom: barBox.bottom }, header: headerBox ? { bottom: headerBox.bottom } : null };
};

const results = [];
let failed = false;
const VIEWS = [{ name: '320x1.3', width: 320, height: 640, scale: 1.3 }, { name: 'desktop', width: 1280, height: 800, scale: 1 }];

try {
    for (const view of VIEWS) {
        for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: theme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => {
                try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); } catch { /* the default theme */ }
            }, [theme]);
            await context.route('**/*', async (route) => {
                const url = new URL(route.request().url());
                if (url.origin !== origin) return route.abort();
                if (!url.pathname.startsWith('/api/')) return route.continue();
                const body = answer(url.pathname, url.search);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            });
            const page = await context.newPage();
            await page.goto(`${origin}/e2e/map-type-filter-harness.html?dark=${theme === 'dark' ? 1 : 0}`, { waitUntil: 'load' });
            if (view.scale !== 1) await page.addStyleTag({ content: `html { font-size: ${view.scale * 100}% !important; }` });
            await page.waitForSelector('[data-testid="map-filter-bar"]', { timeout: 30_000 });
            await page.waitForSelector('.custom-map-pin', { timeout: 30_000 });
            await page.waitForTimeout(800);

            const step = async (label, act) => {
                if (act) await act();
                await page.waitForTimeout(500);
                const m = await page.evaluate(measure);
                const file = `${view.name}-${theme}-${label}.png`;
                await page.screenshot({ path: path.join(SHOTS_DIR, file) });
                results.push({ file, ...m });
                for (const p of m.problems) { failed = true; console.error(`FAIL ${file}: ${p}`); }
                console.log(`${m.problems.length ? 'FAIL' : 'ok  '} ${file}  bar ${m.bar ? `${m.bar.top.toFixed(0)}–${m.bar.bottom.toFixed(0)}` : '-'}  header bottom ${m.header ? m.header.bottom.toFixed(0) : 'none'}`);
            };
            const click = (id) => page.getByTestId(id).click();
            await step('all');
            await step('offers-tools', async () => {
                await click('map-type-offers');
                await click('map-category-chip');
                await page.getByTestId('map-category-panel').getByRole('button', { name: /Tools/ }).click();
            });
            await step('offers-panel-open', () => click('map-category-chip'));
            await step('events', async () => { await click('map-category-chip'); await click('map-type-events'); });
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
}
if (failed) { console.error('map-type-filter-shots: FAILED'); process.exit(1); }
console.log(`map-type-filter-shots: ${results.length} pictures, none failing, in ${SHOTS_DIR}`);
