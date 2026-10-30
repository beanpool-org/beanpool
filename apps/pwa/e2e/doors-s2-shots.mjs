#!/usr/bin/env node
/**
 * Front doors S2 shots: the web's Wants to join and Ask to join at 320 px × 1.3 text, light and dark, against the stubs
 * in doors-s2-shots-harness.tsx (no node is contacted). Each shot is the component alone, at most 900 px tall.
 *
 *   node apps/pwa/e2e/doors-s2-shots.mjs [<out dir>]     (default: scratch/screenshots/doors-s2)
 *
 * Also fails (exit 1) when anything is wider than the 320 px page, so a long word or a long name never scrolls sideways.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT = path.resolve(process.argv[2] || path.join(PWA_DIR, '../..', 'scratch', 'screenshots', 'doors-s2'));
fs.mkdirSync(OUT, { recursive: true });

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const TEXT_SCALE = 1.3;
let failures = 0;

async function shot(name, query, theme, act) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 900 }, colorScheme: theme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${origin}/e2e/doors-s2-shots-harness.html?${query}${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; } *, *::before, *::after { transition: none !important; animation: none !important; }` });
    await page.evaluate(() => document.fonts.ready);
    if (act) await act(page);
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    if (wide > 320) { console.error(`✗ ${name} ${theme}: the page is ${wide} px wide at 320`); failures++; }
    const box = await page.getByTestId('shot').boundingBox();
    const clip = { x: 0, y: Math.max(0, box.y - 8), width: 320, height: Math.min(900, box.height + 16) };
    const out = path.join(OUT, `doors-s2-${name}-320-x1.3-${theme}.png`);
    await page.screenshot({ path: out, clip, fullPage: true });
    console.log(`✓ ${out} (${clip.width}×${Math.round(clip.height)})`);
    await ctx.close();
}

const fill = async (page, prefix) => {
    await page.getByTestId(prefix).click();
    await page.getByTestId(`${prefix}-message`).fill('I live in Chewton and grow tomatoes. Happy to help with the garden.');
};

for (const theme of ['light', 'dark']) {
    await shot('wants-list', 'view=wants', theme, page => page.getByTestId('wants-to-join-k1').waitFor());
    await shot('wants-invited', 'view=wants', theme, async page => {
        await page.getByRole('button', { name: 'Invite Riverbend Joe' }).click();
        await page.getByTestId('wants-to-join-done').waitFor();
    });
    await shot('wants-refused', 'view=wants&refuse=1', theme, async page => {
        await page.getByRole('button', { name: 'Invite Riverbend Joe' }).click();
        await page.getByTestId('wants-to-join-note-k1').waitFor();
    });
    await shot('find-rows', 'view=find', theme, page => page.getByTestId('home-find-asked-ask').waitFor());
    await shot('ask-form', 'view=find', theme, async page => {
        await page.getByTestId('home-find-asked-ask').waitFor();
        await fill(page, 'home-find-asked-ask');
    });
    await shot('ask-sent', 'view=find', theme, async page => {
        await page.getByTestId('home-find-asked-ask').waitFor();
        await fill(page, 'home-find-asked-ask');
        await page.getByTestId('home-find-asked-ask-send').click();
        await page.getByTestId('home-find-asked-ask-said').waitFor();
    });
    await shot('ask-refused', 'view=find&refuse=1', theme, async page => {
        await page.getByTestId('home-find-asked-ask').waitFor();
        await fill(page, 'home-find-asked-ask');
        await page.getByTestId('home-find-asked-ask-send').click();
        await page.getByTestId('home-find-asked-ask-problem').waitFor();
    });
}

await browser.close();
await server.close();
if (failures) { console.error(`${failures} shot(s) failed the 320 px width check`); process.exit(1); }
console.log('All shots saved; nothing wider than 320 px.');
