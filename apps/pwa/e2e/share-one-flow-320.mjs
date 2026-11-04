/**
 * ONE share flow on the web (share-one-flow): a listing's share sheet (components/SharePost.tsx, the real component with the
 * real Invite and share button) in a real Chromium layout at the floor, 320 px with 1.3x text, light and dark, for:
 *   - a member where any member may invite: the line and exactly ONE invite action (Invite and share);
 *   - a member where only admins invite: the line that only admins invite here, no invite action, and ONE more button,
 *     "Ask an admin to invite someone" (none where the node does not take asks);
 *   - an admin where only admins invite: the line and exactly ONE invite action;
 *   - a member with sharing outside on: Share outside, its lines, and one invite action.
 * Never an "Invite someone" button. Nothing here touches a node: every /api request is answered by the page route below.
 *
 *   node e2e/share-one-flow-320.mjs [shots-dir]    # exits non-zero on any problem. Run from apps/pwa. Needs @beanpool/core built.
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
    const onlyAdmins = who === 'admins-only' || who === 'admins-only-no-asks' || who === 'admin';
    if (u.pathname === '/api/community/info') {
        return json({ memberCount: 12, postCount: 30, transactionCount: 4, commonsBalance: 0, profile: 'local',
            features: { beans: true, invites: true, knocks: true, inviteAsks: who !== 'admins-only-no-asks', door: onlyAdmins ? 'admins' : 'members', shareOutside: who === 'outside' } });
    }
    if (u.pathname.startsWith('/api/ledger/balance/')) return json({ balance: 0, floor: 0, usableFloor: 0, canVouch: false });
    if (u.pathname === '/api/node-admin/me') return json({ role: who === 'admin' ? 'admin' : null });
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
        if (el.matches('[data-testid="share-ask-admin"] button, [data-testid="invite-and-share"] button, [data-testid="share-button"], [role="menuitem"]') && r.height < 44) out.push(`the button ${name(el)} is ${Math.round(r.height)} px tall, under 44`);
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
    const cases = [
        ['open-invite-member', 'member', 1, 'This link opens for members only.', 0],
        ['admins-only-member', 'admins-only', 0, 'This link opens for members only, and only admins invite here.', 1],
        ['admins-only-asks-off-member', 'admins-only-no-asks', 0, 'This link opens for members only, and only admins invite here.', 0],
        ['admins-only-admin', 'admin', 1, 'This link opens for members only.', 0],
        ['outside-on-member', 'outside', 1, 'This link opens for members only.', 0],
    ];
    const ONE_NOTE = 'Anyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.';
    for (const theme of ['light', 'dark']) {
        for (const [name, who, wantInvites, wantLine, wantAsks] of cases) {
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
            await page.goto(`${base}/e2e/invite-and-share-harness.html?lang=en`, { waitUntil: 'networkidle' });
            // One Share button (DW2): the ways, and the line under each, are in the menu it opens.
            await page.waitForSelector('[data-testid="share-button"]', { timeout: 20_000 });
            await page.click('[data-testid="share-button"]');
            await page.waitForSelector('[data-testid="share-members-button"]', { timeout: 20_000 });
            await page.waitForSelector('[data-testid="share-members-note"]', { timeout: 20_000 });
            await page.waitForTimeout(800);
            await page.evaluate(() => document.fonts.ready);
            const tag = `share-one-flow-web-${name}-${theme}`;
            await page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });
            const m = await page.evaluate(MEASURE);
            const found = await page.evaluate(() => ({
                invites: document.querySelectorAll('[data-testid="invite-and-share-button"]').length,
                asks: document.querySelectorAll('[data-testid="share-ask-admin-button"]').length,
                outside: document.querySelector('[data-testid="share-outside-line"]')?.textContent?.trim() ?? null,
                old: document.querySelectorAll('[data-testid="invite-someone-button"]').length + [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Invite someone').length,
                line: document.querySelector('[data-testid="share-members-note"]')?.textContent?.trim() ?? null,
            }));
            if (m.pageScrollsSideways) failures.push(`${tag}: the page scrolls sideways`);
            for (const p of m.problems) failures.push(`${tag}: ${p}`);
            if (pageErrors.length) failures.push(`${tag}: page errors ${JSON.stringify(pageErrors)}`);
            if (found.invites !== wantInvites) failures.push(`${tag}: ${found.invites} Invite and share button(s), wanted ${wantInvites}`);
            if (found.asks !== wantAsks) failures.push(`${tag}: ${found.asks} Ask an admin button(s), wanted ${wantAsks}`);
            if (found.asks && found.invites) failures.push(`${tag}: Invite and share and Ask an admin show together`);
            if (who === 'outside' && found.outside !== ONE_NOTE) failures.push(`${tag}: the Share outside note is ${JSON.stringify(found.outside)}, wanted the one note`);
            if (found.old) failures.push(`${tag}: the old Invite someone button shows`);
            if (found.line !== wantLine) failures.push(`${tag}: the line is ${JSON.stringify(found.line)}, wanted ${JSON.stringify(wantLine)}`);
            console.log(`${tag}: ${m.problems.length} problem(s); invite actions ${found.invites}; line "${found.line}"`);
            await context.close();
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
console.log('\n✓ One share flow at 320 px with 1.3x text, light and dark');
