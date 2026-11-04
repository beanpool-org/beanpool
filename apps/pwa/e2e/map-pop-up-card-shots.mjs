/* global process, console, document, window, Range, NodeFilter */
/**
 * The web map's pin card is the Market's list card with a ✕ (slice M1, DESIGN-card-style-box-fable.md §2; Marty, 4 Nov 2026:
 * "the event small tile looks bad ... yes restyle - look at the similar market place offer and map card offer"). The real
 * MapPage under the real header (e2e/map-type-filter-harness.tsx) in headless Chromium, at 320 px with text at 130% and at 1280
 * px (the side bar beside it), light and dark: each pin is tapped and its card shot and measured.
 *
 * Fails (exit 1) when an opened card:
 *   SLOT   - has no list photo slot, or the slot is not 80 wide, or not the full height of the card's lines beside it;
 *   BUTTON - holds a control besides the ✕ (an event: besides its open button, Going and Interested), or any "View" button;
 *   CLOSE  - lets the ✕'s circle meet any of the card's words, or the ✕'s target is under 44 x 44;
 *   ZERO   - shows a count of nobody ("0 going");
 *   FIT    - is not whole on the screen, or the page scrolls sideways.
 *
 * Run from apps/pwa: node e2e/map-pop-up-card-shots.mjs   (MAP_POP_UP_SHOTS_DIR=<dir>; default e2e/screenshots/map-pop-up-card,
 * gitignored). Nothing here talks to a node: every request off this machine is aborted and every /api request is answered here.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.MAP_POP_UP_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'map-pop-up-card');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
const PHOTO = fs.readFileSync(path.join(PWA_DIR, 'public', 'assets', 'neon-vines-banner.png'));

const HOUR = 3600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const base = { description: '', credits: 5, priceType: 'fixed', authorCallsign: 'Bea', createdAt: iso(-5 * HOUR), active: true, status: 'active', repeatable: false, photos: [] };
const at = (n) => ({ lat: -28.64 - n * 0.02, lng: 153.5 + n * 0.03 });
const POSTS = [
    { ...base, id: 'p1', type: 'offer', category: 'food', title: 'A dozen eggs from the back paddock', credits: 12, repeatable: true, authorPublicKey: 'pk-bea',
      photos: ['/api/marketplace/posts/p1/photos/0?v=1'], ...at(0) },
    { ...base, id: 'p3', type: 'need', category: 'transport', title: 'A lift to the Saturday market', credits: 8, authorPublicKey: 'pk-cal', authorCallsign: 'Cal', ...at(2) },
    { ...base, id: 'e1', type: 'event', category: 'community', title: 'Repair café at the hall', authorPublicKey: 'pk-hazel', authorCallsign: 'Hazel', credits: 0,
      eventStartAt: iso(2 * HOUR), eventState: 'scheduled', eventPlaceName: 'Mullumbimby Civic Hall', goingCount: 0, interestedCount: 0, myRsvp: null, ...at(4) },
    { ...base, id: 'e2', type: 'event', category: 'community', title: 'Working bee in the community garden', authorPublicKey: 'pk-hazel', authorCallsign: 'Hazel', credits: 0,
      photos: ['/api/marketplace/posts/e2/photos/0?v=1'], eventStartAt: iso(26 * HOUR), eventState: 'scheduled', eventPlaceName: 'Community garden',
      goingCount: 3, interestedCount: 1, myRsvp: 'going', ...at(6) },
];

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
    if (pathname.startsWith('/api/ledger/balance')) return { balance: 240, isBlockedFromTrading: false };
    return undefined;
}

/** In the page: the opened card, measured. */
const measure = () => {
    const r = (e) => e.getBoundingClientRect();
    const problems = [];
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const wrap = document.querySelector('[data-testid="map-preview-card"]');
    if (!wrap) return { problems: ['no pin card opened'] };
    const outer = wrap.firstElementChild;
    const card = outer.querySelector('[data-testid="listing-list-card"], [data-testid="event-card"]');
    if (!card) return { problems: ['no list card in the pin card'] };
    const isEvent = card.getAttribute('data-testid') === 'event-card';
    const title = (card.querySelector('[data-testid="listing-list-title"]') || card.querySelector('[dir="auto"]'))?.textContent?.trim();
    const c = r(outer);
    if (c.left < -0.5 || c.right > vw + 0.5 || c.top < -0.5 || c.bottom > vh + 0.5) problems.push(`FIT: the card is not whole on the screen (${c.left.toFixed(0)}..${c.right.toFixed(0)} x ${c.top.toFixed(0)}..${c.bottom.toFixed(0)})`);
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`FIT: the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    // SLOT
    const slot = card.querySelector('[data-testid="listing-list-photo"], [data-testid="event-list-photo"]');
    let slotBox = null;
    if (!slot) problems.push('SLOT: no list photo slot');
    else {
        // The box's slot is 5rem (80 at the browser's own text size; 104 with text at 130%, as the Market's list card), and the
        // full height inside the card's frame (its 1 px border is the card's, not the slot's).
        const rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize);
        const s = r(slot), beside = slot.parentElement.clientHeight;
        slotBox = { w: s.width, h: s.height, beside, want: 5 * rem };
        if (Math.abs(s.width - 5 * rem) > 0.5) problems.push(`SLOT: the slot is ${s.width.toFixed(1)} wide, not ${(5 * rem).toFixed(1)} (5rem)`);
        if (Math.abs(s.height - beside) > 1) problems.push(`SLOT: the slot is ${s.height.toFixed(1)} tall beside ${beside.toFixed(1)} of lines`);
        if (slot.parentElement.firstElementChild !== slot) problems.push('SLOT: the slot is not the first thing in the card');
    }
    // BUTTON
    const buttons = [...outer.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim());
    const expected = isEvent ? 4 : 1;
    if (buttons.length !== expected) problems.push(`BUTTON: ${buttons.length} buttons (${buttons.join(' | ')}), expected ${expected}`);
    if (buttons.some(b => /View/.test(b)) || /View (Details|event|listing)/.test(outer.textContent)) problems.push('BUTTON: a View button');
    // CLOSE
    const close = outer.querySelector('button[aria-label="Close preview"]');
    let dotBox = null;
    if (!close) problems.push('CLOSE: no ✕');
    else {
        const cb = r(close);
        if (cb.width < 44 || cb.height < 44) problems.push(`CLOSE: the ✕'s target is ${cb.width.toFixed(0)} x ${cb.height.toFixed(0)}`);
        const dot = r(close.firstElementChild);
        dotBox = dot.toJSON();
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const t of range.getClientRects()) {
                if (t.width === 0) continue;
                if (t.right > dot.left + 0.5 && t.left < dot.right - 0.5 && t.bottom > dot.top + 0.5 && t.top < dot.bottom - 0.5) {
                    problems.push(`CLOSE: the ✕'s circle meets "${n.textContent.trim().slice(0, 30)}"`);
                }
            }
        }
    }
    // ZERO
    if (/(^|\D)0 (going|interested)/.test(outer.textContent)) problems.push('ZERO: a count of nobody');
    return { problems, title, isEvent, card: { w: c.width, h: c.height }, slot: slotBox, dot: dotBox, buttons };
};

const results = [];
let failed = false;
const VIEWS = [
    { name: '320x1.3', width: 320, height: 640, scale: 1.3 },
    { name: '1280', width: 1280, height: 800, scale: 1 },
];
const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();
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
                if (/^\/api\/marketplace\/posts\/[^/]+\/photos\//.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO });
                const body = answer(url.pathname, url.search);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            });
            const page = await context.newPage();
            await page.goto(`${origin}/e2e/map-type-filter-harness.html?dark=${theme === 'dark' ? 1 : 0}`, { waitUntil: 'load' });
            if (view.scale !== 1) await page.addStyleTag({ content: `html { font-size: ${view.scale * 100}% !important; }` });
            await page.waitForSelector('.custom-map-pin', { timeout: 30_000 });
            await page.waitForSelector('.custom-event-pin', { timeout: 30_000 });
            await page.waitForTimeout(800);
            const pins = await page.evaluate(() => [...document.querySelectorAll('.custom-map-pin, .custom-event-pin')].length);
            const seen = new Set();
            for (let i = 0; i < pins; i++) {
                await page.evaluate((k) => document.querySelectorAll('.custom-map-pin, .custom-event-pin')[k]?.click(), i);
                await page.waitForSelector('[data-testid="map-preview-card"]', { timeout: 10_000 });
                await page.waitForTimeout(700);
                const m = await page.evaluate(measure);
                const label = (m.title || `pin${i}`).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
                if (seen.has(label)) { await page.evaluate(() => document.querySelector('[data-testid="map-preview-card"] button[aria-label="Close preview"]')?.click()); continue; }
                seen.add(label);
                const file = `${view.name}-${theme}-${label}.png`;
                const box = await page.evaluate(() => document.querySelector('[data-testid="map-preview-card"]').firstElementChild.getBoundingClientRect().toJSON());
                // The card with a margin of map round it, at most 900 wide.
                const pad = 16;
                const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
                const clip = { x, y, width: Math.min(900, view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) };
                await page.screenshot({ path: path.join(SHOTS_DIR, file), clip: view.width <= 400 ? undefined : clip });
                results.push({ file, ...m });
                for (const p of m.problems) { failed = true; console.error(`FAIL ${file}: ${p}`); }
                console.log(`${m.problems.length ? 'FAIL' : 'ok  '} ${file}  card ${m.card ? `${m.card.w.toFixed(0)}x${m.card.h.toFixed(0)}` : '-'}  slot ${m.slot ? `${m.slot.w.toFixed(0)}x${m.slot.h.toFixed(0)} beside ${m.slot.beside.toFixed(0)}` : '-'}  buttons [${(m.buttons || []).join(' | ')}]`);
                await page.evaluate(() => document.querySelector('[data-testid="map-preview-card"] button[aria-label="Close preview"]')?.click());
                await page.waitForTimeout(300);
            }
            if (seen.size < POSTS.length) { failed = true; console.error(`FAIL ${view.name}-${theme}: opened ${seen.size} of ${POSTS.length} cards (${[...seen].join(', ')})`); }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
    fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
}
if (failed) { console.error('map-pop-up-card-shots: FAILED'); process.exit(1); }
console.log(`map-pop-up-card-shots: ${results.length} cards, none failing, in ${SHOTS_DIR}`);
