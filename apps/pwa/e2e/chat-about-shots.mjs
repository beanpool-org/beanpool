/**
 * "About this listing" in a chat (Message on a Need or an Offer), in a real Chromium layout: the real MessagesPage in App's own
 * layout (e2e/chat-about-harness.tsx), a real sealed DM thread whose lines carry a sealed listing reference, the node answered
 * by the page route below. At 320 × 568 with 1.3x text and at 1280 × 800, light and dark, it photographs the chip above the
 * composer and the cards in the bubbles (a listing that is up, in someone's bubble and in my own, and one that is gone), and
 * MEASURES what jsdom can't:
 *   1. the chip's words are 4.5:1 or better on what is really behind them, and its ✕ is 3:1 or better and a 44 px target;
 *   2. every card's words are 4.5:1 or better on what is really behind them (its own tint over the bubble over the page);
 *   3. a card that opens the listing is a 44 px target; no card runs outside its bubble, no bubble outside the window;
 *   4. nothing runs off sideways, with a title long enough to wrap in the chip and in a card;
 *   5. the card shows the listing as the node answered (its price in Beans), and a gone listing says so;
 *   6. the same thread without any listing (a thread from before) draws no chip and no card;
 *   7. the ✕ takes the chip away.
 * It prints a table (markdown) and exits non-zero on any failed check.
 *
 * Nothing here touches a BeanPool node: every /api request is answered here, and any other /api or /ws request is aborted.
 *
 *   node e2e/chat-about-shots.mjs [shots-dir]
 *
 * Run from apps/pwa: Tailwind reads its config from the working directory. Needs @beanpool/core built.
 */
/* global process, console, document, getComputedStyle, localStorage, URL, window */
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

// The listings the thread is about, as the node answers a lookup by id. 'post-gone' has no answer: gone, or hidden from this reader.
const LADDER = { id: 'post-ladder', type: 'need', title: 'An extension ladder, six metres, for the gutters on the back shed', credits: 4, priceType: 'hourly', status: 'active' };
const EGGS = { id: 'post-eggs', type: 'offer', title: 'Fresh eggs', credits: 6, priceType: 'fixed', status: 'active' };
const GONE = { id: 'post-gone', type: 'offer', title: 'Wheelbarrow, one wheel, a little rusty', credits: 2, priceType: 'fixed', status: 'active' };
const LISTINGS = [LADDER, EGGS];
// The chip waiting in the composer: a title long enough to fold at 320 px.
const CHIP_POST = { id: 'post-honey', type: 'offer', title: 'Honey from the hives behind the school, in jars you bring back', credits: 12, priceType: 'fixed', status: 'active' };

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;

// The thread, sealed by the app's own code, as the node would hand it back.
const { dmKeyContext, lockForDm } = await server.ssrLoadModule('/src/lib/dm-lock.ts');
const { toEd25519Pkcs8, aboutOfPost, metadataWithAbout, sealChatAbout } = await server.ssrLoadModule('@beanpool/core');
const person = (seed, publicKey) => ({ publicKey, privateKey: bytesToHex(toEd25519Pkcs8(seed)) });
const chat = { id: DM, type: 'dm', participants: [ME, BOB] };
const BOB_P = person(BOB_SEED, BOB);
const ME_P = person(ME_SEED, ME);

function thread(withListings) {
    const lines = [];
    const rows = [
        [BOB_P, 'Hi Alice, the gate is fixed.', 60, null],
        [BOB_P, 'Do you still need a hand with the gutters on Saturday morning?', 50, LADDER],
        [ME_P, 'Yes please. I have eggs ready for you too.', 40, EGGS],
        [BOB_P, 'Lovely. Is the wheelbarrow still going spare?', 30, GONE],
    ];
    for (const [from, words, minutes, post] of rows) {
        const id = `00000000-0000-4000-8000-0000000000${String(minutes)}`;
        const sealed = lockForDm(words, chat, from, { messageId: id, after: lines.at(-1)?.id ?? null });
        let metadata;   // the line's signature is in its own ciphertext (format 4)
        if (withListings && post) {
            metadata = metadataWithAbout(metadata, sealChatAbout(aboutOfPost(post), dmKeyContext(chat, from), { senderPubHex: from.publicKey, messageId: id }));
        }
        lines.push({
            id, conversationId: DM, authorPubkey: from.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata,
            type: 'text', timestamp: new Date(NOW - minutes * 60_000).toISOString(), editedAt: null,
        });
    }
    return lines;
}
const THREADS = { about: thread(true), plain: thread(false) };
const conversation = { id: DM, type: 'dm', name: null, participants: [ME, BOB], createdBy: ME, peerCallsign: 'Bob', unreadCount: 0, createdAt: ago(20) };

const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
function answer(url, method, lines) {
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/api/community/info') return json({ name: 'Test community', features: { beans: true } });
    if (method === 'GET' && u.pathname === `/api/messages/conversations/${ME}`) return json({ conversations: [conversation], totalUnread: 0 });
    if (method === 'GET' && u.pathname === `/api/messages/${DM}`) return json({ conversation, messages: lines });
    if (method === 'GET' && u.pathname === '/api/community/members') return json([{ publicKey: BOB, callsign: 'Bob', role: 'member' }]);
    if (method === 'GET' && u.pathname === '/api/marketplace/transactions') return json([]);
    if (method === 'GET' && u.pathname === '/api/marketplace/posts') return json(LISTINGS.filter((p) => p.id === u.searchParams.get('id')));
    if (method === 'POST' && u.pathname === '/api/messages/mark-read') return json({ success: true });
    return null;
}

/** Runs in the page: for each selector, every match's words' contrast against what is really behind them, and its box. */
const MEASURE = (selectors) => {
    const channels = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    // What is really behind an element: its own tint and every translucent ground above the first opaque one, laid over it.
    const behind = (el) => {
        const layers = [];
        let base = [255, 255, 255];
        for (let e = el; e; e = e.parentElement) {
            const c = channels(getComputedStyle(e).backgroundColor);
            if (c.length < 3) continue;
            const a = c.length > 3 ? c[3] : 1;
            if (a === 0) continue;
            if (a === 1) { base = c.slice(0, 3); break; }
            layers.push({ rgb: c.slice(0, 3), a });
        }
        return layers.reverse().reduce((under, { rgb, a }) => under.map((u, i) => rgb[i] * a + u * (1 - a)), base);
    };
    const lum = ([r, g, b]) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const out = {};
    for (const [key, selector] of Object.entries(selectors)) {
        out[key] = [...document.querySelectorAll(selector)].map((el) => {
            const box = el.getBoundingClientRect();
            const parent = el.parentElement.getBoundingClientRect();
            const ink = channels(getComputedStyle(el).color).slice(0, 3);
            return {
                contrast: Number(ratio(ink, behind(el)).toFixed(2)), w: Math.round(box.width), h: Math.round(box.height),
                left: Math.round(box.left), right: Math.round(box.right), parentLeft: Math.round(parent.left), parentRight: Math.round(parent.right),
                text: el.textContent.replace(/\s+/g, ' ').trim(),
            };
        });
    }
    out.sideways = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    out.width = document.documentElement.clientWidth;
    return out;
};
const SELECTORS = {
    chip: '[data-testid="chat-about-chip"]', drop: '[data-testid="chat-about-chip-drop"]',
    card: '[data-testid="chat-about-card"]', gone: '[data-testid="chat-about-gone"]',
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
let blocked = 0;
const failures = [];
const check = (ok, what) => { if (!ok) { failures.push(what); console.error(`  ✗ ${what}`); } };
const rows = [];

async function open(theme, vp, kind) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme });
    await context.route('**/*', (route) => {
        const req = route.request();
        const url = req.url();
        if (url.includes('/api/')) {
            const a = answer(url, req.method(), THREADS[kind]);
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
    await page.goto(`${base}/e2e/chat-about-harness.html`, { waitUntil: 'load' });
    await page.waitForSelector('textarea', { timeout: 30_000 });
    await page.waitForSelector('text=Do you still need a hand', { timeout: 30_000 });
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
            const name = `${vp.w} × ${vp.scale}, ${theme}`;

            // The thread as it was before this change: no listing on any line, no chip.
            const before = await open(theme, vp, 'plain');
            await before.page.waitForTimeout(500);
            const beforeM = await before.page.evaluate(MEASURE, SELECTORS);
            const beforeShot = await shot(before.page, vp, `chat-about-before-${tag}`);
            await before.context.close();

            // Message on a listing from a thread that already has lines in it: the chip waits in the composer, the cards are in the bubbles.
            const { context, page } = await open(theme, vp, 'about');
            await page.evaluate((post) => { window.__chatAboutDrafts.set(post.conversationId, window.__aboutOfPost(post.post)); }, { conversationId: DM, post: CHIP_POST });
            await page.waitForSelector('[data-testid="chat-about-chip"]', { timeout: 15_000 });
            await page.waitForSelector('[data-testid="chat-about-gone"]', { timeout: 15_000 });
            await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="chat-about-card"]')].every((c) => /Beans/.test(c.textContent ?? '')), null, { timeout: 15_000 });
            await page.waitForTimeout(500);
            const m = await page.evaluate(MEASURE, SELECTORS);
            await page.evaluate(() => { const t = document.querySelector('[data-testid="chat-thread"]'); if (t) t.scrollTop = t.scrollHeight; });
            await page.waitForTimeout(200);
            const chipShot = await shot(page, vp, `chat-about-chip-${tag}`);
            // The ✕ in a real browser: the chip goes, and the thread has its room back for the cards.
            await page.click('[data-testid="chat-about-chip-drop"]');
            await page.waitForSelector('[data-testid="chat-about-chip"]', { state: 'detached', timeout: 15_000 });
            const dropped = await page.locator('[data-testid="chat-about-chip"]').count();
            await page.locator('[data-testid="chat-about-card"]').first().scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            const cardShot = await shot(page, vp, `chat-about-cards-${tag}`);
            await page.locator('[data-testid="chat-about-gone"]').scrollIntoViewIfNeeded();
            await page.waitForTimeout(200);
            const goneShot = await shot(page, vp, `chat-about-gone-${tag}`);
            await context.close();

            check(beforeM.chip.length === 0 && beforeM.card.length === 0 && beforeM.gone.length === 0, `${name}: a thread from before draws a chip or a card`);
            check(m.chip.length === 1 && m.drop.length === 1, `${name}: the chip or its ✕ is missing`);
            check(m.card.length === 2 && m.gone.length === 1, `${name}: expected 2 cards and 1 gone card, got ${m.card.length} and ${m.gone.length}`);
            const [chip, drop] = [m.chip[0], m.drop[0]];
            check(chip.contrast >= 4.5, `${name}: the chip's words ${chip.contrast}:1`);
            check(drop.contrast >= 3, `${name}: the chip's ✕ ${drop.contrast}:1`);
            check(drop.h >= 44 && drop.w >= 44, `${name}: the ✕ is ${drop.w} × ${drop.h}`);
            check(chip.right <= m.width && drop.right <= m.width, `${name}: the chip runs off the window (${Math.max(chip.right, drop.right)} past ${m.width})`);
            check(/About: Honey.* · 12 Beans/.test(chip.text), `${name}: the chip says "${chip.text}"`);
            for (const c of [...m.card, ...m.gone]) {
                check(c.contrast >= 4.5, `${name}: a card's words ${c.contrast}:1 ("${c.text.slice(0, 30)}")`);
                check(c.left >= c.parentLeft && c.right <= c.parentRight, `${name}: a card runs outside its bubble (${c.left}–${c.right} in ${c.parentLeft}–${c.parentRight})`);
                check(c.parentRight <= m.width && c.parentLeft >= 0, `${name}: a bubble runs outside the window`);
            }
            for (const c of m.card) {
                check(c.h >= 44, `${name}: a card is ${c.h} px tall`);
                check(/Beans/.test(c.text), `${name}: a card does not show the listing's price: "${c.text}"`);
            }
            check(/no longer up/.test(m.gone[0]?.text ?? ''), `${name}: the gone card says "${m.gone[0]?.text}"`);
            check(dropped === 0, `${name}: the ✕ did not drop the chip`);
            check(!m.sideways && !beforeM.sideways, `${name}: runs off sideways`);
            rows.push({ name, chip, drop, cards: m.card, gone: m.gone[0], shots: [beforeShot, chipShot, cardShot, goneShot] });
        }
    }
} finally {
    await browser.close();
    await server.close();
}

console.log('\n| Case | Chip words | ✕ | ✕ box | Cards (words) | Card heights | Gone card |');
console.log('|---|---|---|---|---|---|---|');
for (const x of rows) {
    console.log(`| ${x.name} | ${x.chip.contrast}:1 | ${x.drop.contrast}:1 | ${x.drop.w} × ${x.drop.h} | ${x.cards.map((c) => `${c.contrast}:1`).join(', ')} | ${x.cards.map((c) => c.h).join(', ')} | ${x.gone.contrast}:1 |`);
}
console.log(`\nRequests aborted (not this harness's to answer): ${blocked}`);
for (const x of rows) console.log(x.shots.join('  '));
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
