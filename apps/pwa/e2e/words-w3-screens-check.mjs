/**
 * Web sweep W3's screens at 320 px with 1.3× text, in a real browser (words slice S3; director amendment 1 item 7):
 * Settings and every screen it opens, a member's profile (another's and your own), the profile editor and wizard, the
 * how-it-works cards, the working style quiz, Add a card, a card's settings, Edit home, a card's "…", the tour bar, the
 * install prompt, the new-account card, Start a community, Suggest a change, the radius picker, the guest lobby, and the
 * app shell's header and tabs. Each is drawn by the app's own components and stylesheet (e2e/words-w3-screens: Vite's
 * dev server) in the pseudo-locale `xx` (every sentence accented and padded ~35 %, the stand-in for a longer
 * language), or in the languages WORDS_W3_LANGS names; the tab strip in each of the 24 languages with the phone's tab
 * words (see SCREENS).
 *
 * Fails on: the page scrolling sideways; any element with words reaching past either edge (outside a box that scrolls
 * sideways); any words clipped by their own box (overflow hidden or clip with more text than fits: a label cut short
 * with an ellipsis counts). /api is answered here; every other host is refused. Nothing here talks to a node.
 *
 * Run: pnpm --filter @beanpool/pwa exec node e2e/words-w3-screens-check.mjs [out-dir]
 *   WORDS_W3_ONLY=settings,quiz    only these screens
 *   WORDS_W3_LANGS=xx,de           these languages (default xx); the shell's tabs then read the phone's tab words
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, getComputedStyle, Node */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = path.resolve(PWA_DIR, '../../packages/beanpool-core/dist');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w3-screens');
const only = (env) => (process.env[env] ? process.env[env].split(',').map((x) => x.trim()) : null);
const LANGS = only('WORDS_W3_LANGS') ?? ['xx'];
/** The 24 languages besides English (core's LANGS), for the tabs. */
const REAL_LANGS = only('WORDS_W3_LANGS') ?? ['es', 'pt', 'hi', 'bn', 'fr', 'ar', 'id', 'ru', 'zh-Hans', 'zh-Hant', 'it', 'de', 'tr', 'sw', 'ml', 'ta', 'uk', 'ur', 'fa', 'vi', 'el', 'fil', 'ja', 'ko'];
const VIEW = { viewport: { width: 320, height: 640 }, textScale: 1.3 };
const { pseudoLocalise } = await import(pathToFileURL(path.join(CORE_DIST, 'words.js')).href);
const wordIn = (lang, english) => (lang === 'xx' ? pseudoLocalise(english) : english);

const ME = 'me-pk-0000000000000000000000000000';
const PEER = 'peer-pk-000000000000000000000000000';
const archetype = (primary, secondary) => JSON.stringify({ primary, secondary, mode: 'quick', updatedAt: '2026-10-01T00:00:00Z' });
const at = (ms) => new Date(Date.now() + ms).toISOString();
const API = {
    info: { memberCount: 14, postCount: 30, transactionCount: 9, commonsBalance: 640, profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } },
    health: { online: true, status: 'ok', version: '1.2.29', nodeName: 'Riverbend', memberCount: 14, postCount: 30, transactions: 9 },
    me: { probation: { onProbation: true, keptPosts: 1, keptPostsNeeded: 3, ageEndsAt: at(2 * 86_400_000), endsWhen: { hours: 72, keptPosts: 3 }, limits: {
        posts: { limit: 3, used: 1, remaining: 2, resetsAt: at(5 * 3_600_000) },
        photos: { limit: 5, used: 5, remaining: 0, resetsAt: at(5 * 3_600_000) },
        new_dm_recipients: { limit: 10, used: 0, remaining: 10, resetsAt: null },
    } } },
    profile: (pk) => (pk === PEER
        ? { publicKey: PEER, callsign: 'Bob', avatar: null, bio: 'Fixes bikes on Sundays', role: 'member', joinedAt: '2026-09-14T00:00:00Z', elderVouchedBy: null, archetype: archetype('weaver', 'connector') }
        : { publicKey: ME, callsign: 'Alice', avatar: null, bio: 'Bakes on Fridays', role: 'member', joinedAt: '2026-01-01T00:00:00Z', archetype: archetype('catalyst', 'spark'), contact: { value: 'alice@example.org', visibility: 'friends' } }),
    balance: { balance: 12.5, floor: -50, earnedCredit: 140, canVouch: true, tier: { name: 'Green Bean', emoji: '🌱' }, trustStats: { tradeCount: 3 } },
    ratings: { average: 4.5, count: 2, asProvider: { average: 5, count: 1 }, asReceiver: { average: 4, count: 1 }, ratings: [
        { stars: 5, comment: 'Lovely bread', role: 'provider', createdAt: '2026-09-02T00:00:00Z' }, { stars: 4, comment: '', role: 'receiver', createdAt: '2026-09-20T00:00:00Z' },
    ] },
    given: { ratings: [{ id: 'r1', stars: 4, comment: '', target_callsign: 'Dan', transactionId: 'tx1', targetPubkey: 'dan-pk', createdAt: '2026-08-01T00:00:00Z' }] },
    prefs: { holiday_mode: 'false', show_as_connection_in_common: 'true', notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'false', eventReminderOffsets: '[1440,60]' },
    blocks: { blocked: [{ publicKey: PEER, blockedAt: '2026-10-01T00:00:00Z' }], max: 100 },
    listing: [{ id: 'p1', type: 'offer', title: 'Sourdough loaves', status: 'active', credits: 12, photos: null, authorPublicKey: PEER }],
};

/** Each screen: its `?screen=`, what shows it is drawn, what to do first, and (for the shell) where to measure. */
const SCREENS = [
    { name: 'settings', ready: 'text=/ĀÇÇÖŪÑŢ/' },
    { name: 'settings-delete', screen: 'settings', ready: 'text=/ĀÇÇÖŪÑŢ/', act: async (page, lang) => {
        await page.getByText(wordIn(lang, 'Account Deletion & Sign Out')).click();
        await page.getByText(wordIn(lang, 'Choose an Action')).waitFor();
    } },
    { name: 'settings-purge', screen: 'settings', ready: 'text=/ĀÇÇÖŪÑŢ/', act: async (page, lang) => {
        await page.getByText(wordIn(lang, 'Account Deletion & Sign Out')).click();
        await page.getByRole('button', { name: wordIn(lang, 'Permanently Delete Account'), exact: true }).click();
        await page.locator('#purge-callsign-input').waitFor();
    } },
    { name: 'settings-signout', screen: 'settings', ready: 'text=/ĀÇÇÖŪÑŢ/', act: async (page, lang) => {
        await page.getByText(wordIn(lang, 'Account Deletion & Sign Out')).click();
        await page.getByRole('button', { name: wordIn(lang, 'Sign Out (Device Only)'), exact: true }).click();
    } },
    { name: 'settings-seed', ready: '[data-testid="seed-words"]' },
    { name: 'settings-diagnostics', ready: 'h3' },
    { name: 'settings-notifications', ready: 'legend' },
    { name: 'settings-blocked', ready: 'text=Bob' },
    { name: 'settings-advanced', ready: 'h3' },
    { name: 'settings-suggest', ready: 'form' },
    { name: 'settings-guide', ready: 'input[type="search"]' },
    { name: 'profile-peer', ready: 'text=Fixes bikes on Sundays' },
    { name: 'profile-self', ready: 'text=Bakes on Fridays' },
    { name: 'profile-edit', ready: '#profile-bio' },
    { name: 'profile-setup', ready: 'h2' },
    { name: 'onboarding-guide', ready: 'h4' },
    { name: 'quiz', ready: '[role="dialog"]' },
    { name: 'quiz-question', screen: 'quiz', ready: '[role="dialog"]', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'Quick Spark: 9 questions, approx 1 minute. A 60-second snapshot of how you like to work.') }).click();
        await page.getByRole('progressbar').waitFor();
    } },
    { name: 'quiz-result', screen: 'quiz', ready: '[role="dialog"]', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'Quick Spark: 9 questions, approx 1 minute. A 60-second snapshot of how you like to work.') }).click();
        for (let i = 0; i < 9; i++) await page.getByRole('radio').first().click();
        await page.getByText(wordIn(lang, 'Who you work well with')).waitFor();
    } },
    { name: 'add-card', ready: '[data-testid="home-add-dialog"]' },
    { name: 'card-settings', ready: '[data-testid="home-settings-dialog"]' },
    { name: 'edit-home', ready: '[data-testid="home-edit-dialog"]', act: async (page) => { await page.locator('[data-testid="home-edit-menu-search-aaaa"]').click(); } },
    { name: 'home-card', ready: '[data-testid="home-card-menu"]', act: async (page) => { await page.locator('[data-testid="home-card-menu"]').click(); } },
    { name: 'tour', ready: '[data-testid="tour-bar"]' },
    { name: 'tour-step', ready: '[data-testid="tour-bar"]' },
    { name: 'install', ready: 'body', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'How?') }).click({ timeout: 10_000 });
    } },
    { name: 'new-account', ready: '[data-testid="new-account-rule"]' },
    { name: 'start-community', ready: '[data-testid="start-community-screen"]' },
    { name: 'suggest', ready: 'form' },
    { name: 'radius', ready: '#radius-picker-title' },
    { name: 'lobby', ready: '[data-testid="lobby-join-card"]', scope: '[data-testid="lobby-join-card"], [data-testid="lobby-bottom-nav"]' },
    { name: 'shell', ready: '[data-testid="mobile-bottom-nav"]', scope: 'header' },
    // The tabs in every real language, with the phone's tab words (word(…, 'tab'): the same keys, already translated in
    // all 24). Not in xx: on a one-word name of 3 to 7 letters its brackets and pad make it 60 to 100 % longer, past any
    // real language's tab word; the header's title and the rest of the screens are checked in xx.
    { name: 'tabs', screen: 'shell', ready: '[data-testid="mobile-bottom-nav"]', scope: '[data-testid="mobile-bottom-nav"]', phoneWords: true, langs: REAL_LANGS },
].filter((sc) => !only('WORDS_W3_ONLY') || only('WORDS_W3_ONLY').includes(sc.name));

/** In the page: what overflows and what is clipped, inside `scope` (the whole page when null); `pseudo` for xx. */
function measure([scope, pseudo]) {
    const W = window.innerWidth;
    const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
    const out = { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: W, past: [], clipped: [], notes: [], measured: 0 };
    const scrollsSideways = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
    };
    const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 70)}"`;
    for (const root of roots) for (const el of [root, ...root.querySelectorAll('*')]) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const control = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
        if (!ownText && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Words for screen readers only (sr-only: a 1 px box that clips by design).
        if (r.width <= 1 && r.height <= 1) continue;
        // In the pseudo-locale, only the words that came through t(): what members wrote reads the same in every
        // language, so a longer language never lengthens it.
        if (pseudo && !/[[\]]/.test(el.textContent || el.getAttribute('placeholder') || '')) continue;
        out.measured++;
        let left = r.left;
        let right = r.right;
        for (const n of el.childNodes) {
            if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const rr of range.getClientRects()) { left = Math.min(left, rr.left); right = Math.max(right, rr.right); }
        }
        if ((right > W + 0.5 || left < -0.5) && !scrollsSideways(el)) out.past.push(`${label(el)} spans ${Math.round(left)}–${Math.round(right)} px`);
        const clips = (v) => v === 'hidden' || v === 'clip';
        if ((clips(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && cs.webkitLineClamp === 'none')) {
            // A one-line field's placeholder can't wrap: a long one is cut at its end. Said, not failed (the field works).
            (el.tagName === 'INPUT' ? out.notes : out.clipped).push(`${label(el)} needs ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`);
        }
    }
    if (out.scrollWidth > W) {
        const wide = [...document.body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > W + 0.5);
        out.widest = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 4)
            .map((el) => `${label(el)} (${typeof el.className === 'string' ? el.className.slice(0, 60) : ''}) right ${Math.round(el.getBoundingClientRect().right)} px`);
    }
    return out;
}

function answer(route) {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/community/info') return reply(200, API.info);
    if (p === '/api/community/health') return reply(200, API.health);
    if (p === '/api/community/me') return reply(200, API.me);
    if (p.startsWith('/api/profile/')) return reply(200, API.profile(decodeURIComponent(p.split('/')[3])));
    if (/^\/api\/members\/[^/]+\/channels$/.test(p)) return reply(200, { channels: [] });
    if (p.startsWith('/api/ledger/balance/')) return reply(200, API.balance);
    if (p.startsWith('/api/ratings/')) return reply(200, url.searchParams.get('direction') === 'given' ? API.given : API.ratings);
    if (p.startsWith('/api/friends/')) return reply(200, [{ publicKey: PEER, callsign: 'Bob' }]);
    if (p === '/api/members/preferences') return reply(200, API.prefs);
    if (p === '/api/blocks') return reply(200, API.blocks);
    if (p === '/api/marketplace/posts') return reply(200, url.searchParams.get('author') ? API.listing : []);
    if (p === '/api/recovery/shares/status') return reply(200, { enrolledSso: [] });
    return reply(404, { error: 'Not Found' });
}

async function main() {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const server = await createServer({ root: PWA_DIR, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    await server.listen();
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    const browser = await chromium.launch();
    const failures = [];
    const notes = [];
    try {
        for (const sc of SCREENS) for (const lang of sc.langs ?? LANGS) {
            const run = `${sc.name} ${lang}`;
            const context = await browser.newContext({ viewport: VIEW.viewport, reducedMotion: 'reduce', colorScheme: 'light' });
            await context.addInitScript((scale) => {
                localStorage.setItem('beanpool-theme-mode', 'light');
                document.addEventListener('DOMContentLoaded', () => {
                    const s = document.createElement('style');
                    s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                    document.head.appendChild(s);
                });
            }, VIEW.textScale);
            await context.route((url) => url.origin !== origin, (route) => route.abort());
            await context.route(`${origin}/api/**`, answer);
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
            try {
                await page.goto(`${origin}/e2e/words-w3-screens/index.html?screen=${sc.screen ?? sc.name}&lang=${encodeURIComponent(lang)}${sc.phoneWords ? '&words=phone' : ''}`, { waitUntil: 'load' });
                await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
                await page.waitForSelector(sc.ready, { timeout: 20_000 });
                await page.waitForTimeout(sc.name === 'install' ? 2500 : 300);
                if (sc.act) await sc.act(page, lang);
                await page.waitForTimeout(300);
                const m = await page.evaluate(measure, [sc.scope ?? null, lang === 'xx']);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${lang}.png`) });
                if (m.scrollWidth > m.width) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px): ${(m.widest ?? []).join('; ')}`);
                for (const p of m.past) failures.push(`${run}: past the edge: ${p}`);
                for (const c of m.clipped) failures.push(`${run}: clipped: ${c}`);
                for (const n of m.notes) notes.push(`${run}: a field's placeholder is cut at its end: ${n}`);
                console.log(`${run}: ${m.measured} elements with words measured, ${m.past.length + m.clipped.length + (m.scrollWidth > m.width ? 1 : 0)} overflow(s)`);
            } catch (e) {
                failures.push(`${run}: ${e.message.split('\n')[0]}${pageErrors.length ? ` (page: ${pageErrors.slice(0, 3).join(' | ').slice(0, 400)})` : ''}`);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${lang}-error.png`) }).catch(() => {});
            }
            await context.close();
        }
    } finally {
        await browser.close();
        await server.close();
    }
    console.log(`screenshots: ${SHOTS_DIR}`);
    for (const n of notes) console.log(`NOTE ${n}`);
    if (failures.length) {
        for (const f of failures) console.log(`FAIL ${f}`);
        process.exit(1);
    }
    console.log(`words-w3-screens-check: ok — ${SCREENS.length} screens in ${LANGS.join(', ')} (the tabs in ${REAL_LANGS.length} languages) at 320 px, 1.3× text: nothing overflows`);
}

main().catch((e) => { console.error(e); process.exit(1); });
