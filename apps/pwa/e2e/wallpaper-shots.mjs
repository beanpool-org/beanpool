/**
 * The doodle wallpaper behind the main screens (Marty, 14 Oct 2026: "missing doodle bg" on the Commons, dark mode).
 * Builds e2e/wallpaper-harness.html with Vite, opens Home, Market and the Commons in headless Chromium at 1280×800 and
 * at 320 px with 1.3x text, light and dark, with the wallpaper on and with Settings → "Plain background", and for each:
 *
 *   - a picture (WALLPAPER_OUT, e2e/screenshots/wallpaper by default);
 *   - how much of the screen shows the wallpaper: a point every 16 px, and at each one the layers under it from the top
 *     down, until one is opaque (a fill at 95% or more, or a picture/gradient of its own) or #root's wallpaper is reached;
 *   - every opaque, square-cornered layer at least 90% of the screen wide (a full-width ground over the wallpaper), by
 *     tag and class. A rounded card that spans a phone is a card, not a ground.
 *
 * With the wallpaper on, a screen fails if anything paints a full-width opaque ground. With "Plain background" the
 * wallpaper is off and nothing is judged; the pictures show the flat colour.
 *
 * Every /api request is answered from fixtures.mjs (and the few Commons routes below); nothing talks to a real node.
 *
 * Run:  node e2e/wallpaper-shots.mjs   (from apps/pwa; WALLPAPER_ONLY=commons limits the screens)
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, getComputedStyle, window -- Node, and the page's side of evaluate() */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR); // Tailwind and PostCSS read their config from here
const OUT = path.resolve(process.env.WALLPAPER_OUT || path.join(PWA_DIR, 'e2e', 'screenshots', 'wallpaper'));
const SCREENS = (process.env.WALLPAPER_ONLY || 'home,market,commons').split(',');

/** As harness.mjs: the root font to 130% and the pixel text sizes with it. */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map(px => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

function answer(pathname, search) {
    if (pathname === '/api/commons/decisions') {
        return { decisions: [], myPoolVoting: { voiceCredits: 12, hasCompletedTrade: true }, canPropose: true };
    }
    return mockResponse(pathname, search);
}

async function startServer() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-wallpaper-'));
    await build({
        configFile: false, root: PWA_DIR, plugins: [react()], logLevel: 'warn',
        define: { __APP_VERSION__: JSON.stringify('harness') },
        build: { outDir, emptyOutDir: true, rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'wallpaper-harness.html') } },
    });
    const server = await preview({ configFile: false, root: PWA_DIR, preview: { port: 0, open: false }, build: { outDir }, logLevel: 'warn' });
    return {
        origin: server.resolvedUrls.local[0].replace(/\/$/, ''),
        close: async () => { await new Promise(r => server.httpServer.close(r)); fs.rmSync(outDir, { recursive: true, force: true }); },
    };
}

/** In the page: the share of sample points where #root's wallpaper is the first opaque layer, and the full-width grounds. */
function measure() {
    const W = window.innerWidth, H = window.innerHeight, root = document.getElementById('root');
    const alphaOf = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 0; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
    const opaque = (el) => {
        const s = getComputedStyle(el);
        if (el !== root && s.backgroundImage !== 'none') return true;
        return alphaOf(s.backgroundColor) * Number(s.opacity) >= 0.95;
    };
    let visible = 0, total = 0;
    const grounds = new Map();
    for (let y = 8; y < H; y += 16) {
        for (let x = 8; x < W; x += 16) {
            total++;
            for (const el of document.elementsFromPoint(x, y)) {
                if (el === root) { visible++; break; }
                if (!opaque(el)) continue;
                const r = el.getBoundingClientRect();
                // A ground is square-cornered: a rounded card as wide as a phone is still a card with its own fill.
                if (r.width >= 0.9 * W && parseFloat(getComputedStyle(el).borderTopLeftRadius) === 0) {
                    const key = `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`;
                    grounds.set(key, { key, bg: getComputedStyle(el).backgroundColor, height: Math.round(r.height) });
                }
                break;
            }
        }
    }
    return { wallpaperPct: Math.round((visible / total) * 1000) / 10, grounds: [...grounds.values()] };
}

const VIEWS = [
    { name: '1280x800', width: 1280, height: 800, textScale: 1 },
    { name: '320x640-130pct', width: 320, height: 640, textScale: 1.3 },
];

fs.mkdirSync(OUT, { recursive: true });
const server = await startServer();
const browser = await chromium.launch();
const rows = [];
let failed = 0;
try {
    for (const screen of SCREENS) {
        for (const view of VIEWS) {
            for (const dark of [false, true]) {
                for (const plain of [false, true]) {
                    const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce' });
                    await context.addInitScript(([mode]) => {
                        try { localStorage.setItem('beanpool-theme-mode', mode); localStorage.setItem('beanpool-theme-default-light-v1', 'done'); } catch { /* the default theme */ }
                    }, [dark ? 'dark' : 'light']);
                    await context.route('**/api/**', async (route) => {
                        const url = new URL(route.request().url());
                        const body = answer(url.pathname, url.search);
                        return body === undefined
                            ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not Found"}' })
                            : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
                    });
                    await context.route('**/ws**', (route) => route.abort());
                    const page = await context.newPage();
                    await page.goto(`${server.origin}/e2e/wallpaper-harness.html?screen=${screen}${plain ? '&plain=1' : ''}`, { waitUntil: 'load' });
                    if (view.textScale !== 1) await page.addStyleTag({ content: TEXT_SCALE_CSS(view.textScale) });
                    await page.waitForLoadState('networkidle').catch(() => {});
                    await page.evaluate(() => document.fonts?.ready).catch(() => {});
                    await page.waitForTimeout(600);
                    const name = `${screen}-${view.name}-${dark ? 'dark' : 'light'}${plain ? '-plain' : ''}`;
                    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
                    const m = await page.evaluate(measure);
                    const bad = !plain && m.grounds.length > 0;
                    if (bad) failed++;
                    rows.push({ name, ...m, bad });
                    console.log(`${bad ? 'FAIL' : 'ok  '} ${name.padEnd(40)} wallpaper ${String(m.wallpaperPct).padStart(5)}%${m.grounds.length ? '  full-width grounds: ' + m.grounds.map(g => `${g.key} (${g.bg}, ${g.height}px)`).join('; ') : ''}`);
                    await context.close();
                }
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
fs.writeFileSync(path.join(OUT, 'wallpaper.json'), JSON.stringify(rows, null, 2));
console.log(`\n${rows.length} pictures in ${OUT}; ${failed} with a full-width ground over the wallpaper`);
process.exit(failed ? 1 : 0);
