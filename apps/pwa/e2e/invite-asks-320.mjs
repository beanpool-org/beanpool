/**
 * MEASURES a member's ask that an admin invite someone, on the web's invite screen at the floor, 320 px with 1.3x text,
 * light and dark, in English and the pseudo-locale `xx` (every sentence ~35 % longer): the real page in a real Chromium
 * layout (e2e/invite-asks-harness.tsx). Nothing here touches a node: every /api request is answered by the page route below.
 *
 * Shots: a member's small button and what they've asked; the sheet; an admin's ask with Send invite and No (where Needs you
 * lands); its reason. Checks: nothing past the screen, nothing scrolls sideways, no words cut, every button and field 44 px
 * or more, the sheet's two fields and no other, and Escape closes it.
 *
 *   node e2e/invite-asks-320.mjs [shots-dir]    # exits non-zero on any problem
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
const HEIGHT = 700;
const FONT_SCALE = 1.3;
const AT = '2026-11-03T02:00:00.000Z';
const ASK = { id: 'a1', firstName: 'Saoirse', howKnown: 'She runs the bakery on Jonson Street and helps at the Saturday market', askedAt: AT };

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, who) {
    const u = new URL(url);
    if (u.pathname === '/api/community/info') return json({ memberCount: 12, postCount: 30, transactionCount: 4, commonsBalance: 0, profile: 'local', features: { beans: true, invites: true, knocks: true, inviteAsks: true, door: 'admins' } });
    if (u.pathname === '/api/node-admin/me') return json({ role: who === 'admin' ? 'admin' : null });
    if (u.pathname.startsWith('/api/ledger/balance/')) return json({ balance: 0, floor: 0, usableFloor: 0 });
    if (u.pathname.startsWith('/api/invite/mine/')) return json({ invites: [] });
    if (u.pathname === '/api/invite/tree') return json([]);
    if (u.pathname === '/api/invite/asks/mine') return json({ waiting: [ASK], answers: [
        { id: 'n1', outcome: 'invited', state: 'ready', code: 'INV-K7QD-2MXA', askedAt: AT, answeredAt: AT },
        { id: 'n2', outcome: 'no', reason: 'We would like to meet them at a market day first', askedAt: AT, answeredAt: AT },
    ] });
    if (u.pathname === '/api/invite/asks') {
        return who === 'admin'
            ? json({ asks: [{ ...ASK, askerPubkey: 'm'.repeat(64), askerCallsign: 'Mel from the Byron co-op' }], total: 1 })
            : json({ error: 'no', code: 'admins_only' }, 403);
    }
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
        if (el.closest('[data-testid^="invite-ask"]') && el.matches('button, input:not([type="radio"])') && r.height < 43.5) out.push(`${name(el)} is ${Math.round(r.height)} px tall, under 44`);
    }
    return { problems: out, pageScrollsSideways: document.documentElement.scrollWidth > vw, fields: document.querySelectorAll('[role="dialog"] input').length };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
try {
    for (const lang of ['en', 'xx']) {
        for (const theme of ['light', 'dark']) {
            for (const who of ['member', 'admin']) {
                const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const url = route.request().url();
                    if (url.includes('/api/')) {
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
                await page.goto(`${base}/e2e/invite-asks-harness.html?${new URLSearchParams({ lang })}`, { waitUntil: 'networkidle' });
                const shoot = async (step) => {
                    await page.waitForTimeout(300);
                    await page.evaluate(() => document.fonts.ready);
                    const tag = `ask-web-${step}-${lang}-${theme}`;
                    await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`), fullPage: true });
                    const m = await page.evaluate(MEASURE);
                    if (m.pageScrollsSideways) failures.push(`${tag}: the page scrolls sideways`);
                    for (const p of m.problems) failures.push(`${tag}: ${p}`);
                    if (pageErrors.length) failures.push(`${tag}: page errors ${JSON.stringify(pageErrors)}`);
                    if (step === 'sheet' && m.fields !== 2) failures.push(`${tag}: the sheet has ${m.fields} fields, not 2`);
                    console.log(`${tag}: ${m.problems.length} problem(s)`);
                };
                if (who === 'member') {
                    await page.getByTestId('invite-ask-answer-n2').waitFor({ timeout: 20_000 });
                    await shoot('mine');
                    await page.getByTestId('invite-ask-open').click();
                    await page.getByTestId('invite-ask-first-name').fill('Saoirse');
                    await page.getByTestId('invite-ask-how-known').fill('She runs the bakery on Jonson Street');
                    await shoot('sheet');
                    await page.keyboard.press('Escape');
                    if (await page.getByRole('dialog').count() !== 0) failures.push(`${lang}-${theme}: Escape left the sheet open`);
                } else {
                    await page.getByTestId('invite-ask-a1').waitFor({ timeout: 20_000 });
                    await shoot('answer');
                    await page.getByTestId('invite-ask-no-a1').click();
                    await page.getByTestId('invite-ask-reason-a1').fill('We would like to meet them first');
                    await shoot('no');
                }
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
console.log('\n✓ the ask on the web at 320 px with 1.3x text, en and xx, light and dark: whole, inside the edge, 44 px targets');
