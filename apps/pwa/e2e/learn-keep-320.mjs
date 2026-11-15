/* eslint-disable no-undef */
/**
 * Learn on the web, keeping it right (DESIGN-local-knowledge-fable.md §3.2 items 9-11, §3.5, §5.2-5.3; slice K5 B), on the REAL
 * page, at the floor (320 px wide, text at 130%), in light and dark: node apps/pwa/e2e/learn-keep-320.mjs [--shots <dir>]
 *   a member's page ("👍 This helped", "Helped 2", "Something changed? Suggest a fix"); the same after the tap ("👍 Helped ✓");
 *   the writer's page with "Mark as out of date" open; an admin's page that is marked (the amber box, Edit, Still right, Clear
 *   the mark); "Suggest a fix" (the form with "WHAT CHANGED? *" first); the fix sent; To check with the pages not checked for a
 *   year; a fix opened (only its changed part, Now beside Suggested, a part the page changed under marked).
 *
 * The real LearnPage with the real stylesheet (e2e/learn-harness.tsx); every /api call is answered here and nothing leaves the
 * machine. Checks, read from the live layout: no sideways scroll; every button at least 44 px tall and inside the screen;
 * nothing is written by just looking (a state's own taps write only what they say).
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

const ME = 'harness-me-pubkey';
const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const page = (id, over = {}, k = {}) => ({
    id, type: 'knowledge', category: 'local-services', title: 'How recycling works at the tip',
    description: 'Bring glass, cans and paper sorted into their own boxes.\n\nThe tip is open every day but Monday, 8 to 4.',
    authorPublicKey: 'member-ada', authorCallsign: 'Ada', createdAt: at(40), status: 'active', photos: [],
    knowledge: { sources: [{ url: 'https://www.council.example/waste/tip', label: 'Council tip page' }], place: 'The tip on Manse Road', lang: null,
        checkedAt: at(20), outdatedAt: null, outdatedNote: null, helped: 2, gathered: false, helpedByMe: false, ...k },
    ...over,
});
const PAGES = {
    tip: page('tip'),
    mine: page('mine', { authorPublicKey: ME, authorCallsign: 'You' }),
    old: page('old', { title: 'Bus times to the station' }, { outdatedAt: at(2), outdatedNote: 'The timetable changed in March: check the new one.' }),
};
const row = (id, title, topic, daysAgo) => ({ id, title, line: 'Ring first.', topic, photo: null, checkedAt: at(daysAgo), helped: 0, pinned: false, outdated: false });
const TO_CHECK = {
    drafts: [{ id: 'f1', kind: 'fix', title: 'How recycling works at the tip', topic: 'local-services', from: { pubkey: 'member-bea', name: 'Bea' }, assistant: null, createdAt: at(1) }],
    total: 1, limit: 50, offset: 0,
    unchecked: { total: 2, rows: [row('u1', 'Where the community hall key is kept', 'good-to-know', 420), row('u2', 'Bus times to the station', 'getting-around', 380)] },
};
const FIX = {
    ...TO_CHECK.drafts[0], body: 'Bring glass, cans and paper sorted into their own boxes.\n\nThe tip is closed on Mondays since March, open 8 to 4 other days.',
    place: 'The tip on Manse Road', sources: PAGES.tip.knowledge.sources, lang: null, about: null, note: 'The tip is closed on Mondays since March',
    photos: [], needsSourcesTicked: false,
    post: { id: 'tip', title: PAGES.tip.title, body: PAGES.tip.description, topic: 'local-services', place: 'The tip on Manse Road', sources: PAGES.tip.knowledge.sources, lang: null },
    changed: ['body'], pageChanged: ['body'],
};

const LIVE = { features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, knowledge: true } };

function answer(method, pathname, search, st) {
    if (pathname === '/api/node-admin/me') return { role: st.role ?? null };
    if (pathname === '/api/marketplace/posts' && new URLSearchParams(search).get('type') === 'knowledge') {
        const id = new URLSearchParams(search).get('id');
        return PAGES[id] ? [PAGES[id]] : [];
    }
    if (method === 'POST' && pathname.endsWith('/helped')) return { helped: 3, helpedByMe: true };
    if (method === 'POST' && pathname === '/api/knowledge/drafts') return { draft: { id: 'fx', kind: 'fix', fixOf: 'tip' } };
    if (pathname === '/api/knowledge/front') return { total: 0, pinned: [], topics: [] };
    if (pathname === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
    if (pathname === '/api/knowledge/drafts') return TO_CHECK;
    if (pathname === '/api/knowledge/drafts/f1') return { draft: FIX };
    return mockResponse(pathname, search, undefined, { communityInfo: LIVE });
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-harness.html`;
const browser = await chromium.launch();
const problems = [];

/** `then`: taps after it is ready, each waiting for what it shows; `type`: [selector, text] filled before the next tap. */
const STATES = [
    { name: 'page-member', hash: 'page-tip', ready: '[data-testid="learn-post-helped"]', full: true },
    { name: 'page-helped', hash: 'page-tip', ready: '[data-testid="learn-post-helped"]', then: [['[data-testid="learn-post-helped"]', '[data-testid="learn-post-helped"][aria-pressed="true"]']], writes: true },
    { name: 'page-writer-mark', hash: 'page-mine', ready: '[data-testid="learn-post-mark"]', then: [['[data-testid="learn-post-mark"]', '[data-testid="learn-post-mark-box"]']], full: true },
    { name: 'page-admin-marked', hash: 'page-old', role: 'admin', ready: '[data-testid="learn-post-clear"]', full: true },
    { name: 'fix-form', hash: 'page-tip', ready: '[data-testid="learn-post-fix"]', then: [['[data-testid="learn-post-fix"]', '[data-testid="learn-form-note"]']] },
    { name: 'fix-sent', hash: 'page-tip', ready: '[data-testid="learn-post-fix"]', then: [['[data-testid="learn-post-fix"]', '[data-testid="learn-form-note"]']],
        type: ['[data-testid="learn-form-note"]', 'Closed on Mondays since March'], after: [['[data-testid="learn-form-send"]', '[data-testid="learn-fix-sent"]']], writes: true },
    { name: 'check-year', hash: 'check', role: 'admin', ready: '[data-testid="learn-check-year"]', full: true },
    { name: 'check-fix', hash: 'check', role: 'admin', ready: '[data-testid="learn-check-list"]', then: [['[data-testid="learn-check-row"]', '[data-testid="learn-check-parts"]']], full: true },
];

try {
    for (const scheme of ['light', 'dark']) {
        for (const st of STATES) {
            const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => { try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* still a theme */ } }, [scheme]);
            const asked = [];
            await context.route('**/api/**', async (route) => {
                const url = new URL(route.request().url());
                const method = route.request().method();
                asked.push(`${method} ${url.pathname}${url.search}`);
                const body = answer(method, url.pathname, url.search, st);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
            });
            await context.route('**/socket.io/**', (route) => route.abort());
            await context.route('**/ws**', (route) => route.abort());
            const tab = await context.newPage();
            tab.setDefaultTimeout(30_000);
            const errors = [];
            tab.on('pageerror', (e) => errors.push(String(e)));
            await tab.goto(`${base}#${st.hash}`, { waitUntil: 'load' });
            await tab.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
            await tab.waitForSelector(st.ready, { timeout: 60_000 });
            for (const [tap, shows] of st.then ?? []) { await tab.click(tap); await tab.waitForSelector(shows); }
            if (st.type) await tab.fill(st.type[0], st.type[1]);
            for (const [tap, shows] of st.after ?? []) { await tab.click(tap); await tab.waitForSelector(shows); }
            await tab.evaluate(() => document.fonts?.ready).catch(() => {});
            await tab.waitForTimeout(300);

            const found = await tab.evaluate(([width]) => {
                const out = [];
                if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const el of document.querySelectorAll('button, a[href], input')) {
                    if (!visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    const name = (el.getAttribute('data-testid') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40);
                    if (r.height < 43.5) out.push(`"${name}" is ${r.height.toFixed(1)} px tall, under 44`);
                    if (r.right > width + 0.5) out.push(`"${name}" runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                    if (el.tagName !== 'INPUT' && el.scrollWidth > el.clientWidth + 1) out.push(`"${name}" is cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
                }
                return out;
            }, [WIDTH]);
            problems.push(...found.map((p) => `${scheme} ${st.name}: ${p}`));
            if (errors.length) problems.push(`${scheme} ${st.name}: page errors: ${errors.join(' | ')}`);
            const writes = asked.filter((a) => !a.startsWith('GET '));
            if (writes.length && !st.writes) problems.push(`${scheme} ${st.name}: a write by looking: ${writes.join(', ')}`);
            console.log(`${scheme} ${st.name}: ${found.length === 0 ? 'ok' : `${found.length} problem(s)`}`);

            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                await tab.screenshot({ path: path.join(SHOTS, `web-learn-keep-320-${scheme}-${st.name}.png`), fullPage: !!st.full });
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
console.log('web learn-keep-320: passed');
process.exit(0);
