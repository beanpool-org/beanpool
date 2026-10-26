/* eslint-disable no-undef */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const WORKTREE_ROOT = path.resolve(PWA_DIR, '../..');
const OUT_DIR = path.join(WORKTREE_ROOT, 'scratch', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MY_PUBKEY = 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678';

const mockMembers = [
    {
        publicKey: 'pubkey-bob-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        callsign: 'Bob (no picture)',
        avatarUrl: null,
        joinedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        publicKey: 'pubkey-carol-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        callsign: 'Carol (preset sunflower)',
        avatarUrl: 'bundled://sunflower',
        joinedAt: '2026-03-02T00:00:00.000Z',
    },
    {
        publicKey: 'pubkey-dave-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        callsign: 'Dave (no picture)',
        avatarUrl: null,
        joinedAt: '2026-03-03T00:00:00.000Z',
    },
];

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/pictures-s4-shots-harness.html`;

const browser = await chromium.launch();

const cases = [
    { id: 'start-enterprise', view: 'start-enterprise', selector: 'form' },
    { id: 'start-project', view: 'start-project', selector: 'form' },
    { id: 'create-group', view: 'create-group', selector: 'form' },
    { id: 'members-list', view: 'members-list', selector: 'button[aria-label*="profile"]' },
];

try {
    for (const theme of ['light', 'dark']) {
        for (const c of cases) {
            const context = await browser.newContext({
                viewport: { width: 320, height: 800 },
                colorScheme: theme,
                deviceScaleFactor: 1.3,
            });
            const page = await context.newPage();

            await page.route('**/api/**', async (route) => {
                const url = route.request().url();

                if (url.includes('/api/community/members') || url.includes('/api/members/whole') || url.includes('/api/members')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify(mockMembers),
                    });
                }
                if (url.includes('/api/friends/added-you')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ addedYou: [], more: 0 }),
                    });
                }
                if (url.includes('/api/friends')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([]),
                    });
                }
                if (url.includes('/api/enterprises') || url.includes('/api/projects') || url.includes('/api/groups')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify([]),
                    });
                }
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({}),
                });
            });

            await page.goto(`${base}?view=${c.view}`);
            if (theme === 'dark') {
                await page.evaluate(() => document.documentElement.classList.add('dark'));
            } else {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }

            try {
                await page.waitForSelector(c.selector, { timeout: 15000 });
            } catch (err) {
                console.log(`Selector ${c.selector} not found for ${c.id}: ${err.message}`);
            }
            await page.waitForTimeout(600);

            const outPath = path.join(OUT_DIR, `${c.id}-${theme}.png`);
            await page.screenshot({ path: outPath, fullPage: true });
            console.log(`Saved screenshot: ${outPath}`);

            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
