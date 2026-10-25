import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(PWA_DIR);
const SHOTS_DIR = path.join(PWA_DIR, 'e2e', 'screenshots', 'header-alerts');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || process.env.HEADER_ALERTS_SHOTS_DIR || path.join(os.tmpdir(), 'header-alerts-shots');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const server = await createServer({
    configFile: path.join(PWA_DIR, 'vite.config.ts'),
    root: PWA_DIR,
    server: { port: 0 },
});
await server.listen();
const port = server.httpServer.address().port;
const baseUrl = `http://localhost:${port}/e2e/header-alerts-harness.html`;

const browser = await chromium.launch();

const MOBILE_WIDTHS = [320, 360, 375, 390, 412, 430];
const TEXT_SCALES = [1.0, 1.3];
const THEMES = ['dark', 'light'];
const STATES = ['none', 'invite', 'three'];
const TABS = ['home', 'map'];

console.log('Capturing real header alerts screenshots...');

// 1. Mobile shots across all widths, text scales, states, themes, and tabs
for (const width of MOBILE_WIDTHS) {
    for (const textScale of TEXT_SCALES) {
        const scaleLabel = textScale === 1.3 ? '130pct' : '100pct';
        for (const theme of THEMES) {
            for (const state of STATES) {
                for (const tab of TABS) {
                    const context = await browser.newContext({
                        viewport: { width, height: 400 },
                        colorScheme: theme,
                    });
                    const page = await context.newPage();
                    await page.goto(`${baseUrl}?state=${state}&tab=${tab}`, { waitUntil: 'networkidle' });

                    await page.evaluate(({ scale, mode }) => {
                        document.documentElement.style.fontSize = `${scale * 100}%`;
                        if (mode === 'dark') {
                            document.documentElement.classList.add('dark', 'dark-theme');
                            document.documentElement.classList.remove('light');
                        } else {
                            document.documentElement.classList.add('light');
                            document.documentElement.classList.remove('dark', 'dark-theme');
                        }
                    }, { scale: textScale, mode: theme });

                    await page.waitForTimeout(300);

                    const shotFileName = `header-${width}-${scaleLabel}-${theme}-${tab}-${state}.png`;
                    const shotPath = path.join(SHOTS_DIR, shotFileName);
                    // Crop header row (<= 900 px crop)
                    await page.screenshot({
                        path: shotPath,
                        clip: { x: 0, y: 0, width, height: 75 },
                    });
                    fs.copyFileSync(shotPath, path.join(ARTIFACTS_DIR, shotFileName));
                    await context.close();
                }
            }
        }
    }
}

// 2. Desktop wide shots (1280 px)
for (const theme of THEMES) {
    for (const state of STATES) {
        const context = await browser.newContext({
            viewport: { width: 1280, height: 600 },
            colorScheme: theme,
        });
        const page = await context.newPage();
        await page.goto(`${baseUrl}?state=${state}&tab=home`, { waitUntil: 'networkidle' });

        await page.evaluate(({ mode }) => {
            if (mode === 'dark') {
                document.documentElement.classList.add('dark', 'dark-theme');
                document.documentElement.classList.remove('light');
            } else {
                document.documentElement.classList.add('light');
                document.documentElement.classList.remove('dark', 'dark-theme');
            }
        }, { mode: theme });

        await page.waitForTimeout(300);

        const shotFileName = `sidebar-1280-100pct-${theme}-${state}.png`;
        const shotPath = path.join(SHOTS_DIR, shotFileName);
        // Crop sidebar footer area where NeedsYouIcons sit (256 x 200, <= 900px crop)
        await page.screenshot({
            path: shotPath,
            clip: { x: 0, y: 400, width: 260, height: 200 },
        });
        fs.copyFileSync(shotPath, path.join(ARTIFACTS_DIR, shotFileName));
        await context.close();
    }
}

await browser.close();
await server.close();
console.log(`Done capturing screenshots in ${SHOTS_DIR} and ${ARTIFACTS_DIR}!`);
