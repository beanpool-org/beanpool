/**
 * The global node's web lobby (G9b, design G9a §7) in headless Chromium: a visitor with no key, at 320 px with 1.3x
 * text, light and dark. Builds the web app as it ships, serves it under the app document's Content-Security-Policy
 * (as web-join-check.mjs does), answers /api as the global node answers a guest (G9a's guestPost: no author key, name,
 * face or tier, the place at the centre of its 0.1° cell, no typed event place, no poll voters), and takes:
 *   1. the lobby's list: the header with Join, the Join card, the cards, and the one line under the first card
 *   2. a listing's detail sheet, from a point the visitor shared, at its top and at its one action, Join
 *   3. the map's pin card: the title and "near here"
 *   4. screen 1 of the join, opened over the lobby by Join
 * and fails on any sideways scroll, any policy violation, any request signed with a key (a visitor has none), any read
 * outside what the node lets a visitor read on the global profile, and any author, face or badge on the page.
 *
 * Nothing here talks to a node: /api is answered below, and every other host is refused (the map has no tiles).
 *
 * Run: pnpm --filter @beanpool/pwa lobby-shots [out-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, localStorage, location -- Node, and the page's side of evaluate() */
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
const VIEW = { viewport: { width: 320, height: 720 }, textScale: 1.3 };

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
        for (const theme of ['light', 'dark']) {
            const seen = { violations: [], signed: [], refused: [], hosts: new Set() };
            const context = await browser.newContext({ viewport: VIEW.viewport, reducedMotion: 'reduce', colorScheme: theme });
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
            }, [VIEW.textScale, theme === 'dark']);
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
                const file = path.join(SHOTS_DIR, `${name}-${theme}.png`);
                await page.screenshot({ path: file });
                console.log(`  ${path.basename(file)}`);
            }

            try {
                await page.goto(`${origin}/app`, { waitUntil: 'load' });
                await page.waitForSelector('[data-testid="visitor-list"]');
                await page.waitForSelector('[data-testid="visitor-card"] img');
                // The list starts at the Join card: bring the first card and the line under it into view too.
                await page.evaluate(() => { document.querySelector('main')?.scrollTo(0, 150); });
                await shot('1-lobby-list');

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
                await page.click('[data-testid="lobby-bottom-nav"] >> text=Map');
                await page.waitForSelector('.custom-map-pin');
                await page.click('.custom-map-pin >> nth=0', { force: true });
                await page.waitForSelector('[data-testid="map-preview-near"]');
                if (await page.$('button[aria-label="New Post"]')) throw new Failure('the map offers New Post to a visitor');
                await shot('3-map-pin-card');

                await page.click('[data-testid="header-join"] >> visible=true');
                await page.waitForSelector('[data-testid="join-screen-guard"]');
                await page.evaluate(() => document.querySelector('[data-testid="join-screen-guard"]')?.scrollIntoView({ block: 'start' }));
                await shot('4-join-screen-1');

                if (seen.violations.length) throw new Failure(`policy violations: ${JSON.stringify(seen.violations)}`);
                if (seen.signed.length) throw new Failure(`requests signed with a key: ${seen.signed.join(', ')}`);
                if (seen.refused.length) throw new Failure(`reads a visitor can't make: ${[...new Set(seen.refused)].join(', ')}`);
                console.log(`✓ ${theme}: no sideways scroll, no person on the page, 0 policy violations, no signed request, only visitor reads`);
            } catch (e) {
                failures.push(theme);
                console.error(`✗ ${theme}\n    ${e instanceof Failure ? e.message : e.stack}`);
                await page.screenshot({ path: path.join(SHOTS_DIR, `FAILED-${theme}.png`) }).catch(() => {});
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
    console.log('\n⭐️ The lobby at 320 px with 1.3x text, light and dark.');
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
