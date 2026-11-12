/**
 * A bell notice read in full (Marty, 12 Nov 2026: "when I click on a bell notification that has more to view I don't see the full
 * message and it goes to a page in BP and then the notification is gone"), in a real Chromium layout: the real mobile header and
 * its bell (e2e/bell-read-harness.tsx), the node answered by the page route below. At 320 × 568 with 1.3x text, light and dark, it
 * photographs the bell's list and a long notice read in full, and CHECKS what jsdom can't:
 *   1. the list cuts a long notice to a few lines (as before), and a tap on it reads it WHOLE: title and body in full, no clamp;
 *   2. reading marks nothing: no request to the node, the count still 2; Back returns to the list with both rows;
 *   3. the sheet fits the window, nothing runs off sideways, and Back / Clear / Open are each a 44 px target or more;
 *   4. Open goes to the notice's place first and only then marks it; Clear marks it and goes nowhere.
 * It prints a table (markdown) and exits non-zero on any failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered here, and any other /api or /ws request is aborted.
 *
 *   node e2e/bell-read-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, localStorage, URL, window */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const VIEWPORT = { w: 320, h: 568, scale: 1.3 };
const NOW_S = Math.floor(Date.now() / 1000);

const LONG_TITLE = '🤖 An AI assistant connected, then disconnected, and took two posts down in your community';
const LONG_BODY = [
    'An assistant that Maya connected to the Mullumbimby community this morning took down two posts: "Spare timber, free to a good home" and "Bike repair on Saturdays".',
    'Both are hidden now and final in 7 days. You can put them back in Settings until then.',
    'It also asked to post a new Offer, which was refused because the assistant has no account here.',
].join('\n\n');
const POST = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOTICES = [
    { id: 'n1', kind: 'community.notice', title: LONG_TITLE, body: LONG_BODY, data: { screen: 'post', postId: POST }, sentAt: NOW_S - 600, seenAt: null },
    { id: 'n2', kind: 'chat.message', title: '💬 New Message', body: 'Maya sent you a message', data: { screen: 'chat', conversationId: 'dm-maya' }, sentAt: NOW_S - 3600, seenAt: null },
];

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const HOME = {
    generatedAt: new Date().toISOString(), profile: 'local', features: { beans: true, decisions: true, invites: true },
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: true, standing: 'member' },
    layout: { v: 2, cards: [], dismissed: {}, updatedAt: null }, cards: { community: { name: 'Test community', members: 3 }, needs: { items: [] } },
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } };
const rows = [];

async function open(theme) {
    const context = await browser.newContext({ viewport: { width: VIEWPORT.w, height: VIEWPORT.h }, colorScheme: theme });
    const log = { marks: [], aborted: 0 };
    await context.route('**/*', (route) => {
        const req = route.request();
        const url = req.url();
        if (url.includes('/api/')) {
            const u = new URL(url);
            if (req.method() === 'GET' && u.pathname === '/api/notices/push') return route.fulfill(json({ notices: NOTICES }));
            if (req.method() === 'POST' && u.pathname === '/api/notices/push/seen') { log.marks.push({ at: Date.now(), body: req.postData() }); return route.fulfill(json({ marked: 1 })); }
            if (req.method() === 'GET' && u.pathname === '/api/home') return route.fulfill(json(HOME));
            if (req.method() === 'GET' && u.pathname === '/api/community/info') return route.fulfill(json({ name: 'Test community', features: { beans: true } }));
            log.aborted++;
            return route.abort();
        }
        if (url.startsWith('ws')) { log.aborted++; return route.abort(); }
        return route.continue();
    });
    const page = await context.newPage();
    // The text size is raised to 130% only after the sheet is open (below): at 320 px and 130% the header gives the tab's name and
    // the sync chip's words the room first and draws no bell at all (HeaderTitle), which is the header's rule, not this change's.
    await page.addInitScript(([th]) => {
        try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ }
        document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.classList.toggle('dark', th === 'dark');
            document.documentElement.classList.toggle('dark-theme', th === 'dark');
        });
    }, [theme]);
    await page.goto(`${base}/e2e/bell-read-harness.html`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="header-bell"]', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="bell-count"]')?.textContent === '2', null, { timeout: 30_000 });
    return { context, page, log };
}

const shot = async (page, name) => {
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: VIEWPORT.w, height: VIEWPORT.h } });
    return path.basename(file);
};

/** Runs in the page: how the open sheet sits in the window. */
const FIT = () => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
    const dialog = document.querySelector('[role="dialog"]');
    const read = document.querySelector('[data-testid="bell-read"]');
    return {
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialog: dialog ? box(dialog) : null,
        windowH: window.innerHeight,
        buttons: read ? Object.fromEntries(['bell-read-back', 'bell-read-clear', 'bell-read-open'].map((id) => [id, read.querySelector(`[data-testid="${id}"]`) ? box(read.querySelector(`[data-testid="${id}"]`)) : null])) : null,
        clamped: read ? [...read.querySelectorAll('*')].filter((e) => /line-clamp/.test(String(e.className))).length : null,
        title: read?.querySelector('[data-testid="bell-read-title"]')?.textContent ?? null,
        body: read?.querySelector('[data-testid="bell-read-body"]')?.textContent ?? null,
        navigated: window.__navigated ?? [],
    };
};

try {
    for (const theme of ['light', 'dark']) {
        const { context, page, log } = await open(theme);
        const tag = `320x568-130pct-${theme}`;

        await page.click('[data-testid="header-bell"]');
        await page.waitForSelector('[role="dialog"]');
        await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale * 100}%`; }, VIEWPORT.scale);
        await page.waitForTimeout(150);
        const listShot = await shot(page, `bell-list-${tag}`);
        const clamped = await page.evaluate(() => document.querySelectorAll('[data-testid="bell-notice"] .line-clamp-2, [data-testid="bell-notice"] .line-clamp-3').length);
        check(clamped >= 2, `${theme}: the list cuts a long row to a few lines, as before`);

        // 1. A tap reads it whole.
        await page.click('[data-testid="bell-notice"][data-notice-id="n1"]');
        await page.waitForSelector('[data-testid="bell-read"]');
        const readShot = await shot(page, `bell-read-${tag}`);
        const fit = await page.evaluate(FIT);
        check(fit.title === LONG_TITLE, `${theme}: the whole title is shown`);
        check(fit.body === LONG_BODY, `${theme}: the whole body is shown`);
        check(fit.clamped === 0, `${theme}: nothing in the full view is clamped`);
        check(!fit.sideways, `${theme}: nothing runs off sideways`);
        check(fit.dialog && fit.dialog.bottom <= fit.windowH && fit.dialog.right <= VIEWPORT.w, `${theme}: the sheet fits the window (${JSON.stringify(fit.dialog)} in ${VIEWPORT.w}x${fit.windowH})`);
        for (const [id, b] of Object.entries(fit.buttons ?? {})) check(b && b.h >= 44, `${theme}: ${id} is a 44 px target (${b ? b.h : 'missing'})`);
        // 2. Reading marks nothing; Back returns to the list.
        check(log.marks.length === 0, `${theme}: reading marked nothing (${log.marks.length} requests)`);
        await page.click('[data-testid="bell-read-back"]');
        await page.waitForSelector('[data-testid="bell-notice"][data-notice-id="n1"]');
        check((await page.locator('[data-testid="bell-notice"]').count()) === 2, `${theme}: Back shows both rows, both still unseen`);
        check(log.marks.length === 0, `${theme}: Back marked nothing`);

        // 3. Clear marks it and goes nowhere.
        await page.click('[data-testid="bell-notice"][data-notice-id="n2"]');
        await page.click('[data-testid="bell-read-clear"]');
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="bell-notice"]').length === 1);
        await page.waitForTimeout(300);
        check(log.marks.length === 1 && /"n2"/.test(log.marks[0].body), `${theme}: Clear marked n2 (${JSON.stringify(log.marks.map((m) => m.body))})`);
        check((await page.evaluate(() => (window.__navigated ?? []).length)) === 0, `${theme}: Clear went nowhere`);

        // 4. Open goes first, then marks.
        await page.click('[data-testid="bell-notice"][data-notice-id="n1"]');
        await page.click('[data-testid="bell-read-open"]');
        await page.waitForFunction(() => (window.__navigated ?? []).length === 1);
        await page.waitForTimeout(200);
        check(log.marks.length === 2 && /"n1"/.test(log.marks[1].body), `${theme}: Open marked n1 after going there`);
        check((await page.evaluate(() => JSON.stringify(window.__navigated))) === JSON.stringify([['marketplace', POST]]), `${theme}: Open went to the post`);
        check((await page.locator('[role="dialog"]').count()) === 0, `${theme}: Open closed the sheet`);
        // Back at normal text size the bell is drawn again, and nothing is left on it.
        await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
        await page.waitForSelector('[data-testid="header-bell"]');
        check((await page.getAttribute('[data-testid="header-bell"]', 'data-unseen')) === '0', `${theme}: both notices left the bell`);

        rows.push({ theme, listShot, readShot, dialog: fit.dialog, buttons: Object.fromEntries(Object.entries(fit.buttons ?? {}).map(([k, v]) => [k, v && `${v.w}x${v.h}`])), aborted: log.aborted });
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('\n| theme | list shot | read shot | sheet box | buttons | aborted requests |\n|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.theme} | ${r.listShot} | ${r.readShot} | ${JSON.stringify(r.dialog)} | ${JSON.stringify(r.buttons)} | ${r.aborted} |`);
if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
console.log('\nall checks passed');
