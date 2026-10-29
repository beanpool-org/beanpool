/**
 * A long chat message folds with "…more" on the web (components/FoldedChatText.tsx), MEASURED in a real Chromium layout at
 * the documented floor, 320 px with 1.3x text, light and dark. jsdom has no layout, so the unit tests model it; this is the
 * run that shows the clamp and the measuring work in a browser. The real MessagesPage draws a group chat's lines (e2e/long-
 * message-more-shots-harness.tsx); a one-to-one chat draws its bubbles by the same code. For each theme it checks that:
 *   1. a 40-line message is clamped to twelve lines, with "…more" under it, and the whole message still in the page;
 *   2. the control is a real button, at least 44 px by 44 px, named "Show the whole message";
 *   3. a 3-line message and a short one have no control and no wrapper at all;
 *   4. "…more" opens the whole message in place, "less" folds it again;
 *   5. a one-paragraph message that folds at 320 px stops folding when the window is wide, and folds again when narrow;
 *   6. nothing scrolls sideways.
 * It photographs the folded and the opened chat (320 px wide, at most 860 px tall) to e2e/shots/ or the folder given.
 *
 * Nothing here touches a BeanPool node: every /api request is answered by the page route below, and any other /api or /ws
 * request is aborted and counted.
 *
 *   node e2e/long-message-more-shots.mjs [shots-dir]    # exits non-zero on any failed check
 *
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
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const WIDTH = 320;
const HEIGHT = 860;
const FONT_SCALE = 1.3;

const GROUP = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3e';
const ME = 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678';
const BEN = 'b'.repeat(64);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const LIST = Array.from({ length: 40 }, (_, i) => `Job ${i + 1} for the working bee`).join('\n');
// About 530 characters: far more than twelve lines at 320 px, under ten in a wide window.
const PARAGRAPH = Array.from({ length: 30 }, () => 'bring a spade').join(' and ');
const NOW = Date.now();
const line = (id, author, text, minutesAgo) => ({
    id, conversationId: GROUP, authorPubkey: author, ciphertext: b64(text), nonce: 'plaintext-v1', type: 'text', metadata: '',
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(), editedAt: null,
});
const MESSAGES = [
    line('m-list', BEN, LIST, 30),
    line('m-ok', ME, 'Thanks Ben, I will do the first ten.', 25),
    line('m-three', BEN, 'Gloves\nSpades\nBarrow', 20),
    line('m-para', BEN, PARAGRAPH, 15),
    line('m-short', ME, 'See you Saturday.', 10),
];
const CONVERSATION = { id: GROUP, type: 'group_thread', name: 'Garden crew', participants: [ME, BEN], createdBy: ME, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method) {
    const u = new URL(url);
    if (method === 'GET' && u.pathname === `/api/messages/conversations/${ME}`) return json({ conversations: [CONVERSATION], totalUnread: 0 });
    if (method === 'GET' && u.pathname === `/api/groups/${GROUP}/chat`) return json({ conversation: CONVERSATION, messages: MESSAGES, canPost: true });
    if (method === 'GET' && u.pathname === `/api/groups/${GROUP}/members`) return json([]);
    if (method === 'GET' && u.pathname === '/api/community/members') return json([{ publicKey: BEN, callsign: 'Ben' }]);
    if (method === 'GET' && u.pathname === '/api/marketplace/transactions') return json([]);
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return json({ success: true });
    return null;
}

const failures = [];
const check = (ok, what) => {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
};

/** Runs in the page: the geometry of one message's words and its control. */
const READ = (needle) => {
    const row = Array.from(document.querySelectorAll('[id^="msg-"]')).find((r) => r.textContent.includes(needle));
    if (!row) return null;
    const words = row.querySelector('[data-testid="chat-text"]');
    const toggle = row.querySelector('[data-testid="chat-fold-toggle"]');
    const lh = words ? parseFloat(getComputedStyle(words.parentElement).lineHeight) : 0;
    const t = toggle ? toggle.getBoundingClientRect() : null;
    return {
        fold: words ? words.dataset.fold : null,
        hasWords: !!words,
        clientHeight: words ? words.clientHeight : 0,
        scrollHeight: words ? words.scrollHeight : 0,
        lineHeight: lh,
        text: words ? words.textContent : row.textContent,
        toggle: toggle ? { label: toggle.getAttribute('aria-label'), text: toggle.textContent, expanded: toggle.getAttribute('aria-expanded'), tag: toggle.tagName, w: Math.round(t.width), h: Math.round(t.height) } : null,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) {
        console.log(`\n${theme}`);
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
            // The app's own choice (lib/useTheme.ts): it is dark unless one is stored.
            try { localStorage.setItem('beanpool-theme-mode', t); } catch { /* private mode */ }
            document.addEventListener('DOMContentLoaded', () => {
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.classList.toggle('dark-theme', t === 'dark');
                document.documentElement.style.fontSize = `${scale * 100}%`;
            });
        }, [theme, FONT_SCALE]);
        await page.goto(`${base}/e2e/long-message-more-shots-harness.html`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-testid="chat-fold-toggle"]', { timeout: 20_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);

        // 1 + 2: the 40-line message is clamped to twelve lines, with a real, big-enough button under it.
        const folded = await page.evaluate(READ, 'Job 1 for');
        check(folded?.fold === 'folded', 'the 40-line message is folded');
        check(folded && Math.abs(folded.clientHeight - 12 * folded.lineHeight) <= 2, `it shows twelve lines (${folded?.clientHeight} px of a ${folded?.lineHeight} px line)`);
        check(folded && folded.scrollHeight > folded.clientHeight + 40, 'it has far more than it shows');
        check(folded?.text === LIST, 'the whole message is in the page, folded');
        check(folded?.toggle?.tag === 'BUTTON' && folded.toggle.label === 'Show the whole message' && folded.toggle.text === '…more' && folded.toggle.expanded === 'false', 'the control is a button, "…more", named "Show the whole message"');
        check(folded?.toggle && folded.toggle.w >= 44 && folded.toggle.h >= 44, `the control is ${folded?.toggle?.w}×${folded?.toggle?.h} px, at least 44×44`);

        // 3: a 3-line message and a short one: no control, no wrapper.
        for (const needle of ['Gloves', 'Thanks Ben', 'See you Saturday']) {
            const r = await page.evaluate(READ, needle);
            check(r && !r.hasWords && !r.toggle, `"${needle}…" has no wrapper and no control`);
        }

        await page.screenshot({ path: path.join(OUT_DIR, `long-message-more-web-320px-130pct-${theme}-folded.png`) });

        // 4: open in place, fold again.
        await page.evaluate(() => document.querySelector('[data-testid="chat-fold-toggle"]').click());
        await page.waitForTimeout(150);
        const open = await page.evaluate(READ, 'Job 1 for');
        check(open?.fold === 'open' && open.clientHeight >= open.scrollHeight - 1, 'tapping …more opens the whole message in place');
        check(open?.toggle?.label === 'Show less' && open.toggle.text === 'less' && open.toggle.expanded === 'true', 'the control now reads "less", named "Show less"');
        await page.evaluate(() => { document.querySelector('[data-testid="chat-text"]').scrollIntoView({ block: 'start' }); });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(OUT_DIR, `long-message-more-web-320px-130pct-${theme}-open.png`) });
        // The foot of the opened message, with "less" under it.
        await page.evaluate(() => { document.querySelector('[data-testid="chat-fold-toggle"]').scrollIntoView({ block: 'center' }); });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(OUT_DIR, `long-message-more-web-320px-130pct-${theme}-open-end.png`) });
        await page.evaluate(() => document.querySelector('[data-testid="chat-fold-toggle"]').click());
        await page.waitForTimeout(150);
        const again = await page.evaluate(READ, 'Job 1 for');
        check(again?.fold === 'folded', '"less" folds it again');

        // 5: a one-paragraph message folds by where its lines really break: not in a wide window, again in a narrow one.
        const narrow = await page.evaluate(READ, 'bring a spade');
        check(narrow?.fold === 'folded', 'the one-paragraph message folds at 320 px');
        await page.setViewportSize({ width: 1400, height: HEIGHT });
        await page.waitForTimeout(500);
        const wide = await page.evaluate(READ, 'bring a spade');
        check(wide && wide.fold === 'whole' && !wide.toggle, `…and is whole in a 1400 px window (${wide?.fold})`);
        await page.setViewportSize({ width: WIDTH, height: HEIGHT });
        await page.waitForTimeout(500);
        const back = await page.evaluate(READ, 'bring a spade');
        check(back?.fold === 'folded' && !!back.toggle, '…and folds again when the window is narrow again');

        // 6: nothing scrolls sideways.
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        check(!sideways, 'the page does not scroll sideways');
        check(pageErrors.length === 0, `no page errors ${pageErrors.length ? JSON.stringify(pageErrors) : ''}`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

if (blocked) console.log(`\n(${blocked} other /api or /ws requests aborted at the browser)`);
console.log(`photographs in ${OUT_DIR}`);
if (failures.length) {
    console.error(`\n✗ ${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('\n✓ a long message folds with …more on the web at 320 px with 1.3x text, light and dark');
