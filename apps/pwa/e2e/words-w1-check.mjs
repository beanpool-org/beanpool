/**
 * Words sweep W1 at 320 px with 1.3× text (translation slice S3; director amendment 1 item 7): the Market, its cards,
 * My Deals, the pricing guide, the report card, the photo viewer, the activity feed, events and their chat, the Pulse
 * and its cards, Messages and Channels, each opened on its own (e2e/words-w1-harness.tsx) in English and in the
 * pseudo-locale `xx`, where every sentence that came through t() is ~35 % longer, as the longer languages are.
 *
 * For each screen it lists, in each language:
 *   - the page scrolling sideways;
 *   - any element with words in it reaching past either edge of the screen (outside a box that scrolls sideways);
 *   - words clipped by their own box (overflow hidden or clip, and more text than fits; an ellipsis counts).
 * It FAILS on what xx shows and English does not: words a longer language pushes off the screen or cuts. What English
 * shows too (a member's long title cut with an ellipsis, by design) is listed, not failed.
 *
 * Builds the harness with Vite into a temp folder; every /api request is answered here, every other host refused.
 * Nothing here talks to a node.
 *
 * Run: node e2e/words-w1-check.mjs [shots-dir]
 *   WORDS_W1_ONLY=market,pulse     only these screens
 *   WORDS_W1_LANGS=en,xx,de        these languages (default en,xx)
 *   DEBUG_W1=1                     when a page scrolls sideways, print every element past the edge and what clips it
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, localStorage, getComputedStyle, Node, NodeFilter -- Node, and the page's side of evaluate() */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w1');
const only = (env) => (process.env[env] ? process.env[env].split(',').map((x) => x.trim()) : null);
const LANGS = only('WORDS_W1_LANGS') ?? ['en', 'xx'];
const SCREENS = [
    'market', 'cards-grid', 'cards-list', 'cards-compact', 'my-deals-pending', 'my-deals-active', 'my-deals-history', 'pricing',
    'report', 'lightbox', 'activity-full', 'activity-strip', 'events-grid', 'events-list', 'event-detail', 'event-chat',
    'pulse-cards', 'pulse', 'pulse-intake', 'channels', 'messages', 'messages-dm',
].filter((s) => !only('WORDS_W1_ONLY') || only('WORDS_W1_ONLY').includes(s));

/** Android's font size scales text, not layout: the root to 130 %, and the cards' pixel sizes with it (harness.mjs). */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map((px) => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

// ── What the node answers ───────────────────────────────────────────────────────────────────────────────────────
const ME = 'harness-me-pubkey';
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const MEMBERS = [
    { publicKey: 'member-bob', callsign: 'Bob', avatarUrl: 'bundled://leaf', role: 'member' },
    { publicKey: 'member-charlie', callsign: 'Charlie', avatarUrl: 'bundled://leaf', role: 'member' },
];
const CONVERSATIONS = [
    { id: 'conv-trade', type: 'dm', name: null, participants: [ME, 'member-charlie'], createdBy: ME, peerCallsign: 'Charlie', peerAvatar: 'bundled://leaf',
        unreadCount: 2, createdAt: iso(-26 * HOUR), postId: 'post-2', postTitle: 'Sourdough loaf, still warm from the oven', postStatus: 'pending' },
    { id: 'conv-bob', type: 'dm', name: null, participants: [ME, 'member-bob'], createdBy: ME, peerCallsign: 'Bob', peerAvatar: 'bundled://leaf',
        unreadCount: 0, createdAt: iso(-50 * HOUR), postId: 'post-3', postTitle: 'Ladder', postStatus: 'completed' },
    { id: 'group-1', type: 'group_thread', name: 'Garden crew', participants: [ME, 'member-bob', 'member-charlie'], createdBy: ME, unreadCount: 0, createdAt: iso(-72 * HOUR) },
];
const line = (id, author, text, over = {}) => ({ id, conversationId: 'conv-trade', authorPubkey: author, ciphertext: text, nonce: '00000', type: 'text', timestamp: iso(-HOUR), metadata: null, ...over });
const MESSAGES = {
    'conv-trade': [
        line('m1', 'member-charlie', 'Is the loaf still free?'),
        line('m2', ME, 'Yes, come by Saturday', { metadata: JSON.stringify({ replyToId: 'm1' }) }),
        line('m3', 'SYSTEM', '', { type: 'system', systemType: 'ESCROW_FUNDED', metadata: JSON.stringify({ amount: 3, postId: 'post-2' }) }),
    ],
};
const TXS = [
    { id: 'tx-held', postId: 'post-2', postTitle: 'Sourdough loaf', buyerPublicKey: ME, buyerCallsign: 'You', sellerPublicKey: 'member-charlie', sellerCallsign: 'Charlie', credits: 3, status: 'pending', createdAt: iso(-26 * HOUR) },
    { id: 'tx-done', postId: 'post-3', postTitle: 'Ladder', buyerPublicKey: ME, buyerCallsign: 'You', sellerPublicKey: 'member-bob', sellerCallsign: 'Bob', credits: 5, status: 'completed', createdAt: iso(-50 * HOUR), completedAt: iso(-49 * HOUR), ratedByBuyer: false, ratedBySeller: false },
];
const FEED = [
    { id: 1, eventType: 'member_joined', actorPubkey: 'member-bob', actorCallsign: 'Bob', createdAt: iso(-HOUR) },
    { id: 2, eventType: 'trade_completed', actorPubkey: 'member-sam', actorCallsign: 'Sam', targetPubkey: 'member-bea', targetCallsign: 'Bea', metadata: { postId: 'post-2', postTitle: 'Bike repair', credits: 12 }, createdAt: iso(-2 * HOUR) },
    { id: 3, eventType: 'rating_given', actorPubkey: 'member-rae', actorCallsign: 'Rae', targetPubkey: 'member-tia', targetCallsign: 'Tia', metadata: { stars: 4, comment: 'Fast and friendly' }, createdAt: iso(-3 * HOUR) },
    { id: 4, eventType: 'post_created', actorPubkey: 'member-damo', actorCallsign: 'Damo', metadata: { postId: 'post-1', title: 'Record fair', credits: 5 }, createdAt: iso(-26 * HOUR) },
];
const pulseItem = (over) => ({ id: 'pi-1', ownerPubkey: ME, url: 'https://youtube.com/watch?v=1', platform: 'youtube', category: 'food', title: 'Seed saving at the hall',
    thumbnailUrl: null, callsign: 'GreenThumb', avatarUrl: 'bundled://leaf', source: 'user', isVerified: true, publishedAt: iso(-3 * HOUR), ...over });
const PULSE_ITEMS = [pulseItem({}), pulseItem({ id: 'pi-2', ownerPubkey: 'council', callsign: 'Shire Council', title: 'Road closure on Main St', source: 'official', isOfficial: true })];
const channel = (over) => ({ url: null, handle: null, category: 'other', isPrimaryVideo: false, supportsAutolist: false, oauthVerifiedAt: null, syndicateToNode: true, ...over });
const CHANNELS = [
    channel({ id: 'ch-yt', platform: 'youtube', handle: '@anagrows', url: 'https://youtube.com/@anagrows', category: 'food', isPrimaryVideo: true, supportsAutolist: true, oauthVerifiedAt: '2026-10-01T00:00:00Z' }),
    channel({ id: 'ch-ig', platform: 'instagram', handle: '@ana.makes', url: 'https://instagram.com/ana.makes', category: 'craft' }),
    channel({ id: 'ch-web', platform: 'website', url: 'https://ana.example', category: 'community' }),
];
const NUDGES = [{ channelId: 'ch-yt', platform: 'youtube', newPostsCount: 3, currentCount: 10 }];
const EVENT_CHAT = {
    conversation: { id: 'ev-1', type: 'event_thread', name: 'Working bee at the hall', participants: [], createdBy: 'member-hazel', createdAt: '' },
    messages: [
        { id: 'e1', conversationId: 'ev-1', authorPubkey: 'member-goer', authorCallsign: 'Goer', authorAvatar: 'bundled://leaf', ciphertext: b64('Bringing a thermos'), nonce: 'plaintext-v1', type: 'text', timestamp: iso(-HOUR) },
        { id: 'e2', conversationId: 'ev-1', authorPubkey: 'member-goer', authorCallsign: 'Goer', authorAvatar: 'bundled://leaf', ciphertext: '', nonce: 'plaintext-v1', type: 'removed', timestamp: iso(-HOUR) },
    ],
    readOnly: false, readOnlyReason: null, canPost: true, isHost: true, title: 'Working bee at the hall', eventEndAt: iso(33 * HOUR), eventState: 'scheduled',
    privateNote: 'Gate code 1234', notice: "Visible to the host, everyone going, and this node's operator.",
};

function answer(pathname, search) {
    if (pathname.startsWith('/api/messages/conversations/')) return { conversations: CONVERSATIONS, totalUnread: 2 };
    if (pathname === '/api/messages/mark-read') return { success: true };
    const conv = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (conv) return { conversation: CONVERSATIONS.find((c) => c.id === conv[1]) ?? null, messages: MESSAGES[conv[1]] ?? [] };
    if (pathname === '/api/marketplace/transactions') return TXS;
    if (pathname === '/api/community/members') return MEMBERS;
    if (pathname.startsWith('/api/friends/')) return [];
    if (pathname === '/api/activity/feed') return { feed: FEED };
    if (pathname === '/api/pulse/feed') return { items: PULSE_ITEMS, nextCursor: null };
    if (pathname === '/api/channels/mine') return { channels: CHANNELS };
    if (pathname === '/api/member/pulse/nudges') return { nudges: NUDGES };
    if (/^\/api\/marketplace\/posts\/[^/]+\/chat$/.test(pathname)) return EVENT_CHAT;
    if (pathname === '/api/member/pulse/preview') {
        return { preview: { url: 'https://instagram.com/p/abc123/', title: 'Saving tomato seed', thumbnailUrl: null, platform: 'instagram', category: 'food', isDuplicate: false, authorCallsign: 'GreenThumb', isVerified: true } };
    }
    return mockResponse(pathname, search);
}

// ── In the page ─────────────────────────────────────────────────────────────────────────────────────────────────
/** What overflows and what is clipped; each with its words, and whether they came through t() (xx's marks). */
function measure(debug) {
    const W = window.innerWidth;
    const out = { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: W, past: [], clipped: [] };
    const scrollsSideways = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
    };
    const words = (el) => (el.textContent || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
    const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${words(el).slice(0, 70)}"`;
    // The same element in English and in xx: its place in the page (the screens draw the same tree in every language).
    const pathOf = (el) => { const parts = []; for (let e = el; e && e !== document.body; e = e.parentElement) parts.unshift(`${e.tagName.toLowerCase()}:${[...(e.parentElement?.children ?? [])].indexOf(e)}`); return parts.join('>'); };
    for (const el of document.body.querySelectorAll('*')) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const control = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
        if (!ownText && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        if (el.closest('.sr-only')) continue;
        const r = el.getBoundingClientRect();
        const clips = (v) => v === 'hidden' || v === 'clip';
        // Words squeezed to nothing by their neighbours: a box with text, as tall as a line, and no width left.
        if (ownText && r.width < 1 && r.height > 0 && clips(cs.overflowX)) {
            out.clipped.push({ what: `${label(el)} squeezed to ${r.width.toFixed(1)} px wide`, key: pathOf(el), sentence: /[[\]~]/.test(words(el)) });
            continue;
        }
        if (r.width === 0 || r.height === 0) continue;
        // The words themselves, not the box: a word too long to break spills out of its box, and the box's rectangle
        // does not include the spill. A box that clips its own overflow (an ellipsis) shows no spill: its words are
        // measured as clipped below, and only the box itself can reach past the edge.
        let left = r.left;
        let right = r.right;
        if (!clips(cs.overflowX)) {
            for (const n of el.childNodes) {
                if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(n);
                for (const rr of range.getClientRects()) { left = Math.min(left, rr.left); right = Math.max(right, rr.right); }
            }
        }
        const sentence = /[[\]~]/.test(words(el));
        if ((right > W + 0.5 || left < -0.5) && !scrollsSideways(el)) out.past.push({ what: `${label(el)} spans ${Math.round(left)}–${Math.round(right)} px`, key: pathOf(el), sentence });
        if ((clips(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && cs.webkitLineClamp === 'none')) {
            out.clipped.push({ what: `${label(el)} needs ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`, key: pathOf(el), sentence });
        }
    }
    if (out.scrollWidth > W) {
        // What widens the page: past the edge with no ancestor that clips or scrolls it.
        const unclipped = (el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return false;
            return true;
        };
        const wide = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > W + 0.5 && unclipped(el));
        out.widest = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 4)
            .map((el) => `${label(el)} (${typeof el.className === 'string' ? el.className.slice(0, 60) : ''}) right ${Math.round(el.getBoundingClientRect().right)} px`);
    }
    out.textLength = document.body.innerText.length;
    if (debug && out.scrollWidth > W) {
        out.debug = { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, items: [] };
        for (const el of document.body.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (r.right <= W + 0.5) continue;
            let clip = null;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowX !== 'visible') { clip = `${p.tagName.toLowerCase()}.${String(p.className).slice(0, 40)} ox=${cs.overflowX} right=${Math.round(p.getBoundingClientRect().right)} sw=${p.scrollWidth} cw=${p.clientWidth}`; break; }
            }
            out.debug.items.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)} pos=${getComputedStyle(el).position} clip=${clip}`);
        }
        out.debug.items = out.debug.items.slice(0, 12);
    }
    return out;
}

async function main() {
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w1-build-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    const listed = [];
    try {
        await build({
            configFile: false, root: PWA_DIR, plugins: [react()], define: { __APP_VERSION__: JSON.stringify('harness') }, logLevel: 'warn',
            build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'words-w1-harness.html') } },
        });
        server = await preview({ configFile: false, root: PWA_DIR, preview: { port: 0, open: false }, build: { outDir }, logLevel: 'warn' });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const screen of SCREENS) {
            const english = { past: new Set(), clipped: new Set() };
            for (const lang of LANGS) {
                const run = `${screen} ${lang}`;
                const context = await browser.newContext({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce', colorScheme: 'light' });
                await context.addInitScript(() => {
                    localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                    localStorage.setItem('beanpool-theme-mode', 'light');
                });
                await context.route((url) => url.origin !== origin, (route) => route.abort());
                await context.route(`${origin}/api/**`, (route) => {
                    const url = new URL(route.request().url());
                    const body = answer(url.pathname, url.search);
                    if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
                    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                });
                await context.route(`${origin}/ws**`, (route) => route.abort());
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', (e) => errors.push(e.message));
                try {
                    await page.goto(`${origin}/e2e/words-w1-harness.html?screen=${screen}&lang=${lang}`, { waitUntil: 'load' });
                    await page.addStyleTag({ content: TEXT_SCALE_CSS(1.3) });
                    await page.waitForSelector('html[data-harness-ready="true"]', { timeout: 20_000 });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.waitForTimeout(700);
                    const m = await page.evaluate(measure, !!process.env.DEBUG_W1);
                    if (m.debug) console.log(JSON.stringify(m.debug, null, 1));
                    await page.screenshot({ path: path.join(SHOTS_DIR, `${screen}-${lang}.png`), fullPage: false });
                    if (errors.length) failures.push(`${run}: page error: ${errors[0]}`);
                    if (m.textLength < 20) failures.push(`${run}: nothing drawn (${m.textLength} characters)`);
                    const sideways = m.scrollWidth > m.width;
                    if (lang === 'en') {
                        for (const p of m.past) english.past.add(p.key);
                        for (const c of m.clipped) english.clipped.add(c.key);
                        if (sideways) listed.push(`${run}: the page scrolls sideways in English too (${m.scrollWidth}px): ${(m.widest ?? []).join('; ')}`);
                        for (const p of m.past) listed.push(`${run}: past the edge in English: ${p.what}`);
                        for (const c of m.clipped) listed.push(`${run}: clipped in English: ${c.what}`);
                    } else {
                        if (sideways) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px): ${(m.widest ?? []).join('; ')}`);
                        for (const p of m.past) (english.past.has(p.key) ? listed : failures).push(`${run}: past the edge: ${p.what}`);
                        for (const c of m.clipped) {
                            const inEnglish = english.clipped.has(c.key);
                            (inEnglish ? listed : failures).push(`${run}: clipped${inEnglish ? ' (in English too)' : c.sentence ? '' : ' (not through t(): a member\'s words)'}: ${c.what}`);
                        }
                    }
                    console.log(`${run}: ${m.past.length} past the edge, ${m.clipped.length} clipped${sideways ? ', scrolls sideways' : ''}`);
                } catch (e) {
                    failures.push(`${run}: ${e.message}`);
                    await page.screenshot({ path: path.join(SHOTS_DIR, `${screen}-${lang}-error.png`) }).catch(() => {});
                }
                await context.close();
            }
        }
    } finally {
        await browser?.close();
        await new Promise((r) => (server ? server.httpServer.close(r) : r()));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    for (const l of listed) console.log(`note ${l}`);
    console.log(`screenshots: ${SHOTS_DIR}`);
    if (failures.length) {
        for (const f of failures) console.log(`FAIL ${f}`);
        process.exit(1);
    }
    console.log(`words-w1-check: ok — ${SCREENS.length} screens at 320 px, 1.3× text, in ${LANGS.join(', ')}: nothing a longer language pushes off the screen or cuts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
