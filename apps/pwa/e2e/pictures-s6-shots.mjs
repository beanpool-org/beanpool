/* eslint-disable no-undef */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const WORKTREE_ROOT = path.resolve(PWA_DIR, '../..');
const OUT_DIR = path.join(WORKTREE_ROOT, 'scratch', 'shots', 'pictures-s6');
fs.mkdirSync(OUT_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
    logLevel: 'error',
});
await server.listen();
const port = server.httpServer.address().port;
const base = `http://localhost:${port}/e2e/pictures-s6-shots-harness.html`;

const browser = await chromium.launch();

const cases = [
    { id: 'web-market-grid-320px-130pct', view: 'web-market-grid' },
    { id: 'web-market-list-320px-130pct', view: 'web-market-list' },
    { id: 'web-market-compact-320px-130pct', view: 'web-market-compact' },
    { id: 'web-home-market-320px-130pct', view: 'web-home-market' },
    { id: 'phone-market-grid-320dp-130pct', view: 'phone-market-grid' },
    { id: 'phone-market-list-320dp-130pct', view: 'phone-market-list' },
    { id: 'phone-market-compact-320dp-130pct', view: 'phone-market-compact' },
    { id: 'phone-home-market-320dp-130pct', view: 'phone-home-market' },
];

try {
    for (const theme of ['light', 'dark']) {
        for (const c of cases) {
            const context = await browser.newContext({
                viewport: { width: 320, height: 750 },
                colorScheme: theme,
                deviceScaleFactor: 1.3,
            });
            const page = await context.newPage();

            await page.route('**/api/**', async (route) => {
                const url = route.request().url();
                if (url.includes('/api/home')) {
                    return route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        headers: { etag: 'W/"shots"' },
                        body: JSON.stringify({
                            generatedAt: new Date().toISOString(),
                            profile: 'local',
                            community: { name: 'Mullumbimby Commons', members: 42, openInvites: 0, publicBoard: false, tradesThisMonth: 12, commonsPot: 150, listings: 3, eventsSoon: 0 },
                            cards: {
                                market: {
                                    items: [
                                        { id: 'h1', type: 'offer', title: 'Fresh Sourdough Loaf', category: 'food', photoUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="%23f59e0b"/></svg>', bannerUrl: null, distanceKm: 1 },
                                        { id: 'h2', type: 'offer', title: 'Enterprise Sourdough Starter', category: 'food', photoUrl: null, bannerUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="267"><rect width="800" height="267" fill="%23059669"/></svg>', distanceKm: 2 },
                                        { id: 'h3', type: 'offer', title: 'Garden Spade & Rake Hire', category: 'tools', photoUrl: null, bannerUrl: null, distanceKm: 3 },
                                    ],
                                    total14d: 3,
                                    more: false,
                                },
                            },
                            features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
                            switches: { beans: true },
                            me: { standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' }, joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false },
                            layout: { v: 2, cards: [{ id: 'market', type: 'market' }], dismissed: {}, updatedAt: null },
                        }),
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
                await page.evaluate(() => {
                    document.documentElement.classList.add('dark');
                    document.documentElement.classList.add('dark-theme');
                });
            } else {
                await page.evaluate(() => {
                    document.documentElement.classList.remove('dark');
                    document.documentElement.classList.remove('dark-theme');
                });
            }

            try {
                await page.waitForSelector('[data-testid="shot-container"]', { timeout: 10000 });
            } catch (err) {
                console.log(`Container not found for ${c.id}: ${err.message}`);
            }
            await page.waitForTimeout(500);

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
