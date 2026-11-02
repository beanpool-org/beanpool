#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch, openMarket, settle } from './harness.mjs';
import { POSTS } from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'screenshots', 'fresh-banner');
fs.mkdirSync(outDir, { recursive: true });

// Make sure posts have createdAt set to earlier today so freshTodayCount > 0
const now = new Date();
const freshPosts = POSTS.map((p, i) => ({
    ...p,
    createdAt: new Date(now.getTime() - (i + 1) * 60 * 1000).toISOString(),
}));

async function run() {
    const server = await startServer();
    const browser = await launch();

    try {
        const configs = [
            { name: 'fresh-banner-320-x1.3-light.png', width: 320, height: 750, textScale: 1.3, dark: false },
            { name: 'fresh-banner-320-x1.3-dark.png', width: 320, height: 750, textScale: 1.3, dark: true },
            { name: 'fresh-banner-1280-light.png', width: 1280, height: 800, textScale: 1.0, dark: false },
            { name: 'fresh-banner-1280-dark.png', width: 1280, height: 800, textScale: 1.0, dark: true },
        ];

        for (const cfg of configs) {
            const { context, page } = await openMarket(browser, server.origin, {
                width: cfg.width,
                height: cfg.height,
                dark: cfg.dark,
                textScale: cfg.textScale,
                posts: freshPosts,
            });

            const banner = page.locator('button:has-text("Tap to dismiss • Scroll down to explore")');
            await banner.waitFor({ state: 'visible', timeout: 10000 });
            await settle(page);

            const filePath = path.join(outDir, cfg.name);
            await page.screenshot({ path: filePath, fullPage: false });
            console.log(`Saved screenshot: ${filePath}`);
            await context.close();
        }

        // Take a screenshot showing visible keyboard focus ring
        {
            const { context, page } = await openMarket(browser, server.origin, {
                width: 320,
                height: 750,
                dark: false,
                textScale: 1.3,
                posts: freshPosts,
            });
            const banner = page.locator('button:has-text("Tap to dismiss • Scroll down to explore")');
            await banner.waitFor({ state: 'visible', timeout: 10000 });
            await banner.focus();
            await settle(page);
            const focusPath = path.join(outDir, 'fresh-banner-320-x1.3-focused.png');
            await page.screenshot({ path: focusPath });
            console.log(`Saved screenshot: ${focusPath}`);
            await context.close();
        }
    } finally {
        await browser.close();
        await server.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
