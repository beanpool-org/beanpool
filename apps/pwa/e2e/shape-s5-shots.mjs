#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);

const REPO_ROOT = path.resolve(PWA_DIR, '../..');
const SHOTS_DIR = path.join(REPO_ROOT, 'scratch', 'fable-design', 'community-shape-s5-shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();

const TEXT_SCALE = 1.3;

for (const theme of ['light', 'dark']) {
    // 1. Home summary line
    {
        const ctx = await browser.newContext({
            viewport: { width: 320, height: 400 },
            colorScheme: theme,
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`${origin}/e2e/shape-s5-shots-harness.html?view=card${theme === 'dark' ? '&dark=1' : ''}`, {
            waitUntil: 'networkidle',
        });
        await page.addStyleTag({
            content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);

        const outPath = path.join(SHOTS_DIR, `home-summary-line-${theme}.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`Saved screenshot: ${outPath}`);
        await ctx.close();
    }

    // 2. Settings row
    {
        const ctx = await browser.newContext({
            viewport: { width: 320, height: 400 },
            colorScheme: theme,
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`${origin}/e2e/shape-s5-shots-harness.html?view=settings${theme === 'dark' ? '&dark=1' : ''}`, {
            waitUntil: 'networkidle',
        });
        await page.addStyleTag({
            content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);

        const outPath = path.join(SHOTS_DIR, `settings-row-${theme}.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`Saved screenshot: ${outPath}`);
        await ctx.close();
    }

    // 3. Modal overview
    {
        const ctx = await browser.newContext({
            viewport: { width: 320, height: 800 },
            colorScheme: theme,
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`${origin}/e2e/shape-s5-shots-harness.html?view=modal${theme === 'dark' ? '&dark=1' : ''}`, {
            waitUntil: 'networkidle',
        });
        await page.addStyleTag({
            content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);

        const outPath = path.join(SHOTS_DIR, `shape-modal-${theme}.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`Saved screenshot: ${outPath}`);
        await ctx.close();
    }
}

await browser.close();
await server.close();
console.log('Screenshots complete.');
