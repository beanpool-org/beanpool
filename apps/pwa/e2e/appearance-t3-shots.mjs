/**
 * The look on the web, as a member picks it (colour themes T3): the real MessagesPage, drawn by its own harness
 * (e2e/appearance-t3-harness.tsx, which calls the real useTheme()), in each of Classic, Light and Dark at the
 * documented floor, 320 px with 1.3x text. The look is set the way a member's choice is kept: the stored value
 * (`beanpool-theme-mode`: dark = Classic, light, night = Dark), read by useTheme. For each look it checks that
 *   1. <html> carries what the look needs: the scheme classes, and data-bp-theme="night" for Dark and nowhere else;
 *   2. the own bubble's words read on its fill at 4.5:1 or more (Classic's was 3.28:1 before slice T1);
 *   3. the other person's bubble and the page behind the thread are not the own bubble's colour (the thread has two voices);
 *   4. nothing scrolls sideways.
 * It photographs the thread (both bubbles) to the folder given. Nothing here touches a BeanPool node: every /api request is
 * answered by the page route below, and any other /api or /ws request is aborted.
 *
 *   node e2e/appearance-t3-shots.mjs [shots-dir]    # exits non-zero on any failed check
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, window, getComputedStyle, localStorage, URL, Buffer */
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
const NOW = Date.now();
const line = (id, author, text, minutesAgo) => ({
    id, conversationId: GROUP, authorPubkey: author, ciphertext: b64(text), nonce: 'plaintext-v1', type: 'text', metadata: '',
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(), editedAt: null,
});
const MESSAGES = [
    line('m1', BEN, 'Are you coming to the working bee on Saturday?', 40),
    line('m2', ME, 'Yes, I will bring a spade and some gloves.', 36),
    line('m3', BEN, 'Lovely. We start at nine by the creek gate, and there is tea after.', 30),
    line('m4', ME, 'Thanks Ben, see you there.', 24),
    line('m5', BEN, 'Bring your own mug if you can.', 10),
    line('m6', ME, 'Will do.', 6),
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

/** Runs in the page: the own bubble and another's, as drawn. */
const READ = () => {
    const rgb = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const bubbleOf = (needle) => {
        const row = Array.from(document.querySelectorAll('[id^="msg-"]')).find((r) => r.textContent.includes(needle));
        return row?.querySelector('.bp-bubble-mine') ?? null;
    };
    const mine = bubbleOf('Thanks Ben');
    const row = Array.from(document.querySelectorAll('[id^="msg-"]')).find((r) => r.textContent.includes('Lovely.'));
    const words = mine ? Array.from(mine.querySelectorAll('*')).find((e) => e.childNodes.length && Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.includes('Thanks Ben'))) : null;
    const mineFill = mine ? rgb(getComputedStyle(mine).backgroundColor) : null;
    const mineInk = words ? rgb(getComputedStyle(words).color) : null;
    // The other person's bubble: the first element in their row with an opaque fill.
    let otherFill = null;
    if (row) for (const e of row.querySelectorAll('*')) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0.99) { otherFill = c; break; } }
    const root = document.documentElement;
    return {
        classes: [...root.classList].sort().join(' '),
        look: root.getAttribute('data-bp-theme'),
        scheme: root.style.colorScheme,
        mineFill, mineInk, otherFill,
        mineRatio: mineFill && mineInk ? ratio(mineFill, mineInk) : null,
        apart: mineFill && otherFill ? ratio(mineFill, otherFill) : null,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
};

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;

// Stored value, what members call it, the scheme the device is set to while it is drawn.
const LOOKS = [['light', 'Light', 'light'], ['dark', 'Classic', 'dark'], ['night', 'Dark', 'dark']];

try {
    for (const [stored, name, deviceScheme] of LOOKS) {
        console.log(`\n${name} (stored ${stored})`);
        const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: deviceScheme });
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
        await page.addInitScript(([value, scale]) => {
            try { localStorage.setItem('beanpool-theme-mode', value); } catch { /* private mode */ }
            document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${scale * 100}%`; });
        }, [stored, FONT_SCALE]);
        await page.goto(`${base}/e2e/appearance-t3-harness.html`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[id^="msg-"]', { timeout: 20_000 });
        await page.evaluate(() => document.fonts.ready);
        // Six short lines fit one screen: the picture is the top of the page, not a scrolled one.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);

        const r = await page.evaluate(READ);
        const dark = deviceScheme === 'dark';
        check(r.classes.includes('dark-theme') === dark && r.scheme === (dark ? 'dark' : 'light'), `<html> carries the ${dark ? 'dark' : 'light'} scheme (${r.classes})`);
        check(r.look === (stored === 'night' ? 'night' : null), `data-bp-theme is ${stored === 'night' ? '"night"' : 'not set'} (${r.look})`);
        check(r.mineRatio !== null && r.mineRatio >= 4.5, `the own bubble's words read on its fill: ${r.mineRatio?.toFixed(2)}:1 (fill ${JSON.stringify(r.mineFill)})`);
        check(r.apart !== null && r.apart > 1.2, `the two bubbles are apart: ${r.apart?.toFixed(2)}:1`);
        check(!r.sideways, 'nothing scrolls sideways');
        check(pageErrors.length === 0, `no page error${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
        await page.screenshot({ path: path.join(OUT_DIR, `chat-${name.toLowerCase()}.png`) });
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}

console.log(`\n${blocked} request(s) to a node or socket were aborted; none left this machine.`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nEvery look reads at AA in the thread at 320 px with 1.3x text.');
