/**
 * The Ledger's doors to deals in the web app (deals S6, DESIGN-deals-fable.md §2.2, §5), at 320 px with 1.3× text, light
 * and dark: the real LedgerPage (e2e/ledger-doors-shots-harness.tsx), its Wallet tab, with beans held in trust (the Held in
 * Trust total, and the rows of a hold whose deal the member has, a hold it hasn't, and Beans from a member) and with
 * nothing held (no total).
 *
 * Fails on: the page scrolling sideways; anything with words past either edge; the total or a hold's row under 44 px tall,
 * or not a <button>; a tap that doesn't go where it should (the total: the Market's deals sheet on In Progress; the row:
 * the deal's listing); text under 4.5:1 is for the contrast check (e2e/dark-contrast-check.mjs), not here.
 *
 * Builds the harness with Vite into a temp folder; every /api request is answered here, every other host refused.
 * Nothing here talks to a node.
 *
 * Run: node e2e/ledger-doors-shots.mjs [shots-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, document, window, localStorage */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY, mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-ledger-doors');
const ME = IDENTITY.publicKey;
const LISTING = '123e4567-e89b-12d3-a456-426614174000';
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 24 * 3600 * 1000;

/** Android's font size scales text, not layout: the root to 130 %, and the cards' pixel sizes with it (harness.mjs). */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((px) => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

const BALANCE = {
    balance: 85, floor: -200, usableFloor: -200, liveOffers: 1, activated: true, frozen: false, earnedCredit: 150, tierCredit: 200,
    commonsBalance: 12.5, qualifiedValue: 300, avgRating: 4.5, reviewCount: 3, trustStats: { uniquePartners: 4 }, callsign: 'Visitor',
    tier: { name: 'Resident' },
};
const TXNS = (held) => (held ? [
    { id: 't1', from: ME, to: 'escrow_deal-1', amount: 45, taxFee: 0, memo: `Escrow hold for offer ${LISTING}`, timestamp: iso(-DAY) },
    { id: 't2', from: ME, to: 'escrow_deal-gone', amount: 5, taxFee: 0, memo: 'Adjust escrow for 2 hours', timestamp: iso(-2 * DAY) },
    { id: 't3', from: 'member-mia', to: ME, amount: 40, taxFee: 0, memo: `Paid for ${LISTING} thanks`, timestamp: iso(-3 * DAY) },
] : [
    { id: 't3', from: 'member-mia', to: ME, amount: 40, taxFee: 0, memo: 'Fresh eggs', timestamp: iso(-3 * DAY) },
]);

const unanswered = new Set();
function answer(pathname, search, held) {
    if (pathname.startsWith('/api/ledger/balance')) return BALANCE;
    if (pathname === '/api/ledger/transactions') return TXNS(held);
    if (pathname === '/api/community/members') return [];
    if (pathname === '/api/members') return { members: [], nextCursor: null };
    if (pathname === '/api/community/me') return { mute: { muted: false, until: null }, features: null };
    if (pathname === '/api/community/info') return { memberCount: 40, postCount: 4, transactionCount: 9, commonsBalance: 12.5, profile: 'local', features: {} };
    if (pathname === '/api/commons/repayment') return { repayment: null };
    if (pathname.startsWith('/api/friends/')) return [];
    const fallback = mockResponse(pathname, search);
    if (fallback === undefined) unanswered.add(pathname);
    return fallback;
}

/** In the page: sideways scroll, words past an edge, and the two doors' size and kind. */
function measure() {
    const W = window.innerWidth;
    const out = { problems: [] };
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > W) out.problems.push('the page scrolls sideways');
    for (const el of document.body.querySelectorAll('*')) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        if (el.closest('.sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > W + 0.5 || r.left < -0.5) out.problems.push(`"${el.textContent.trim().slice(0, 40)}" spans ${Math.round(r.left)}–${Math.round(r.right)} px`);
    }
    const door = (testId, what) => {
        const els = [...document.querySelectorAll(`[data-testid="${testId}"]`)];
        return els.map((el) => {
            const r = el.getBoundingClientRect();
            if (el.tagName !== 'BUTTON') out.problems.push(`${what} is a <${el.tagName.toLowerCase()}>, not a button`);
            if (r.height < 43.5) out.problems.push(`${what} is ${Math.round(r.height)} px tall`);
            return Math.round(r.height);
        });
    };
    out.total = door('ledger-in-escrow', 'the Held in Trust total');
    out.rows = door('ledger-held-row', 'a hold\'s row');
    return out;
}

async function main() {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-ledger-doors-build-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    try {
        await build({
            configFile: false, root: PWA_DIR, plugins: [react()], define: { __APP_VERSION__: JSON.stringify('harness') }, logLevel: 'warn',
            build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'ledger-doors-shots-harness.html') } },
        });
        server = await preview({ configFile: false, root: PWA_DIR, preview: { port: 0, open: false }, build: { outDir }, logLevel: 'warn' });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const mode of ['light', 'dark']) {
            for (const held of [true, false]) {
                const run = `${mode} · ${held ? 'beans held in trust' : 'nothing held'}`;
                const context = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce', colorScheme: mode });
                await context.addInitScript((m) => {
                    localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                    localStorage.setItem('beanpool-theme-mode', m);
                }, mode);
                await context.route((url) => url.origin !== origin, (route) => route.abort());
                await context.route(`${origin}/api/**`, (route) => {
                    const url = new URL(route.request().url());
                    const body = answer(url.pathname, url.search, held);
                    if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                });
                await context.route(`${origin}/ws**`, (route) => route.abort());
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                try {
                    await page.goto(`${origin}/e2e/ledger-doors-shots-harness.html?held=${held ? 1 : 0}`, { waitUntil: 'load' });
                    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
                    await page.waitForSelector('html[data-harness-ready="true"]', { timeout: 20_000 });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.locator('button:has-text("💸")').first().click({ timeout: 10_000 });
                    await page.waitForTimeout(700);
                    const m = await page.evaluate(measure);
                    const problems = [...m.problems, ...errors.map((e) => `page error: ${e}`)];
                    if (held) {
                        if (m.total.length !== 1) problems.push(`expected the Held in Trust total, found ${m.total.length}`);
                        if (m.rows.length !== 1) problems.push(`expected one hold's row, found ${m.rows.length}`);
                    } else if (m.total.length || m.rows.length) problems.push('a door is drawn with nothing held');
                    await page.screenshot({ path: path.join(SHOTS_DIR, `ledger-wallet-${mode}-${held ? 'held' : 'none'}.png`), fullPage: true });
                    if (held) {
                        await page.locator('[data-testid="ledger-in-escrow"]').click();
                        await page.locator('[data-testid="ledger-held-row"]').click();
                        const went = await page.evaluate(() => window.__navigated);
                        const want = JSON.stringify([['marketplace', 'deals_active'], ['marketplace', LISTING]]);
                        if (JSON.stringify(went) !== want) problems.push(`taps went to ${JSON.stringify(went)}, not ${want}`);
                    }
                    for (const p of problems) failures.push(`${run}: ${p}`);
                    console.log(`${problems.length ? '✗' : '✓'} ${run}${problems.length ? `: ${problems.join('; ')}` : ` (total ${m.total.join(',') || '-'} px, rows ${m.rows.join(',') || '-'} px)`}`);
                } finally {
                    await context.close();
                }
            }
        }
        if (unanswered.size) console.log(`  (unanswered /api paths, read as empty: ${[...unanswered].join(', ')})`);
    } finally {
        await browser?.close();
        await server?.close();
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    if (failures.length) {
        console.error(failures.map((f) => `  ✗ ${f}`).join('\n'));
        process.exit(1);
    }
    console.log(`Every state holds. Pictures: ${SHOTS_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
