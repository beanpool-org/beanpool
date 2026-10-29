/* eslint-disable no-undef */
// The web Market's cards in a tall container, in real Chromium: is each card its own height, the same in a short and a
// tall one? (The phone's list card filled the screen, 29 Oct; this is the web side of that check.) Optionally takes the
// 320 px / 130% text screenshots into scratch/shots/market-card-height with --shots.
//
//   node apps/pwa/e2e/market-card-height-check.mjs [--shots]
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.resolve(PWA_DIR, '../..', 'scratch', 'shots', 'market-card-height');
const shots = process.argv.includes('--shots');
if (shots) fs.mkdirSync(OUT_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/market-card-height-harness.html`;
const browser = await chromium.launch();

// A card of any view is well short of the container: list and compact rows a few hundred px at 130% text, a grid tile
// its square and its words.
const CAP = { list: 320, grid: 520, compact: 140 };
let failures = 0;

try {
    for (const view of ['list', 'grid', 'compact']) {
        for (const n of [1, 10]) {
            for (const kind of ['photoless', 'banner', 'mixed']) {
                const heights = [];
                for (const tall of [700, 2400]) {
                    const context = await browser.newContext({ viewport: { width: 320, height: Math.min(tall, 900) }, deviceScaleFactor: 1 });
                    const page = await context.newPage();
                    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
                    await page.goto(`${base}?view=${view}&n=${n}&kind=${kind}&tall=${tall}`, { waitUntil: 'networkidle' });
                    await page.addStyleTag({ content: 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; }' });
                    await page.evaluate(() => document.fonts.ready);
                    const measured = await page.evaluate(() => Array.from(document.querySelectorAll('[data-card]')).map((w) => (w.firstElementChild ?? w).getBoundingClientRect().height));
                    heights.push(measured);
                    await context.close();
                }
                const [short, tallH] = heights;
                const same = short.length === n && short.every((h, i) => Math.abs(h - tallH[i]) < 0.5);
                const within = Math.max(...short, ...tallH) < CAP[view];
                const ok = same && within;
                if (!ok) failures++;
                console.log(`${ok ? 'ok  ' : 'FAIL'} ${view.padEnd(7)} n=${String(n).padEnd(2)} ${kind.padEnd(9)} cards ${short.map((h) => Math.round(h)).join(',')} | tall ${tallH.map((h) => Math.round(h)).join(',')}`);
            }
        }
    }

    if (shots) {
        for (const theme of ['light', 'dark']) {
            for (const view of ['list', 'grid']) {
                for (const n of [1, 10]) {
                    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme, deviceScaleFactor: 1.3 });
                    const page = await context.newPage();
                    await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
                    await page.goto(`${base}?view=${view}&n=${n}&kind=mixed&tall=${n === 1 ? 640 : 1500}${theme === 'dark' ? '&dark=1' : ''}`, { waitUntil: 'networkidle' });
                    await page.addStyleTag({ content: 'html { font-size: 130% !important; } *, *::before, *::after { transition: none !important; }' });
                    await page.evaluate(() => document.fonts.ready);
                    await page.screenshot({ path: path.join(OUT_DIR, `web-${view}-${n}-${theme}.png`) });
                    await context.close();
                }
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}
console.log(failures === 0 ? 'every web Market card is its own height' : `${failures} case(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
