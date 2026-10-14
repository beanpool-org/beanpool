/**
 * The first screens in other languages at 320 px with 1.3× text, light and dark (translation slice S2; director
 * amendment 1 item 7): the welcome page on a local community, and the guest lobby's Home on the worldwide one (HomePage
 * as a visitor sees it), each opened with `?lang=` in the pseudo-locale `xx` (every sentence accented and padded
 * ~35 %), Russian, French and Simplified Chinese.
 *
 * Builds the web app as it ships and serves it under the app document's Content-Security-Policy; /api is answered here,
 * every other host is refused. For each screen it fails on:
 *   - the page scrolling sideways;
 *   - any element with words in it reaching past either edge of the screen (outside a box that scrolls sideways);
 *   - any words clipped by their own box (overflow hidden or clip, and more text than fits);
 *   - `<html lang>` not the language opened, or `dir` not ltr;
 *   - the language switch missing from the top of the screen, or not naming the language.
 * In `xx` it also lists the text a member reads that is not padded: words that did not come through t() (a later
 * slice's, or a member's own); a list, not a failure.
 *
 * Nothing here talks to a node.
 *
 * Run: pnpm --filter @beanpool/pwa words-screens-check [out-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global Buffer, URL, console, process, document, window, getComputedStyle, Node, NodeFilter -- Node, and the page's side of evaluate() */
import { build, preview, transformWithEsbuild } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_SOURCE = path.resolve(PWA_DIR, '../server/src/app-document-csp.ts');
process.chdir(PWA_DIR);

const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-screens');
const LANGS = [
    { lang: 'xx', html: 'en-XA', name: 'English' },
    { lang: 'ru', html: 'ru', name: 'Русский' },
    { lang: 'fr', html: 'fr', name: 'Français' },
    { lang: 'zh-Hans', html: 'zh-Hans', name: '简体中文' },
];
const VIEW = { viewport: { width: 320, height: 568 }, textScale: 1.3 };

const LOCAL_INFO = { memberCount: 40, postCount: 4, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };
const GLOBAL_INFO = { memberCount: 40, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
const SCREENS = [
    { name: 'welcome', info: LOCAL_INFO, ready: 'h2' },
    { name: 'lobby-home', info: GLOBAL_INFO, ready: '[data-testid="guest-lobby"]' },
];

async function loadPolicy() {
    const source = fs.readFileSync(POLICY_SOURCE, 'utf8');
    const { code } = await transformWithEsbuild(source, POLICY_SOURCE, { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** In the page: what overflows, what is clipped, and (for xx) the text that is not padded. */
function measure() {
    const W = window.innerWidth;
    const out = { scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: W, past: [], clipped: [], unpadded: [] };
    const scrollsSideways = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const ox = getComputedStyle(p).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
    };
    const label = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} "${(el.textContent || '').trim().slice(0, 60)}"`;
    for (const el of document.body.querySelectorAll('*')) {
        const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (!ownText) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if ((r.right > W + 0.5 || r.left < -0.5) && !scrollsSideways(el)) out.past.push(`${label(el)} spans ${Math.round(r.left)}–${Math.round(r.right)} px`);
        const clips = (v) => v === 'hidden' || v === 'clip';
        if ((clips(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (clips(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && cs.webkitLineClamp === 'none')) {
            out.clipped.push(`${label(el)} needs ${el.scrollWidth}×${el.scrollHeight} in ${el.clientWidth}×${el.clientHeight}`);
        }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.trim();
        if (!/[A-Za-z]{2}/.test(text)) continue;
        const el = n.parentElement;
        if (!el || el.closest('select, option, script, style, [aria-hidden="true"]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (!/[[\]~]/.test(text) && !el.closest('[translate="no"]')) out.unpadded.push(text.slice(0, 80));
    }
    out.html = { lang: document.documentElement.lang, dir: document.documentElement.dir };
    const sw = document.querySelector('[data-testid="language-switch"]');
    out.switch = sw ? { text: sw.textContent, top: Math.round(sw.getBoundingClientRect().top) } : null;
    return out;
}

async function main() {
    const policy = await loadPolicy();
    const outDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bp-words-screens-build-'));
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    let server;
    let browser;
    const failures = [];
    const lists = [];
    try {
        await build({ root: PWA_DIR, logLevel: 'error', build: { outDir, emptyOutDir: true } });
        server = await preview({
            configFile: false, root: PWA_DIR, build: { outDir }, logLevel: 'warn',
            preview: { port: 0, open: false, headers: { 'Content-Security-Policy': policy.APP_DOCUMENT_CSP, 'Referrer-Policy': policy.APP_DOCUMENT_REFERRER_POLICY } },
        });
        const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
        browser = await chromium.launch();
        for (const screen of SCREENS) for (const { lang, html, name } of LANGS) for (const theme of ['light', 'dark']) {
            const run = `${screen.name} ${lang} ${theme}`;
            const violations = [];
            const context = await browser.newContext({ viewport: VIEW.viewport, reducedMotion: 'reduce', colorScheme: theme });
            await context.exposeBinding('__reportCspViolation', (_s, v) => { violations.push(v); });
            await context.addInitScript(([scale, dark]) => {
                document.addEventListener('securitypolicyviolation', (e) => {
                    window.__reportCspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI });
                });
                localStorage.setItem('beanpool-theme-default-light-v1', 'done');
                localStorage.setItem('beanpool-theme-mode', dark ? 'dark' : 'light');
                document.addEventListener('DOMContentLoaded', () => {
                    const s = document.createElement('style');
                    s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                    document.head.appendChild(s);
                });
            }, [VIEW.textScale, theme === 'dark']);
            await context.route((url) => url.origin !== origin, (route) => route.abort());
            await context.route(`${origin}/api/**`, (route) => {
                const p = new URL(route.request().url()).pathname;
                const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
                if (p === '/api/community/info') return reply(200, screen.info);
                if (p === '/api/community/health') return reply(200, { status: 'ok', version: '1.2.28' });
                if (p === '/api/marketplace/posts') return reply(200, []);
                if (p === '/api/node/config') return reply(200, { serviceRadius: null });
                if (p === '/api/node/info') return reply(200, { peerNodes: [] });
                if (p === '/api/global/home') return reply(200, { communities: [], counts: { members: 40, communities: 2 } });
                return reply(404, { error: 'Not Found' });
            });
            const page = await context.newPage();
            try {
                await page.goto(`${origin}/?lang=${encodeURIComponent(lang)}`, { waitUntil: 'networkidle' });
                await page.waitForSelector(screen.ready, { timeout: 15_000 });
                await page.waitForTimeout(400);
                const m = await page.evaluate(measure);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${screen.name}-${lang}-${theme}.png`), fullPage: true });
                if (m.scrollWidth > m.width) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px)`);
                for (const p of m.past) failures.push(`${run}: past the edge: ${p}`);
                for (const c of m.clipped) failures.push(`${run}: clipped: ${c}`);
                if (m.html.lang !== html) failures.push(`${run}: <html lang="${m.html.lang}">, expected ${html}`);
                if (m.html.dir !== 'ltr') failures.push(`${run}: <html dir="${m.html.dir}">, expected ltr`);
                if (!m.switch) failures.push(`${run}: no language switch`);
                else {
                    if (!m.switch.text.includes(name)) failures.push(`${run}: the switch says "${m.switch.text}", not ${name}`);
                    if (m.switch.top > 200) failures.push(`${run}: the switch is ${m.switch.top}px down, not at the top`);
                }
                if (violations.length) failures.push(`${run}: ${violations.length} policy violation(s): ${JSON.stringify(violations[0])}`);
                if (lang === 'xx' && theme === 'light') lists.push(`${screen.name}: ${m.unpadded.length} text(s) not through t(): ${JSON.stringify([...new Set(m.unpadded)])}`);
                console.log(`${run}: ${m.past.length + m.clipped.length + (m.scrollWidth > m.width ? 1 : 0)} overflow(s)`);
            } catch (e) {
                failures.push(`${run}: ${e.message}`);
                await page.screenshot({ path: path.join(SHOTS_DIR, `${screen.name}-${lang}-${theme}-error.png`), fullPage: true }).catch(() => {});
            }
            await context.close();
        }
    } finally {
        await browser?.close();
        await new Promise((r) => (server ? server.httpServer.close(r) : r()));
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    for (const l of lists) console.log(`xx: ${l}`);
    console.log(`screenshots: ${SHOTS_DIR}`);
    if (failures.length) {
        for (const f of failures) console.log(`FAIL ${f}`);
        process.exit(1);
    }
    console.log(`words-screens-check: ok — ${SCREENS.length} screens × ${LANGS.length} languages × light and dark at 320 px, 1.3× text: nothing overflows`);
}

main().catch((e) => { console.error(e); process.exit(1); });
