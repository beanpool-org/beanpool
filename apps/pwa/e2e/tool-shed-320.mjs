/**
 * MEASURES the Tool shed's web screens (slice T1.3: "the same in vitest and a browser at 320 px") in a real Chromium
 * layout at the documented floor, 320 px with 1.3x text, in English and in the pseudo-locale `xx` (every sentence ~35 %
 * longer, as the longer languages are), light and dark: Your things, a thing in the shop and asked for, a thing lent
 * outside BeanPool, a thing with every field said, Edit with every field, and Loans (e2e/tool-shed-harness.tsx draws
 * each through the real tools' covered page). For each it lists:
 *   - the page, or any box in it, scrolling sideways; any element reaching past either edge of the screen;
 *   - a button, link, field or switch under 44 px tall;
 *   - words cut by their own box (overflow hidden or clip with more text than fits), unless the box cuts on purpose
 *     with an ellipsis (a row's one-line state);
 *   - an error on the page.
 * It photographs each screen at 320 px wide and at most 860 px tall (the top, and where it is longer, the rest of it
 * scrolled into view) to e2e/shots/ or the folder given.
 *
 * Nothing here touches a BeanPool node: every /api request is answered by the page route below (the member's Offers
 * and deals, the price guide, the private copy), and any other /api or /ws request is aborted and counted.
 *
 *   node e2e/tool-shed-320.mjs [shots-dir]    # exits non-zero on any problem
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global process, console, document, getComputedStyle, URL, URLSearchParams */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const WIDTH = 320;
const HEIGHT = 860;
const FONT_SCALE = 1.3;

const SCREENS = [
    { name: 'main', screen: 'main', key: null, waitFor: 'things-main' },
    { name: 'thing-in-shop-asked', screen: 'thing', key: 't-1', waitFor: 'thing-screen' },
    { name: 'thing-lent-outside', screen: 'thing', key: 't-2', waitFor: 'thing-screen' },
    { name: 'thing-every-field', screen: 'thing', key: 't-3', waitFor: 'thing-screen' },
    { name: 'edit-every-field', screen: 'edit', key: 't-3', waitFor: 'thing-edit-screen' },
    { name: 'loans', screen: 'loans', key: null, waitFor: 'things-loans-screen' },
];

const NOW = Date.now();
const DAY = 86_400_000;
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
/** The community's server, as these screens ask it. */
function answer(url, method) {
    const u = new URL(url);
    switch (`${method} ${u.pathname}`) {
        case 'GET /api/community/info': return json({ memberCount: 12, postCount: 30, transactionCount: 4, commonsBalance: 0, profile: 'local', features: { beans: true } });
        case 'GET /api/tools/things': return json({ tool: 'things', doc: null, updatedAt: null });
        case 'PUT /api/tools/things': return json({ success: true, tool: 'things', updatedAt: new Date().toISOString() });
        case 'GET /api/marketplace/posts': return json([{ id: 'post-1', title: 'Cordless drill', type: 'offer', status: 'active', authorPublicKey: 'tool-shed-harness-owner', priceType: 'fixed' }]);
        case 'GET /api/marketplace/transactions': return json([{ id: 'tx-1', postId: 'post-1', sellerPublicKey: 'tool-shed-harness-owner', buyerPublicKey: 'b', status: 'requested', createdAt: new Date(NOW - DAY).toISOString() }]);
        case 'GET /api/pricing-guide': return json({ items: [{ id: 'th-002', category: 'tools', emoji: '🪜', name: 'Extension Ladder Hire (6m / Day)', description: '', priceBeans: 12, unit: 'day' }] });
        default: return null;
    }
}

/** Runs in the page: what reaches past the screen, scrolls sideways, is too small to press, or cuts its words. */
const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const name = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        if (el.scrollWidth > el.clientWidth + 1 && !['visible', 'clip'].includes(cs.overflowX) && cs.overflowX !== 'hidden') out.push(`${name(el)} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
        const cuts = (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflow === 'clip') && el.scrollWidth > el.clientWidth + 1;
        if (cuts && cs.textOverflow !== 'ellipsis' && /\p{L}/u.test(el.textContent || '') && el.tagName !== 'IMG') out.push(`${name(el)} cuts its words (${el.scrollWidth} > ${el.clientWidth})`);
        const pressable = el.matches('button, a[href], input:not([type="file"]), textarea, [role="switch"]');
        if (pressable && cs.display !== 'none' && cs.visibility !== 'hidden' && r.height < 44) out.push(`${name(el)} is ${Math.round(r.height)} px tall, under 44`);
    }
    return { problems: out, pageScrollsSideways: document.documentElement.scrollWidth > vw };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const lang of ['en', 'xx']) {
        for (const theme of ['light', 'dark']) {
            for (const s of SCREENS) {
                const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const req = route.request();
                    const url = req.url();
                    if (url.includes('/api/')) {
                        const a = answer(url, req.method());
                        if (a) return route.fulfill(a);
                        blocked++;
                        return route.abort();
                    }
                    if (url.startsWith('ws')) { blocked++; return route.abort(); }
                    return route.continue();
                });
                const page = await context.newPage();
                const pageErrors = [];
                page.on('pageerror', (e) => pageErrors.push(e.message));
                await page.addInitScript(([t, scale]) => {
                    document.addEventListener('DOMContentLoaded', () => {
                        document.documentElement.classList.toggle('dark', t === 'dark');
                        document.documentElement.classList.toggle('dark-theme', t === 'dark');
                        document.documentElement.style.fontSize = `${scale * 100}%`;
                    });
                }, [theme, FONT_SCALE]);
                const q = new URLSearchParams({ screen: s.screen, lang, ...(s.key ? { key: s.key } : {}) });
                await page.goto(`${base}/e2e/tool-shed-harness.html?${q}`, { waitUntil: 'networkidle' });
                await page.waitForSelector(`[data-testid="${s.waitFor}"]`, { timeout: 20_000 });
                await page.waitForTimeout(400);
                await page.evaluate(() => document.fonts.ready);

                const tag = `tool-shed-${s.name}-${lang}-${theme}`;
                await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });
                // The covered page scrolls inside itself: a second photograph of the rest, where there is more.
                const more = await page.evaluate((h) => {
                    const pane = document.querySelector('[data-testid="tools-page"]');
                    if (!pane || pane.scrollHeight <= pane.clientHeight + 40) return false;
                    pane.scrollTop = Math.min(pane.scrollHeight - pane.clientHeight, h - 120);
                    return true;
                }, HEIGHT);
                if (more) {
                    await page.waitForTimeout(150);
                    await page.screenshot({ path: path.join(OUT_DIR, `${tag}-more.png`) });
                }
                const m = await page.evaluate(MEASURE);
                if (m.pageScrollsSideways) failures.push(`${tag}: the page scrolls sideways`);
                for (const p of m.problems) failures.push(`${tag}: ${p}`);
                if (pageErrors.length) failures.push(`${tag}: page errors ${JSON.stringify(pageErrors)}`);
                console.log(`${tag}: ${m.problems.length} problem(s), sideways ${m.pageScrollsSideways}${more ? ', 2 photographs' : ''}`);
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`(${blocked} other /api or /ws requests aborted at the browser)`);
console.log(`photographs in ${OUT_DIR}`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ the Tool shed at 320 px with 1.3x text, in English and xx, light and dark: nothing past the screen, nothing scrolls sideways, every target 44 px or more, no words cut');
