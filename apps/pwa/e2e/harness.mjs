/**
 * Builds e2e/harness.html (the Market page on its own) with Vite and opens it in headless Chromium at a chosen
 * width, colour scheme and text size, with every /api request answered from fixtures.mjs. Nothing here talks to
 * a real node, and nothing here writes into apps/server/public — the build goes to a temp folder.
 *
 * Used by market-grid-shots.mjs (the PR's pictures).
 *
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Tailwind and PostCSS read their config from the working directory.
process.chdir(PWA_DIR);

/**
 * Android's "font size" setting scales text, not layout. Chromium has no such switch, so this approximates it the
 * way apps/manager/e2e does: the root font size goes to 130% (every rem-based Tailwind size follows, padding
 * included, which is harsher than a phone), and the arbitrary pixel sizes the cards use are scaled to match.
 */
const TEXT_SCALE_CSS = (scale) => `
html { font-size: ${scale * 100}% !important; }
${[8, 9, 10, 11, 12, 13, 14, 15, 16].map(px => `.text-\\[${px}px\\] { font-size: ${px * scale}px !important; }`).join('\n')}
`;

/** A production build of the harness page, in a temp folder, served by Vite's preview server. */
export async function startServer() {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-market-grid-'));
    await build({
        configFile: false,
        root: PWA_DIR,
        plugins: [react()],
        define: { __APP_VERSION__: JSON.stringify('harness') },
        logLevel: 'warn',
        build: {
            outDir,
            emptyOutDir: true,
            rollupOptions: { input: path.join(PWA_DIR, 'e2e', 'harness.html') },
        },
    });
    const server = await preview({
        configFile: false,
        root: PWA_DIR,
        preview: { port: 0, open: false },
        build: { outDir },
        logLevel: 'warn',
    });
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    return {
        origin,
        async close() {
            await new Promise((resolve) => server.httpServer.close(resolve));
            fs.rmSync(outDir, { recursive: true, force: true });
        },
    };
}

export async function launch() {
    return chromium.launch();
}

/**
 * One page showing the Market grid. `width` is the viewport, `dark` picks the theme (both the emulated colour
 * scheme and the stored Settings choice), `textScale` is the 1.3x font setting, and `posts` is the feed to answer
 * with (fixtures.POSTS unless a caller wants the poll somewhere else). Returns once the feed has drawn.
 */
export async function openMarket(browser, origin, { width, height = 1200, dark = false, textScale = 1, posts } = {}) {
    const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: dark ? 'dark' : 'light',
        reducedMotion: 'reduce',
    });

    // The app is LIGHT by default whatever the device is set to (useTheme, #930 and the day after): dark only
    // arrives from a stored Settings choice. So seed the choice itself, exactly as Settings would have written
    // it, rather than relying on the emulated colour scheme — otherwise every "dark" picture comes out light.
    await context.addInitScript(([mode]) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-theme-default-light-v1', 'done');
        } catch { /* a picture of the default theme is still a picture */ }
    }, [dark ? 'dark' : 'light']);

    const unrouted = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const body = mockResponse(url.pathname, url.search, posts);
        if (body === undefined) {
            unrouted.push(url.pathname);
            return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // Nothing in a picture of the grid needs the live socket, and an unanswered one retries noisily.
    await context.route('**/ws**', (route) => route.abort());

    const page = await context.newPage();
    await page.goto(`${origin}/e2e/harness.html`, { waitUntil: 'load' });
    if (textScale !== 1) await page.addStyleTag({ content: TEXT_SCALE_CSS(textScale) });

    // The grid is drawn: wait for the feed rather than a timer.
    await page.waitForSelector('text=Chainsaw, sharpened', { timeout: 20_000 });
    await settle(page);
    return { context, page, unrouted };
}

export async function settle(page) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(350);
}

/** The Card View grid itself — the element the pictures are of. */
export function grid(page) {
    return page.locator('div.grid.grid-cols-1.sm\\:grid-cols-2').first();
}
