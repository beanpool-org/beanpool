/* global process, console, document, getComputedStyle, window */
/**
 * The web map's pins and bubbles, the phone's (web-map-pins): in the real MapPage under the real header
 * (e2e/map-type-filter-harness.tsx), in headless Chromium at 320 px with text at 130% and at desktop width (1280), light and
 * dark. The map holds an Elder's offer and an Elder's need (the pin's ring stays green / terracotta, a gold halo sits outside
 * it), a newer member's offer, and bubbles of 3, 12, 30 and 120 pins (36 / 46 / 56 / 64 px, "99+" on the last). A second step
 * chooses the last chip of a row at 320 px, to see it is scrolled clear of the ›.
 *
 * Fails (exit 1) on: an Elder pin with a gold ring, or none of the halo; a bubble of the wrong size or label; a chosen chip
 * under the › or cut by its row's edge.
 *
 * Run from apps/pwa: node e2e/map-pins-shots.mjs   (MAP_PINS_SHOTS_DIR=<dir>: where the pictures and results.json go; default
 * e2e/screenshots/map-pins, gitignored). Nothing here talks to a node: every request off this machine is aborted and every
 * /api request is answered here.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.MAP_PINS_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'map-pins');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const base = { description: '', price_c: 500, priceType: 'fixed', authorCallsign: 'Bea', createdAt: iso(-5 * HOUR), active: true, status: 'active', repeatable: true, photos: [] };
// The community's centre is where the map opens; the groups sit round it, a kilometre apart, so each is its own bubble.
const CENTRE = { lat: -28.64, lng: 153.5 };
const SPOTS = [
    { dx: -0.014, dy: -0.016, n: 3 }, { dx: -0.014, dy: 0.016, n: 12 }, { dx: 0.014, dy: -0.016, n: 30 }, { dx: 0.014, dy: 0.016, n: 120 },
];
const POSTS = [
    { ...base, id: 'elder-offer', type: 'offer', category: 'food', title: 'Elder eggs', authorPublicKey: 'pk-elder', authorEnergyCycled: 500000, lat: CENTRE.lat + 0.003, lng: CENTRE.lng - 0.008 },
    { ...base, id: 'elder-need', type: 'need', category: 'tools', title: 'Elder ladder', authorPublicKey: 'pk-elder', authorEnergyCycled: 500000, lat: CENTRE.lat + 0.003, lng: CENTRE.lng + 0.008 },
    { ...base, id: 'new-offer', type: 'offer', category: 'garden', title: 'New seedlings', authorPublicKey: 'pk-new', authorEnergyCycled: 2000, lat: CENTRE.lat - 0.006, lng: CENTRE.lng - 0.006 },
    { ...base, id: 'e1', type: 'event', category: 'community', title: 'Repair café', authorPublicKey: 'pk-hazel', price_c: 0, repeatable: false,
      eventStartAt: iso(2 * HOUR), eventState: 'scheduled', goingCount: 2, interestedCount: 1, myRsvp: null, lat: CENTRE.lat - 0.006, lng: CENTRE.lng + 0.006 },
];
SPOTS.forEach((s, g) => {
    for (let i = 0; i < s.n; i++) {
        // Within ~25 m of each other: one bubble at every zoom the map opens at.
        POSTS.push({ ...base, id: `c${g}-${i}`, type: i % 3 ? 'offer' : 'need', category: 'food', title: `Group ${g} item ${i}`, authorPublicKey: `pk-${g}-${i}`, authorEnergyCycled: 2000,
            lat: CENTRE.lat + s.dx + ((i * 7) % 11) * 0.00002, lng: CENTRE.lng + s.dy + ((i * 5) % 13) * 0.00002 });
    }
});

function answer(pathname, search) {
    const params = new URLSearchParams(search);
    if (pathname === '/api/marketplace/posts') {
        const types = (params.get('types') || 'offer,need').split(',');
        return POSTS.filter(p => types.includes(p.type));
    }
    if (pathname === '/api/enterprises/map') return { enterprises: [] };
    if (pathname === '/api/enterprises/statuses') return { enterprises: [] };
    if (pathname === '/api/treasuries') return { treasuries: [] };
    if (pathname === '/api/groups') return [];
    if (pathname === '/api/activity/feed') return { feed: [] };
    if (pathname === '/api/community/members') return [];
    if (pathname === '/api/events/mine') return [];
    if (pathname === '/api/node/config') return { readAuthRequired: false };
    if (pathname === '/api/node/info') return { callsign: 'Harness', peerNodes: [] };
    if (pathname === '/api/federation/peers/reachable') return { peers: [] };
    if (pathname.startsWith('/api/ledger/balance')) return { balance_c: 24000, isBlockedFromTrading: false };
    return undefined;
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

const EXPECTED_BUBBLES = { '3': 36, '12': 46, '30': 56, '99+': 64 };

/** In the page: the pins and bubbles as drawn now. */
const measurePins = (EXPECTED_BUBBLES) => {
    const problems = [];
    const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
    const pins = [...document.querySelectorAll('.custom-map-pin')];
    const halos = pins.filter(p => p.querySelector('[data-elder-halo]'));
    if (halos.length !== 2) problems.push(`expected 2 Elder pins with a halo, found ${halos.length}`);
    const ringColours = [];
    for (const pin of halos) {
        const ring = [...pin.querySelectorAll('div')].find(d => /border: 2\.5px solid/.test(d.getAttribute('style') || ''));
        const colour = ring ? getComputedStyle(ring).borderTopColor : '';
        ringColours.push(colour);
        if (colour === rgb('#fbbf24')) problems.push('an Elder pin has a gold ring');
    }
    const want = [rgb('#10b981'), rgb('#d97757')].sort().join('|');
    if (halos.length === 2 && [...ringColours].sort().join('|') !== want) problems.push(`the Elder rings are ${ringColours.join(' / ')}, expected green and terracotta`);
    const bubbles = [...document.querySelectorAll('[data-cluster-bubble]')].map(b => ({ label: b.textContent.trim(), width: b.getBoundingClientRect().width, fill: getComputedStyle(b).backgroundColor }));
    for (const [label, size] of Object.entries(EXPECTED_BUBBLES)) {
        const b = bubbles.find(x => x.label === label);
        if (!b) problems.push(`no bubble reading ${label}`);
        else if (Math.abs(b.width - size) > 0.6) problems.push(`the ${label} bubble is ${b.width}px, expected ${size}`);
        else if (b.fill !== rgb('#2563eb')) problems.push(`the ${label} bubble is ${b.fill}, expected the info blue`);
    }
    return { problems, ringColours, bubbles };
};

/** In the page: the chosen chip in the row with this test id is wholly inside the row and clear of the ›. */
const measureChosen = (rowId) => {
    const problems = [];
    const row = document.querySelector(`[data-testid="${rowId}"]`);
    if (!row) return { problems: [`no row ${rowId}`] };
    const chosen = row.querySelector('[aria-pressed="true"]:not([data-testid="map-calendar-button"])');
    if (!chosen) return { problems: ['no chosen chip'] };
    const r = row.getBoundingClientRect(), c = chosen.getBoundingClientRect();
    if (c.left < r.left - 1.5) problems.push(`the chosen chip starts ${(r.left - c.left).toFixed(1)}px left of its row`);
    if (c.right > r.right + 1.5) problems.push(`the chosen chip runs ${(c.right - r.right).toFixed(1)}px past its row`);
    const hint = row.parentElement.querySelector('[data-testid="map-more-hint"]');
    if (hint) {
        const h = hint.getBoundingClientRect();
        const over = !(c.right <= h.left || c.left >= h.right);
        if (over) problems.push(`the chosen chip "${chosen.textContent.trim()}" is under the ›`);
    }
    return { problems, chip: chosen.textContent.trim(), hint: !!hint, chipBox: { left: c.left, right: c.right }, rowBox: { left: r.left, right: r.right } };
};

const results = [];
let failed = false;
const VIEWS = [{ name: '320x1.3', width: 320, height: 640, scale: 1.3 }, { name: 'desktop', width: 1280, height: 800, scale: 1, clip: { x: 256, y: 0, width: 900, height: 800 } }];

try {
    for (const view of VIEWS) {
        for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: theme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => {
                try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme */ }
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
            await page.waitForSelector('.leaflet-marker-icon', { timeout: 30_000, state: 'attached' });
            await page.waitForTimeout(1200);

            const shoot = async (label, measure, ...args) => {
                const m = await page.evaluate(measure, ...args);
                const file = `${view.name}-${theme}-${label}.png`;
                await page.screenshot({ path: path.join(SHOTS_DIR, file), ...(view.clip ? { clip: view.clip } : {}) });
                results.push({ file, ...m });
                for (const p of m.problems) { failed = true; console.error(`FAIL ${file}: ${p}`); }
                console.log(`${m.problems.length ? 'FAIL' : 'ok  '} ${file}`);
            };
            await shoot('pins-and-bubbles', measurePins, EXPECTED_BUBBLES);
            if (view.name === '320x1.3') {
                // Events: the last pill of the type row, then the last date chip, each chosen at 320 px.
                await page.getByTestId('map-type-events').scrollIntoViewIfNeeded();
                await page.getByTestId('map-type-events').click();
                await page.waitForTimeout(500);
                await shoot('chip-events-pill', measureChosen, 'map-filter-row');
                const week = page.getByTestId('event-window-chips').getByRole('button').last();
                await week.click();
                await page.waitForTimeout(500);
                await shoot('chip-next-7-days', measureChosen, 'event-window-chips');
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
}
if (failed) { console.error('map-pins-shots: FAILED'); process.exit(1); }
console.log(`map-pins-shots: ${results.length} pictures, none failing, in ${SHOTS_DIR}`);
