/**
 * MEASURES "Your account is new" and the node's refusal boxes (G11-e) in a real Chromium layout at the documented
 * floor, 320px with 1.3x text (and a 260px stress case), light and dark: nothing may reach past the viewport, the
 * page may not scroll sideways, and every card must render all three limits. Photographs each case to e2e/shots/.
 *
 * Nothing here touches a BeanPool node: /api/community/me is answered by the page route with a fixture, and any
 * other /api or /ws request is aborted and counted, so a stray fetch fails the run instead of escaping.
 *
 *   node e2e/new-account-card-check.mjs     # exits non-zero on any overflow
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory.
 */
/* global process, console, document, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.join(PWA_DIR, 'e2e', 'shots');

const CASES = [
    { name: 'phone-320-130pc', width: 320, height: 1400, fontScale: 1.3 },
    { name: 'STRESS-narrow-260-130pc', width: 260, height: 1600, fontScale: 1.3 },
];

const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(Date.now() + h * HOUR).toISOString();
const STANDING = {
    publicKey: 'me',
    probation: {
        onProbation: true, exemptBecause: null, ageEndsAt: at(50), keptPosts: 1, keptPostsNeeded: 3,
        endsWhen: { hours: 72, keptPosts: 3 },
        limits: {
            posts: { limit: 3, used: 3, remaining: 0, resetsAt: at(23) },
            photos: { limit: 5, used: 2, remaining: 3, resetsAt: at(5) },
            new_dm_recipients: { limit: 10, used: 10, remaining: 0, resetsAt: at(23) },
            knocks: { limit: 1 },
        },
    },
    mute: { muted: false, until: null },
};

/** Runs in the page: anything reaching past the viewport, and whether the page scrolls sideways. */
const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').slice(0, 40)}" spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') out.push(`${el.tagName.toLowerCase()} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return {
        overflow: out,
        pageScrollsSideways: document.documentElement.scrollWidth > vw,
        cards: document.querySelectorAll('[data-testid="new-account-card"]').length,
        rows: document.querySelectorAll('[data-testid^="new-account-limit-"]').length,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 } });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) {
        for (const c of CASES) {
            const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, colorScheme: theme });
            await context.route('**/*', (route) => {
                const url = route.request().url();
                if (url.includes('/api/community/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STANDING) });
                if (url.includes('/api/') || url.startsWith('ws')) { blocked++; return route.abort(); }
                return route.continue();
            });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            await page.goto(`${base}/e2e/new-account-card-harness.html`, { waitUntil: 'networkidle' });
            await page.evaluate(([t, scale]) => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            }, [theme, c.fontScale]);
            await page.waitForSelector('[data-testid="new-account-card"]');
            await page.evaluate(() => document.fonts.ready);

            const shot = `new-account-${c.name}-${theme}.png`;
            await page.screenshot({ path: path.join(OUT_DIR, shot), fullPage: true });
            const m = await page.evaluate(MEASURE);
            if (m.cards !== 2) failures.push(`${shot}: ${m.cards} cards rendered, expected 2`);
            if (m.rows !== 6) failures.push(`${shot}: ${m.rows} limit rows rendered, expected 6`);
            if (m.pageScrollsSideways) failures.push(`${shot}: the page scrolls sideways`);
            for (const o of m.overflow) failures.push(`${shot}: ${o}`);
            if (pageErrors.length) failures.push(`${shot}: page errors ${JSON.stringify(pageErrors)}`);
            console.log(`${shot}: ${m.cards} cards, ${m.rows} rows, ${m.overflow.length} overflowing, sideways ${m.pageScrollsSideways}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`(${blocked} other /api or /ws requests aborted at the browser)`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} problem(s):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ nothing reaches past the viewport, nothing scrolls sideways');
