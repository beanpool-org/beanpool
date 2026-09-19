#!/usr/bin/env node
/**
 * Takes pictures of each Settings screen the operator manual describes at phone width (390px).
 * Saves compressed WebP images (<80 KB each) into packages/beanpool-guide/operators/images/.
 *
 * Usage:
 *   node e2e/manual-shots.mjs [out-dir]
 *   pnpm --filter @beanpool/guide screenshots
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    startServer,
    launch,
    openSettings,
    selectSubTab,
    settle,
    SCREENS,
    screenName,
    ALL_MODALS,
    openModal,
    topModal,
} from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const outDir = process.argv[2] || path.resolve(REPO_ROOT, 'packages/beanpool-guide/operators/images');

fs.mkdirSync(outDir, { recursive: true });

const WIDTH = 390;
const MAX_H = 800;

async function saveWebP(page, pngBuffer, outFile, quality = 0.82) {
    const b64 = pngBuffer.toString('base64');
    const webpDataUrl = await page.evaluate(async ({ b64, quality }) => {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/webp', quality));
            };
            img.src = 'data:image/png;base64,' + b64;
        });
    }, { b64, quality });
    const buf = Buffer.from(webpDataUrl.split(',')[1], 'base64');
    fs.writeFileSync(outFile, buf);
    const kb = (buf.length / 1024).toFixed(1);
    console.log(`  ✓ ${path.basename(outFile)} (${kb} KB)`);
    if (buf.length > 80 * 1024) {
        console.warn(`    ⚠️ Warning: ${path.basename(outFile)} is ${kb} KB (exceeds ~80 KB)`);
    }
}

async function captureScreen(page, name) {
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const height = Math.min(scrollHeight, MAX_H);
    const pngBuffer = await page.screenshot({
        animations: 'disabled',
        clip: { x: 0, y: 0, width: WIDTH, height },
    });
    const outFile = path.join(outDir, `${name}.webp`);
    await saveWebP(page, pngBuffer, outFile);
}

console.log(`Taking manual screenshots (width: ${WIDTH}px) -> ${outDir}`);

const { server, origin } = await startServer();
const browser = await launch();

try {
    // 1. Sign-in screen
    {
        const { context, page } = await openSettings(browser, origin, {
            width: WIDTH,
            height: MAX_H,
            signedIn: false,
        });
        await captureScreen(page, 'sign-in');
        await context.close();
    }

    // 2. Cold-start wizard
    {
        const { context, page } = await openSettings(browser, origin, {
            width: WIDTH,
            height: MAX_H,
            screen: { tab: 'home' },
        });
        const wizardBtn = page.getByRole('button', { name: /Launch Cold-Start Wizard/i });
        if (await wizardBtn.isVisible()) {
            await wizardBtn.click();
            await settle(page);
            await captureScreen(page, 'cold-start');
        }
        await context.close();
    }

    // 3. Tab screens (17 screens across the 5 sections)
    const tabs = [...new Set(SCREENS.map(s => s.tab))];
    for (const tab of tabs) {
        const { context, page } = await openSettings(browser, origin, {
            width: WIDTH,
            height: MAX_H,
            screen: { tab },
        });
        for (const screen of SCREENS.filter(s => s.tab === tab)) {
            if (screen.sub) {
                await selectSubTab(page, screen.sub);
                await settle(page);
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await captureScreen(page, screenName(screen));
        }
        await context.close();
    }

    // 4. Member detail modal (described in people/members-and-invites.md)
    {
        const modal = ALL_MODALS.find(m => m.name === 'member-detail');
        if (modal) {
            const { context, page } = await openSettings(browser, origin, {
                width: WIDTH,
                height: MAX_H,
                screen: modal.screen,
                overrides: modal.overrides,
            });
            await openModal(page, modal);
            const card = topModal(page).card;
            const cardHeight = await card.evaluate((el) => el.getBoundingClientRect().height);
            await page.setViewportSize({ width: WIDTH, height: Math.min(MAX_H, Math.max(780, Math.ceil(cardHeight) + 64)) });
            await page.waitForTimeout(200);
            const pngBuffer = await page.screenshot({ animations: 'disabled' });
            const outFile = path.join(outDir, 'modal-member-detail.webp');
            await saveWebP(page, pngBuffer, outFile);
            await context.close();
        }
    }

    console.log(`\nAll manual screenshots saved successfully.`);
} finally {
    await browser.close();
    await server.close();
}
