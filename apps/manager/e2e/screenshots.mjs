#!/usr/bin/env node
/**
 * Pictures of every Settings screen, for review: `node e2e/screenshots.mjs <out-dir> [widths] [textScale]`.
 * Widths default to 360,1280. Each picture is the top of the page, at most 1500px tall.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openSettings, selectSubTab, settle, SCREENS, screenName } from './harness.mjs';

const out = process.argv[2];
if (!out) {
    console.error('usage: node e2e/screenshots.mjs <out-dir> [360,1280] [textScale]');
    process.exit(2);
}
const widths = (process.argv[3] || '360,1280').split(',').map(Number);
const textScale = Number(process.argv[4] || 1);
const MAX_H = 1500;
fs.mkdirSync(out, { recursive: true });

async function shot(page, name) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const width = page.viewportSize().width;
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height: Math.min(height, MAX_H) } });
    console.log(file);
}

const { server, origin } = await startServer();
const browser = await launch();
try {
    for (const width of widths) {
        const suffix = `${width}${textScale !== 1 ? `-x${textScale}` : ''}`;
        const tabs = [...new Set(SCREENS.map(s => s.tab))];
        for (const tab of tabs) {
            const { context, page } = await openSettings(browser, origin, { width, height: width < 600 ? 780 : 900, textScale, screen: { tab } });
            for (const screen of SCREENS.filter(s => s.tab === tab)) {
                if (screen.sub) {
                    await selectSubTab(page, screen.sub);
                    await settle(page);
                }
                await page.evaluate(() => window.scrollTo(0, 0));
                await shot(page, `${screenName(screen)}-${suffix}`);
            }
            await context.close();
        }
        if (width < 1024) {
            const { context, page } = await openSettings(browser, origin, { width, height: 780, textScale, screen: { tab: 'economy' } });
            await page.getByRole('button', { name: 'Menu' }).click();
            await page.getByRole('dialog', { name: 'Settings menu' }).waitFor();
            await page.waitForTimeout(200);
            await page.screenshot({ path: path.join(out, `menu-${suffix}.png`) });
            await page.getByRole('button', { name: /Manual: running your community/ }).click();
            await page.waitForTimeout(200);
            await page.screenshot({ path: path.join(out, `manual-${suffix}.png`) });
            await context.close();
        }
        {
            const { context, page } = await openSettings(browser, origin, { width, height: width < 600 ? 780 : 900, textScale, signedIn: false });
            await shot(page, `sign-in-${suffix}`);
            await context.close();
        }
        {
            const { context, page } = await openSettings(browser, origin, {
                width, height: width < 600 ? 780 : 900, textScale, signedIn: false, hash: `#handoff=${'ab'.repeat(16)}&section=disputes`,
            });
            await page.waitForSelector('main');
            await settle(page);
            await shot(page, `handoff-disputes-${suffix}`);
            await context.close();
        }
    }
} finally {
    await browser.close();
    await server.close();
}
