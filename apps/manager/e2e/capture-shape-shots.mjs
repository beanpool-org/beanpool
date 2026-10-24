import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openSettings, settle } from './harness.mjs';

const OUT_DIR = '/Users/marty/projects/beanpool/scratch/fable-design/community-shape-s4-shots';
fs.mkdirSync(OUT_DIR, { recursive: true });

const WIDTH = 320;
const MAX_H = 880;

const { server, origin } = await startServer();
const browser = await launch();

try {
    for (const theme of ['dark', 'light']) {
        const isDark = theme === 'dark';
        
        // 1. Closed Shape Page
        {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: 800,
                textScale: 1.3,
                screen: { tab: 'shape' },
                colorScheme: theme,
            });
            if (!isDark) {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }
            await page.waitForSelector('[data-testid="community-shape-section"]', { timeout: 10000 });
            await settle(page);
            const file = path.join(OUT_DIR, `shape-overview-${theme}.png`);
            await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: MAX_H } });
            console.log(`Saved ${file}`);
            await context.close();
        }

        // 2. Open Setting Row (e.g. Who can join, or Beans, or Known floor)
        {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: 800,
                textScale: 1.3,
                screen: { tab: 'shape' },
                colorScheme: theme,
            });
            if (!isDark) {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }
            await page.waitForSelector('[data-testid="community-shape-section"]', { timeout: 10000 });
            await settle(page);
            // Click to expand join row
            await page.getByTestId('shape-expand-join').click();
            await page.waitForSelector('[data-testid="shape-consequence"]', { timeout: 5000 });
            await settle(page);
            const file = path.join(OUT_DIR, `shape-open-join-${theme}.png`);
            await page.getByTestId('shape-row-join').screenshot({ path: file });
            console.log(`Saved ${file}`);
            await context.close();
        }

        // 3. Open Known Floor row
        {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: 800,
                textScale: 1.3,
                screen: { tab: 'shape' },
                colorScheme: theme,
            });
            if (!isDark) {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }
            await page.waitForSelector('[data-testid="community-shape-section"]', { timeout: 10000 });
            await settle(page);
            // Scroll to knownFloor
            const kf = page.getByTestId('shape-expand-knownFloor');
            await kf.scrollIntoViewIfNeeded();
            await kf.click();
            await page.waitForSelector('[data-testid="shape-consequence"]', { timeout: 5000 });
            await settle(page);
            const file = path.join(OUT_DIR, `shape-open-floor-${theme}.png`);
            await page.getByTestId('shape-row-knownFloor').screenshot({ path: file });
            console.log(`Saved ${file}`);
            await context.close();
        }

        // 4. Admin view (read-only with reason and no controls)
        {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: 800,
                textScale: 1.3,
                screen: { tab: 'shape' },
                handoffRole: 'admin',
                signedIn: false,
                hash: `#handoff=${'ab'.repeat(16)}&section=shape`,
                colorScheme: theme,
            });
            if (!isDark) {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }
            await page.waitForSelector('[data-testid="community-shape-section"]', { timeout: 10000 });
            await settle(page);
            const file = path.join(OUT_DIR, `shape-admin-view-${theme}.png`);
            await page.screenshot({ path: file, clip: { x: 0, y: 0, width: WIDTH, height: MAX_H } });
            console.log(`Saved ${file}`);
            await context.close();
        }

        // 5. Home Card
        {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: 800,
                textScale: 1.3,
                screen: { tab: 'home' },
                colorScheme: theme,
            });
            if (!isDark) {
                await page.evaluate(() => document.documentElement.classList.remove('dark'));
            }
            await page.waitForSelector('[data-testid="home-community-shape-card"]', { timeout: 10000 });
            await page.getByTestId('home-community-shape-card').scrollIntoViewIfNeeded();
            await settle(page);
            const file = path.join(OUT_DIR, `home-card-${theme}.png`);
            await page.getByTestId('home-community-shape-card').screenshot({ path: file });
            console.log(`Saved ${file}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
