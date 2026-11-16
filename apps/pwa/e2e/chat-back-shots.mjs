/**
 * The chat header's back arrow in a real Chromium layout (Marty, 16 Nov, in an event chat: "clicking on chat in menu should
 * take you back to the main chat menu - not just need the tiny back arrow"): the real MessagesPage in App's own layout, a DM
 * and an event chat, at 320 × 568 with 1.3x text, light and dark. It photographs the header with the arrow and MEASURES:
 *   1. the arrow is its own target of at least 44 × 44 px, named "Back to chats";
 *   2. its ink is 3:1 or better on what is really behind it (a graphic's floor; the arrow carries no words);
 *   3. the bottom bar's Chat (as App's, with Chat showing) closes the chat to the list, and the words typed are back in the
 *      box when the chat opens again.
 * It prints a table (markdown) and exits non-zero on any failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered here, and any other /api or /ws request is aborted.
 *
 *   node e2e/chat-back-shots.mjs [shots-dir]
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
const EVENT = 'c0ffee00-0000-4000-8000-0000000000e1';
const ME = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const BOB = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const AGO = new Date(Date.now() - 86_400_000).toISOString();
const VP = { w: 320, h: 568, scale: 1.3 };
const TYPED = 'Can you bring the long ladder?';

const dm = { id: DM, type: 'dm', name: null, participants: [ME, BOB], createdBy: ME, peerCallsign: 'Bob', unreadCount: 0, createdAt: AGO };
const event = { id: EVENT, type: 'event_thread', name: 'Working bee at the hall', participants: [ME], createdBy: BOB, unreadCount: 0, createdAt: AGO };
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method) {
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/api/community/info') return json({ name: 'Test community', features: { beans: true } });
    if (method === 'GET' && u.pathname === `/api/messages/conversations/${ME}`) return json({ conversations: [dm, event], totalUnread: 0 });
    if (method === 'GET' && u.pathname === `/api/messages/${DM}`) return json({ conversation: dm, messages: [] });
    if (method === 'GET' && u.pathname === `/api/marketplace/posts/${EVENT}/chat`) {
        return json({
            conversation: event, messages: [], readOnly: false, readOnlyReason: null, canPost: true, isHost: false, title: event.name,
            eventEndAt: new Date(Date.now() + 86_400_000).toISOString(), eventState: 'scheduled', privateNote: null,
            notice: "Visible to the host, everyone going, and this node's operator.",
        });
    }
    if (method === 'GET' && u.pathname === '/api/community/members') return json([{ publicKey: BOB, callsign: 'Bob', role: 'member' }]);
    if (method === 'GET' && u.pathname === '/api/marketplace/transactions') return json([]);
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return json({ success: true });
    return null;
}

/** Runs in the page: the back arrow's box, its ink against what is really behind it, and its spoken name. */
const MEASURE = () => {
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
    const el = document.querySelector('[data-testid="chat-back"]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const ink = channels(getComputedStyle(el).color).slice(0, 3);
    return {
        name: el.getAttribute('aria-label'), w: Math.round(box.width), h: Math.round(box.height), top: Math.round(box.top), left: Math.round(box.left),
        contrast: Number(ratio(ink, opaque(el)).toFixed(2)), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();
let blocked = 0;
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } };
const rows = [];

async function open(theme, chat) {
    const context = await browser.newContext({ viewport: { width: VP.w, height: VP.h }, colorScheme: theme });
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
    page.on('dialog', (d) => d.dismiss());
    await page.addInitScript(([th, scale]) => {
        try { localStorage.setItem('beanpool-theme-mode', th); } catch { /* private mode */ }
        document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.classList.toggle('dark', th === 'dark');
            document.documentElement.classList.toggle('dark-theme', th === 'dark');
            document.documentElement.style.fontSize = `${scale * 100}%`;
        });
    }, [theme, VP.scale]);
    await page.goto(`${base}/e2e/chat-back-harness.html?open=${chat}`, { waitUntil: 'load' });
    await page.waitForSelector('[data-testid="chat-back"]', { timeout: 30_000 });
    await page.waitForTimeout(500);
    return { context, page };
}
/** The header with the arrow in it: 320 px wide, from just above the arrow to just below it. */
const shot = async (page, m, name) => {
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: Math.max(0, m.top - 24), width: VP.w, height: m.h + 48 } });
    return path.basename(file);
};

try {
    for (const theme of ['light', 'dark']) {
        for (const [kind, id] of [['DM', DM], ['event chat', EVENT]]) {
            const name = `${kind}, ${VP.w} × ${VP.scale}, ${theme}`;
            const { context, page } = await open(theme, id);
            const m = await page.evaluate(MEASURE);
            const file = await shot(page, m, `chat-back-${kind === 'DM' ? 'dm' : 'event'}-${VP.w}-${Math.round(VP.scale * 100)}pct-${theme}`);
            check(m.name === 'Back to chats', `${name}: named "${m.name}"`);
            check(m.w >= 44 && m.h >= 44, `${name}: ${m.w} × ${m.h}`);
            check(m.contrast >= 3, `${name}: arrow ${m.contrast}:1`);
            check(!m.sideways, `${name}: runs off sideways`);
            // The bottom bar's Chat with the chat open: the list, then the chat again with its words in the box.
            const box = kind === 'DM' ? 'textarea' : '[data-testid="event-chat"] textarea';
            await page.fill(box, TYPED);
            await page.click('[data-testid="harness-tab-Chat"]');
            const listed = await page.waitForSelector('[data-testid="conversation-filter-chips"]', { timeout: 10_000 }).then(() => true, () => false);
            check(listed, `${name}: Chat in the bottom bar shows the chat list`);
            await page.click(`text=${kind === 'DM' ? 'Bob' : 'Working bee at the hall'}`);
            await page.waitForSelector(box, { timeout: 10_000 });
            const kept = await page.inputValue(box);
            check(kept === TYPED, `${name}: the draft came back as "${kept}"`);
            rows.push({ name, m, listed, kept: kept === TYPED, file });
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('\n| Case | Named | Box | Arrow contrast | Chat → list | Draft kept | Shot |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.m.name} | ${r.m.w} × ${r.m.h} | ${r.m.contrast}:1 | ${r.listed ? 'yes' : 'NO'} | ${r.kept ? 'yes' : 'NO'} | ${r.file} |`);
console.log(`\n${blocked} other requests blocked; shots in ${OUT_DIR}`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
