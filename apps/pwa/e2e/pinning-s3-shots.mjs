#!/usr/bin/env node
/**
 * pinning-s3 evidence screenshots (scratch/fable-design/DESIGN-pinning-fable.md):
 * Captures real browser screenshots of the web app at:
 *   - 320 px (130% text scale)
 *   - 768 px
 *   - 1280 px
 *   - 1600 px
 * In both light and dark themes, before and after pinning:
 *   - before: unpinned Market feed
 *   - after-feed: the pin as the grid's first cell, with its "📌 PINNED" chip (no Pinned heading in the grid)
 *   - after-detail: Pinned post detail line and "Take the pin off" button
 *   - after-sheet: PinSheet dialog with 1d/3d/7d duration options
 *
 * Computes MD5 checksums for the PR body. Screenshots are saved to scratch/pinning-s3-evidence (not committed).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer, launch, settle, TEXT_SCALE_CSS } from './harness.mjs';
import { POSTS, IDENTITY, mockResponse } from './fixtures.mjs';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = path.resolve(PWA_DIR, '../..');
const OUT_DIR = path.join(ROOT_DIR, 'scratch', 'pinning-s3-evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

const NOW = Date.now();
const FUTURE_3D = new Date(NOW + 3 * 86_400_000).toISOString();

// Prepare unpinned posts (before)
const unpinnedPosts = POSTS.map(p => ({
    ...p,
    pinnedUntil: null,
    pinnedAt: null,
}));

// Prepare pinned posts (after) - pin the first post
const pinnedPosts = POSTS.map((p, idx) => {
    if (idx === 0) {
        return {
            ...p,
            pinnedUntil: FUTURE_3D,
            pinnedAt: new Date(NOW - 3600_000).toISOString(),
        };
    }
    return {
        ...p,
        pinnedUntil: null,
        pinnedAt: null,
    };
});

const VIEWPORTS = [
    { name: '320px-x1.3', width: 320, height: 850, textScale: 1.3 },
    { name: '768px', width: 768, height: 900, textScale: 1.0 },
    { name: '1280px', width: 1280, height: 900, textScale: 1.0 },
    { name: '1600px', width: 1600, height: 900, textScale: 1.0 },
];

const THEMES = ['light', 'dark'];

async function openPage(browser, origin, { width, height, dark, textScale, posts }) {
    const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: dark ? 'dark' : 'light',
        reducedMotion: 'reduce',
    });

    await context.addInitScript(([mode]) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
        } catch {}
    }, [dark ? 'dark' : 'light']);

    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/community/info') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ profile: 'local', features: { beans: true, pins: true } }),
            });
        }
        if (url.pathname === '/api/community/me') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ publicKey: IDENTITY.publicKey, role: 'owner' }),
            });
        }
        if (url.pathname === '/api/node-admin/me') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ role: 'owner' }),
            });
        }
        if (url.pathname.startsWith('/api/marketplace/posts/') && url.pathname.endsWith('/pin')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        }
        if (url.pathname.startsWith('/api/marketplace/posts/') && url.pathname.endsWith('/unpin')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        }

        const body = mockResponse(url.pathname, url.search, posts);
        if (body === undefined) {
            return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not Found' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    await context.route('**/ws**', (route) => route.abort());

    const page = await context.newPage();
    await page.goto(`${origin}/e2e/harness.html`, { waitUntil: 'load' });
    if (textScale !== 1) {
        await page.addStyleTag({ content: TEXT_SCALE_CSS(textScale) });
    }

    await page.waitForSelector('text=Chainsaw, sharpened', { timeout: 20_000 });
    await settle(page);
    return { context, page };
}

function md5File(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
}

async function main() {
    console.log('Building harness and starting preview server...');
    const server = await startServer();
    console.log(`Server started at ${server.origin}`);
    const browser = await launch();

    const results = [];

    try {
        for (const vp of VIEWPORTS) {
            for (const theme of THEMES) {
                const dark = theme === 'dark';

                // 1. BEFORE: Unpinned Market feed
                {
                    const { context, page } = await openPage(browser, server.origin, {
                        width: vp.width,
                        height: vp.height,
                        dark,
                        textScale: vp.textScale,
                        posts: unpinnedPosts,
                    });
                    const filename = `before-feed-${vp.name}-${theme}.png`;
                    const filePath = path.join(OUT_DIR, filename);
                    await page.screenshot({ path: filePath });
                    results.push({ name: filename, path: filePath });
                    await context.close();
                }

                // 2. AFTER: Pinned Market feed (the grid has no Pinned block: the pin is its first cell, with its chip)
                {
                    const { context, page } = await openPage(browser, server.origin, {
                        width: vp.width,
                        height: vp.height,
                        dark,
                        textScale: vp.textScale,
                        posts: pinnedPosts,
                    });
                    await page.waitForSelector('[data-testid="market-pinned-tile"]', { timeout: 10_000 });
                    await settle(page);

                    const filename = `after-feed-${vp.name}-${theme}.png`;
                    const filePath = path.join(OUT_DIR, filename);
                    await page.screenshot({ path: filePath });
                    results.push({ name: filename, path: filePath });
                    await context.close();
                }

                // 3. AFTER: Pinned post detail (banner line + Take the pin off button)
                {
                    const { context, page } = await openPage(browser, server.origin, {
                        width: vp.width,
                        height: vp.height,
                        dark,
                        textScale: vp.textScale,
                        posts: pinnedPosts,
                    });
                    // Click on the pinned post to open detail view
                    const card = page.locator('text=Chainsaw, sharpened').first();
                    await card.click();
                    await page.waitForSelector('[data-testid="post-pinned-detail-banner"]', { timeout: 10_000 });
                    await settle(page);

                    const filename = `after-detail-${vp.name}-${theme}.png`;
                    const filePath = path.join(OUT_DIR, filename);
                    await page.screenshot({ path: filePath });
                    results.push({ name: filename, path: filePath });
                    await context.close();
                }

                // 4. AFTER: PinSheet dialog open
                {
                    const { context, page } = await openPage(browser, server.origin, {
                        width: vp.width,
                        height: vp.height,
                        dark,
                        textScale: vp.textScale,
                        posts: unpinnedPosts,
                    });
                    // Open detail of an unpinned post
                    const card = page.locator('text=Chainsaw, sharpened').first();
                    await card.click();
                    await page.waitForSelector('[data-testid="post-menu-trigger"]', { timeout: 10_000 });

                    // Open "··· Options" menu
                    await page.click('[data-testid="post-menu-trigger"]');
                    await page.waitForSelector('[data-testid="menu-pin-post"]', { timeout: 5000 });

                    // Click "Pin to the top…"
                    await page.click('[data-testid="menu-pin-post"]');
                    await page.waitForSelector('[data-testid="pin-sheet-modal"]', { timeout: 5000 });
                    await settle(page);

                    const filename = `after-sheet-${vp.name}-${theme}.png`;
                    const filePath = path.join(OUT_DIR, filename);
                    await page.screenshot({ path: filePath });
                    results.push({ name: filename, path: filePath });
                    await context.close();
                }

                console.log(`Completed shots for ${vp.name} (${theme})`);
            }
        }

        console.log('\n--- EVIDENCE CHECKSUMS (MD5) ---');
        console.log('| File | Viewport | Theme | State | MD5 Checksum |');
        console.log('|---|---|---|---|---|');
        for (const item of results) {
            const md5 = md5File(item.path);
            const [state, vp, themeWithExt] = item.name.split('-');
            const theme = themeWithExt.replace('.png', '');
            console.log(`| \`${item.name}\` | ${vp} | ${theme} | ${state} | \`${md5}\` |`);
        }
        console.log('--------------------------------\n');
    } finally {
        await browser.close();
        await server.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
