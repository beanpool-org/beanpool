/**
 * The web Tags field with this community's typed tags (DESIGN-tags-free-entry-fable.md §3, slice F3) in a real browser, at
 * 320 px with 130% text, both themes: the "Tags used here" rows under the library's matches, a merged tag shown as its library
 * tag, nothing past 320 px, every target 44 px or more. The community's list is fed in: contacts no node.
 *
 * Run:  node apps/pwa/e2e/tags-f3-shots.mjs   (Chromium for Playwright)   SHOTS_DIR=<dir> for the screenshots
 */
/* global console, process, document */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS = process.env.SHOTS_DIR || path.join(PWA_DIR, 'e2e', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/tags-f3-shots-harness.html`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme: theme });
        const page = await context.newPage();
        await page.goto(`${base}?dark=${theme === 'dark' ? '1' : '0'}`);
        await page.addStyleTag({ content: 'html { font-size: 130%; }' });
        await page.waitForSelector('[data-testid="tag-picker"]', { timeout: 15000 });
        await page.getByRole('button', { name: '+ Add tag' }).click();
        const field = page.getByPlaceholder('Search tags...');
        await field.fill('han');
        await page.getByTestId('tag-picker-used-here').waitFor({ timeout: 5000 });
        const rows = await page.getByTestId('tag-picker-used-here').locator('button').allTextContents();
        check(rows.length === 2 && rows[0].startsWith('#handmade') && !rows.some((r) => r.startsWith('#hand tools')),
            `${theme}: the tags used here under the library's, the library's own label left to it (${JSON.stringify(rows)})`);
        await page.screenshot({ path: path.join(SHOTS, `web-tags-used-here-${theme}-320.png`) });
        const layout = await page.evaluate(() => ({
            wide: [...document.querySelectorAll('[role="dialog"] *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > 320.5; }).length,
            small: [...document.querySelectorAll('[data-testid="tag-picker-used-here"] button')].filter((b) => b.getBoundingClientRect().height < 44).length,
            scroll: document.documentElement.scrollWidth,
        }));
        check(layout.wide === 0 && layout.scroll <= 320 && layout.small === 0, `${theme}: nothing past 320 px, every row 44 px or more (${JSON.stringify(layout)})`);
        await field.fill('lim');
        await page.getByText('#limones').waitFor({ timeout: 5000 });
        await page.screenshot({ path: path.join(SHOTS, `web-tags-used-here-merged-${theme}-320.png`) });
        await field.fill('limones');
        await field.press('Enter');
        check(await page.getByRole('button', { name: 'Remove Lemon' }).count() > 0, `${theme}: Enter on a merged word adds the library tag`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
