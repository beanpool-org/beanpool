/**
 * Web sweep W4's screens at 320 px with 1.3× text, in a real browser (words slice S3; director amendment 1 item 7):
 * joining (the lobby, "have you used BeanPool before?", bringing an account, the name, the sign-ins, the two doors, a
 * cancelled sign-in, the network's limit, "you're already here", "we can't tell"), getting an account back with a
 * sign-in, a re-key code, adding a sign-in and "one way back", an owner's unlock, the recovery alert, sign-in recovery,
 * an owner's 12 words check and prompt, the recovery kit, and the Invites page. Each is drawn by the app's own components
 * and stylesheet (e2e/words-w4-screens: Vite's dev server) in the pseudo-locale `xx` (every sentence accented and padded
 * ~35 %, the stand-in for a longer language), or in the languages WORDS_W4_LANGS names.
 *
 * Fails on: the page scrolling sideways; any element with words reaching past either edge (outside a box that scrolls
 * sideways); any words clipped by their own box (overflow hidden or clip with more text than fits). The measure is
 * e2e/words-w3-screens-check.mjs's. /api is answered here; every other host is refused. Nothing here talks to a node.
 *
 * Run: pnpm --filter @beanpool/pwa exec node e2e/words-w4-screens-check.mjs [out-dir]
 *   WORDS_W4_ONLY=join-lobby,invites   only these screens
 *   WORDS_W4_LANGS=xx,de               these languages (default xx)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, getComputedStyle, Node, URL, localStorage */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = path.resolve(PWA_DIR, '../../packages/beanpool-core/dist');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-w4-screens');
const only = (env) => (process.env[env] ? process.env[env].split(',').map((x) => x.trim()) : null);
const LANGS = only('WORDS_W4_LANGS') ?? ['xx'];
const VIEW = { viewport: { width: 320, height: 640 }, textScale: 1.3 };
const { pseudoLocalise } = await import(pathToFileURL(path.join(CORE_DIST, 'words.js')).href);
const wordIn = (lang, english) => (lang === 'xx' ? pseudoLocalise(english) : english);

const AT = '2026-10-03T12:00:00.000Z';
const NONCE = { nonce: 'node-nonce-1', expiresInSeconds: 600, providers: ['google', 'apple', 'facebook'], clientIds: { google: 'web-client', apple: 'org.beanpool.web', facebook: '818892721251369' } };
const LOCAL = { memberCount: 14, postCount: 30, transactionCount: 9, commonsBalance: 640, profile: 'local', features: { beans: true, invites: true, knocks: true, door: 'members' } };

/** Into the name screen from "have you used BeanPool before?", with a name someone here already has. */
async function toName(page, lang) {
    await page.locator('[data-testid="join-new"]').click();
    await page.locator('[data-testid="join-callsign"]').fill('Bea');
    await page.getByText('Bea', { exact: false }).locator('xpath=self::p[@role="status"]').waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(900);
    void lang;
}

/** Each screen: its `?screen=`, what shows it is drawn, what to do first, and how the node answers it. */
const SCREENS = [
    { name: 'join-lobby', ready: '[data-testid="join-start"]:not([disabled])' },
    { name: 'join-guard', ready: '[data-testid="join-new"]' },
    { name: 'join-restore', ready: '[data-testid="join-restore-signin"]' },
    { name: 'join-name', screen: 'join-sign-in', ready: '[data-testid="join-new"]', act: toName },
    { name: 'join-sign-in', ready: '[data-testid="join-new"]', act: async (page, lang) => {
        await toName(page, lang);
        await page.locator('[data-testid="join-name-next"]').click();
        await page.locator('[data-testid="join-provider-google"]').waitFor();
    } },
    { name: 'join-doors', ready: '[data-testid="join-new"]', act: async (page, lang) => {
        await toName(page, lang);
        await page.locator('[data-testid="join-name-next"]').click();
        await page.locator('[data-testid="join-words-problem"]').waitFor();
        await page.locator('[data-testid="join-provider-google"]').waitFor();
    } },
    { name: 'join-cancelled', ready: '[data-testid="join-provider-google"]' },
    { name: 'join-limited', ready: '[data-testid="join-notice"]', join: (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'rate_limited' }) }) },
    { name: 'join-already', ready: '[data-testid="join-already-joined"]', join: (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'already_joined', error: 'x' }) }) },
    { name: 'join-unknown', ready: '[data-testid="join-unknown"][role="alert"]', join: (route) => route.abort() },
    { name: 'restore-name', ready: '[data-testid="restore-callsign"]', act: async (page) => {
        await page.locator('[data-testid="restore-callsign"]').fill('Zed');
        await page.locator('[data-testid="restore-none"]').waitFor();
    } },
    { name: 'restore-sign-in', ready: '[data-testid="restore-callsign"]', act: async (page) => {
        await page.locator('[data-testid="restore-callsign"]').fill('Alice');
        await page.locator('[data-testid="restore-candidate"]').click();
        await page.locator('[data-testid="restore-provider-google"]').waitFor();
    } },
    { name: 'rekey-form', ready: '[data-testid="web-rekey-form"]', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'Continue'), exact: true }).click();
        await page.getByRole('alert').waitFor();
    } },
    { name: 'rekey-waiting', ready: '[data-testid="web-rekey-form"]', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'Continue'), exact: true }).click();
        await page.locator('[data-testid="web-rekey-number"]').waitFor();
    } },
    { name: 'add-sign-in', ready: '[data-testid="add-sign-in-start"]', act: async (page) => {
        await page.locator('[data-testid="add-sign-in-start"]').click();
        await page.locator('[data-testid="add-sign-in-google"]').waitFor();
    } },
    { name: 'one-way-back', ready: '[data-testid="one-way-back-landing"]' },
    { name: 'owner-unlock', ready: '[data-testid="owner-unlock-card"]', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, 'Paste a code'), exact: true }).click();
        await page.locator('#owner-unlock-code').fill('hello');
        await page.getByRole('button', { name: wordIn(lang, 'Check the code'), exact: true }).click();
        await page.getByRole('alert').waitFor();
    } },
    { name: 'recovery-alert', ready: 'button.bg-bp-danger-fill' },
    { name: 'signin-recovery', ready: '[data-testid="signin-recovery"]' },
    { name: 'owner-words', ready: '#owner-words-input', act: async (page, lang) => {
        await page.locator('#owner-words-input').fill('abandon ability able');
        await page.getByRole('button', { name: wordIn(lang, 'Check my words'), exact: true }).click();
        await page.getByRole('status').last().waitFor();
    } },
    { name: 'owner-prompt', ready: '[role="region"]' },
    { name: 'recovery-kit', ready: '[data-testid="recovery-kit"] button', act: async (page) => {
        await page.locator('[data-testid="recovery-kit"] button').click();
        await page.locator('[data-testid="recovery-kit"] [role="group"]').waitFor();
    } },
    { name: 'invites', ready: 'text=/Kim/', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, '✨ Generate New Invite'), exact: true }).click();
        await page.getByText(wordIn(lang, 'Share this code with someone you trust')).waitFor();
    } },
    { name: 'invites-tree', screen: 'invites', ready: 'text=/Kim/', act: async (page, lang) => {
        await page.getByRole('button', { name: wordIn(lang, '🌳 Tree'), exact: true }).click();
        await page.getByText('Bo', { exact: true }).waitFor();
    } },
    { name: 'invites-admins', ready: 'h2', info: { ...LOCAL, features: { ...LOCAL.features, door: 'admins' } } },
].filter((sc) => !only('WORDS_W4_ONLY') || only('WORDS_W4_ONLY').includes(sc.name));

/** In the page: what overflows and what is clipped (e2e/words-w3-screens-check.mjs's measure); `pseudo` for xx. */
function measure([pseudo]) {
    const W = window.innerWidth;
    const out = { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: W, past: [], clipped: [], notes: [], measured: 0 };
    const scrollsSideways = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
    };
    const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 70)}"`;
    for (const el of [document.body, ...document.body.querySelectorAll('*')]) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        const control = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
        if (!ownText && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Words for screen readers only (a 1 px box that clips by design).
        if (r.width <= 1 && r.height <= 1) continue;
        // In the pseudo-locale, only the words that came through t(): what others wrote reads the same in every language.
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

/** The node, for screen `sc`. */
function answerFor(sc) {
    return (route) => {
        const url = new URL(route.request().url());
        const p = url.pathname;
        const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (p === '/api/join' && sc.join) return sc.join(route);
        if (p === '/api/community/info') return reply(200, sc.info ?? LOCAL);
        if (p.startsWith('/api/members/callsign-available/')) return reply(200, { available: false });
        if (p === '/api/join/sso-nonce' || p === '/api/join/link/sso-nonce') return reply(200, NONCE);
        if (p === '/api/join/work') return reply(200, { work: null, turnstile: null });
        if (p.startsWith('/api/community/membership/')) return reply(200, { isMember: false, callsign: null });
        if (p === '/api/recovery/lookup/Alice') return reply(200, [{ publicKey: 'a'.repeat(64), callsign: 'Alice', canRecoverBySso: true }]);
        if (p.startsWith('/api/recovery/lookup/')) return reply(200, []);
        if (p === '/api/recovery/collect/sso-nonce') return reply(200, { ...NONCE, nonce: 'rn-1' });
        if (p === '/api/recovery/collect/mine') return reply(200, { count: 2, collections: [{ collectionId: 'c-1', generation: 1, startedAt: new Date().toISOString() }] });
        if (p === '/api/recovery/collect') return reply(200, { collectionId: 'col-1', threshold: 1 });
        if (p === '/api/community/me') return reply(200, { publicKey: 'x', probation: { onProbation: true, keptPosts: 0, ageEndsAt: new Date(Date.now() + 86_400_000).toISOString(), rules: 'words' } });
        if (p === '/api/node/owner/words-check') return reply(200, { owner: true, wordsCheckedAt: null });
        if (p.startsWith('/api/invite/mine/')) return reply(200, { invites: [
            { code: 'INV-OLD1-CODE', createdBy: 'me', createdAt: AT, usedBy: null, usedAt: null, intendedFor: 'Kim' },
            { code: 'INV-USED-CODE', createdBy: 'me', createdAt: AT, usedBy: 'x', usedAt: AT, intendedFor: 'Lou' },
        ] });
        if (p === '/api/invite/tree') return reply(200, [{ publicKey: 'a'.repeat(64), callsign: 'Ana', joinedAt: AT, inviteCode: '', children: [
            { publicKey: 'c'.repeat(64), callsign: 'Bo', joinedAt: AT, inviteCode: 'INV-OLD0-CODE', children: [] },
        ] }]);
        if (p === '/api/invite/generate') return reply(200, { success: true, invite: { code: 'INV-NEW1-CODE', createdBy: 'me', createdAt: AT, usedBy: null, usedAt: null } });
        if (p === '/api/node-admin/me') return reply(200, { role: null });
        return reply(404, { error: 'Not Found' });
    };
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
        for (const sc of SCREENS) for (const lang of LANGS) {
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
            await context.route(`${origin}/api/**`, answerFor(sc));
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (e) => pageErrors.push(e.message));
            try {
                await page.goto(`${origin}/e2e/words-w4-screens/index.html?screen=${sc.screen ?? sc.name}&lang=${encodeURIComponent(lang)}`, { waitUntil: 'load' });
                await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
                await page.waitForSelector(sc.ready, { timeout: 20_000 });
                await page.waitForTimeout(300);
                if (sc.act) await sc.act(page, lang);
                await page.waitForTimeout(300);
                const m = await page.evaluate(measure, [lang === 'xx']);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${lang}.png`) });
                if (m.scrollWidth > m.width) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px): ${(m.widest ?? []).join('; ')}`);
                for (const p of m.past) failures.push(`${run}: past the edge: ${p}`);
                for (const c of m.clipped) failures.push(`${run}: clipped: ${c}`);
                for (const n of m.notes) notes.push(`${run}: a field's placeholder is cut at its end: ${n}`);
                if (m.measured === 0) failures.push(`${run}: nothing with words was measured`);
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
    console.log(`words-w4-screens-check: ok — ${SCREENS.length} screens in ${LANGS.join(', ')} at 320 px, 1.3× text: nothing overflows`);
}

main().catch((e) => { console.error(e); process.exit(1); });
