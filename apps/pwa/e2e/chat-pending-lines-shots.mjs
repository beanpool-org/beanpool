/**
 * A chat line on its way, in a real Chromium layout: the real MessagesPage in App's own layout, a real sealed DM, the node
 * answered by the page route below. At 320 × 568 with 1.3x text and at 1280 × 800, light and dark, it takes a line sending
 * (the send held) and a line that failed (the send cut off), photographs each, and MEASURES what jsdom can't:
 *   1. "! not delivered", Retry, Discard and "Sending…" are 4.5:1 or better on what is really behind them;
 *   2. Retry and Discard are 44 px targets;
 *   3. nothing runs off sideways and the failed line's buttons are in view;
 *   4. the chat list's "! not delivered" is 4.5:1 or better;
 *   5. a failed line long enough to fold: its "…more" is 4.5:1 or better on the failed bubble, and a 44 px target.
 * It prints a table (markdown) and exits non-zero on any failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered here, and any other /api or /ws request is aborted.
 *
 *   node e2e/chat-pending-lines-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, getComputedStyle, localStorage, URL */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PWA_DIR, 'e2e', 'shots');

const DM = 'c0ffee00-0000-4000-8000-0000000000d1';
const ME_SEED = new Uint8Array(32).fill(7);
const BOB_SEED = new Uint8Array(32).fill(9);
const ME = bytesToHex(ed25519.getPublicKey(ME_SEED));
const BOB = bytesToHex(ed25519.getPublicKey(BOB_SEED));
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const VIEWPORTS = [{ w: 320, h: 568, scale: 1.3 }, { w: 1280, h: 800, scale: 1 }];
const TYPED = 'Can you bring the long ladder on Saturday morning?';
const TYPED_LONG = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long note`).join('\n');

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

// The thread, sealed by the app's own code, as the node would hand it back.
const { lockForDm } = await server.ssrLoadModule('/src/lib/dm-lock.ts');
const { toEd25519Pkcs8 } = await server.ssrLoadModule('@beanpool/core');
const person = (seed, publicKey) => ({ publicKey, privateKey: bytesToHex(toEd25519Pkcs8(seed)) });
const chat = { id: DM, type: 'dm', participants: [ME, BOB] };
const LINES = [];
for (const [from, words, minutes] of [[person(BOB_SEED, BOB), 'Hi Alice, the gate is fixed.', 50], [person(ME_SEED, ME), 'That is great news, thank you.', 40], [person(BOB_SEED, BOB), 'Happy to help. Anything else this week?', 30]]) {
    const id = `00000000-0000-4000-8000-0000000000${String(minutes)}`;
    LINES.push({
        id, conversationId: DM, authorPubkey: from.publicKey, ...lockForDm(words, chat, from, { messageId: id, after: LINES.at(-1)?.id ?? null }),
        type: 'text', timestamp: new Date(NOW - minutes * 60_000).toISOString(), editedAt: null,
    });
}
const conversation = { id: DM, type: 'dm', name: null, participants: [ME, BOB], createdBy: ME, peerCallsign: 'Bob', unreadCount: 0, createdAt: ago(20) };

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method) {
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/api/community/info') return json({ name: 'Test community', features: { beans: true } });
    if (method === 'GET' && u.pathname === `/api/messages/conversations/${ME}`) return json({ conversations: [conversation], totalUnread: 0 });
    if (method === 'GET' && u.pathname === `/api/messages/${DM}`) return json({ conversation, messages: LINES });
    if (method === 'GET' && u.pathname === '/api/community/members') return json([{ publicKey: BOB, callsign: 'Bob', role: 'member' }]);
    if (method === 'GET' && u.pathname === '/api/marketplace/transactions') return json([]);
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return json({ success: true });
    return null;
}

/** Runs in the page: contrast of an element's words against what is really behind them, and its box. */
const MEASURE = (ids) => {
    const channels = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const opaque = (el) => {
        for (let e = el; e; e = e.parentElement) {
            const c = channels(getComputedStyle(e).backgroundColor);
            if (c.length && (c.length < 4 || c[3] === 1)) return c.slice(0, 3);
        }
        return [255, 255, 255];
    };
    const lum = ([r, g, b]) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const out = {};
    for (const id of ids) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) { out[id] = null; continue; }
        const box = el.getBoundingClientRect();
        const ink = channels(getComputedStyle(el).color).slice(0, 3);
        out[id] = { contrast: Number(ratio(ink, opaque(el)).toFixed(2)), w: Math.round(box.width), h: Math.round(box.height), bottom: Math.round(box.bottom), right: Math.round(box.right) };
    }
    out.sideways = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    out.width = document.documentElement.clientWidth;
    return out;
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } };
const rows = [];

async function open(theme, vp, onSend, words = TYPED) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme });
    await context.route('**/*', (route) => {
        const req = route.request();
        const url = req.url();
        if (url.includes('/api/messages/send')) return onSend(route);
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
    page.on('dialog', (d) => d.dismiss());
    await page.addInitScript(([th, scale]) => {
        try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ }
        document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.classList.toggle('dark', th === 'dark');
            document.documentElement.classList.toggle('dark-theme', th === 'dark');
            document.documentElement.style.fontSize = `${scale * 100}%`;
        });
    }, [theme, vp.scale]);
    await page.goto(`${base}/e2e/chat-pending-lines-harness.html`, { waitUntil: 'load' });
    await page.waitForSelector('textarea', { timeout: 30_000 });
    await page.waitForSelector('text=Happy to help', { timeout: 30_000 });
    await page.fill('textarea', words);
    await page.press('textarea', 'Enter');
    return { context, page };
}
/** At most 900 px wide, the right-hand side of a wide window: the member's own lines sit there. */
const shot = async (page, vp, name) => {
    const file = path.join(OUT_DIR, `${name}.png`);
    const width = Math.min(vp.w, 900);
    await page.screenshot({ path: file, clip: { x: vp.w - width, y: 0, width, height: vp.h } });
    return path.basename(file);
};

try {
    for (const theme of ['light', 'dark']) {
        for (const vp of VIEWPORTS) {
            const tag = `${vp.w}x${vp.h}-${Math.round(vp.scale * 100)}pct-${theme}`;

            const held = await open(theme, vp, () => { /* the send is never answered */ });
            await held.page.waitForSelector('[data-testid="chat-line-sending"]', { timeout: 15_000 });
            await held.page.waitForTimeout(500);
            const sending = await held.page.evaluate(MEASURE, ['chat-line-sending']);
            const sendingShot = await shot(held.page, vp, `chat-line-sending-${tag}`);
            await held.context.close();

            const cut = await open(theme, vp, (route) => route.abort());
            await cut.page.waitForSelector('[data-testid="chat-line-failed"]', { timeout: 15_000 });
            await cut.page.waitForTimeout(500);
            const failed = await cut.page.evaluate(MEASURE, ['chat-line-failed', 'chat-line-retry', 'chat-line-discard', 'chat-thread']);
            const failedShot = await shot(cut.page, vp, `chat-line-failed-${tag}`);
            await cut.page.click('button[aria-label="Back to messages"]');
            await cut.page.waitForSelector('[data-testid="chat-row-not-delivered"]', { timeout: 15_000 });
            const list = await cut.page.evaluate(MEASURE, ['chat-row-not-delivered']);
            await cut.context.close();

            const long = await open(theme, vp, (route) => route.abort(), TYPED_LONG);
            await long.page.waitForSelector('[data-testid="chat-line-failed"]', { timeout: 15_000 });
            await long.page.waitForSelector('[data-testid="chat-fold-toggle"]', { timeout: 15_000 });
            await long.page.waitForTimeout(500);
            const folded = await long.page.evaluate(MEASURE, ['chat-fold-toggle']);
            const foldedShot = await shot(long.page, vp, `chat-line-failed-long-${tag}`);
            await long.context.close();

            const name = `${vp.w} × ${vp.scale}, ${theme}`;
            const [s, f, r, d, l, m] = [sending['chat-line-sending'], failed['chat-line-failed'], failed['chat-line-retry'], failed['chat-line-discard'], list['chat-row-not-delivered'], folded['chat-fold-toggle']];
            check(s.contrast >= 4.5, `${name}: Sending… ${s.contrast}:1`);
            check(f.contrast >= 4.5, `${name}: ! not delivered ${f.contrast}:1`);
            check(r.contrast >= 4.5, `${name}: Retry ${r.contrast}:1`);
            check(d.contrast >= 4.5, `${name}: Discard ${d.contrast}:1`);
            check(l.contrast >= 4.5, `${name}: the list's ! not delivered ${l.contrast}:1`);
            check(m.contrast >= 4.5, `${name}: …more on a failed line ${m.contrast}:1`);
            check(m.h >= 44 && m.w >= 44, `${name}: …more ${m.w} × ${m.h}`);
            check(r.h >= 44 && r.w >= 44, `${name}: Retry ${r.w} × ${r.h}`);
            check(d.h >= 44 && d.w >= 44, `${name}: Discard ${d.w} × ${d.h}`);
            check(!sending.sideways && !failed.sideways, `${name}: runs off sideways`);
            check(r.bottom <= failed['chat-thread'].bottom && r.right <= failed.width, `${name}: Retry out of view (${r.bottom} past ${failed['chat-thread'].bottom})`);
            rows.push({ name, s, f, r, d, l, m, shots: [sendingShot, failedShot, foldedShot] });
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('\n| Case | Sending… | ! not delivered | Retry | Discard | List mark | …more | Retry box | Discard box | …more box |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const x of rows) console.log(`| ${x.name} | ${x.s.contrast}:1 | ${x.f.contrast}:1 | ${x.r.contrast}:1 | ${x.d.contrast}:1 | ${x.l.contrast}:1 | ${x.m.contrast}:1 | ${x.r.w} × ${x.r.h} | ${x.d.w} × ${x.d.h} | ${x.m.w} × ${x.m.h} |`);
console.log(`\nRequests aborted (not this harness's to answer): ${blocked}`);
for (const x of rows) console.log(x.shots.join('  '));
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
