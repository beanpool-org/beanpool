import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const OUT_DIR = path.resolve(PWA_DIR, '../..', 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/tags-t3-shots-harness.html`;

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        const isDark = theme === 'dark';
        const context = await browser.newContext({
            viewport: { width: 320, height: 800 },
            colorScheme: theme,
            deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        await page.goto(`${base}?dark=${isDark ? '1' : '0'}`);
        await page.waitForSelector('[data-testid="tag-picker"]', { timeout: 10000 });

        // Shot 1: Closed picker row under Category with chips and "+ Add" button
        const rowShot = path.join(OUT_DIR, `web-tag-picker-row-${theme}-320.png`);
        await page.screenshot({ path: rowShot, fullPage: false });
        console.log(`Saved web row shot: ${rowShot}`);

        // Click "+ Add" to open sheet dialog
        const addButton = page.getByRole('button', { name: /\+ Add/i });
        await addButton.click();
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
        await page.waitForTimeout(300);

        // Shot 2: Sheet dialog open with suggestions and expandable groups
        const sheetShot = path.join(OUT_DIR, `web-tag-picker-sheet-${theme}-320.png`);
        await page.screenshot({ path: sheetShot, fullPage: false });
        console.log(`Saved web sheet shot: ${sheetShot}`);

        // Type search query to show label index search in action
        const searchInput = page.getByPlaceholder(/Search tags/i);
        await searchInput.fill('citrus');
        await page.waitForTimeout(300);

        // Shot 3: Search active showing matching tag chips
        const searchShot = path.join(OUT_DIR, `web-tag-picker-search-${theme}-320.png`);
        await page.screenshot({ path: searchShot, fullPage: false });
        console.log(`Saved web search shot: ${searchShot}`);

        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
