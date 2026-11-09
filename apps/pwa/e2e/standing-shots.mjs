#!/usr/bin/env node
/**
 * Standing deals S2 shots and checks: the take-up screen and each phase's panel (standing-harness.tsx), at 320 px with 1.3x
 * text, light and dark, in English and Spanish. No node is contacted. Each shot is at most 900 px tall.
 *
 *   node apps/pwa/e2e/standing-shots.mjs [<out dir>]     (default: scratch/screenshots/standing-s2)
 *
 * Fails (exit 1) when anything is wider than the 320 px page, or a button's words are cut (content wider than its box).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT = path.resolve(process.argv[2] || path.join(PWA_DIR, '../..', 'scratch', 'screenshots', 'standing-s2'));
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
let failures = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); failures++; };

try {
    for (const view of ['take-up', 'panels', 'short']) {
        for (const theme of ['light', 'dark']) {
            for (const lang of ['en', 'es']) {
                const label = `${view} ${theme} ${lang}`;
                const ctx = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
                const page = await ctx.newPage();
                await page.goto(`${origin}/e2e/standing-harness.html?view=${view}&lang=${lang}${theme === 'dark' ? '&dark=1' : ''}`);
                await page.addStyleTag({ content: 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; animation: none !important; }' });
                await page.waitForSelector('[data-testid="shot"] button');
                await page.waitForTimeout(150);
                const wide = await page.evaluate(() => document.documentElement.scrollWidth);
                if (wide > 320) fail(`${label}: the page is ${wide} px wide`);
                const cut = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.textContent));
                if (cut.length) fail(`${label}: cut button words ${JSON.stringify(cut)}`);
                const box = await page.locator('[data-testid="shot"]').boundingBox();
                const out = path.join(OUT, `${view}-${theme}-${lang}.png`);
                await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 320, height: Math.min(900, Math.ceil(box.height)) }, fullPage: true });
                console.log(`✓ ${label}: ${wide} px wide → ${path.basename(out)} (320×${Math.min(900, Math.ceil(box.height))})`);
                await ctx.close();
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
