#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);

const REPO_ROOT = path.resolve(PWA_DIR, '../..');
// `--shots <dir>` writes there; else the repo's scratch/shots.
const shotsAt = process.argv.indexOf('--shots');
const SHOTS_DIR = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : path.join(REPO_ROOT, 'scratch', 'shots', 'lounge-l1', 'web');
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

// waiting: the Cancel card; none: the community holds nothing (Got it); cancelled: a Cancel that worked, this visit.
for (const state of ['waiting', 'none', 'cancelled']) {
    for (const theme of ['light', 'dark']) {
        const ctx = await browser.newContext({
            viewport: { width: 320, height: 600 },
            colorScheme: theme,
            deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(`${origin}/e2e/lounge-l1-shots-harness.html?state=${state}${theme === 'dark' ? '&dark=1' : ''}`, {
            waitUntil: 'networkidle',
        });
        await page.addStyleTag({
            content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; }`,
        });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        const width = await page.evaluate(() => document.scrollingElement.scrollWidth);
        if (width > 320) throw new Error(`${state} ${theme}: the page scrolls sideways (${width}px)`);

        const outPath = path.join(SHOTS_DIR, `l1-${state}-card-web-320-x1.3-${theme}.png`);
        await page.screenshot({ path: outPath, fullPage: true });
        console.log(`Saved screenshot: ${outPath}`);
        await ctx.close();
    }
}

await browser.close();
await server.close();
