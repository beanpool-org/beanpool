/**
 * The web chat's pinned deal block (the Trust Hold banner, the listing header and the deal strip) must never take the thread
 * off a small screen or push the composer under the bottom nav. MEASURED in a real Chromium layout: the real MessagesPage
 * inside App's own layout (e2e/chat-deal-strip-fit-harness.tsx: App's root row, the real MobileHeader, `main` with the bottom
 * nav's padding, a nav of the same box), light and dark, at 360 x 640 with 1.3x text, 320 x 568 with 1x text and 320 x 568 with
 * 1.3x text (the documented floor). jsdom has no layout, so the unit tests pin the structure; this is the run that shows the
 * numbers. For each case it reads the thread's height, where the composer ends against the nav's top, the pinned block, and
 * whether `main` scrolled; it fails when:
 *   1. the thread is under 120 px, or the composer's bottom is under the nav's top (or the column's own bottom). In a window
 *      too short for both (the last viewport), the thread is the room that is left and only the composer must stay on screen;
 *   2. `main` scrolls (the column is taller than `main` leaves it) or the page scrolls sideways;
 *   3. the chat's Back button is out of view;
 *   4. some button of the pinned block cannot be reached by Tab, or is not in view inside its box once focused;
 *   5. the pinned "Rate your partner" banner shows beside a strip card for the same deal (two doors to one form).
 * It prints a table (markdown) of every case, and photographs each (320-360 px wide, at most 640 px tall) to e2e/shots/ or the
 * folder given.
 *
 * Nothing here touches a BeanPool node: every /api request is answered by the page route below, and any other /api or /ws
 * request is aborted and counted.
 *
 *   node e2e/chat-deal-strip-fit.mjs [shots-dir] [--page <another MessagesPage.tsx>]   # exits non-zero on any failed check
 *
 * --page measures another copy of MessagesPage.tsx (it must sit in src/pages, for its own relative imports): the table for
 * the page before a change, next to the table for the page after it. With it the checks only report; they do not fail.
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global process, console, document, getComputedStyle, localStorage, URL, Buffer */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const args = process.argv.slice(2);
const pageFlag = args.indexOf('--page');
const OTHER_PAGE = pageFlag >= 0 ? path.resolve(args.splice(pageFlag, 2)[1]) : null;
const OUT_DIR = args[0] ? path.resolve(args[0]) : path.join(PWA_DIR, 'e2e', 'shots');

const DM = 'c0ffee00-0000-4000-8000-0000000000d1';
const ME = 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678';
const BOB = 'b'.repeat(64);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();

/** A deal between me and Bob. By default I pay (I am the buyer) and it is held in trust. */
const deal = (id, title, over = {}) => ({
    id, postId: `post-${id}`, postTitle: title, buyerPublicKey: ME, buyerCallsign: 'Alice', sellerPublicKey: BOB, sellerCallsign: 'Bob',
    credits: 12, status: 'pending', createdAt: ago(2), ratedByBuyer: false, ratedBySeller: false, ...over,
});
/** The same deal with Bob paying: I am its seller. */
const sold = (id, title, over = {}) => deal(id, title, { buyerPublicKey: BOB, buyerCallsign: 'Bob', sellerPublicKey: ME, sellerCallsign: 'Alice', ...over });
const finished = { status: 'completed', completedAt: ago(8) };

const CASES = [
    {
        key: 'pay-2', label: 'I pay for 2 deals with Bob (banner + 1 card)',
        txs: [deal('t1', 'Sourdough bread, two loaves', { createdAt: ago(1) }), deal('t2', 'Hand-knitted wool socks', { createdAt: ago(3) })],
    },
    {
        key: 'pay-1-unrated', label: '1 deal in trust + 1 older finished, unrated',
        txs: [deal('t1', 'Sourdough bread, two loaves', { createdAt: ago(1) }), deal('t3', 'Bicycle repair', { createdAt: ago(10), ...finished })],
    },
    { key: 'payee-1', label: 'Payee only, 1 deal (strip, no banner)', txs: [sold('t1', 'Sourdough bread, two loaves', { createdAt: ago(1) })] },
    {
        key: 'payee-3', label: 'Payee only, 3 deals (strip, no banner)',
        txs: [sold('t1', 'Sourdough bread, two loaves', { createdAt: ago(1) }), sold('t2', 'Hand-knitted wool socks', { createdAt: ago(3) }), sold('t3', 'Bicycle repair', { createdAt: ago(10), ...finished })],
    },
    {
        key: 'pay-3-listing', label: 'I pay for 2 + 1 unrated, chat opened from a listing',
        listing: true,
        txs: [deal('t1', 'Sourdough bread, two loaves', { createdAt: ago(1) }), deal('t2', 'Hand-knitted wool socks', { createdAt: ago(3) }), deal('t3', 'Bicycle repair', { createdAt: ago(10), ...finished })],
    },
];
const VIEWPORTS = [
    { w: 360, h: 640, scale: 1.3 },
    { w: 320, h: 568, scale: 1.0 },
    { w: 320, h: 568, scale: 1.3 },
    // A window too short to hold the chat's header, a thread of 120 px and its composer at 1.3x text: the thread is then the
    // whole room and the pinned box has none (so only the checks that keep the composer on screen apply).
    { w: 320, h: 440, scale: 1.3, short: true },
];

const text = (id, from, body, minutesAgo) => ({
    id, conversationId: DM, authorPubkey: from, ciphertext: b64(body), nonce: 'plaintext-v1', type: 'text', metadata: '',
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(), editedAt: null,
});
const LINES = [
    text('m1', BOB, 'Hi Alice, the bread is baked and ready whenever you are.', 50),
    text('m2', ME, 'Lovely, I can collect it on Saturday morning.', 40),
    text('m3', BOB, 'Saturday works. Knock on the side door.', 30),
    text('m4', ME, 'See you then.', 20),
];

const conversation = (listing) => ({
    id: DM, type: 'dm', name: null, participants: [ME, BOB], createdBy: ME, peerCallsign: 'Bob', unreadCount: 0, createdAt: ago(20),
    postId: listing ? 'post-t1' : null, postTitle: listing ? 'Sourdough bread, two loaves' : null,
});

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method, kase) {
    const u = new URL(url);
    const conv = conversation(kase.listing);
    if (method === 'GET' && u.pathname === '/api/community/info') return json({ name: 'Test community', features: { beans: true } });
    if (method === 'GET' && u.pathname === `/api/messages/conversations/${ME}`) return json({ conversations: [conv], totalUnread: 0 });
    if (method === 'GET' && u.pathname === `/api/messages/${DM}`) return json({ conversation: conv, messages: LINES });
    if (method === 'GET' && u.pathname === '/api/community/members') return json([{ publicKey: BOB, callsign: 'Bob', role: 'member' }]);
    if (method === 'GET' && u.pathname === '/api/marketplace/transactions') return json(kase.txs);
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return json({ success: true });
    return null;
}

/** Runs in the page: where everything is, in px from the top of the window. */
const READ = () => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const main = q('[data-testid="app-main"]');
    const nav = q('[data-testid="mobile-bottom-nav"]');
    const root = main.firstElementChild;
    // The page before the pinned block had no test ids: its thread is the root's one growing scroll box.
    const thread = q('[data-testid="chat-thread"]')
        || Array.from(root.children).find((c) => getComputedStyle(c).overflowY === 'auto' && getComputedStyle(c).flexGrow === '1');
    let composer = q('textarea');
    while (composer && composer.parentElement !== root) composer = composer.parentElement;
    const pinned = q('[data-testid="chat-pinned"]');
    const strip = q('[data-testid="chat-deal-strip"]');
    const m = rect(main);
    const mainContentBottom = m.bottom - parseFloat(getComputedStyle(main).paddingBottom);
    const line = Math.min(rect(nav).top, mainContentBottom);
    const t = rect(thread);
    const c = rect(composer);
    const back = rect(q('button[aria-label="Back to messages"]'));
    return {
        navTop: Math.round(rect(nav).top),
        threadH: Math.round(t.height),
        composerBottom: Math.round(c.bottom),
        composerOver: Math.round(c.bottom - line),
        pinnedH: pinned ? Math.round(rect(pinned).height) : (strip ? Math.round(rect(strip).height) : 0),
        pinnedScrollH: pinned ? pinned.scrollHeight : 0,
        pinnedClientH: pinned ? pinned.clientHeight : 0,
        cards: strip ? strip.querySelectorAll('[role="group"]').length : 0,
        mainScrollTop: Math.round(main.scrollTop),
        mainOverflow: Math.max(0, main.scrollHeight - main.clientHeight),
        backTop: back ? Math.round(back.top - m.top) : null,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        banner: !!q('[data-testid="chat-rate-banner"]'),
        reviewCard: !!q('[data-testid="chat-deal-strip"] button[aria-label^="Leave a review"]'),
        trust: Array.from(document.querySelectorAll('div')).some((d) => d.children.length === 0 && d.textContent.includes('Trust Hold')),
    };
};

/** Runs in the page: the pinned block's own box (the strip alone when the page has no pinned box), and its enabled buttons. */
const PINNED_BUTTONS = () => {
    const own = document.querySelector('[data-testid="chat-pinned"]') || document.querySelector('[data-testid="chat-deal-strip"]');
    return own.querySelectorAll('button:not([disabled])').length;
};
/** Runs in the page after a Tab: the focused control, when it is in the pinned block, and whether it is in view there. */
const FOCUSED_IN_PINNED = () => {
    const own = document.querySelector('[data-testid="chat-pinned"]') || document.querySelector('[data-testid="chat-deal-strip"]');
    const a = document.activeElement;
    if (!a || !own.contains(a)) return null;
    const ar = a.getBoundingClientRect();
    const pr = own.getBoundingClientRect();
    const clipTop = Math.max(pr.top, document.querySelector('[data-testid="app-main"]').getBoundingClientRect().top);
    const clipBottom = Math.min(pr.bottom, document.querySelector('[data-testid="mobile-bottom-nav"]').getBoundingClientRect().top);
    return { id: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 60), ok: ar.top >= clipTop - 1 && ar.bottom <= clipBottom + 1 };
};

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error',
    resolve: OTHER_PAGE ? { alias: [{ find: /^\.\.\/src\/pages\/MessagesPage$/, replacement: OTHER_PAGE }] } : {},
});
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;
const failures = [];
const check = (ok, what) => {
    if (ok) return;
    failures.push(what);
    console.error(`  ✗ ${what}`);
};
const rows = [];

try {
    for (const theme of ['light', 'dark']) {
        for (const vp of VIEWPORTS) {
            for (const kase of CASES) {
                const tag = `${kase.key} ${vp.w}x${vp.h} @${Math.round(vp.scale * 100)}% ${theme}`;
                const shot = `chat-fit-${kase.key}-${vp.w}x${vp.h}-${Math.round(vp.scale * 100)}pct-${theme}`;
                const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme });
                await context.route('**/*', (route) => {
                    const req = route.request();
                    const url = req.url();
                    if (url.includes('/api/')) {
                        const a = answer(url, req.method(), kase);
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
                await page.addInitScript(([th, scale]) => {
                    // The app's own choice (lib/useTheme.ts): it is dark unless one is stored.
                    try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ }
                    document.addEventListener('DOMContentLoaded', () => {
                        document.documentElement.classList.toggle('dark', th === 'dark');
                        document.documentElement.classList.toggle('dark-theme', th === 'dark');
                        document.documentElement.style.fontSize = `${scale * 100}%`;
                    });
                }, [theme, vp.scale]);
                await page.goto(`${base}/e2e/chat-deal-strip-fit-harness.html`, { waitUntil: 'networkidle' });
                await page.waitForSelector('textarea', { timeout: 20_000 });
                await page.waitForSelector('[data-testid="chat-deal-strip"], [data-testid="chat-rate-banner"]', { timeout: 20_000 });
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(600);   // the chat's lines load, then the thread scrolls to the last one
                const r = await page.evaluate(READ);

                // Every button of the pinned block is reachable by the real keyboard (Tab moves focus and scrolls the focused
                // control into view), and in view in its box once it has focus.
                const total = await page.evaluate(PINNED_BUTTONS);
                const reached = new Set();
                let inView = 0;
                await page.focus('button[aria-label="Back to messages"]');
                for (let i = 0; i < 40 && reached.size < total; i++) {
                    await page.keyboard.press('Tab');
                    const st = await page.evaluate(FOCUSED_IN_PINNED);
                    if (st && !reached.has(st.id)) { reached.add(st.id); if (st.ok) inView++; }
                }
                const reach = { buttons: total, reached: reached.size, inView };

                await page.evaluate(() => { const p = document.querySelector('[data-testid="chat-pinned"]'); if (p) p.scrollTop = 0; });
                await page.screenshot({ path: path.join(OUT_DIR, `${shot}.png`) });
                // The pinned box scrolled to its end, when it has more than it shows.
                if (r.pinnedScrollH > r.pinnedClientH + 1) {
                    await page.evaluate(() => { const p = document.querySelector('[data-testid="chat-pinned"]'); p.scrollTop = p.scrollHeight; });
                    await page.waitForTimeout(100);
                    await page.screenshot({ path: path.join(OUT_DIR, `${shot}-scrolled.png`) });
                }

                rows.push({ tag, theme, vp, kase, r, reach });
                if (!OTHER_PAGE) {
                    check(vp.short || r.threadH >= 119.5, `${tag}: the thread is ${r.threadH} px (under 120)`);
                    check(r.composerOver <= 0.5, `${tag}: the composer ends ${r.composerOver} px under the nav's top`);
                    check(r.mainOverflow === 0 && r.mainScrollTop === 0, `${tag}: main scrolls (overflow ${r.mainOverflow}, scrolled ${r.mainScrollTop})`);
                    check(r.backTop !== null && r.backTop >= -0.5, `${tag}: the Back button is out of view (${r.backTop})`);
                    check(!r.sideways, `${tag}: the page scrolls sideways`);
                    check(vp.short || (reach.reached === reach.buttons && reach.inView === reach.buttons), `${tag}: Tab reached ${reach.reached} and showed ${reach.inView} of ${reach.buttons} pinned buttons`);
                    check(!(r.banner && r.reviewCard), `${tag}: the Rate your partner banner shows beside a Review card`);
                    check(pageErrors.length === 0, `${tag}: page errors ${JSON.stringify(pageErrors)}`);
                }
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

// The table: one line per case x viewport. The geometry is the same in both themes; a theme that differs is shown.
const lines = [
    '| Case | Viewport, text | Pinned block (shown / its content) | Thread px | Composer vs nav | Back in view | Tab reached (in view) |',
    '|---|---|---|---|---|---|---|',
];
for (const x of rows.filter((y) => y.theme === 'light')) {
    const dark = rows.find((y) => y.theme === 'dark' && y.kase === x.kase && y.vp === x.vp);
    const same = dark && dark.r.threadH === x.r.threadH && dark.r.composerOver === x.r.composerOver;
    const { r, reach, vp, kase } = x;
    const composer = r.composerOver <= 0.5 ? `above the nav (${-r.composerOver} px clear)` : `**${r.composerOver} px under the nav**`;
    lines.push(`| ${kase.label} | ${vp.w}×${vp.h}, ${Math.round(vp.scale * 100)} % | ${r.pinnedH} / ${r.pinnedScrollH || r.pinnedH} px, ${r.cards} card${r.cards === 1 ? '' : 's'}${r.trust ? ' + banner' : ''} | ${r.threadH}${same ? '' : ` (dark ${dark?.r.threadH})`} | ${composer} | ${r.backTop !== null && r.backTop >= -0.5 ? 'yes' : '**no**'} | ${reach.buttons ? `${reach.reached}/${reach.buttons} (${reach.inView})` : '-'} |`);
}
console.log(`\n${lines.join('\n')}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'chat-fit-table.md'), `${lines.join('\n')}\n`);
if (blocked) console.log(`(${blocked} other /api or /ws requests aborted at the browser)`);
console.log(`photographs in ${OUT_DIR}`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log(OTHER_PAGE ? '\n(measured another MessagesPage: checks only reported)' : '\n✓ the pinned deal block never takes the thread or the composer, at 320 px and 360 px, light and dark');
