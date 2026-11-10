/**
 * The Credit line tab beside Beans on Send in the web app (slice G1; DESIGN-invites-and-names-list-amend2-fable.md §6), at
 * 320 px with 1.3× text, light and dark: the real LedgerPage (e2e/ledger-doors-shots-harness.tsx, nothing held), its Wallet
 * tab, Send open on the Credit line tab with Dana picked and 50 typed (the node offers up to 100), the same with the node's
 * refusal shown, and a member holding no Beans, whose Send opens on the Credit line tab.
 *
 * Fails on: the page scrolling sideways; anything with words past either edge; a tab under 44 px tall or not a tab; text
 * in the Send form under 4.5:1 contrast with what it is drawn on (3:1 from 18.66px bold or 24px).
 *
 * Builds the harness with Vite into a temp folder; every /api request is answered here, every other host refused.
 * Nothing here talks to a node.
 *
 * Run: node e2e/ledger-credit-gift-shots.mjs [shots-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global URL, console, process, document, window, localStorage, getComputedStyle */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-ledger-credit-gift');
const DANA = 'd'.repeat(64);
const REFUSAL = 'You’re using part of your credit line, so you can give 8 Beans of it at most now.';

/** Android's font size scales text, not layout: the root to 130 %, and the cards' pixel sizes with it (harness.mjs). */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((px) => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

// Every Beans figure is whole hundredths under a `_c` key, as the node answers (qualifiedValue and the gift's max, room and canGive keep their names).
const balance = (balance_c) => ({
    balance_c, floor_c: -15300, usableFloor_c: -15300, liveOffers: 1, activated: true, frozen: false, earnedCredit_c: 300, tierCredit_c: 300,
    commonsBalance_c: 1250, qualifiedValue: 1000, avgRating: 5, reviewCount: 0, trustStats: { uniquePartners: 1 }, callsign: 'Visitor',
    tier: { name: 'Newcomer' }, roomHeld_c: 15000,
});

const unanswered = new Set();
function answer(method, pathname, search, state) {
    if (pathname === '/api/credit/gift') {
        if (method === 'GET') return { status: 200, body: { offered: true, max: 10000, room: 15000, canGive: 10000, why: null } };
        return state.refuse ? { status: 409, body: { error: REFUSAL, code: 'in_use' } } : { status: 200, body: { amount_c: 5000, room: 10000, canGive: 5000 } };
    }
    if (pathname.startsWith('/api/ledger/balance')) return { status: 200, body: balance(state.balance_c) };
    if (pathname === '/api/ledger/transactions') return { status: 200, body: [] };
    if (pathname === '/api/community/members') return { status: 200, body: [{ publicKey: DANA, callsign: 'Dana' }] };
    if (pathname === '/api/members') return { status: 200, body: { members: [{ publicKey: DANA, callsign: 'Dana' }], nextCursor: null } };
    if (pathname === '/api/community/me') return { status: 200, body: { mute: { muted: false, until: null }, features: null } };
    if (pathname === '/api/community/info') return { status: 200, body: { memberCount: 40, postCount: 4, transactionCount: 9, commonsBalance_c: 1250, profile: 'local', features: {} } };
    if (pathname === '/api/commons/repayment') return { status: 200, body: { repayment: null } };
    if (pathname.startsWith('/api/friends/')) return { status: 200, body: [] };
    const fallback = mockResponse(pathname, search);
    if (fallback === undefined) unanswered.add(pathname);
    return fallback === undefined ? { status: 404, body: { error: 'Not Found' } } : { status: 200, body: fallback };
}

/** In the page: sideways scroll, words past an edge, the tabs' size and role, and the form's contrast. */
function measure() {
    const W = window.innerWidth;
    const problems = [];
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > W) problems.push('the page scrolls sideways');
    for (const el of document.body.querySelectorAll('*')) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        if (el.closest('.sr-only')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > W + 0.5 || r.left < -0.5) problems.push(`"${el.textContent.trim().slice(0, 40)}" spans ${Math.round(r.left)}–${Math.round(r.right)} px`);
    }
    for (const id of ['send-kind-beans', 'send-kind-credit']) {
        const tab = document.querySelector(`[data-testid="${id}"]`);
        if (!tab) { problems.push(`${id} is missing`); continue; }
        if (tab.getAttribute('role') !== 'tab') problems.push(`${id} has no tab role`);
        if (tab.getBoundingClientRect().height < 43.5) problems.push(`${id} is ${Math.round(tab.getBoundingClientRect().height)} px tall`);
    }
    const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const backdrop = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const c = rgb(getComputedStyle(e).backgroundColor);
            if (c && c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        for (const l of layers.reverse()) base = over(l, base);
        return base;
    };
    const form = document.querySelector('[data-testid="send-kind-tabs"]')?.parentElement;
    for (const el of form ? form.querySelectorAll('*') : []) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        if (el.closest('button:disabled')) continue; // an inactive control (WCAG 1.4.3)
        const cs = getComputedStyle(el);
        const fg = rgb(cs.color);
        if (!fg) continue;
        const bg = backdrop(el);
        const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        const size = parseFloat(cs.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) problems.push(`"${el.textContent.trim().slice(0, 40)}" has contrast ${ratio.toFixed(2)}:1`);
    }
    return problems;
}

async function main() {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-ledger-credit-gift-build-'));
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
            for (const shot of ['credit-tab', 'refusal', 'no-beans']) {
                const run = `${mode} · ${shot}`;
                const state = { balance_c: shot === 'no-beans' ? 0 : 123456, refuse: shot === 'refusal' };
                const context = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce', colorScheme: mode });
                await context.addInitScript((m) => {
                    localStorage.setItem('beanpool-theme-mode', m);
                }, mode);
                await context.route((url) => url.origin !== origin, (route) => route.abort());
                await context.route(`${origin}/api/**`, (route) => {
                    const url = new URL(route.request().url());
                    const { status, body } = answer(route.request().method(), url.pathname, url.search, state);
                    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
                });
                await context.route(`${origin}/ws**`, (route) => route.abort());
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                try {
                    await page.goto(`${origin}/e2e/ledger-doors-shots-harness.html?held=0`, { waitUntil: 'load' });
                    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
                    await page.waitForSelector('html[data-harness-ready="true"]', { timeout: 20_000 });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.locator('button:has-text("💸")').first().click({ timeout: 10_000 });
                    await page.waitForTimeout(500);
                    if (shot === 'no-beans') {
                        await page.getByRole('button', { name: 'Give part of your credit line' }).click({ timeout: 10_000 });
                    } else {
                        await page.getByRole('button', { name: /Send Beans/ }).last().click({ timeout: 10_000 });
                        await page.locator('[data-testid="send-kind-credit"]').click();
                        await page.getByRole('button', { name: /Select recipient/ }).click();
                        await page.getByText('Dana', { exact: true }).click();
                        await page.getByLabel('Credit line to give').fill('50');
                        if (shot === 'refusal') {
                            await page.getByRole('button', { name: 'Give credit line' }).click();
                            await page.getByText(REFUSAL).waitFor({ timeout: 10_000 });
                        }
                    }
                    await page.waitForTimeout(300);
                    const problems = [...await page.evaluate(measure), ...errors.map((e) => `page error: ${e}`)];
                    await page.locator('[data-testid="send-kind-tabs"]').scrollIntoViewIfNeeded();
                    await page.screenshot({ path: path.join(SHOTS_DIR, `web-${mode}-${shot}.png`) });
                    for (const p of problems) failures.push(`${run}: ${p}`);
                    console.log(`${problems.length ? '✗' : '✓'} ${run}${problems.length ? `: ${problems.join('; ')}` : ''}`);
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
