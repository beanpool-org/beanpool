/**
 * MEASURES the web's Invite and share button at the floor, 320 px with 1.3x text, light and dark, in English, the pseudo-locale
 * `xx` (every sentence ~35 % longer) and Tamil. The real SharePostButtons in a real Chromium layout (e2e/invite-and-share-harness.tsx),
 * three ways: the button closed; the panel open; and the panel after a tap with the node unreachable (the line that says an
 * offline ticket can't take anyone to a listing). Where this member may not invite (only admins invite and they are none)
 * there must be no button at all.
 * Nothing here touches a node: every /api request is answered by the page route below.
 *
 * Checks: nothing past the screen, nothing scrolls sideways, no words cut, every button 44 px or more; the panel has no
 * choice on it (the vouching reset, R0).
 *
 *   node e2e/invite-and-share-320.mjs [shots-dir]    # exits non-zero on any problem
 *
 * Run from apps/pwa. Needs @beanpool/core built.
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
const HEIGHT = 760;
const FONT_SCALE = 1.3;

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, who) {
    const u = new URL(url);
    if (u.pathname === '/api/community/info') {
        return json({ memberCount: 12, postCount: 30, transactionCount: 4, commonsBalance: 0, profile: 'local',
            features: { beans: true, invites: true, door: who === 'locked-out' ? 'admins' : 'members', shareOutside: true } });
    }
    if (u.pathname.startsWith('/api/ledger/balance/')) return json({ balance: 0, floor: 0, usableFloor: 0 });
    if (u.pathname === '/api/node-admin/me') return json({ role: null });
    return null;
}

const MEASURE = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const name = (el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40)}"`;
    for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        const hidden = el.matches('input[type="radio"]');
        if (!hidden && (r.right > vw + 0.5 || r.left < -0.5)) out.push(`${name(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
        const cuts = (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflow === 'clip') && el.scrollWidth > el.clientWidth + 1;
        if (!hidden && cuts && cs.textOverflow !== 'ellipsis' && /\p{L}/u.test(el.textContent || '')) out.push(`${name(el)} cuts its words (${el.scrollWidth} > ${el.clientWidth})`);
        if (el.matches('[data-testid="invite-and-share"] button, [data-testid="share-button"], [role="menuitem"]') && r.height < 44) out.push(`the button ${name(el)} is ${Math.round(r.height)} px tall, under 44`);
        if (el.matches('fieldset label') && r.height < 44) out.push(`the choice ${name(el)} is ${Math.round(r.height)} px tall, under 44`);
        if (el.matches('fieldset label span') && el.scrollWidth > el.clientWidth) out.push(`the words of ${name(el)} spill out of it (${el.scrollWidth} > ${el.clientWidth})`);
    }
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    return {
        problems: out,
        pageScrollsSideways: document.documentElement.scrollWidth > vw,
        hasButton: !!document.querySelector('[data-testid="invite-and-share-button"]'),
        radios: radios.map((r) => `${r.getAttribute('aria-label')}${r.checked ? ' (on)' : ''}`),
        note: document.querySelector('[data-testid="invite-and-share-note"]')?.textContent ?? null,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
try {
    for (const lang of ['en', 'xx', 'ta']) {
        for (const theme of ['light', 'dark']) {
            for (const state of ['closed', 'member', 'offline', 'locked-out']) {
                const who = state === 'closed' ? 'member' : state;
                const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const req = route.request();
                    const url = req.url();
                    if (url.includes('/api/')) {
                        if (state === 'offline' && req.method() === 'POST') return route.abort();
                        const a = answer(url, who);
                        return a ? route.fulfill(a) : route.abort();
                    }
                    if (url.startsWith('ws')) return route.abort();
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
                await page.goto(`${base}/e2e/invite-and-share-harness.html?${new URLSearchParams({ lang })}`, { waitUntil: 'networkidle' });
                // One Share button (DW2): the ways, and Invite and share among them, are in the menu it opens. 'closed' is the
                // panel closed, with the menu open to show the choice and its sentence.
                await page.waitForSelector('[data-testid="share-button"]', { timeout: 20_000 });
                await page.click('[data-testid="share-button"]');
                await page.waitForSelector('[data-testid="share-members-button"]', { timeout: 20_000 });
                if (state !== 'locked-out') await page.waitForSelector('[data-testid="invite-and-share-button"]', { timeout: 20_000 });
                else await page.waitForTimeout(800);
                if (state === 'member' || state === 'offline') {
                    // The choice closes the menu and opens its panel under the row.
                    await page.click('[data-testid="invite-and-share-button"]');
                    await page.waitForSelector('[data-testid="invite-and-share-panel"]', { timeout: 10_000 });
                }
                if (state === 'offline') {
                    await page.click('[data-testid="invite-and-share-make"]');
                    await page.waitForSelector('[data-testid="invite-and-share-note"]', { timeout: 10_000 });
                }
                await page.waitForTimeout(300);
                await page.evaluate(() => document.fonts.ready);
                const tag = `invite-and-share-web-${state}-${lang}-${theme}`;
                await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });
                const m = await page.evaluate(MEASURE);
                if (m.pageScrollsSideways) failures.push(`${tag}: the page scrolls sideways`);
                for (const p of m.problems) failures.push(`${tag}: ${p}`);
                if (pageErrors.length) failures.push(`${tag}: page errors ${JSON.stringify(pageErrors)}`);
                if (state === 'locked-out' && m.hasButton) failures.push(`${tag}: a member where only admins invite sees the button`);
                if ((state === 'member' || state === 'offline') && m.radios.length !== 0) failures.push(`${tag}: the panel has a choice on it (${m.radios.join(', ')})`);
                if (state === 'offline' && !m.note) failures.push(`${tag}: no note after the node was unreachable`);
                console.log(`${tag}: ${m.problems.length} problem(s); ${m.radios.join(', ') || 'no control'}${m.note ? `; note: ${m.note.slice(0, 50)}` : ''}`);
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
console.log('\n✓ Invite and share at 320 px with 1.3x text, en, xx and ta, light and dark');
