/* eslint-disable no-undef */
/**
 * Learn on the web (DESIGN-local-knowledge-amend-fable.md, slice K2), on the REAL pages, at the floor (320 px wide, text at
 * 130%), in light and dark: node apps/pwa/e2e/learn-320.mjs [--shots <dir>]
 *   1. the front (pinned page, three topics, a topic of five with "See all 5 ›"), one topic alone, a search with no match,
 *      a page with five sources and its photo, a page marked out of date, a page gathered with the assistant;
 *   2. the preview on a node with Learn off and showcase on (Example Valley's three pages under the strip);
 *   3. the Market with "tip" typed: the one line "📖 In Learn: 2 for "tip" ›".
 *
 * The real LearnPage and MarketplacePage with the real stylesheet (e2e/learn-harness.tsx); every /api call is answered here
 * and nothing leaves the machine. Checks, read from the live layout: no sideways scroll; every control (button, link) at
 * least 44 px tall; no chip, count or button word cut; the preview never asks the node for Learn or for a page; a live
 * node asks only for its own routes; pressing a row, Back and the Market line asks the app for the right place.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;
const HEIGHT = 720;
const SCALE = 1.3;

const LIMIT_S = Number(process.env.LEARN_LIMIT_S || 240);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const row = (id, title, line, topic, over = {}) => ({ id, title, line, topic, photo: null, checkedAt: at(20), helped: 0, pinned: false, outdated: false, ...over });

const ROWS = {
    flood: row('flood', 'Who to call when the creek floods the road', 'Call the council roads line first, and emergency services if anyone is in danger.', 'emergencies', { helped: 14, pinned: true, photo: '/assets/header-bg.png' }),
    s1: row('s1', 'How recycling works at the tip', 'Bring glass, cans and paper sorted into their own boxes.', 'local-services', { helped: 9, checkedAt: at(400) }),
    s2: row('s2', 'Green waste is free on the first weekend of the month', 'Bring it loose, not in bags.', 'local-services', { helped: 6 }),
    s3: row('s3', 'Council rates: who to ask about a hardship plan', 'The rates office takes calls from nine to three.', 'local-services', { helped: 3 }),
    s4: row('s4', 'Water restrictions this summer', 'Level two from December.', 'local-services'),
    s5: row('s5', 'Where to leave old paint and batteries', 'The shed by the gate, never the bins.', 'local-services'),
    old: row('old', 'The valley bus: times and where it stops', 'Leaves the shop at eight and one on weekdays.', 'getting-around', { outdated: true, helped: 2 }),
};
const FRONT = {
    total: 7,
    pinned: [ROWS.flood],
    topics: [
        { id: 'emergencies', count: 1, rows: [ROWS.flood] },
        { id: 'local-services', count: 5, rows: [ROWS.s1, ROWS.s2, ROWS.s3] },
        { id: 'getting-around', count: 1, rows: [ROWS.old] },
    ],
};
const knowledge = (over = {}) => ({ sources: [], place: null, lang: null, checkedAt: at(20), outdatedAt: null, outdatedNote: null, helped: 14, gathered: false, ...over });
const post = (id, over = {}) => ({
    id, type: 'knowledge', category: 'emergencies', title: 'Who to call when the creek floods the road', status: 'active', active: true, createdAt: at(60),
    description: 'Call the council roads line first, and emergency services if anyone is in danger.\n\nThe low bridge goes under first; the back road by the quarry stays open longer. Do not drive through water over the road: the creek is faster than it looks.',
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', photos: [], knowledge: knowledge(), ...over,
});
const POSTS = {
    flood: post('flood', {
        photos: ['/assets/header-bg.png'],
        knowledge: knowledge({
            place: 'The low bridge by the creek, Manse Road', lang: 'es',
            sources: [
                { url: 'https://www.council.example/roads/flood-response', label: 'Council roads line and flood response' },
                { url: 'https://www.ses.example/storms', label: 'SES storm and flood advice' },
                { url: 'http://roads.council.example:8080/closures', label: '' },
                { url: 'https://bom.example/warnings/flood', label: 'Bureau of Meteorology flood warnings' },
                { url: 'https://abc.example/emergency', label: 'Local emergency broadcast' },
            ],
        }),
    }),
    old: post('old', { category: 'getting-around', title: 'The valley bus: times and where it stops', knowledge: knowledge({ helped: 2, outdatedAt: at(5), outdatedNote: 'The timetable changed in March: ask at the shop.' }) }),
    gathered: post('gathered', { category: 'health-help', title: 'Clinic opening hours', authorCallsign: 'Bea', knowledge: knowledge({ gathered: true, helped: 0, sources: [{ url: 'https://clinic.example/hours', label: 'Clinic hours' }] }) }),
};
const SEARCH_TIP = { total: 2, rows: [ROWS.s1, ROWS.s5] };

const LIVE = { features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, knowledge: true } };
const PREVIEW = { features: { beans: false, knowledge: false, showcase: true } };

/** The node's answer to one /api call, or undefined for a 404 (as an older node would). */
function answer(pathname, search, info) {
    if (pathname === '/api/knowledge/front') {
        const q = new URLSearchParams(search);
        if (q.get('q')) return q.get('q') === 'tip' ? SEARCH_TIP : { total: 0, rows: [] };
        if (q.get('topic')) return { topic: q.get('topic'), count: 5, rows: [ROWS.s1, ROWS.s2, ROWS.s3, ROWS.s4, ROWS.s5], next: null };
        return FRONT;
    }
    if (pathname === '/api/marketplace/posts' && new URLSearchParams(search).get('type') === 'knowledge') {
        return Object.values(POSTS).filter((p) => p.id === new URLSearchParams(search).get('id'));
    }
    return mockResponse(pathname, search, undefined, { communityInfo: info });
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-harness.html`;
const browser = await chromium.launch();
const problems = [];

/** Each picture: its name, the node it talks to, what must be on screen, and what the checks may expect of it. */
const STATES = [
    { name: 'front', info: LIVE, hash: 'front', ready: '[data-testid="learn-topic-local-services"]' },
    { name: 'topic', info: LIVE, hash: 'topic', ready: '[data-testid="learn-topic-view"]' },
    { name: 'search-none', info: LIVE, hash: 'search', ready: '[data-testid="learn-search-empty"]' },
    { name: 'page-flood', info: LIVE, hash: 'page-flood', ready: '[data-testid="learn-post-sources"]' },
    { name: 'page-old', info: LIVE, hash: 'page-old', ready: '[data-testid="learn-post-outdated"]' },
    { name: 'page-gathered', info: LIVE, hash: 'page-gathered', ready: '[data-testid="learn-post-gathered"]' },
    { name: 'preview-front', info: PREVIEW, hash: 'front', ready: '[data-testid="learn-preview-strip"]', preview: true },
    { name: 'market-line', info: LIVE, hash: 'market', ready: '[data-testid="market-learn-line"]' },
];

try {
    for (const scheme of ['light', 'dark']) {
        for (const st of STATES) {
            const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => {
                try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* the default theme is still a theme */ }
            }, [scheme]);
            const asked = [];
            await context.route('**/api/**', async (route) => {
                const url = new URL(route.request().url());
                asked.push(`${route.request().method()} ${url.pathname}${url.search}`);
                const body = answer(url.pathname, url.search, st.info);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', headers: { ETag: `W/"learn-${st.name}"` }, body: JSON.stringify(body) }).catch(() => {});
            });
            await context.route('**/socket.io/**', (route) => route.abort());
            await context.route('**/ws**', (route) => route.abort());
            const page = await context.newPage();
            page.setDefaultTimeout(30_000);
            const errors = [];
            page.on('pageerror', (e) => errors.push(String(e)));
            await page.goto(`${base}#${st.hash}`, { waitUntil: 'load' });
            await page.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
            await page.waitForSelector(st.ready, { timeout: 60_000 });
            await page.evaluate(() => document.fonts?.ready).catch(() => {});
            await page.waitForTimeout(450);

            // The Market's own chips are not this slice's to measure: on its state only the new line is.
            const found = await page.evaluate(([width, only]) => {
                const out = [];
                if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const el of document.querySelectorAll(only ?? 'button, a[href]')) {
                    if (!visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    const name = (el.getAttribute('data-testid') || el.textContent || '').trim().slice(0, 40);
                    if (r.height < 43.5) out.push(`"${name}" is ${r.height.toFixed(1)} px tall, under 44`);
                    // A chip in the topic row scrolls sideways by design: the row must fit the screen and say "more" (the ›).
                    if (r.right > width + 0.5 && !el.closest('[data-testid="learn-topic-chips"]')) out.push(`"${name}" runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                }
                const chips = document.querySelector('[data-testid="learn-topic-chips"]');
                if (chips) {
                    if (chips.getBoundingClientRect().right > width + 0.5) out.push('the topic row runs past the screen');
                    if (chips.scrollWidth > chips.clientWidth + 4 && !document.querySelector('[data-testid="map-more-hint"]')) out.push('the topic row scrolls sideways and shows no › hint');
                }
                // Words cut: a chip, a button or a row's own words must fit their box (the chip row itself scrolls, by design).
                for (const el of document.querySelectorAll('[data-testid="learn-topic-chips"] button, [data-testid="learn-row-topic"], [data-testid="learn-see-all-local-services"], [data-testid="learn-back"], [data-testid="market-learn-line"]')) {
                    if (visible(el) && el.scrollWidth > el.clientWidth + 1) out.push(`"${(el.textContent || '').trim().slice(0, 40)}" is cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
                }
                return out;
            }, [WIDTH, st.name === 'market-line' ? '[data-testid="market-learn-line"]' : null]);
            problems.push(...found.map((p) => `${scheme} ${st.name}: ${p}`));
            if (errors.length) problems.push(`${scheme} ${st.name}: page errors: ${errors.join(' | ')}`);

            // What the page asked the node.
            const learnAsked = asked.filter((a) => a.includes('/api/knowledge/') || a.includes('type=knowledge'));
            if (st.preview) {
                if (learnAsked.length) problems.push(`${scheme} ${st.name}: the preview asked the node for Learn: ${learnAsked.join(', ')}`);
            } else if (learnAsked.length === 0) {
                problems.push(`${scheme} ${st.name}: a live node was never asked for Learn`);
            }
            const writes = asked.filter((a) => !a.startsWith('GET '));
            if (writes.length) problems.push(`${scheme} ${st.name}: a write: ${writes.join(', ')}`);
            if (st.name === 'market-line') {
                const listings = asked.filter((a) => a.includes('/api/marketplace/posts'));
                if (listings.some((a) => a.includes('knowledge'))) problems.push(`${scheme} market-line: the Market asked for a page: ${listings.filter((a) => a.includes('knowledge')).join(', ')}`);
            }
            console.log(`${scheme} ${st.name}: ${found.length === 0 ? 'ok' : `${found.length} problem(s)`}; learn reads: ${learnAsked.length}`);

            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `web-learn-320-${scheme}-${st.name}.png`) });
                if (['front', 'page-flood'].includes(st.name)) {
                    await page.screenshot({ path: path.join(SHOTS, `web-learn-320-${scheme}-${st.name}-full.png`), fullPage: true });
                }
            }

            // Pressing: a row opens its page; Back leaves Learn; the Market's line asks for the right place.
            if (st.name === 'front') {
                await page.click('[data-testid="learn-topic-emergencies"] [data-testid="learn-row"]');
                await page.waitForSelector('[data-testid="learn-post"]');
                await page.click('[data-testid="learn-back"]');
                await page.waitForSelector('[data-testid="learn-topic-chips"]');
                await page.click('[data-testid="learn-back"]');
                const navs = await page.evaluate(() => window.__navs);
                if (JSON.stringify(navs) !== JSON.stringify([['back']])) problems.push(`${scheme} front: Back asked for ${JSON.stringify(navs)}, wanted [["back"]]`);
            }
            if (st.name === 'market-line') {
                await page.click('[data-testid="market-learn-line"]');
                const navs = await page.evaluate(() => window.__navs);
                if (JSON.stringify(navs) !== JSON.stringify([['navigate', 'learn-search', 'tip']])) problems.push(`${scheme} market-line: the line asked for ${JSON.stringify(navs)}`);
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('web learn-320: passed');
process.exit(0);
