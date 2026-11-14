/* eslint-disable no-undef */
/**
 * Learn on the web, writing (DESIGN-local-knowledge-amend-fable.md, slice K4), on the REAL page, at the floor (320 px wide,
 * text at 130%), in light and dark: node apps/pwa/e2e/learn-write-320.mjs [--shots <dir>]
 *   the front for a member with one waiting ("1 of yours is waiting for an admin ›", "＋ Suggest knowledge" at the foot);
 *   the front for an admin with three to check (amber "▲ 3 to check ›", "＋ Add local knowledge"); the form; My suggestions;
 *   To check; one opened (an assistant's draft, with its tick); "Not this one".
 *
 * The real LearnPage with the real stylesheet (e2e/learn-harness.tsx); every /api call is answered here and nothing leaves the
 * machine. Checks, read from the live layout: no sideways scroll; every button at least 44 px tall and inside the screen; the
 * foot button never covers the last thing on the page once scrolled to the end; nothing is written by just looking.
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
const LIMIT_S = Number(process.env.LEARN_LIMIT_S || 300);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const row = (id, title, line, topic, over = {}) => ({ id, title, line, topic, photo: null, checkedAt: at(20), helped: 0, pinned: false, outdated: false, ...over });
const FRONT = {
    total: 3, pinned: [],
    topics: [
        { id: 'emergencies', count: 1, rows: [row('flood', 'Who to call when the creek floods the road', 'Call the council roads line first.', 'emergencies', { helped: 14 })] },
        { id: 'local-services', count: 2, rows: [
            row('s1', 'How recycling works at the tip', 'Bring glass, cans and paper sorted into their own boxes.', 'local-services', { helped: 9 }),
            row('s2', 'Green waste is free on the first weekend of the month', 'Bring it loose, not in bags.', 'local-services'),
        ] },
    ],
};
const mine = (id, over = {}) => ({ id, kind: 'new', title: 'Bins go out on Tuesday night, kerbside by seven', topic: 'local-services', state: 'waiting', createdAt: at(3), answeredAt: null, postId: null, reason: null, reasonWords: null, ...over });
const MINE = { waiting: [mine('w1')], answered: [
    mine('a1', { state: 'approved', postId: 's1', title: 'How recycling works at the tip', answeredAt: at(1) }),
    mine('a2', { state: 'declined', reason: 'duplicate', reasonWords: 'We have a page on the bins already: add to that one.', title: 'Where the bins go', answeredAt: at(2) }),
] };
const waitingRow = (id, over = {}) => ({ id, kind: 'new', title: 'The back road by the quarry stays open longer in a flood', topic: 'emergencies', from: { pubkey: 'member-ada', name: 'Ada' }, assistant: null, createdAt: at(1), ...over });
const TO_CHECK = [waitingRow('d1', { assistant: 'Research helper', from: { pubkey: 'admin-me', name: 'Damo' } }), waitingRow('d2'), waitingRow('d3', { kind: 'fix', title: 'Bins day' })];
const WHOLE = {
    ...TO_CHECK[0], body: 'When the low bridge goes under, use the back road by the quarry.\n\nIt stays open about two hours longer. Never drive through water over the road.',
    place: 'Quarry Road, past the old mill', sources: [{ url: 'https://www.council.example/roads/flood-response', label: 'Council roads line and flood response' }, { url: 'https://ses.example/storms', label: '' }],
    lang: 'en', about: 'place', note: null, photos: [], needsSourcesTicked: true,
};

const LIVE = { features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, knowledge: true } };

function answer(pathname, search, st) {
    if (pathname === '/api/node-admin/me') return { role: st.role ?? null };
    if (pathname === '/api/knowledge/front') return FRONT;
    if (pathname === '/api/knowledge/drafts/mine') return st.role ? { waiting: [], answered: [] } : MINE;
    if (pathname === '/api/knowledge/drafts') return { drafts: TO_CHECK, total: TO_CHECK.length, limit: 50, offset: 0 };
    if (pathname === '/api/knowledge/drafts/d1') return { draft: WHOLE };
    return mockResponse(pathname, search, undefined, { communityInfo: LIVE });
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-harness.html`;
const browser = await chromium.launch();
const problems = [];

/** `then`: taps after it is ready (one opened, Not this one), each waiting for what it shows. */
const STATES = [
    { name: 'front-member', hash: 'front', ready: '[data-testid="learn-mine-line"]' },
    { name: 'front-admin', hash: 'front', role: 'admin', ready: '[data-testid="learn-check-line"]' },
    { name: 'form', hash: 'suggest', ready: '[data-testid="learn-form"]', full: true },
    { name: 'mine', hash: 'mine', ready: '[data-testid="learn-mine"]' },
    { name: 'check', hash: 'check', role: 'admin', ready: '[data-testid="learn-check-list"]' },
    { name: 'check-one', hash: 'check', role: 'admin', ready: '[data-testid="learn-check-list"]', then: [['[data-testid="learn-check-row"]', '[data-testid="learn-check-one"]']], full: true },
    { name: 'check-no', hash: 'check', role: 'admin', ready: '[data-testid="learn-check-list"]', then: [['[data-testid="learn-check-row"]', '[data-testid="learn-check-one"]'], ['[data-testid="learn-check-not"]', '[data-testid="learn-check-no"]']], full: true },
];

try {
    for (const scheme of ['light', 'dark']) {
        for (const st of STATES) {
            const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => { try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* still a theme */ } }, [scheme]);
            const asked = [];
            await context.route('**/api/**', async (route) => {
                const url = new URL(route.request().url());
                asked.push(`${route.request().method()} ${url.pathname}${url.search}`);
                const body = answer(url.pathname, url.search, st);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
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
            for (const [tap, shows] of st.then ?? []) {
                await page.click(tap);
                await page.waitForSelector(shows);
            }
            await page.evaluate(() => document.fonts?.ready).catch(() => {});
            await page.waitForTimeout(400);

            const found = await page.evaluate(([width]) => {
                const out = [];
                if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const el of document.querySelectorAll('button, a[href]')) {
                    if (!visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    const name = (el.getAttribute('data-testid') || el.textContent || '').trim().slice(0, 40);
                    if (r.height < 43.5) out.push(`"${name}" is ${r.height.toFixed(1)} px tall, under 44`);
                    // The topic row scrolls sideways by design (learn-320.mjs checks it fits and shows its ›).
                    if (r.right > width + 0.5 && !el.closest('[data-testid="learn-topic-chips"]')) out.push(`"${name}" runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                    if (el.scrollWidth > el.clientWidth + 1 && !el.closest('[data-testid="learn-topic-chips"]')) out.push(`"${name}" is cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
                }
                // Scrolled to the end, the foot button sits under the standing line: it covers nothing.
                const foot = document.querySelector('[data-testid="learn-suggest"]');
                const standing = document.querySelector('[data-testid="learn-standing"]');
                if (foot && standing) {
                    window.scrollTo(0, document.documentElement.scrollHeight);
                    const f = foot.getBoundingClientRect();
                    const s = standing.getBoundingClientRect();
                    if (f.top < s.bottom - 0.5) out.push(`at the end the foot button (top ${f.top.toFixed(1)}) covers the standing line (bottom ${s.bottom.toFixed(1)})`);
                    window.scrollTo(0, 0);
                }
                return out;
            }, [WIDTH]);
            problems.push(...found.map((p) => `${scheme} ${st.name}: ${p}`));
            if (errors.length) problems.push(`${scheme} ${st.name}: page errors: ${errors.join(' | ')}`);
            const writes = asked.filter((a) => !a.startsWith('GET '));
            if (writes.length) problems.push(`${scheme} ${st.name}: a write by looking: ${writes.join(', ')}`);
            console.log(`${scheme} ${st.name}: ${found.length === 0 ? 'ok' : `${found.length} problem(s)`}`);

            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await page.screenshot({ path: path.join(SHOTS, `web-learn-write-320-${scheme}-${st.name}.png`) });
                if (st.full) await page.screenshot({ path: path.join(SHOTS, `web-learn-write-320-${scheme}-${st.name}-full.png`), fullPage: true });
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
console.log('web learn-write-320: passed');
process.exit(0);
