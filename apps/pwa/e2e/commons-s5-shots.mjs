/* eslint-disable no-undef */
// Commons S5 and S6 shots at 320 px with 130% text, light and dark: node apps/pwa/e2e/commons-s5-shots.mjs
// Written to scratch/screenshots/commons-s5-*.png (cropped to the page, never the whole 1.3x canvas).
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
const base = `http://localhost:${port}/e2e/commons-s5-shots-harness.html`;

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const cases = [
    // The Decide section: the Commons Pool and Voice credits cards, with the phone's words.
    { id: 'decide-cards', view: 'decide', wait: '[data-testid="voice-credits-card"]' },
    // Empty Groups list on each chip: the line says what the chip is for and the button starts that kind (none on All).
    { id: 'empty-all', view: 'groups', wait: 'text=No enterprises found', clipY: 420 },
    { id: 'empty-projects', view: 'groups', chip: '🌱 Projects', wait: 'text=Start a project', clipY: 420 },
    { id: 'empty-enterprises', view: 'groups', chip: '🏛️ Enterprises', wait: 'text=Start an enterprise', clipY: 420 },
    // Talk's group form hands over here: Commons opens with Start something up.
    { id: 'start-dialog', view: 'start-dialog', wait: '[role="dialog"]' },
    // The start form with neither kind picked (opened from the dialog's Project row, then the other card unselected is not possible:
    // the Chat group form's bridge opens it unset).
    { id: 'form-unset', view: 'groups', chip: null, bridge: true, wait: 'form' },
];

const browser = await chromium.launch();
try {
    for (const theme of ['light', 'dark']) {
        for (const c of cases) {
            const context = await browser.newContext({ viewport: { width: 320, height: 1200 }, colorScheme: theme, deviceScaleFactor: 1 });
            const page = await context.newPage();
            // 130% text, as a browser set to it (the PWA has no setting of its own).
            await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '130%'; }); });
            await page.route('**/api/**', async (route) => {
                const url = route.request().url();
                if (url.includes('/api/community/info')) return json(route, { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 250, profile: 'local', features: { beans: true, enterprises: true, decisions: true } });
                if (url.includes('/api/commons/decisions')) return json(route, { decisions: [], myPoolVoting: { voiceCredits: 9.6, hasCompletedTrade: true, qualifiedTradeValue: 9.6 }, canPropose: true });
                if (url.includes('/api/commons/balance')) return json(route, { balance: 250 });
                if (url.includes('/api/ledger/balance')) return json(route, { balance: 100, floor: -500, commonsBalance: 250, earnedCredit: 12, callsign: 'Alice', keeperOf: [], tier: 'contributor' });
                if (url.includes('/api/treasuries')) return json(route, { treasuries: [] });
                if (url.includes('/api/your-groups')) return json(route, { items: [] });
                if (url.includes('/api/groups')) return json(route, []);
                return json(route, {});
            });
            await page.goto(`${base}?view=${c.view}`);
            if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
            else await page.evaluate(() => document.documentElement.classList.remove('dark'));
            await page.waitForSelector(c.wait.startsWith('text=') ? c.wait : c.wait, { timeout: 15000 }).catch(() => {});
            if (c.chip) {
                await page.getByRole('button', { name: c.chip }).click();
                await page.waitForSelector(c.wait, { timeout: 15000 }).catch(() => {});
            }
            if (c.bridge) {
                // ＋ Start something → Chat group → "With Beans involved? Start a project or an enterprise →": the form opens with neither kind picked.
                await page.getByRole('button', { name: /Start something/ }).first().click();
                await page.getByRole('dialog').getByRole('button', { name: /Chat group/ }).click();
                await page.getByText('Start a project or an enterprise →').click();
                await page.waitForSelector('form', { timeout: 15000 }).catch(() => {});
            }
            await page.waitForTimeout(500);
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            const outPath = path.join(OUT_DIR, `commons-s5-${c.id}-${theme}.png`);
            await page.screenshot({ path: outPath, fullPage: false, clip: { x: 0, y: c.clipY ?? 0, width: 320, height: 760 } });
            console.log(`${c.id} ${theme}: horizontal overflow ${overflow}px -> ${outPath}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
