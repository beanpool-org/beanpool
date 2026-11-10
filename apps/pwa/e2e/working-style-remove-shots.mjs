/**
 * Remove my working style on the web's three cards (DESIGN-archetype-across-fable.md §3, S3) at 320 px with 1.3× text, in a
 * real browser, in the light and the dark scheme: the profile editor (ProfilePage), your own profile (PublicProfilePage) and
 * Settings, each drawn by the app's own components and stylesheet (e2e/words-w3-screens: Vite's dev server) with /api
 * answered here. Fails on: the page scrolling sideways; the Remove button missing, under 44 px tall, or its words under 4.5:1
 * against the card behind them. Nothing here talks to a node.
 *
 * Run: pnpm --filter @beanpool/pwa exec node e2e/working-style-remove-shots.mjs [out-dir]
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, getComputedStyle */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = process.argv[2] || path.join(process.env.TMPDIR || os.tmpdir(), 'bp-working-style-remove');
const ME = 'me-pk-0000000000000000000000000000';
const SCALE = 1.3;
const SCREENS = [
    { name: 'profile-edit', ready: '[aria-label="Retake community working style quiz"]' },
    { name: 'profile-self', ready: '[aria-label="Retake community working style quiz"]' },
    { name: 'settings', ready: '[aria-label="Retake community working style quiz"]' },
];
const mine = { publicKey: ME, callsign: 'Alice', avatar: null, bio: 'Bakes on Fridays', role: 'member', joinedAt: '2026-01-01T00:00:00Z', contact: null,
    archetype: JSON.stringify({ primary: 'weaver', secondary: 'sage', mode: 'quick', takenOn: '2026-11-02' }) };

function answer(route) {
    const p = new URL(route.request().url()).pathname;
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p.startsWith('/api/profile/')) return reply(200, mine);
    if (p === '/api/community/info') return reply(200, { memberCount: 14, postCount: 30, transactionCount: 9, commonsBalance_c: 64000, profile: 'local', features: { beans: true } });
    if (p.startsWith('/api/community/membership/')) return reply(200, { isMember: true });
    if (p.startsWith('/api/marketplace/posts')) return reply(200, []);
    if (p.startsWith('/api/ratings/')) return reply(200, { average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 }, ratings: [] });
    return reply(404, { error: 'Not Found' });
}

/** In the page: the button's box, and its words' contrast against the first background behind them. */
function measure() {
    const el = document.querySelector('button[aria-label="Remove my working style"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const box = el.getBoundingClientRect();
    const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (css) => (css.match(/[\d.]+/g) || []).map(Number);
    const ink = parse(getComputedStyle(el).color);
    let node = el;
    let bg = [0, 0, 0, 0];
    while (node && !(bg.length === 3 || bg[3] > 0)) { bg = parse(getComputedStyle(node).backgroundColor); node = node.parentElement; }
    const hi = Math.max(lum(ink), lum(bg));
    const lo = Math.min(lum(ink), lum(bg));
    return {
        height: box.height, right: box.right, left: box.left, text: el.textContent.trim(), contrast: (hi + 0.05) / (lo + 0.05),
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), width: window.innerWidth,
    };
}

const server = await createServer({ root: PWA_DIR, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch();
const failures = [];
fs.mkdirSync(SHOTS_DIR, { recursive: true });
try {
    for (const theme of ['light', 'dark']) for (const sc of SCREENS) {
        const run = `${sc.name} ${theme}`;
        const context = await browser.newContext({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce', colorScheme: theme });
        await context.addInitScript(([scale, mode]) => {
            localStorage.setItem('beanpool-theme-mode', mode);
            // Dark as the app sets it (lib/useTheme.ts): html.dark.dark-theme.
            const dress = () => { if (mode === 'dark') { document.documentElement.classList.add('dark', 'dark-theme'); document.documentElement.style.colorScheme = 'dark'; } };
            dress();
            document.addEventListener('DOMContentLoaded', () => {
                dress();
                const s = document.createElement('style');
                s.textContent = `html { font-size: ${scale * 100}% !important; }`;
                document.head.appendChild(s);
            });
        }, [SCALE, theme]);
        await context.route((url) => url.origin !== origin, (route) => route.abort());
        await context.route(`${origin}/api/**`, answer);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        try {
            await page.goto(`${origin}/e2e/words-w3-screens/index.html?screen=${sc.name}&lang=en`, { waitUntil: 'load' });
            await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
            await page.waitForSelector(sc.ready, { timeout: 20_000 });
            if (theme === 'dark') await page.evaluate(() => { document.documentElement.classList.add('dark', 'dark-theme'); document.documentElement.style.colorScheme = 'dark'; });
            await page.waitForTimeout(400);
            if (theme === 'dark' && !(await page.evaluate(() => document.documentElement.classList.contains('dark-theme')))) { failures.push(`${run}: the page did not stay dark`); continue; }
            const m = await page.evaluate(measure);
            await page.waitForTimeout(200);
            await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${theme}.png`) });
            if (!m) { failures.push(`${run}: the card has no Remove my working style button`); continue; }
            if (m.height < 44) failures.push(`${run}: the button is ${Math.round(m.height)} px tall, under 44`);
            if (m.contrast < 4.5) failures.push(`${run}: its words are ${m.contrast.toFixed(2)}:1 against the card, under 4.5`);
            if (m.scrollWidth > m.width) failures.push(`${run}: the page scrolls sideways (${m.scrollWidth}px in ${m.width}px)`);
            if (m.right > m.width + 0.5 || m.left < -0.5) failures.push(`${run}: the button runs past the edge (${Math.round(m.left)}–${Math.round(m.right)})`);
            console.log(`${run}: "${m.text}" ${Math.round(m.height)} px tall, contrast ${m.contrast.toFixed(2)}:1`);
        } catch (e) {
            failures.push(`${run}: ${e.message.split('\n')[0]}${errors.length ? ` (page: ${errors.slice(0, 2).join(' | ').slice(0, 300)})` : ''}`);
            await page.screenshot({ path: path.join(SHOTS_DIR, `${sc.name}-${theme}-error.png`) }).catch(() => {});
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(`screenshots: ${SHOTS_DIR}`);
if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
}
console.log('working-style-remove-shots: ok — three cards, both schemes, at 320 px with 1.3× text.');
