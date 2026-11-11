#!/usr/bin/env node
/**
 * Slice Y0's screens at 320 px with 1.3x text, light and dark (global-yes-y0-harness.tsx): the waiting page for a restored
 * account, its yes, the name asked on the yes, How it works with the line in the Safety Backup's place, and global's yes
 * card. Fails on any sideways scroll, and on a primary control under 48 px tall.
 *
 * Run: node apps/pwa/e2e/global-yes-y0-shots.mjs [--shots <dir>]
 */
/* global document, console, process */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const shotsAt = process.argv.indexOf('--shots');
const SHOTS_DIR = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : path.join(os.tmpdir(), 'bp-global-yes-y0-shots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const problems = [];

async function shot(page, name, theme) {
    await page.waitForTimeout(300);
    const width = await page.evaluate(() => document.scrollingElement.scrollWidth);
    if (width > 320) problems.push(`${name} ${theme}: scrolls sideways (${width}px)`);
    const out = path.join(SHOTS_DIR, `y0-${name}-320-x1.3-${theme}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`${name} ${theme}: width ${width} → ${out}`);
}

async function tall(page, selector, name) {
    const h = await page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().height);
    if (h < 48) problems.push(`${name}: ${selector} is ${h}px tall`);
}

try {
    for (const theme of ['light', 'dark']) {
        for (const view of ['waiting', 'yes', 'name', 'card']) {
            const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, deviceScaleFactor: 2 });
            const page = await ctx.newPage();
            page.on('pageerror', (e) => problems.push(`${view} ${theme}: page error ${e.message}`));
            await page.goto(`${origin}/e2e/global-yes-y0-harness.html?view=${view}${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
            await page.addStyleTag({ content: 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; }' });
            if (view === 'waiting') {
                await page.getByText('You asked to join Byron Shire BeanPool.').waitFor();
                await shot(page, 'waiting', theme);
            } else if (view === 'yes') {
                await page.getByTestId('knock-waiting-join').waitFor();
                await tall(page, '[data-testid="knock-waiting-join"]', `yes ${theme}`);
                await shot(page, 'yes', theme);
            } else if (view === 'name') {
                await page.getByLabel('Your name here').waitFor();
                await tall(page, '[data-testid="knock-join-name-go"]', `name ${theme}`);
                await shot(page, 'name', theme);
                await page.getByLabel('Your name here').fill('CJ');
                await page.getByTestId('knock-join-name-go').click();
                await page.getByTitle('Green Bean').click();
                await shot(page, 'photo', theme);
                await page.getByRole('button', { name: 'Next →' }).click();
                await page.getByTestId('tour-words-kept').waitFor();
                if (await page.getByTestId('backup-words').count()) problems.push(`tour ${theme}: the 12 words were shown`);
                await shot(page, 'tour', theme);
            } else {
                await page.getByTestId('card').waitFor();
                await tall(page, '[data-testid="card"] a', `card ${theme}`);
                await shot(page, 'card', theme);
            }
            await ctx.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log('global-yes-y0-shots: ok');
