/* eslint-disable no-undef */
/**
 * Learn's recognition on the web (DESIGN-local-knowledge-fable.md §2.10, §3.7; slice K8) on the REAL pages, at the floor (320 px
 * wide, text at 130%), in light and dark: node apps/pwa/e2e/learn-thank-320.mjs [--shots <dir>]
 *   a member on Ada's page ("🗺️ Local guide" under her name, "🫘 Thank Ada"); the tap, then the Ledger's Send form for each
 *   reader: one who can send (Ada chosen, the note filled, no amount), one whose first trade is still to come and one with no
 *   Beans to send (today's 🔒 words, Ada kept); Ada's profile with the badge (and no Thank).
 *
 * The real LearnPage, LedgerPage and PublicProfilePage with the real stylesheet (e2e/learn-thank-harness.tsx); every /api call
 * is answered here and nothing leaves the machine. Checks, read from the live layout: no sideways scroll; no words past either
 * edge; every button and field at least 44 px tall, inside the screen and not cut; what each state should say is there; nothing
 * is written by looking or by the tap (the Ledger only opens its form; the member sends).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TEXT_SCALE_CSS } from './harness.mjs';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
const WIDTH = 320;
const HEIGHT = 720;
const SCALE = 1.3;
const LIMIT_S = Number(process.env.LEARN_LIMIT_S || 300);
setTimeout(() => { console.error(`\nStopped after ${LIMIT_S} s, not finished.`); process.exit(2); }, LIMIT_S * 1000).unref();

const DAY = 86_400_000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const TITLE = 'How recycling works at the tip';
const NOTE = `Thanks for "${TITLE}"`;
const ADA = 'member-ada';
const TIP = {
    id: 'tip', type: 'knowledge', category: 'local-services', title: TITLE,
    description: 'Bring glass, cans and paper sorted into their own boxes.\n\nThe tip is open every day but Monday, 8 to 4.',
    authorPublicKey: ADA, authorCallsign: 'Ada', createdAt: at(40), status: 'active', photos: [],
    knowledge: { sources: [{ url: 'https://www.council.example/waste/tip', label: 'Council tip page' }], place: 'The tip on Manse Road', lang: null,
        checkedAt: at(20), outdatedAt: null, outdatedNote: null, helped: 4, gathered: false, helpedByMe: false, writerLocalGuide: true },
};
// The member's own figures, as /api/ledger/balance answers them (whole hundredths), for each reader.
const FIGURES = {
    'can-send': { balance_c: 12000, earnedCredit_c: 300 },
    'first-trade': { balance_c: 12000, earnedCredit_c: 0 },
    'positive-balance': { balance_c: 0, earnedCredit_c: 300 },
};
const LOCKED = {
    'first-trade': '🔒 Direct sends unlock after your first completed trade on the Marketplace, and require a positive balance.',
    'positive-balance': '🔒 You can only send beans you currently hold — direct sends require a positive balance.',
};
const LIVE = { memberCount: 40, postCount: 4, transactionCount: 9, commonsBalance_c: 0, profile: 'local',
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, knowledge: true } };
// Reads the node answers to a POST: not writes.
const POST_READS = new Set(['/api/trust/profile']);

function answer(method, pathname, search, st) {
    if (pathname === '/api/node-admin/me') return { role: null };
    if (pathname === '/api/marketplace/posts' && new URLSearchParams(search).get('type') === 'knowledge') {
        return new URLSearchParams(search).get('id') === 'tip' ? [TIP] : [];
    }
    if (pathname === '/api/knowledge/front') return { total: 0, pinned: [], topics: [] };
    if (pathname === '/api/knowledge/drafts/mine') return { waiting: [], answered: [] };
    if (pathname.startsWith('/api/ledger/balance')) {
        return { ...FIGURES[st.reader ?? 'can-send'], floor_c: -15300, usableFloor_c: -15300, commonsBalance_c: 0, callsign: 'You', tier: { name: 'Newcomer' }, activated: true, frozen: false };
    }
    if (pathname === '/api/ledger/transactions') return [];
    if (pathname === '/api/members') {
        // A read by key: the Ledger names Thank's recipient from the node's member list, by key (review of #3243).
        const keys = new URLSearchParams(search).get('keys');
        if (keys !== null) return keys.split(',').filter((k) => k === ADA).map(() => ({ publicKey: ADA, callsign: 'Ada', joinedAt: at(300) }));
        return { members: [], nextCursor: null };
    }
    if (pathname === '/api/community/me') return { mute: { muted: false, until: null }, features: null };
    if (pathname === '/api/credit/gift') return { offered: false };
    if (pathname === '/api/commons/repayment') return { repayment: null };
    if (pathname.startsWith('/api/friends/')) return [];
    if (pathname === '/api/trust/profile') return { vouchedInBy: null, badges: ['local-guide'] };
    if (pathname === `/api/profile/${ADA}`) {
        return { publicKey: ADA, callsign: 'Ada', avatar: null, bio: 'Allotment on Manse Road.', role: 'member', joined_at: at(300), stats: { ratingsReceivedCount: 0, averageRating: 0 } };
    }
    return mockResponse(pathname, search, [], { communityInfo: LIVE });
}

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/learn-thank-harness.html`;
const browser = await chromium.launch();
const problems = [];

/** `says`: [selector, exact text] pairs; `value`: [selector, the field's value]; `none`: selectors that must not be there. */
const THANK = '[data-testid="learn-post-thank"]';
const MEMO = 'input[placeholder="Memo (optional)"]';
const AMOUNT = 'input[placeholder="Amount (B)"]';
const STATES = [
    { name: 'page-member', screen: 'page', ready: THANK, full: true,
        says: [['[data-testid="learn-post-writer-guide"]', '🗺️ Local guide'], [THANK, '🫘 Thank Ada']] },
    { name: 'send-can-send', screen: 'page', reader: 'can-send', ready: THANK, tap: [THANK, MEMO],
        value: [[MEMO, NOTE], [AMOUNT, '']], none: ['[data-testid="send-beans-locked"]'], recipient: 'Ada' },
    { name: 'send-first-trade', screen: 'page', reader: 'first-trade', ready: THANK, tap: [THANK, '[data-testid="send-beans-locked"]'],
        says: [['[data-testid="send-beans-locked"]', LOCKED['first-trade']]], none: [MEMO, AMOUNT], recipient: 'Ada' },
    { name: 'send-positive-balance', screen: 'page', reader: 'positive-balance', ready: THANK, tap: [THANK, '[data-testid="send-beans-locked"]'],
        says: [['[data-testid="send-beans-locked"]', LOCKED['positive-balance']]], none: [MEMO, AMOUNT], recipient: 'Ada' },
    { name: 'profile', screen: 'profile', ready: '[data-testid="profile-local-guide"]', full: true,
        says: [['[data-testid="profile-local-guide"]', '🗺️ Local guide']], noThank: true },
];

try {
    for (const scheme of ['light', 'dark']) {
        for (const st of STATES) {
            const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, colorScheme: scheme, reducedMotion: 'reduce' });
            await context.addInitScript(([mode]) => { try { localStorage.setItem('beanpool-theme-mode', mode); } catch { /* still a theme */ } }, [scheme]);
            const asked = [];
            await context.route('**/api/**', async (route) => {
                const url = new URL(route.request().url());
                const method = route.request().method();
                asked.push(`${method} ${url.pathname}`);
                const body = answer(method, url.pathname, url.search, st);
                if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' });
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
            });
            await context.route('**/socket.io/**', (route) => route.abort());
            await context.route('**/ws**', (route) => route.abort());
            await context.route((url) => !['localhost', '127.0.0.1'].includes(url.hostname), (route) => route.abort());
            const tab = await context.newPage();
            tab.setDefaultTimeout(30_000);
            const errors = [];
            tab.on('pageerror', (e) => errors.push(String(e)));
            await tab.goto(`${base}?screen=${st.screen}`, { waitUntil: 'load' });
            await tab.addStyleTag({ content: TEXT_SCALE_CSS(SCALE) });
            await tab.waitForSelector(st.ready, { timeout: 60_000 });
            if (st.tap) { await tab.click(st.tap[0]); await tab.waitForSelector(st.tap[1]); }
            await tab.evaluate(() => document.fonts?.ready).catch(() => {});
            await tab.waitForTimeout(400);

            const found = await tab.evaluate(([width, says, value, none, recipient, noThank]) => {
                const out = [];
                if (document.documentElement.scrollWidth > width) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${width}px)`);
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
                for (const el of document.querySelectorAll('button, a[href], input')) {
                    if (!visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    const name = (el.getAttribute('data-testid') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40);
                    if (r.height < 43.5) out.push(`"${name}" is ${r.height.toFixed(1)} px tall, under 44`);
                    if (r.right > width + 0.5) out.push(`"${name}" runs past the ${width}px edge (right ${r.right.toFixed(1)})`);
                    if (el.tagName !== 'INPUT' && el.scrollWidth > el.clientWidth + 1) out.push(`"${name}" is cut (${el.scrollWidth}px of ${el.clientWidth}px)`);
                }
                for (const el of document.body.querySelectorAll('*')) {
                    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
                    if (el.closest('.sr-only') || !visible(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.right > width + 0.5 || r.left < -0.5) out.push(`"${el.textContent.trim().slice(0, 40)}" spans ${Math.round(r.left)}–${Math.round(r.right)} px`);
                }
                for (const [sel, text] of says) {
                    const el = document.querySelector(sel);
                    if (!el) out.push(`${sel} is missing`);
                    else if (el.textContent.trim() !== text) out.push(`${sel} says "${el.textContent.trim()}", not "${text}"`);
                }
                for (const [sel, v] of value) {
                    const el = document.querySelector(sel);
                    if (!el) out.push(`${sel} is missing`);
                    else if (el.value !== v) out.push(`${sel} holds "${el.value}", not "${v}"`);
                }
                for (const sel of none) if (document.querySelector(sel)) out.push(`${sel} is shown`);
                if (recipient && ![...document.querySelectorAll('button')].some((b) => b.textContent.includes(recipient))) out.push(`no recipient button names ${recipient}`);
                if (noThank && /Thank/.test(document.body.textContent)) out.push('the profile offers Thank');
                return out;
            }, [WIDTH, st.says ?? [], st.value ?? [], st.none ?? [], st.recipient ?? null, !!st.noThank]);
            problems.push(...found.map((p) => `${scheme} ${st.name}: ${p}`));
            if (errors.length) problems.push(`${scheme} ${st.name}: page errors: ${errors.join(' | ')}`);
            const writes = asked.filter((a) => !a.startsWith('GET ') && !POST_READS.has(a.slice(a.indexOf(' ') + 1)));
            if (writes.length) problems.push(`${scheme} ${st.name}: a write without the member sending: ${writes.join(', ')}`);
            if (st.tap) {
                const thanks = await tab.evaluate(() => window.__thanks);
                if (JSON.stringify(thanks) !== JSON.stringify([{ to: ADA, note: NOTE }])) {
                    problems.push(`${scheme} ${st.name}: Thank handed over ${JSON.stringify(thanks)}`);
                }
            }
            console.log(`${scheme} ${st.name}: ${found.length === 0 && !errors.length ? 'ok' : 'problem(s)'}`);

            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                if (st.tap && !st.full) await tab.locator(st.tap[1]).scrollIntoViewIfNeeded();
                await tab.screenshot({ path: path.join(SHOTS, `web-learn-thank-320-${scheme}-${st.name}.png`), fullPage: !!st.full });
            }
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}

if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('web learn-thank-320: passed');
process.exit(0);
