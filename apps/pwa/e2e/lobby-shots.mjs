/**
 * The global node's web lobby (G9b, design G9a §7) in headless Chromium: a visitor with no key, at 320x568 px with
 * 1.3x text and at 1280 px wide, light and dark (and the list alone at 640 px, the first width with a two-column grid).
 * Builds the web app as it ships, serves it under the app document's Content-Security-Policy (as web-join-check.mjs
 * does), answers /api as the global node answers a guest (G9a's guestPost: no author key, name, face or tier, the place
 * at the centre of its 0.1° cell, no typed event place, no poll voters), and takes:
 *   1. the lobby's list: the header with Join, the Join card, the cards, and the one line about joining
 *   2. a listing's detail sheet, from a point the visitor shared, at its top and at its one action, Join
 *   3. the map's pin card: the title and "near here"
 *   4. screen 1 of the join, opened over the lobby by Join
 *   5. a listing opened from a shared link (`/?post=`), which the lobby keeps in this tab for after the join
 * and fails on any sideways scroll, any policy violation, any request signed with a key (a visitor has none), any read
 * outside what the node lets a visitor read on the global profile, and any author, face or badge on the page. It also
 * measures: the one line under the first card in the one-column list, and from a grid width on a single line of its
 * own above a full first row of cards; each card's accessible name (title, type, terms, category, distance); the pin
 * card's ✕ at least 44 px square; and the shared link's id, and nothing else, kept in sessionStorage.
 *
 * Nothing here talks to a node: /api is answered below, and every other host is refused (the map has no tiles).
 *
 * Run: pnpm --filter @beanpool/pwa lobby-shots [out-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, localStorage, sessionStorage, location, getComputedStyle -- Node, and the page's side of evaluate() */
import { build, preview, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SOURCE = path.resolve(PWA_DIR, '../server/src/app-document-csp.ts');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.argv[2] || path.join(os.tmpdir(), 'bp-lobby-shots');
const PHOTO = fs.readFileSync(path.join(PWA_DIR, 'public/assets/header-bg.png'));
// `steps: 'list'` draws and measures the list only: the grid's first width, between the phone and the desktop.
const VIEWS = [
    { name: '320', viewport: { width: 320, height: 568 }, textScale: 1.3, steps: 'all' },
    { name: '640', viewport: { width: 640, height: 800 }, textScale: 1, steps: 'list' },
    { name: '1280', viewport: { width: 1280, height: 800 }, textScale: 1, steps: 'all' },
];
const LINKED_POST_STORAGE_KEY = 'beanpool_lobby_linked_post';

async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

// What the global node lets a visitor read (apps/server/src/https-server.ts PUBLIC_READ_EXACT / PUBLIC_READ_PATTERNS,
// less MEMBERS_ONLY_ON_GUEST_LISTINGS_*). The lobby needs far fewer.
const VISITOR_READS_EXACT = new Set([
    '/api/version', '/api/community/info', '/api/community/health', '/api/node/config', '/api/directory/info',
    '/api/invite/check', '/api/attest', '/api/marketplace/posts', '/api/federation/reachable-peers', '/api/pricing-guide',
    '/api/pair/poll', '/api/channels/options', '/api/pulse/oauth/config', '/api/node/info', '/api/federation/links',
    '/api/node/identity-epoch', '/api/global/communities', '/api/global/home', '/api/join/knock/status',
]);
const VISITOR_READS_PATTERNS = [
    /^\/api\/community\/membership\/[^/]+$/, /^\/api\/members\/callsign-available\/[^/]+$/, /^\/api\/recovery\/lookup\/[^/]+$/,
    /^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/, /^\/api\/messages\/[^/]+\/attachment$/, /^\/api\/pulse\/items\/[^/]+\/thumbnail$/,
    /^\/api\/avatar\/[^/]+$/,
];
const visitorMayRead = (p) => VISITOR_READS_EXACT.has(p) || VISITOR_READS_PATTERNS.some((re) => re.test(p));

const HOUR = 3_600_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const person = { authorPublicKey: 'hidden', authorCallsign: '', authorAvatarUrl: null, authorEnergyCycled: 0, authorFoundingNeeded: false };
const listing = (over) => ({
    type: 'offer', category: 'food', credits: 0, priceType: 'fixed', status: 'active', active: true, repeatable: false,
    audienceScope: 'public', photos: [], createdAt: iso(-3 * HOUR), updatedAt: iso(-3 * HOUR), ...person, ...over,
});
// Cell centres (0.1°), as the node sends a guest.
const POSTS = [
    listing({
        id: 'g-1', title: 'Sourdough loaves every Saturday', description: 'Two loaves a week from my kitchen. Happy to swap for eggs, jam or a hand in the garden.',
        photos: ['/api/marketplace/posts/g-1/photos/0', '/api/marketplace/posts/g-1/photos/1'], lat: -28.5, lng: 153.5,
    }),
    listing({ id: 'g-2', type: 'need', category: 'tools', title: 'Borrow a long ladder for two days', description: 'To clear the gutters before the rain.', lat: -28.6, lng: 153.5 }),
    listing({ id: 'g-3', category: 'education', title: 'Guitar lessons for beginners', description: 'An hour on Sunday afternoons.', photos: ['/api/marketplace/posts/g-3/photos/0'], lat: -28.5, lng: 153.6 }),
    listing({
        id: 'g-4', type: 'event', category: 'events', title: 'Seed swap in the park', description: 'Bring seeds, take seeds.',
        eventStartAt: iso(50 * HOUR), eventEndAt: iso(52 * HOUR), eventState: 'scheduled', goingCount: 6, interestedCount: 3, lat: -28.5, lng: 153.5,
    }),
];

class Failure extends Error {}

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-lobby-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    try {
        await build({ root: PWA_DIR, logLevel: 'error', build: { outDir, emptyOutDir: true } });
        server = await preview({
            configFile: false, root: PWA_DIR, build: { outDir }, logLevel: 'warn',
            preview: { port: 0, open: false, headers: { 'Content-Security-Policy': policy.APP_DOCUMENT_CSP, 'Referrer-Policy': policy.APP_DOCUMENT_REFERRER_POLICY } },
        });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const view of VIEWS) for (const theme of ['light', 'dark']) {
            const run = `${view.name} ${theme}`;
            const seen = { violations: [], signed: [], refused: [], hosts: new Set() };
            const context = await browser.newContext({ viewport: view.viewport, reducedMotion: 'reduce', colorScheme: theme });
            await context.exposeBinding('__reportCspViolation', (_s, v) => { seen.violations.push(v); });
            await context.addInitScript(([scale, dark]) => {
                document.addEventListener('securitypolicyviolation', (e) => {
                    window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, page: location.href });
                });
                // The visitor shared a point (the Market's Distance sheet), so distances show.
                localStorage.setItem('beanpool-radius', JSON.stringify({ lat: -28.52, lng: 153.52, radiusKm: 50, label: 'Mullumbimby' }));
                localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                localStorage.setItem('beanpool-theme-mode', dark ? 'dark' : 'light');
                document.addEventListener('DOMContentLoaded', () => {
                    const s = document.createElement('style');
                    s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                    document.head.appendChild(s);
                });
            }, [view.textScale, theme === 'dark']);
            await context.route((url) => url.origin !== origin, (route) => {
                seen.hosts.add(new URL(route.request().url()).hostname);
                return route.abort();
            });
            await context.route(`${origin}/api/**`, (route) => {
                const req = route.request();
                const url = new URL(req.url());
                const p = url.pathname;
                if (req.headers()['x-public-key']) seen.signed.push(p);
                if (!visitorMayRead(p)) seen.refused.push(p);
                const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
                if (p === '/api/community/info') {
                    return reply(200, { memberCount: 40, postCount: 4, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false, distanceSearch: true } });
                }
                if (p === '/api/community/health') return reply(200, { status: 'ok', version: '1.2.26' });
                if (p === '/api/marketplace/posts') {
                    const id = url.searchParams.get('id');
                    return reply(200, id ? POSTS.filter((x) => x.id === id) : POSTS);
                }
                if (/^\/api\/marketplace\/posts\/[^/]+\/photos\/[^/]+$/.test(p)) return route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO });
                if (p === '/api/node/config') return reply(200, { serviceRadius: null });
                if (p === '/api/node/info') return reply(200, { peerNodes: [] });
                return reply(404, { error: 'Not Found' });
            });
            const page = await context.newPage();

            async function shot(name) {
                await page.waitForTimeout(250);
                const { scrollWidth, innerWidth } = await page.evaluate(() => ({
                    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth,
                }));
                if (scrollWidth > innerWidth) throw new Failure(`${name}: the page scrolls sideways (${scrollWidth}px in ${innerWidth}px)`);
                const text = await page.evaluate(() => document.body.innerText);
                const person = text.match(/\bhidden\b|Anonymous|Posted by|Elder|Steward|Resident|Newcomer|No ratings/);
                if (person) throw new Failure(`${name}: the page shows "${person[0]}"`);
                const avatars = await page.evaluate(() => Array.from(document.images).map((i) => i.getAttribute('src')).filter((s) => s && s.includes('/api/avatar/')));
                if (avatars.length) throw new Failure(`${name}: a face on the page: ${avatars.join(', ')}`);
                const file = path.join(SHOTS_DIR, `${name}-${view.name}-${theme}.png`);
                await page.screenshot({ path: file });
                console.log(`  ${path.basename(file)}`);
            }

            /**
             * Where the one line about joining sits among the cards (4112421731). In the one-column list: right under the
             * first card, before the second. In a grid: on a row of its own above every card, one rendered line, with the
             * first row of cards full, never one card alone beside an empty gap.
             */
            async function checkListLayout() {
                const m = await page.evaluate(() => {
                    const list = document.querySelector('[data-testid="visitor-list"]');
                    const noteEl = list.querySelector('[data-testid="visitor-list-note"]');
                    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
                    // Each card sits in a `display: contents` wrapper, so the grid's items are the wrappers' children.
                    const items = Array.from(list.children).flatMap((w) => Array.from(w.children)).filter((el) => el !== noteEl);
                    return {
                        columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
                        notes: list.querySelectorAll('[data-testid="visitor-list-note"]').length,
                        note: box(noteEl),
                        lineHeight: parseFloat(getComputedStyle(noteEl).lineHeight),
                        cards: items.map(box),
                    };
                });
                if (m.notes !== 1) throw new Failure(`the list has ${m.notes} notes about joining, not one`);
                if (m.cards.length < 3) throw new Failure(`the list has ${m.cards.length} cards; the layout check needs 3`);
                if (m.columns === 1) {
                    if (!(m.note.top >= m.cards[0].bottom - 1 && m.note.bottom <= m.cards[1].top + 1)) {
                        throw new Failure(`one column: the note (${m.note.top}-${m.note.bottom}) is not between the first card (ends ${m.cards[0].bottom}) and the second (starts ${m.cards[1].top})`);
                    }
                    return 'one column, the note under the first card';
                }
                const firstTop = Math.min(...m.cards.map((c) => c.top));
                const firstRow = m.cards.filter((c) => Math.abs(c.top - firstTop) < 2).length;
                if (m.note.bottom > firstTop + 1) {
                    throw new Failure(`${m.columns} columns: the note (${Math.round(m.note.top)}-${Math.round(m.note.bottom)}) is not above the cards (first row at ${Math.round(firstTop)}, ${firstRow} card(s) on it)`);
                }
                if (firstRow !== Math.min(m.columns, m.cards.length)) throw new Failure(`${m.columns} columns: ${firstRow} card(s) on the first row`);
                if (m.note.height > m.lineHeight * 1.5) throw new Failure(`${m.columns} columns: the note runs to ${Math.round(m.note.height / m.lineHeight)} lines`);
                return `${m.columns} columns, the note on one line above a first row of ${firstRow}`;
            }

            try {
                await page.goto(`${origin}/app`, { waitUntil: 'load' });
                await page.waitForSelector('[data-testid="visitor-list"]');
                await page.waitForSelector('[data-testid="visitor-card"] img');
                // On a phone the list starts at the Join card: bring the first card and the line under it into view.
                if (view.name === '320') await page.evaluate(() => { document.querySelector('[data-testid="visitor-list-note"]')?.scrollIntoView({ block: 'center' }); });
                await shot('1-lobby-list');
                const layout = await checkListLayout();
                // A card's name for a screen reader: its title first, then what else it shows (4112421734).
                const named = await page.getByRole('button', { name: /^Borrow a long ladder for two days\. Need\. Free, a swap, or ask\. Tools\. about \d+ km\.$/ }).count();
                if (named !== 1) throw new Failure('no card is named "Borrow a long ladder for two days. Need. Free, a swap, or ask. Tools. about N km."');
                if (view.steps === 'list') {
                    if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations)}`);
                    if (seen.signed.length) throw new Failure(`requests signed with a key: ${seen.signed.join(', ')}`);
                    if (seen.refused.length) throw new Failure(`reads a visitor can't make: ${[...new Set(seen.refused)].join(', ')}`);
                    console.log(`✓ ${run}: ${layout}; cards named in full; no sideways scroll, no person on the page`);
                    continue;
                }

                await page.click('[data-testid="visitor-card"] >> nth=0');
                await page.waitForSelector('[data-testid="visitor-detail"]');
                const buttons = await page.$$eval('[data-testid="visitor-detail"] button', (bs) => bs.map((b) => b.textContent.trim()));
                if (JSON.stringify(buttons) !== JSON.stringify(['← Back to Market', "Join to see who's offering"])) {
                    throw new Failure(`the detail sheet's buttons: ${JSON.stringify(buttons)}`);
                }
                await shot('2a-detail-sheet-top');
                await page.evaluate(() => document.querySelector('[data-testid="visitor-join"]')?.scrollIntoView({ block: 'center' }));
                await shot('2b-detail-sheet-join');

                await page.click('text=← Back to Market');
                // The bottom bar on a phone, the sidebar from md up.
                await page.click('nav button:has-text("Map") >> visible=true');
                await page.waitForSelector('.custom-map-pin');
                await page.click('.custom-map-pin >> nth=0', { force: true });
                await page.waitForSelector('[data-testid="map-preview-near"]');
                if (await page.$('button[aria-label="New Post"]')) throw new Failure('the map offers New Post to a visitor');
                // The ✕ is a 44 px target at least, as the event card's is (4112421737).
                const close = await page.$eval('[data-testid="map-preview-card"] button[aria-label="Close preview"]', (b) => {
                    const r = b.getBoundingClientRect();
                    return { w: Math.round(r.width), h: Math.round(r.height) };
                });
                if (close.w < 44 || close.h < 44) throw new Failure(`the pin card's ✕ is ${close.w}x${close.h} px`);
                await shot('3-map-pin-card');

                await page.click('[data-testid="header-join"] >> visible=true');
                await page.waitForSelector('[data-testid="join-screen-guard"]');
                await page.evaluate(() => document.querySelector('[data-testid="join-screen-guard"]')?.scrollIntoView({ block: 'start' }));
                await shot('4-join-screen-1');

                // A shared link (4112421730): the listing opens in the lobby, and this tab keeps its id, and only that,
                // for after the join; the address loses `?post=`.
                await page.goto(`${origin}/app?post=g-2`, { waitUntil: 'load' });
                await page.waitForSelector('[data-testid="visitor-detail"]');
                const linked = await page.evaluate((key) => ({ kept: sessionStorage.getItem(key), search: location.search }), LINKED_POST_STORAGE_KEY);
                const kept = linked.kept ? JSON.parse(linked.kept) : null;
                if (!kept || kept.id !== 'g-2' || Object.keys(kept).sort().join() !== 'at,id') throw new Failure(`the shared link kept ${linked.kept}`);
                if (linked.search) throw new Failure(`the address still says ${linked.search}`);
                await shot('5-shared-link');

                if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations)}`);
                if (seen.signed.length) throw new Failure(`requests signed with a key: ${seen.signed.join(', ')}`);
                if (seen.refused.length) throw new Failure(`reads a visitor can't make: ${[...new Set(seen.refused)].join(', ')}`);
                console.log(`✓ ${run}: ${layout}; cards named in full; ✕ ${close.w}x${close.h} px; the shared link kept; no sideways scroll, no person on the page, 0 policy violations, no signed request, only visitor reads`);
            } catch (e) {
                failures.push(run);
                console.error(`✗ ${run}\n    ${e instanceof Failure ? e.message : e.stack}`);
                await page.screenshot({ path: path.join(SHOTS_DIR, `FAILED-${view.name}-${theme}.png`) }).catch(() => {});
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser?.close();
        if (server) await new Promise((resolve) => server.httpServer.close(resolve));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log(`\nPictures: ${SHOTS_DIR}`);
    if (failures.length) {
        console.error(`\n❌ ${failures.join(', ')} failed.`);
        process.exit(1);
    }
    console.log('\n⭐️ The lobby at 320 px with 1.3x text, at 640 px and at 1280 px, light and dark.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
