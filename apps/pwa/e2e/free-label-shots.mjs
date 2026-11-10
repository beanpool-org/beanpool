/* global process, console, document, window */
/**
 * What a listing priced at 0 reads ("Free", "Free help wanted"), and the New Post form's type choices with a line under each
 * (core listing-price.ts, post-type-lines.ts), in the real components (e2e/free-label-harness.tsx), in headless Chromium at 320 px
 * with text at 130%, at 390 px and at desktop width (1280), light and dark: the Market cards in grid, list and compact, the New
 * Post form's four choices, and a free Need's own page.
 *
 * Fails (exit 1) on, at any step: a free price that still draws a Beans sign or a figure, the price box's label still saying
 * "Willing to pay" over a free Need, a choice's line cut by its button's edge or missing, the page scrolling sideways.
 *
 * Run from apps/pwa: node e2e/free-label-shots.mjs   (FREE_LABEL_SHOTS_DIR=<dir>: where the pictures go; default
 * e2e/screenshots/free-label, gitignored). Nothing here talks to a node: every request off this machine is aborted and every
 * /api request is answered here.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { POSTS } from './free-label-posts.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.env.FREE_LABEL_SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots', 'free-label');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

function answer(pathname) {
    if (pathname === '/api/marketplace/posts') return POSTS;
    const one = pathname.match(/^\/api\/marketplace\/posts\/([^/]+)$/);
    if (one) return POSTS.find(p => p.id === one[1]);
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
    if (pathname === '/api/marketplace/transactions') return [];
    // The member has a name and a photo, so posting is not gated (lib/profile-status.ts).
    if (pathname.startsWith('/api/profile/')) return { publicKey: pathname.split('/').pop(), callsign: 'You', avatar: 'https://placehold.invalid/a.png' };
    if (pathname.startsWith('/api/ledger/balance')) return { balance_c: 24000, isBlockedFromTrading: false };
    return undefined;
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

const VIEWS = [
    { name: '320x1.3', width: 320, height: 640, scale: 1.3 },
    { name: '390', width: 390, height: 780, scale: 1 },
    { name: 'desktop', width: 1280, height: 800, scale: 1 },
];
const results = [];
let failed = false;
const note = (label, problems) => {
    results.push({ label, problems });
    if (problems.length) failed = true;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${label}${problems.length ? `\n     ${problems.join('\n     ')}` : ''}`);
};

for (const view of VIEWS) {
    for (const dark of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light' });
        await ctx.addInitScript(() => {
            try { localStorage.setItem('beanpool-sync-state', JSON.stringify({ connected: true, lastSyncTime: Date.now() - 60000, merkleRoot: null, accountCount: 0 })); } catch (e) { /* private window */ }
        });
        await ctx.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname.startsWith('/api/')) {
                const body = answer(url.pathname);
                return route.fulfill({ status: body === undefined ? 404 : 200, contentType: 'application/json', body: JSON.stringify(body === undefined ? {} : body) });
            }
            return route.continue();
        });
        const page = await ctx.newPage();
        const tag = `${view.name}-${dark ? 'dark' : 'light'}`;
        const open = async (qs) => {
            await page.goto(`${origin}/e2e/free-label-harness.html?${qs}${dark ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
            await page.addStyleTag({ content: `html { font-size: ${16 * view.scale}px !important; }` });
            await page.waitForTimeout(400);
        };

        // 1. The Market cards.
        await open('view=cards');
        const cards = await page.evaluate(() => {
            const problems = [];
            const vw = document.documentElement.clientWidth;
            if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
            for (const section of document.querySelectorAll('[data-testid^="cards-"]')) {
                const view = section.getAttribute('data-testid');
                const text = section.textContent || '';
                const free = (text.match(/Free/g) || []).length;
                if (free !== 3) problems.push(`${view}: ${free} Free prices, expected 3 (two Offers and a Need at 0)`);
                if (/Free\s*\/(hr|day|wk|mo)/i.test(text)) problems.push(`${view}: Free with a unit`);
                if (/(^|[^\d.])0\s*(B|🫘)/.test(text)) problems.push(`${view}: a 0 with a Beans sign`);
            }
            return problems;
        });
        note(`cards ${tag}`, cards);
        await page.screenshot({ path: path.join(SHOTS_DIR, `cards-${tag}.png`), fullPage: true });

        // 2. The New Post form's four choices.
        await open('view=form');
        const form = await page.evaluate(() => {
            const problems = [];
            const panel = document.querySelector('[data-testid="map-new-post-panel"]');
            if (!panel) return ['no New Post panel'];
            const vw = document.documentElement.clientWidth;
            for (const kind of ['offer', 'need', 'poll', 'event']) {
                const line = panel.querySelector(`[data-testid="new-post-type-line-${kind}"]`);
                if (!line || !(line.textContent || '').trim()) { problems.push(`no line under ${kind}`); continue; }
                const box = line.getBoundingClientRect();
                if (box.left < -0.5 || box.right > vw + 0.5) problems.push(`the ${kind} line runs past the screen (${box.left.toFixed(0)}..${box.right.toFixed(0)})`);
                if (line.scrollWidth > line.clientWidth + 1) problems.push(`the ${kind} line is cut by its box`);
            }
            if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
            return problems;
        });
        note(`form ${tag}`, form);
        await page.screenshot({ path: path.join(SHOTS_DIR, `form-${tag}.png`) });

        // 3. A free Need's own page.
        await open('view=detail&post=free-need');
        const detail = await page.evaluate(() => {
            const problems = [];
            const box = document.querySelector('[data-testid="listing-price"]');
            if (!box) return ['no price box'];
            const text = box.textContent || '';
            if (!/Free help wanted/.test(text)) problems.push(`the box does not say Free help wanted: "${text}"`);
            if (/Willing to pay/i.test(text)) problems.push('the box still says Willing to pay');
            if (box.querySelector('img')) problems.push('the free price draws a Beans sign');
            if (/(^|[^\d.])0(?![\d.])/.test(text)) problems.push(`a 0 in the free price: "${text}"`);
            const vw = document.documentElement.clientWidth;
            if (document.documentElement.scrollWidth > vw + 1) problems.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
            return problems;
        });
        note(`detail ${tag}`, detail);
        await page.screenshot({ path: path.join(SHOTS_DIR, `detail-${tag}.png`) });
        await ctx.close();
    }
}

await browser.close();
await server.close();
fs.writeFileSync(path.join(SHOTS_DIR, 'results.json'), JSON.stringify(results, null, 2));
console.log(failed ? 'FAILED' : 'all ok', `(${results.length} checks; pictures in ${SHOTS_DIR})`);
process.exit(failed ? 1 : 0);
