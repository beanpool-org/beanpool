/**
 * A chat line's actions on the web stay inside the line and the window (emulator walk 147, 20 Nov 2026: on the phone, Reply,
 * React, Edit and Delete beside a wide line of mine pushed it past the screen's right edge at 320 dp with 1.3x text; #3307
 * fixed the phone's row). The web draws a line's actions in the line itself, after its time, in a span that wraps
 * (pages/MessagesPage.tsx), so the same overflow should not happen here: this MEASURES it in a real Chromium layout, light
 * and dark, at the documented floor (320 px with 1.3x text), at 320 px with 1x and in a wide window. The real MessagesPage draws
 * a group chat's lines (e2e/long-message-more-shots-harness.tsx, the same page at the same chat); a one-to-one chat draws its
 * bubbles by the same code. For each it checks that:
 *   1. my wide line, my four-line line and someone else's offer Reply and React, and mine Delete and Edit;
 *   2. every line's bubble lies inside the window, and every one of its buttons inside its bubble;
 *   3. nothing scrolls sideways.
 * It photographs the chat at 320 px with 1.3x text to e2e/shots/ or the folder given.
 *
 * Nothing here touches a BeanPool node: every /api request is answered by the page route below, and any other /api or /ws
 * request is aborted and counted.
 *
 *   node e2e/chat-line-actions-320.mjs [shots-dir]    # exits non-zero on any failed check
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global process, console, document, localStorage, URL, Buffer */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');
const HEIGHT = 860;
const SIZES = [
    { width: 320, scale: 1.3, shot: true },
    { width: 320, scale: 1, shot: false },
    { width: 1280, scale: 1.3, shot: false },
];

const GROUP = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3e';
const ME = 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678';
const BEN = 'b'.repeat(64);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const TWO = 'Yes, the trays are ready. Come by after four and bring the twine.';
const FOUR = 'The trays are ready on the back step. Come by after four, bring the twine if you have it, and the pots too; I will leave the gate open for you.';
const NOW = Date.now();
const line = (id, author, text, minutesAgo) => ({
    id, conversationId: GROUP, authorPubkey: author, ciphertext: b64(text), nonce: 'plaintext-v1', type: 'text', metadata: '',
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(), editedAt: null,
});
// Mine within the 15-minute edit window, so they offer Edit as well as Delete.
const MESSAGES = [
    line('m-ben-four', BEN, FOUR, 9),
    line('m-mine-two', ME, TWO, 6),
    line('m-mine-four', ME, FOUR, 5),
    line('m-ben-short', BEN, 'Yes.', 3),
    line('m-mine-short', ME, 'k', 2),
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

/** Runs in the page: each line's bubble and its buttons, across the window. */
const MEASURE = () => {
    const width = document.documentElement.clientWidth;
    return {
        width,
        sideways: document.documentElement.scrollWidth > width,
        lines: Array.from(document.querySelectorAll('[id^="msg-"]')).map((row) => {
            const bubble = row.querySelector('[data-testid="chat-bubble"]');
            const b = bubble ? bubble.getBoundingClientRect() : null;
            return {
                id: row.id.slice(4),
                bubble: b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null,
                buttons: Array.from(row.querySelectorAll('button')).map((el) => {
                    const r = el.getBoundingClientRect();
                    return { name: el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
                }),
            };
        }),
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;

try {
    for (const theme of ['light', 'dark']) for (const size of SIZES) {
        console.log(`\n${theme}, ${size.width} px, ${size.scale}x text`);
        const context = await browser.newContext({ viewport: { width: size.width, height: HEIGHT }, colorScheme: theme });
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
        }, [theme, size.scale]);
        await page.goto(`${base}/e2e/long-message-more-shots-harness.html`, { waitUntil: 'networkidle' });
        await page.waitForSelector('#msg-m-mine-short', { timeout: 20_000 });
        // The app gives the page the window's height (App.tsx: h-screen); the harness's wrapper only a minimum, which leaves the
        // thread no room to show its lines. Its widths are the same either way.
        await page.addStyleTag({ content: '#root > div { height: 100vh; display: flex; flex-direction: column; }' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);

        const m = await page.evaluate(MEASURE);
        check(m.lines.length === MESSAGES.length, `${m.lines.length} of ${MESSAGES.length} lines drawn`);
        const names = (id) => (m.lines.find((l) => l.id === id)?.buttons ?? []).map((b) => b.name);
        // 1: the actions each line offers, drawn.
        for (const id of ['m-mine-two', 'm-mine-four']) {
            const n = names(id);
            check(['Reply to message', 'React to message', 'Delete message', 'Edit message'].every((w) => n.includes(w)), `${id}: Reply, React, Delete and Edit (${n.join(', ')})`);
        }
        const ben = names('m-ben-four');
        check(['Reply to message', 'React to message'].every((w) => ben.includes(w)), `m-ben-four: Reply and React (${ben.join(', ')})`);
        // 2: every bubble inside the window, every button inside its bubble.
        for (const l of m.lines) {
            const b = l.bubble;
            check(!!b && b.left >= -0.5 && b.right <= m.width + 0.5, `${l.id}: its bubble inside the window (${b ? `${b.left.toFixed(1)} to ${b.right.toFixed(1)} of ${m.width}` : 'none'})`);
            const out = l.buttons.filter((x) => !b || x.left < b.left - 0.5 || x.right > b.right + 0.5 || x.top < b.top - 0.5 || x.bottom > b.bottom + 0.5);
            check(out.length === 0, `${l.id}: its ${l.buttons.length} buttons inside its bubble${out.length ? ` (out: ${out.map((x) => `${x.name} ${x.left.toFixed(1)}-${x.right.toFixed(1)}`).join(', ')})` : ''}`);
        }
        // 3: nothing scrolls sideways.
        check(!m.sideways, 'the page does not scroll sideways');
        check(pageErrors.length === 0, `no page errors ${pageErrors.length ? JSON.stringify(pageErrors) : ''}`);
        if (size.shot) await page.screenshot({ path: path.join(OUT_DIR, `chat-line-actions-web-320px-130pct-${theme}.png`) });
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
console.log('\n✓ a chat line\'s actions stay inside the line and the window on the web, light and dark, 320 px at 1.3x and 1x, and wide');
