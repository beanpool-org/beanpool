/* eslint-disable no-undef */
/**
 * The ONE Share button and its menu (DESIGN-detail-pages-fable.md §2.5, slice DW2) on the REAL Market page, opened on a listing
 * and on an event: 320 px wide with 1.3x text (the floor) and 1280 px wide, light and dark, the menu shut and the menu open.
 *
 *   node e2e/share-menu-shots.mjs [--out <dir>]     # exits non-zero on any problem. Run from apps/pwa. Needs @beanpool/core built.
 *
 * Nothing here touches a node: every /api request is answered by the page route below. The page is the Market page alone (no
 * sidebar around it).
 *
 * Checks, from the live layout: nothing past the screen and no sideways scroll; shut, the page shows ONE Share button and none of
 * the ways or their sentences; open, the menu holds Share with members, Share outside the community and Invite and share in that
 * order, each with its sentence inside its own item; every control is 44 px or more; no words cut.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const outAt = process.argv.indexOf('--out');
const OUT_DIR = outAt > 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve(PWA_DIR, '../..', 'scratch', 'screenshots', 'share-menu');
fs.mkdirSync(OUT_DIR, { recursive: true });

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const AT = '2026-10-24T10:00:00.000Z';
const HOUR = 3_600_000;
const PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#7a9a6a"/></svg>');
const POSTS = [
    {
        id: 'p-ladder', type: 'offer', category: 'tools', title: 'Long ladder to lend', description: 'A 6 m extension ladder, light enough for one person.',
        credits: 15, priceType: 'fixed', status: 'active', active: true, repeatable: false, authorPublicKey: 'damo-key', authorCallsign: 'Damo',
        createdAt: AT, photos: [PHOTO], audienceScope: 'public',
    },
    {
        id: 'ev-market', type: 'event', category: 'community', title: 'Mullumbimby Community Market', description: 'The farmers and community market at Summers Park. Next date: Sat 21 Nov.',
        credits: 0, priceType: 'fixed', status: 'active', active: true, repeatable: false, authorPublicKey: 'damo-key', authorCallsign: 'Damo', createdAt: AT,
        photos: [PHOTO], audienceScope: 'public', eventState: 'scheduled', goingCount: 0, interestedCount: 0, myRsvp: null,
        eventStartAt: new Date(Date.now() + 48 * HOUR).toISOString(), eventEndAt: new Date(Date.now() + 54 * HOUR).toISOString(),
        eventPlaceName: 'Summers Park, corner of Stuart and Dalley Streets', lat: -28.55, lng: 153.5,
    },
];
const KINDS = [
    { kind: 'listing', post: 'p-ladder', trigger: '[data-testid="share-button"]' },
    { kind: 'event', post: 'ev-market', trigger: '[data-testid="event-share"]' },
];
const SIZES = [
    { name: '320', width: 320, height: 900, scale: 1.3 },
    { name: '1280', width: 1280, height: 900, scale: 1 },
];
const WANT_ITEMS = [
    ['Share with members', 'This link opens for members only.'],
    ['Share outside the community', 'Anyone with the link can read this'],
    ['Invite and share', 'One invite, for one person: a code works once.'],
];

// The Share block only (the button, the menu and what follows it): the rest of the page is other slices' to measure. The page
// as a whole must still not scroll sideways.
const MEASURE = (trigger) => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const name = (el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
    const block = document.querySelector(trigger)?.closest('.flex.flex-col.gap-2');
    if (!block) out.push(`no Share block around ${trigger}`);
    for (const el of block ? [block, ...block.querySelectorAll('*')] : []) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        const cs = getComputedStyle(el);
        const cuts = (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflow === 'clip') && el.scrollWidth > el.clientWidth + 1;
        if (cuts && cs.textOverflow !== 'ellipsis' && /\p{L}/u.test(el.textContent || '') && !el.matches('img, svg')) out.push(`${name(el)} cuts its words (${el.scrollWidth} > ${el.clientWidth})`);
        if (el.matches('[role="menuitem"]') && r.height < 44) out.push(`the item ${name(el)} is ${Math.round(r.height)} px tall, under 44`);
    }
    const menu = document.querySelector('[role="menu"]');
    const items = menu ? [...menu.querySelectorAll('[role="menuitem"]')] : [];
    return {
        problems: out,
        sideways: document.documentElement.scrollWidth > vw,
        menu: !!menu,
        items: items.map((i) => i.textContent.trim()),
        menuBox: menu ? (({ left, right, width }) => ({ left: Math.round(left), right: Math.round(right), width: Math.round(width) }))(menu.getBoundingClientRect()) : null,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/share-menu-harness.html`;
const browser = await chromium.launch();
const failures = [];
try {
    for (const theme of ['light', 'dark']) {
        for (const size of SIZES) {
            for (const k of KINDS) {
                const tag = `share-menu-${k.kind}-${size.name}${size.scale !== 1 ? `-x${size.scale}` : ''}-${theme}`;
                const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: theme, deviceScaleFactor: 1 });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                await page.addInitScript((scale) => {
                    try { localStorage.setItem('marketplace_view_mode', 'list'); } catch { /* none */ }
                    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
                }, size.scale);
                await page.route('**/*', async (route) => {
                    const url = new URL(route.request().url());
                    if (!url.hostname.includes('localhost')) return route.abort();
                    if (!url.pathname.startsWith('/api/')) return route.continue();
                    const p = url.pathname;
                    if (p.startsWith('/api/community/info')) {
                        return json(route, { memberCount: 12, profile: 'local', features: { beans: true, invites: true, knocks: true, door: 'members', shareOutside: true, escrow: true, enterprises: true, decisions: true } });
                    }
                    if (p === '/api/marketplace/posts') {
                        const id = url.searchParams.get('id');
                        return json(route, id ? POSTS.filter((x) => x.id === id) : (url.searchParams.get('author') ? [] : POSTS));
                    }
                    if (p === '/api/node-admin/me') return json(route, { role: null });
                    if (p.startsWith('/api/ledger/balance')) return json(route, { balance: 100, floor: -500, usableFloor: 0, isBlockedFromTrading: false, keeperOf: [] });
                    if (p === '/api/marketplace/transactions') return json(route, []);
                    if (p.startsWith('/api/ratings')) return json(route, { ratings: [], average: 0, count: 0 });
                    if (p.startsWith('/api/treasuries')) return json(route, { treasuries: [] });
                    if (p.startsWith('/api/groups')) return json(route, []);
                    if (p.startsWith('/api/members')) return json(route, []);
                    return json(route, {});
                });
                await page.goto(`${base}?post=${k.post}${theme === 'dark' ? '&dark=1' : ''}`);
                await page.waitForSelector(k.trigger, { timeout: 30_000 });
                await page.waitForTimeout(600);
                await page.evaluate(() => document.fonts.ready);

                // Shut: ONE Share button, none of the ways or their sentences.
                const shut = await page.evaluate(() => ({
                    ways: ['share-members-button', 'share-outside-button', 'invite-and-share-button', 'share-ask-admin-button']
                        .filter((id) => document.querySelector(`[data-testid="${id}"]`)),
                    menu: !!document.querySelector('[role="menu"]'),
                    sentences: ['This link opens for members only.', 'Anyone with the link can read this', 'One invite, for one person'].filter((s) => document.body.textContent.includes(s)),
                }));
                if (shut.ways.length || shut.menu || shut.sentences.length) failures.push(`${tag}: shut, the page shows ${JSON.stringify(shut)}`);
                const scrollToRow = () => page.locator(k.trigger).first().evaluate((el) => {
                    el.scrollIntoView({ block: 'start' });
                    window.scrollBy(0, -80);
                });
                await scrollToRow();
                await page.waitForTimeout(200);
                await page.screenshot({ path: path.join(OUT_DIR, `${tag}-shut.png`) });
                const shutMeasure = await page.evaluate(MEASURE, k.trigger);
                if (shutMeasure.sideways) failures.push(`${tag}: shut, the page scrolls sideways`);
                for (const p of shutMeasure.problems) failures.push(`${tag} (shut): ${p}`);

                // Open: the ways, in order, each with its sentence inside its own item.
                await page.click(k.trigger);
                await page.waitForSelector('[data-testid="invite-and-share-button"]', { timeout: 20_000 });
                await page.waitForTimeout(300);
                await scrollToRow();
                await page.waitForTimeout(200);
                await page.screenshot({ path: path.join(OUT_DIR, `${tag}-open.png`) });
                const open = await page.evaluate(MEASURE, k.trigger);
                if (open.sideways) failures.push(`${tag}: open, the page scrolls sideways`);
                for (const p of open.problems) failures.push(`${tag} (open): ${p}`);
                if (!open.menu) failures.push(`${tag}: the menu did not open`);
                if (open.items.length !== WANT_ITEMS.length) failures.push(`${tag}: ${open.items.length} items ${JSON.stringify(open.items)}, wanted ${WANT_ITEMS.length}`);
                WANT_ITEMS.forEach(([label, sentence], i) => {
                    const got = open.items[i] ?? '';
                    if (!got.startsWith(label) || !got.includes(sentence)) failures.push(`${tag}: item ${i + 1} reads ${JSON.stringify(got)}, wanted "${label}" then "${sentence}"`);
                });
                if (pageErrors.length) failures.push(`${tag}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${tag}: ${shutMeasure.problems.length + open.problems.length} problem(s); menu ${JSON.stringify(open.menuBox)}; ${open.items.length} items`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(`photographs in ${OUT_DIR}`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ One Share button and its menu, on a listing and on an event: 320 px with 1.3x text and 1280 px, light and dark');
