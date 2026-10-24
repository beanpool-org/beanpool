/**
 * Render check and screenshot generator for wide-screen pages (web-wide-pages-fix1).
 *
 * Checks in headless Chromium inside the app shell (w-64 sidebar + flex-1 main):
 * 1. Pulse card and Enterprise card widths are NEVER narrower than at 320px phone
 *    at windows 768, 1024, 1280, 1600 and at 100% / 130% text.
 * 2. Tool photo is NEVER drawn wider than 800px.
 * 3. Captures screenshots of Pulse, Commons, Tools, Channels, and Chat
 *    at 768, 1024, 1280, 1600 and at 320 @ 130% text, in light and dark themes (<= 900px crops).
 */
/* global console, process, document */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = path.join(PWA_DIR, 'e2e', 'shots', 'wide-pages');

const TEXT_SCALES = [1.0, 1.3];
const PAGES = ['pulse', 'commons', 'tools', 'channels', 'chat'];

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
});
await server.listen();
const port = server.httpServer.address().port;
const baseUrl = `http://localhost:${port}/e2e/wide-pages-harness.html`;

const browser = await chromium.launch();
const failures = [];
const measurements = {};

try {
    // 1. Measure reference widths at 320px phone (100% and 130%)
    for (const scale of TEXT_SCALES) {
        const key = `320@${Math.round(scale * 100)}%`;
        const context = await browser.newContext({
            viewport: { width: 320, height: 800 },
            colorScheme: 'light',
        });
        const page = await context.newPage();
        await page.goto(`${baseUrl}?page=all`, { waitUntil: 'networkidle' });
        await page.evaluate((s) => {
            document.documentElement.style.fontSize = `${s * 100}%`;
        }, scale);
        await page.waitForTimeout(300);

        const pulseWidth = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="pulse-grid"] article');
            return el ? el.getBoundingClientRect().width : 0;
        });
        const enterpriseWidth = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="commons-grid"] > div, [data-testid="commons-grid"] [role="button"]');
            return el ? el.getBoundingClientRect().width : 0;
        });
        const toolPhotoWidth = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="tool-photo"]');
            return el ? el.getBoundingClientRect().width : 0;
        });

        measurements[key] = { pulseWidth, enterpriseWidth, toolPhotoWidth };
        console.log(`Reference phone ${key}: Pulse=${pulseWidth.toFixed(1)}px, Enterprise=${enterpriseWidth.toFixed(1)}px, ToolPhoto=${toolPhotoWidth.toFixed(1)}px`);
        await context.close();
    }

    // 2. Measure and check at windows 768, 1024, 1280, 1600 at 100% and 130%
    for (const winWidth of [768, 1024, 1280, 1600]) {
        for (const scale of TEXT_SCALES) {
            const key = `${winWidth}@${Math.round(scale * 100)}%`;
            const refKey = `320@${Math.round(scale * 100)}%`;
            const ref = measurements[refKey];

            const context = await browser.newContext({
                viewport: { width: winWidth, height: 900 },
                colorScheme: 'light',
            });
            const page = await context.newPage();
            await page.goto(`${baseUrl}?page=all`, { waitUntil: 'networkidle' });
            await page.evaluate((s) => {
                document.documentElement.style.fontSize = `${s * 100}%`;
            }, scale);
            await page.waitForTimeout(300);

            const pulseWidth = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="pulse-grid"] article');
                return el ? el.getBoundingClientRect().width : 0;
            });
            const enterpriseWidth = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="commons-grid"] > div, [data-testid="commons-grid"] [role="button"]');
                return el ? el.getBoundingClientRect().width : 0;
            });
            const toolPhotoWidth = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="tool-photo"]');
                return el ? el.getBoundingClientRect().width : 0;
            });

            measurements[key] = { pulseWidth, enterpriseWidth, toolPhotoWidth };
            console.log(`Window ${key}: Pulse=${pulseWidth.toFixed(1)}px (ref: ${ref.pulseWidth.toFixed(1)}px), Enterprise=${enterpriseWidth.toFixed(1)}px (ref: ${ref.enterpriseWidth.toFixed(1)}px), ToolPhoto=${toolPhotoWidth.toFixed(1)}px`);

            // Check: Pulse card never narrower than at 320px phone
            if (pulseWidth < ref.pulseWidth - 1) {
                failures.push(`Pulse card at ${key} (${pulseWidth.toFixed(1)}px) is narrower than at 320px phone (${ref.pulseWidth.toFixed(1)}px)`);
            }
            // Check: Enterprise card never narrower than at 320px phone
            if (enterpriseWidth < ref.enterpriseWidth - 1) {
                failures.push(`Enterprise card at ${key} (${enterpriseWidth.toFixed(1)}px) is narrower than at 320px phone (${ref.enterpriseWidth.toFixed(1)}px)`);
            }
            // Check: Tool photo never drawn wider than 800px
            if (toolPhotoWidth > 800.5) {
                failures.push(`Tool photo at ${key} (${toolPhotoWidth.toFixed(1)}px) is wider than 800px`);
            }

            await context.close();
        }
    }

    // 3. Take screenshots of Pulse, Commons, Tools, Channels, and Chat
    // at 768, 1024, 1280, 1600 and at 320 x 130%, light and dark (<= 900px crops)
    // Only captured when explicitly requested with --shots.
    const shouldTakeShots = process.argv.includes('--shots');
    if (shouldTakeShots) {
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        const SHOT_CASES = [
            { name: '320-130pc', width: 320, height: 800, scale: 1.3 },
            { name: '768', width: 768, height: 900, scale: 1.0 },
            { name: '1024', width: 1024, height: 900, scale: 1.0 },
            { name: '1280', width: 1280, height: 900, scale: 1.0 },
            { name: '1600', width: 1600, height: 900, scale: 1.0 },
        ];

        for (const theme of ['light', 'dark']) {
            for (const sc of SHOT_CASES) {
                for (const p of PAGES) {
                    const context = await browser.newContext({
                        viewport: { width: sc.width, height: sc.height },
                        colorScheme: theme,
                    });
                    const page = await context.newPage();
                    await page.goto(`${baseUrl}?page=${p}`, { waitUntil: 'networkidle' });
                    await page.evaluate(([t, s]) => {
                        document.documentElement.classList.toggle('dark', t === 'dark');
                        document.documentElement.classList.toggle('dark-theme', t === 'dark');
                        document.documentElement.style.fontSize = `${s * 100}%`;
                    }, [theme, sc.scale]);
                    await page.waitForTimeout(200);

                    const shotFilename = `${p}-${sc.name}-${theme}.png`;
                    const shotPath = path.join(SHOTS_DIR, shotFilename);
                    const cropWidth = Math.min(sc.width, 900);
                    const cropHeight = Math.min(sc.height, 800);

                    await page.screenshot({
                        path: shotPath,
                        clip: { x: 0, y: 0, width: cropWidth, height: cropHeight },
                    });

                    await context.close();
                }
            }
        }
    }

} finally {
    await browser.close();
    await server.close();
}

console.log('\n--- Render Check Summary ---');
if (failures.length > 0) {
    console.error('FAILURES:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
} else {
    console.log('✓ All card widths and tool photo constraints passed across all windows and text scales.');
}
