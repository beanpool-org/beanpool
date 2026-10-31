/**
 * The tag sheet in a real browser, inside what it is really drawn inside (DESIGN-owner-seeding-tags-fable.md §4.4; review of
 * #2663). jsdom lays nothing out and submits no form from a key press, so these two live here: `fixed` measured against a
 * blurred, scrolling panel (the map's New Post panel) clipped the sheet to it, and Enter in the search is a real implicit
 * submit of the form round the picker. At 320 px, 130% text, both themes.
 *
 * Run:  node apps/pwa/e2e/tags-t3-panel-check.mjs   (Chromium for Playwright; contacts no node)
 *   TAG_PANEL_SHOTS=<dir>  also write the open sheet in each theme to that folder
 */
/* global console, process, document, window */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);

const server = await createServer({ configFile: path.join(PWA_DIR, 'vite.config.ts'), root: PWA_DIR, server: { port: 0 }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}/e2e/tags-t3-shots-harness.html`;

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: 320, height: 568 }, colorScheme: theme });
        const page = await context.newPage();
        await page.goto(`${base}?view=panel&dark=${theme === 'dark' ? '1' : '0'}`);
        await page.addStyleTag({ content: 'html { font-size: 130%; }' });
        await page.waitForSelector('[data-testid="tag-picker"]', { timeout: 15000 });
        const counts = () => page.getByTestId('counts').textContent();

        await page.getByRole('button', { name: '+ Add tag' }).click();
        const sheet = page.locator('[role="dialog"]');
        await sheet.waitFor();

        if (process.env.TAG_PANEL_SHOTS) await page.screenshot({ path: path.join(process.env.TAG_PANEL_SHOTS, `tag-sheet-panel-${theme}-320.png`) });

        const box = await sheet.boundingBox();
        check(box.x === 0 && box.y === 0 && box.width === 320 && box.height === 568, `${theme}: the overlay covers the whole 320 x 568 screen (got ${box.width} x ${box.height} at ${box.x},${box.y})`);
        // What a finger lands on: the element on top at each control's centre is that control, nothing of the panel over it.
        const onTop = async (name) => page.getByRole('button', { name }).evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { hit: el === top || el.contains(top), bottom: r.bottom, height: r.height };
        });
        const done = await onTop('Done');
        check(done.hit && done.bottom <= 568, `${theme}: Done is on top and on screen`);
        check(done.height >= 44, `${theme}: Done is at least 44 px tall (${done.height})`);

        const search = page.getByPlaceholder('Search tags...');
        await search.fill('lemon');
        await search.press('Enter');
        await page.waitForTimeout(100);
        check((await counts()) === '0 0', `${theme}: Enter in the search submits nothing (submits, page Escapes: ${await counts()})`);
        check(await sheet.isVisible(), `${theme}: Enter leaves the sheet open`);

        await search.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        check((await counts()) === '0 0', `${theme}: Escape shuts the sheet and reaches no page handler (${await counts()})`);

        // The control the test leans on: the same keys with the sheet shut do reach the form and the page.
        await page.getByLabel('Title').press('Enter');
        await page.getByLabel('Title').press('Escape');
        await page.waitForTimeout(100);
        check((await counts()) === '1 1', `${theme}: with the sheet shut, Enter submits and Escape is the page's, so the two above could fail (${await counts()})`);
        await context.close();
    }
} finally {
    await browser.close();
    await server.close();
}
if (failures.length) {
    console.error(`${failures.length} failed`);
    process.exit(1);
}
console.log('tag sheet panel check passed');
